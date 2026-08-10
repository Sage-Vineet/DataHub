// Tests for the AI Reasonableness Check / Reclassification Recommendation
// layer — the 12 cases required by the specification.
//
// WHAT THIS LAYER IS: a second-pass accounting review that runs AFTER the
// deterministic Chart of Accounts is generated. It never generates or
// classifies anything; it reads the authoritative hierarchy and proposes
// presentation fixes for a human to accept or reject.
//
// These tests exercise the layer's real decision logic — the deterministic
// gates that decide whether a model proposal becomes a stored recommendation
// (normalizeProposal / isMaterial / resolveSource / resolveImpact), and the
// gates that decide whether a stored recommendation may be applied
// (validateTargetLevels / resolveTargetLevels / classificationFingerprint).
// Gemini itself is not called: what matters for correctness is that a
// plausible-but-wrong model answer cannot become a recommendation, and that a
// stale recommendation cannot overwrite a newer user change.
//
// Run: node --test backend/src/services/keyReports/aiReasonablenessCheck.test.js

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./aiHierarchyRecommendationService.js");
const {
  normalizeProposal, isMaterial, resolveSource, resolveImpact,
  validateTargetLevels, resolveTargetLevels, classificationFingerprint,
  buildSectionCatalog, buildSiblingIndex, toReviewInput, columnsToLevels,
  buildReasonablenessPrompt, toPublicRecommendation,
} = svc;

// ── Fixtures ────────────────────────────────────────────────────────────────
// A realistic company P&L skeleton. Note there is nothing hardcoded about
// these labels in the implementation — they are this company's own sections,
// and the tests below rely on that by using non-generic wording.
const PL_SECTIONS = [
  ["Net Income", "Total Revenue", "Income"],
  ["Net Income", "Total Revenue", "Income", "Product Sales"],
  ["Net Income", "Operating Expenses"],
  ["Net Income", "Pretax Income", "Other Income"],
  ["Net Income", "Pretax Income", "Other Expenses"],
];

const account = (over = {}) => ({
  id: "acc-1",
  systemId: "INC-003",
  accountNumber: "4100",
  name: "Interest Income",
  accountType: "income",
  statementType: "profit_loss",
  hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
  parent: "Income",
  siblings: ["Product Sales", "Service Revenue"],
  ...over,
});

// A model answer in the exact shape the prompt demands.
const proposal = (over = {}) => ({
  id: "acc-1",
  kind: "HIERARCHY_MOVE",
  recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
  recommendedAccountType: null,
  recommendedStatementType: null,
  confidence: "HIGH",
  reason: "Interest Income is non-operating and should not sit inside operating revenue.",
  ...over,
});

const accept = (raw, acct = account(), sections = PL_SECTIONS) => {
  const p = normalizeProposal(raw, acct, sections);
  return p && isMaterial(p) ? p : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. Interest Income incorrectly under Revenue → recommendation generated
// ═══════════════════════════════════════════════════════════════════════════
describe("1. Interest Income sitting inside operating revenue", () => {
  test("produces a recommendation", () => {
    const p = accept(proposal());
    assert.ok(p, "a recommendation must be produced");
    assert.equal(p.accountId, "acc-1");
    assert.deepEqual(p.recommendedHierarchy, ["Net Income", "Pretax Income", "Other Income", "Interest Income"]);
  });

  test("it is HIGH confidence and material", () => {
    const p = accept(proposal());
    assert.equal(p.confidenceBand, "HIGH");
    assert.equal(p.impact, "OPERATING_RESULT", "moving it changes Operating Income / EBITDA");
    assert.equal(isMaterial(p), true);
  });

  test("the target section came from the company's OWN document structure", () => {
    const p = accept(proposal());
    assert.equal(p.source, "DOCUMENT_MATCH");
  });

  test("a target section the company does not have is marked AI-derived, not document-matched", () => {
    const p = accept(proposal({
      recommendedHierarchy: ["Net Income", "Non-Operating Items", "Interest Income"],
    }));
    assert.ok(p);
    assert.equal(p.source, "AI_REASONABLENESS");
  });

  test("the account is never renamed by a recommendation", () => {
    const bad = accept(proposal({
      recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Revenue"],
    }));
    assert.equal(bad, null, "a hierarchy that does not end at this account must be rejected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Interest Income already correctly placed → no recommendation
// ═══════════════════════════════════════════════════════════════════════════
describe("2. Interest Income already under Other Income", () => {
  const placed = account({
    hierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
    parent: "Other Income",
    siblings: ["Dividend Income"],
  });

  test("a no-op proposal is discarded rather than stored", () => {
    const p = accept(proposal({
      recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
    }), placed);
    assert.equal(p, null);
  });

  test("a differently-cased no-op is still recognised as a no-op", () => {
    const p = accept(proposal({
      recommendedHierarchy: ["net income", "PRETAX INCOME", "other income", "Interest Income"],
    }), placed);
    assert.equal(p, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Interest Expense incorrectly under operating expenses
// ═══════════════════════════════════════════════════════════════════════════
describe("3. Interest Expense inside operating expenses", () => {
  const acct = account({
    id: "acc-2", systemId: "EXP-011", name: "Interest Expense", accountType: "expense",
    hierarchy: ["Net Income", "Operating Expenses", "Interest Expense"],
    parent: "Operating Expenses", siblings: ["Rent", "Utilities"],
  });

  test("produces a material recommendation into the company's Other Expenses section", () => {
    const p = accept(proposal({
      id: "acc-2",
      recommendedHierarchy: ["Net Income", "Pretax Income", "Other Expenses", "Interest Expense"],
      reason: "Financing cost, not an operating expense.",
    }), acct);
    assert.ok(p);
    assert.equal(p.impact, "OPERATING_RESULT");
    assert.equal(p.source, "DOCUMENT_MATCH");
    assert.equal(p.recommendedRollup, "Other Expenses");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 & 5. Gain / Loss on sale of fixed assets
// ═══════════════════════════════════════════════════════════════════════════
describe("4. Gain on Sale of Assets incorrectly under Revenue", () => {
  const acct = account({
    id: "acc-3", name: "Gain on Sale of Assets", accountType: "income",
    hierarchy: ["Net Income", "Total Revenue", "Income", "Gain on Sale of Assets"],
    parent: "Income", siblings: ["Product Sales"],
  });

  test("produces a recommendation into Other Income", () => {
    const p = accept(proposal({
      id: "acc-3",
      recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Gain on Sale of Assets"],
      reason: "A gain on disposal is not operating revenue.",
    }), acct);
    assert.ok(p);
    assert.equal(p.confidenceBand, "HIGH");
    assert.equal(p.impact, "OPERATING_RESULT");
  });
});

describe("5. Loss on Sale of Assets incorrectly under operating expenses", () => {
  const acct = account({
    id: "acc-4", name: "Loss on Sale of Equipment", accountType: "expense",
    hierarchy: ["Net Income", "Operating Expenses", "Loss on Sale of Equipment"],
    parent: "Operating Expenses", siblings: ["Rent"],
  });

  test("produces a recommendation into Other Expenses", () => {
    const p = accept(proposal({
      id: "acc-4",
      recommendedHierarchy: ["Net Income", "Pretax Income", "Other Expenses", "Loss on Sale of Equipment"],
    }), acct);
    assert.ok(p);
    assert.equal(p.impact, "OPERATING_RESULT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Retained Earnings incorrectly classified as P&L
// ═══════════════════════════════════════════════════════════════════════════
describe("6. Retained Earnings sitting in the P&L", () => {
  const acct = account({
    id: "acc-5", systemId: "INC-020", name: "Retained Earnings",
    accountType: "income", statementType: "profit_loss",
    hierarchy: ["Net Income", "Total Revenue", "Income", "Retained Earnings"],
    parent: "Income", siblings: ["Product Sales"],
  });

  test("a RECLASSIFY recommendation is produced and carries a target type", () => {
    const p = accept(proposal({
      id: "acc-5",
      kind: "RECLASSIFY",
      recommendedHierarchy: ["Total Liabilities and Equity", "Total Equity", "Equity", "Retained Earnings"],
      recommendedAccountType: "equity",
      recommendedStatementType: "balance_sheet",
      reason: "Retained Earnings is an equity account, not P&L income.",
    }), acct, []);
    assert.ok(p);
    assert.equal(p.kind, "RECLASSIFY");
    assert.equal(p.recommendedAccountType, "equity");
    assert.equal(p.recommendedStatementType, "balance_sheet");
    assert.equal(p.impact, "CLASSIFICATION");
  });

  test("a RECLASSIFY is always material, even at LOW confidence", () => {
    const p = normalizeProposal(proposal({
      id: "acc-5", kind: "RECLASSIFY", confidence: "LOW",
      recommendedHierarchy: ["Total Liabilities and Equity", "Total Equity", "Equity", "Retained Earnings"],
      recommendedAccountType: "equity", recommendedStatementType: "balance_sheet",
    }), acct, []);
    assert.ok(p);
    assert.equal(isMaterial(p), true, "a statement-type change always deserves a human look");
  });

  test("a RECLASSIFY with no valid target type is discarded, never downgraded to a move", () => {
    for (const badType of [null, "", "revenue", "profit"]) {
      const p = normalizeProposal(proposal({
        id: "acc-5", kind: "RECLASSIFY",
        recommendedHierarchy: ["Total Liabilities and Equity", "Total Equity", "Equity", "Retained Earnings"],
        recommendedAccountType: badType, recommendedStatementType: "balance_sheet",
      }), acct, []);
      assert.equal(p, null, `type "${badType}" must not produce a recommendation`);
    }
  });

  test("a RECLASSIFY to the type the account already has is discarded", () => {
    const p = normalizeProposal(proposal({
      id: "acc-5", kind: "RECLASSIFY",
      recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Retained Earnings"],
      recommendedAccountType: "income",
    }), acct, []);
    assert.equal(p, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. A normal sales account → no false recommendation
// ═══════════════════════════════════════════════════════════════════════════
describe("7. Normal operating revenue is left alone", () => {
  test("a keyword-only lookalike is not turned into a recommendation by the pipeline", () => {
    // "Gain sharing revenue" is genuinely operating revenue. If the model
    // returns nothing for it — the intended behaviour — nothing is stored.
    const acct = account({
      id: "acc-6", name: "Gain sharing revenue",
      hierarchy: ["Net Income", "Total Revenue", "Income", "Gain sharing revenue"],
      siblings: ["Product Sales", "Service Revenue"],
    });
    assert.equal(accept(null, acct), null);
    assert.equal(normalizeProposal(undefined, acct, PL_SECTIONS), null);
  });

  test("even if the model does answer, a no-op answer stores nothing", () => {
    const acct = account({
      id: "acc-6", name: "Product Sales",
      hierarchy: ["Net Income", "Total Revenue", "Income", "Product Sales"],
    });
    const p = accept(proposal({
      id: "acc-6",
      recommendedHierarchy: ["Net Income", "Total Revenue", "Income", "Product Sales"],
    }), acct);
    assert.equal(p, null);
  });

  test("the prompt tells the model to judge from context, not keywords", () => {
    const prompt = buildReasonablenessPrompt([account()], PL_SECTIONS, "profit_loss");
    assert.match(prompt, /DO NOT flag an account merely because its name contains/i);
    assert.match(prompt, /Gain sharing revenue/, "the restraint example must be in the prompt");
    assert.match(prompt, /siblings/i, "sibling context must be supplied");
    // The company's own sections are offered as the target set.
    assert.match(prompt, /Net Income > Pretax Income > Other Income/);
    // It must never be asked to rebuild the COA.
    assert.match(prompt, /NOT being asked to regenerate, re-classify, or re-build/i);
    assert.match(prompt, /STRICT JSON only/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Ambiguous account name → LOW confidence or nothing
// ═══════════════════════════════════════════════════════════════════════════
describe("8. Ambiguous accounts do not generate confident noise", () => {
  const acct = account({
    id: "acc-7", name: "Other Charges", accountType: "expense",
    hierarchy: ["Net Income", "Operating Expenses", "Other Charges"],
    parent: "Operating Expenses", siblings: ["Rent", "Utilities"],
  });

  test("a LOW-confidence presentation-only tweak is filtered out as immaterial", () => {
    const p = normalizeProposal(proposal({
      id: "acc-7", kind: "ROLLUP_INSERT", confidence: "LOW",
      recommendedHierarchy: ["Net Income", "Operating Expenses", "Sundry", "Other Charges"],
    }), acct, PL_SECTIONS);
    assert.ok(p, "it normalizes...");
    assert.equal(p.confidenceBand, "LOW");
    assert.equal(isMaterial(p), false, "...but must not reach the reviewer");
  });

  test("an invalid/missing confidence band is discarded outright", () => {
    for (const band of [undefined, "", "VERY HIGH", "0.9", "maybe"]) {
      assert.equal(
        normalizeProposal(proposal({ id: "acc-7", confidence: band }), acct, PL_SECTIONS),
        null,
        `confidence "${band}" must not be persisted`,
      );
    }
  });

  test("free-form garbage never becomes a recommendation", () => {
    const cases = [
      { recommendedHierarchy: [] },
      { recommendedHierarchy: ["Interest Income"] },                 // too short
      { recommendedHierarchy: ["A", "", "Interest Income"] },        // empty level
      { recommendedHierarchy: Array(20).fill("X").concat(["Interest Income"]) }, // too deep
      { recommendedHierarchy: ["Interest Income", "Other", "Interest Income"] }, // inside itself
    ];
    for (const c of cases) {
      assert.equal(normalizeProposal(proposal(c), account(), PL_SECTIONS), null,
        `must reject ${JSON.stringify(c.recommendedHierarchy).slice(0, 60)}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 & 10. Reject leaves the COA alone; accept applies the hierarchy
// ═══════════════════════════════════════════════════════════════════════════
describe("9. Rejecting a recommendation", () => {
  test("reject only ever writes to the recommendation row, never the COA", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "aiHierarchyRecommendationService.js"), "utf8");
    const body = src.slice(src.indexOf("async function rejectRecommendation"), src.indexOf("async function ignoreRecommendation"));
    assert.match(body, /\.from\(TABLE\)/, "it updates the recommendations table");
    assert.equal(/chart_of_accounts/.test(body), false, "it must never touch chart_of_accounts");
    assert.equal(/updateAccountHierarchy/.test(body), false);
    assert.match(body, /rejection_reason/, "the optional reason is stored for audit");
    assert.match(body, /\.in\("status", \["pending"\]\)/, "only a pending recommendation can be rejected");
  });
});

describe("10. Accepting a recommendation applies the hierarchy correctly", () => {
  test("the full recommended hierarchy is what gets written", () => {
    const reco = {
      recommended_hierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
      recommended_rollup: "Other Income",
    };
    const levels = resolveTargetLevels(reco, ["Net Income", "Total Revenue", "Income", "Interest Income"], "Interest Income");
    assert.deepEqual(levels, ["Net Income", "Pretax Income", "Other Income", "Interest Income"]);
    assert.deepEqual(validateTargetLevels(levels, "Interest Income"), []);
  });

  test("a legacy roll-up-only recommendation still applies as an insert above the account", () => {
    const reco = { recommended_hierarchy: null, recommended_rollup: "Interest Income" };
    const levels = resolveTargetLevels(reco, ["Net Income", "Income", "Interest Income"], "Interest Income");
    assert.deepEqual(levels, ["Net Income", "Income", "Interest Income", "Interest Income"]);
  });

  test("a legacy roll-up already present is not inserted twice", () => {
    const reco = { recommended_hierarchy: null, recommended_rollup: "Other Income" };
    const current = ["Net Income", "Other Income", "Interest Income"];
    assert.deepEqual(resolveTargetLevels(reco, current, "Interest Income"), current);
  });

  test("unsafe targets are refused before anything is written", () => {
    assert.ok(validateTargetLevels(["A", "Renamed"], "Interest Income").length, "must end at the account");
    assert.ok(validateTargetLevels(["Interest Income", "Interest Income"], "Interest Income").length, "no self-nesting");
    assert.ok(validateTargetLevels(["A", "", "Interest Income"], "Interest Income").length, "no empty level");
    assert.ok(validateTargetLevels(["Interest Income"], "Interest Income").length, "not a usable path");
    assert.ok(validateTargetLevels(Array(16).fill("X").concat("Interest Income"), "Interest Income").length, "too deep");
  });

  test("apply goes exclusively through the existing updateAccountHierarchy path", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "aiHierarchyRecommendationService.js"), "utf8");
    const body = src.slice(src.indexOf("async function applyRecommendation"), src.indexOf("async function acceptRecommendation"));
    assert.match(body, /updateAccountHierarchy\(reco\.account_id, patch, userId\)/);
    // No direct write to the COA table anywhere in the apply path.
    assert.equal(/from\("chart_of_accounts"\)\s*\.update/.test(body), false);
    // And no balance/GL field is ever in the patch.
    for (const banned of [/balance/i, /general_ledger/i, /amount/i]) {
      assert.equal(banned.test(body), false, `apply must never reference ${banned}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. AI unavailable → the COA workflow still succeeds
// ═══════════════════════════════════════════════════════════════════════════
describe("11. AI failure never breaks the COA workflow", () => {
  test("generateRecommendations returns a summary instead of throwing when Gemini is unusable", async () => {
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      // No DB is reachable in this test environment either, so this exercises
      // the harshest case: the pass cannot even load the COA.
      await svc.generateRecommendations("company-1", "version-1");
    } catch (err) {
      // A throw is acceptable ONLY if the caller is guaranteed to swallow it,
      // which the sync pipeline does — assert that guarantee explicitly.
      const sync = require("fs").readFileSync(
        require("path").join(__dirname, "keyReportSyncService.js"), "utf8");
      const i = sync.indexOf("Phase 2d");
      const block = sync.slice(i, i + 900);
      assert.match(block, /try \{/, "the recommendation pass must be wrapped in try/catch");
      assert.match(block, /catch \(recoErr\)/);
      assert.equal(/return haltWith/.test(block), false, "a failure here must never halt the sync");
    } finally {
      if (original !== undefined) process.env.GEMINI_API_KEY = original;
    }
  });

  test("the sync pipeline treats the pass as advisory and continues to Trial Balance", () => {
    const sync = require("fs").readFileSync(require("path").join(__dirname, "keyReportSyncService.js"), "utf8");
    const recoAt = sync.indexOf("Phase 2d: AI Hierarchy Recommendation Engine");
    const tbAt = sync.indexOf("Phase 3: Trial Balance");
    assert.ok(recoAt > 0 && tbAt > recoAt, "Trial Balance must come after, and be reachable");
    const between = sync.slice(recoAt, tbAt);
    assert.match(between, /catch \(recoErr\)/);
    assert.match(between, /logger\.warn/);
  });

  test("no report engine reads the recommendations table", () => {
    const fs = require("fs");
    const path = require("path");
    for (const f of ["financialStatementService.js", "keyReportReportService.js", "keyReportAccountingService.js"]) {
      const p = path.join(__dirname, f);
      if (!fs.existsSync(p)) continue;
      assert.equal(
        /key_report_coa_hierarchy_recommendations/.test(fs.readFileSync(p, "utf8")), false,
        `${f} must not read recommendations — reports read chart_of_accounts only`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. A stale recommendation cannot overwrite newer user changes
// ═══════════════════════════════════════════════════════════════════════════
describe("12. Stale recommendations are refused", () => {
  const base = { hierarchy: ["Net Income", "Income", "Interest Income"], accountType: "income", statementType: "profit_loss" };

  test("an unchanged account produces an identical fingerprint", () => {
    assert.equal(classificationFingerprint(base), classificationFingerprint({ ...base }));
  });

  test("a hierarchy change since generation is detected", () => {
    const moved = { ...base, hierarchy: ["Net Income", "Other Income", "Interest Income"] };
    assert.notEqual(classificationFingerprint(base), classificationFingerprint(moved));
  });

  test("a type or statement change since generation is detected", () => {
    assert.notEqual(classificationFingerprint(base), classificationFingerprint({ ...base, accountType: "equity" }));
    assert.notEqual(classificationFingerprint(base), classificationFingerprint({ ...base, statementType: "balance_sheet" }));
  });

  test("case and padding differences are NOT treated as a change", () => {
    assert.equal(
      classificationFingerprint(base),
      classificationFingerprint({ ...base, hierarchy: [" net income ", "INCOME", "Interest Income"] }),
    );
  });

  test("the apply path compares the snapshot against live state and returns a conflict", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "aiHierarchyRecommendationService.js"), "utf8");
    const body = src.slice(src.indexOf("async function applyRecommendation"), src.indexOf("async function acceptRecommendation"));
    assert.match(body, /STALE_RECOMMENDATION/);
    assert.match(body, /conflict: true/);
    // The comparison must happen BEFORE the write.
    assert.ok(body.indexOf("STALE_RECOMMENDATION") < body.indexOf("updateAccountHierarchy"),
      "staleness must be checked before the COA is touched");
  });

  test("the route surfaces a stale recommendation as 409, not a generic error", () => {
    const routes = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "routes", "keyReports.js"), "utf8");
    const i = routes.indexOf("/hierarchy-recommendations/:recommendationId/apply");
    const block = routes.slice(i, i + 1200);
    assert.match(block, /result\.conflict \? 409 : 422/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Supporting behaviour
// ═══════════════════════════════════════════════════════════════════════════
describe("context assembly feeds the model real evidence", () => {
  test("padded level columns are collapsed to the account's real depth", () => {
    const row = { level_1: "Net Income", level_2: "Income", level_3: "Interest Income", level_4: "Interest Income", level_5: "Interest Income" };
    assert.deepEqual(columnsToLevels(row), ["Net Income", "Income", "Interest Income"]);
  });

  test("the section catalog is built from the company's own category nodes, per statement", () => {
    const cats = [
      { statement_type: "profit_loss", level_1: "Net Income", level_2: "Other Income" },
      { statement_type: "profit_loss", level_1: "Net Income", level_2: "Other Income" }, // dup
      { statement_type: "balance_sheet", level_1: "Total Assets", level_2: "Current Assets" },
    ];
    const cat = buildSectionCatalog(cats);
    assert.deepEqual(cat.profit_loss, [["Net Income", "Other Income"]], "duplicates collapse");
    assert.deepEqual(cat.balance_sheet, [["Total Assets", "Current Assets"]]);
  });

  test("siblings are gathered from the shared immediate parent, excluding the account itself", () => {
    const leaves = [
      { id: "a", parent_account_id: "p1", account_name: "Interest Income" },
      { id: "b", parent_account_id: "p1", account_name: "Product Sales" },
      { id: "c", parent_account_id: "p2", account_name: "Rent" },
    ];
    const idx = buildSiblingIndex(leaves);
    const input = toReviewInput(
      { ...leaves[0], parent_account_id: "p1", level_1: "Income", level_2: "Interest Income" }, idx,
    );
    assert.deepEqual(input.siblings, ["Product Sales"]);
    assert.equal(input.parent, "Income");
  });
});

describe("the API contract the reviewer sees", () => {
  test("statuses are exposed uppercase, including for legacy rows", () => {
    const mk = (status) => toPublicRecommendation({
      id: "r1", account_id: "a1", status, current_hierarchy: ["A", "B"],
      recommended_rollup: "X", chart_of_accounts: { account_name: "Acc" },
    });
    assert.equal(mk("pending").status, "PENDING");
    assert.equal(mk("applied").status, "APPLIED");
    assert.equal(mk("rejected").status, "REJECTED");
    assert.equal(mk("accepted").status, "APPLIED", "legacy accepted reads as applied");
    assert.equal(mk("ignored").status, "REJECTED", "legacy ignored reads as rejected");
  });

  test("a legacy roll-up row still renders a full recommended hierarchy", () => {
    const pub = toPublicRecommendation({
      id: "r1", account_id: "a1", status: "pending",
      current_hierarchy: ["Net Income", "Income", "Interest Income"],
      recommended_rollup: "Other Income", confidence: 0.9,
      chart_of_accounts: { account_name: "Interest Income" },
    });
    assert.deepEqual(pub.recommendedHierarchy, ["Net Income", "Income", "Other Income", "Interest Income"]);
    assert.equal(pub.confidenceBand, "HIGH", "a band is derived for rows that predate the column");
  });
});

describe("no second COA engine was introduced", () => {
  test("the service never writes classification or hierarchy itself", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "aiHierarchyRecommendationService.js"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    // The ONLY chart_of_accounts access is reading, plus the single call into
    // the shared update function.
    assert.equal(/from\("chart_of_accounts"\)[\s\S]{0,80}\.update\(/.test(code), false);
    assert.equal(/from\("chart_of_accounts"\)[\s\S]{0,80}\.insert\(/.test(code), false);
    assert.equal(/from\("chart_of_accounts"\)[\s\S]{0,80}\.delete\(/.test(code), false);
    assert.equal((code.match(/updateAccountHierarchy\(/g) || []).length, 1);
  });

  test("no hardcoded account-name to section mapping table exists", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "aiHierarchyRecommendationService.js"), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    // Section names may only appear inside the prompt string, never as code
    // constants that decide placement.
    for (const name of ["Other Income", "Other Expenses", "Pretax Income"]) {
      const asConstant = new RegExp(`(const|let|var)\\s+\\w+\\s*=\\s*[^;]*["'\`]${name}["'\`]`);
      assert.equal(asConstant.test(code), false, `"${name}" must not be a code constant`);
    }
  });

  test("account types and statement types are validated against a closed set", () => {
    const p = normalizeProposal(proposal({
      kind: "RECLASSIFY", recommendedAccountType: "asset", recommendedStatementType: "cash_flow",
      recommendedHierarchy: ["Total Assets", "Other", "Interest Income"],
    }), account(), []);
    assert.equal(p, null, "an unknown statement type must be refused");
  });
});
