import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildReasonablenessPrompt,
  buildSectionCatalog,
  buildSiblingIndex,
  classificationFingerprint,
  columnsToLevels,
  isMaterial,
  normalizeProposal,
  resolveImpact,
  resolveSource,
  resolveTargetLevels,
  toPublicRecommendation,
  toReviewInput,
  validateTargetLevels,
  type CoaRow,
  type RawProposal,
  type ReviewAccount,
} from "./coa-recommendation.js";

/**
 * The reasonableness review's decision logic — the gates that decide whether a
 * model proposal becomes a stored recommendation, and whether a stored one may
 * be applied.
 *
 * Ported from `aiReasonablenessCheck.test.js` on the `data_room` branch, whose
 * framing is worth repeating: the model itself is not called here. What matters
 * for correctness is that a plausible-but-wrong answer cannot become a
 * recommendation, and that a stale recommendation cannot overwrite a newer
 * change. Both are decided by pure functions, so both are testable exactly.
 *
 * Nothing about the section labels below is hardcoded in the implementation.
 * They are one company's own structure, and the tests use deliberately
 * non-generic wording to keep it that way.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const PL_SECTIONS = [
  ["Net Income", "Total Revenue", "Income"],
  ["Net Income", "Total Revenue", "Income", "Product Sales"],
  ["Net Income", "Operating Expenses"],
  ["Net Income", "Pretax Income", "Other Income"],
  ["Net Income", "Pretax Income", "Other Expenses"],
];

const account = (over: Partial<ReviewAccount> = {}): ReviewAccount => ({
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

/** A model answer in the exact shape the prompt demands. */
const proposal = (over: Partial<RawProposal> = {}): RawProposal => ({
  id: "acc-1",
  kind: "HIERARCHY_MOVE",
  recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
  recommendedAccountType: null,
  recommendedStatementType: null,
  confidence: "HIGH",
  reason: "Interest income is non-operating and should not sit inside operating revenue.",
  ...over,
});

describe("1. interest income sitting inside operating revenue", () => {
  it("produces a recommendation", () => {
    const p = normalizeProposal(proposal(), account(), PL_SECTIONS);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("HIERARCHY_MOVE");
    expect(p!.recommendedHierarchy).toEqual([
      "Net Income",
      "Pretax Income",
      "Other Income",
      "Interest Income",
    ]);
  });

  it("is HIGH confidence and material", () => {
    const p = normalizeProposal(proposal(), account(), PL_SECTIONS)!;
    expect(p.confidenceBand).toBe("HIGH");
    expect(p.confidence).toBe(0.95);
    expect(isMaterial(p)).toBe(true);
    // Moving out of operating revenue changes Operating Income, which is the
    // whole reason this is worth a reviewer's time.
    expect(p.impact).toBe("OPERATING_RESULT");
  });

  it("marks a target taken from the company's OWN structure as document-matched", () => {
    const p = normalizeProposal(proposal(), account(), PL_SECTIONS)!;
    expect(p.source).toBe("DOCUMENT_MATCH");
  });

  it("marks a section the company does not have as AI-derived", () => {
    const p = normalizeProposal(
      proposal({
        recommendedHierarchy: ["Net Income", "Nonoperating Items", "Interest Income"],
      }),
      account(),
      PL_SECTIONS,
    )!;
    // Being honest about which of the two it is, is what lets a reviewer trust
    // the document-matched ones without checking every path by hand.
    expect(p.source).toBe("AI_REASONABLENESS");
  });

  it("never renames the account", () => {
    const renamed = normalizeProposal(
      proposal({
        recommendedHierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Revenue"],
      }),
      account(),
      PL_SECTIONS,
    );
    expect(renamed).toBeNull();
  });
});

describe("2. interest income already under Other Income", () => {
  const placed = account({
    hierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
    parent: "Other Income",
  });

  it("discards a no-op proposal rather than storing it", () => {
    expect(normalizeProposal(proposal(), placed, PL_SECTIONS)).toBeNull();
  });

  it("still recognises a differently-cased no-op", () => {
    const p = normalizeProposal(
      proposal({
        recommendedHierarchy: ["net income", "PRETAX INCOME", "other income", "Interest Income"],
      }),
      placed,
      PL_SECTIONS,
    );
    expect(p).toBeNull();
  });
});

describe("3-5. the other presentation cases", () => {
  it("moves interest expense into the company's Other Expenses section", () => {
    const expenseAccount = account({
      id: "acc-2",
      name: "Interest Expense",
      accountType: "expense",
      hierarchy: ["Net Income", "Operating Expenses", "Interest Expense"],
      parent: "Operating Expenses",
    });
    const p = normalizeProposal(
      proposal({
        id: "acc-2",
        recommendedHierarchy: ["Net Income", "Pretax Income", "Other Expenses", "Interest Expense"],
      }),
      expenseAccount,
      PL_SECTIONS,
    )!;
    expect(p.source).toBe("DOCUMENT_MATCH");
    expect(isMaterial(p)).toBe(true);
  });

  it("moves a gain on sale of assets into Other Income", () => {
    const gain = account({
      id: "acc-3",
      name: "Gain on Sale of Assets",
      hierarchy: ["Net Income", "Total Revenue", "Income", "Gain on Sale of Assets"],
    });
    const p = normalizeProposal(
      proposal({
        id: "acc-3",
        recommendedHierarchy: [
          "Net Income",
          "Pretax Income",
          "Other Income",
          "Gain on Sale of Assets",
        ],
      }),
      gain,
      PL_SECTIONS,
    )!;
    expect(p.impact).toBe("OPERATING_RESULT");
  });

  it("moves a loss on sale of assets into Other Expenses", () => {
    const loss = account({
      id: "acc-4",
      name: "Loss on Sale of Assets",
      accountType: "expense",
      hierarchy: ["Net Income", "Operating Expenses", "Loss on Sale of Assets"],
    });
    const p = normalizeProposal(
      proposal({
        id: "acc-4",
        recommendedHierarchy: [
          "Net Income",
          "Pretax Income",
          "Other Expenses",
          "Loss on Sale of Assets",
        ],
      }),
      loss,
      PL_SECTIONS,
    )!;
    expect(p.source).toBe("DOCUMENT_MATCH");
  });
});

describe("6. retained earnings sitting in the P&L", () => {
  const re = account({
    id: "acc-5",
    name: "Retained Earnings",
    accountType: "equity",
    statementType: "profit_loss",
    hierarchy: ["Net Income", "Total Revenue", "Income", "Retained Earnings"],
  });
  const reclassify = (over: Partial<RawProposal> = {}) =>
    proposal({
      id: "acc-5",
      kind: "RECLASSIFY",
      recommendedHierarchy: ["Balance Sheet", "Equity", "Retained Earnings"],
      recommendedAccountType: "equity",
      recommendedStatementType: "balance_sheet",
      ...over,
    });

  it("produces a RECLASSIFY carrying a target type", () => {
    const p = normalizeProposal(reclassify(), account({ ...re, accountType: "income" }), PL_SECTIONS)!;
    expect(p.kind).toBe("RECLASSIFY");
    expect(p.recommendedAccountType).toBe("equity");
    expect(p.recommendedStatementType).toBe("balance_sheet");
    expect(p.impact).toBe("CLASSIFICATION");
  });

  it("treats a RECLASSIFY as material even at LOW confidence", () => {
    const p = normalizeProposal(
      reclassify({ confidence: "LOW" }),
      account({ ...re, accountType: "income" }),
      PL_SECTIONS,
    )!;
    // It changes which statement a number appears on. That always deserves a
    // human look, however unsure the model was.
    expect(isMaterial(p)).toBe(true);
  });

  it("discards a RECLASSIFY with no valid target type, never downgrading it", () => {
    // Downgrading to a HIERARCHY_MOVE would apply a P&L path to a balance-sheet
    // account — a worse outcome than dropping the proposal.
    expect(
      normalizeProposal(
        reclassify({ recommendedAccountType: null }),
        account({ ...re, accountType: "income" }),
        PL_SECTIONS,
      ),
    ).toBeNull();
    expect(
      normalizeProposal(
        reclassify({ recommendedAccountType: "nonsense" }),
        account({ ...re, accountType: "income" }),
        PL_SECTIONS,
      ),
    ).toBeNull();
  });

  it("discards a RECLASSIFY to the type the account already has", () => {
    expect(normalizeProposal(reclassify(), re, PL_SECTIONS)).toBeNull();
  });

  it("discards a RECLASSIFY with an invalid statement type", () => {
    expect(
      normalizeProposal(
        reclassify({ recommendedStatementType: "cash_flow" }),
        account({ ...re, accountType: "income" }),
        PL_SECTIONS,
      ),
    ).toBeNull();
  });
});

describe("7-8. restraint: noise never becomes a recommendation", () => {
  it("stores nothing for a no-op answer about ordinary revenue", () => {
    const ordinary = account({
      id: "acc-9",
      name: "Gain sharing revenue",
      hierarchy: ["Net Income", "Total Revenue", "Income", "Gain sharing revenue"],
    });
    // A keyword lookalike. The pipeline's protection is that a proposal which
    // does not actually move the account is discarded regardless of wording.
    expect(
      normalizeProposal(
        proposal({
          id: "acc-9",
          recommendedHierarchy: [
            "Net Income",
            "Total Revenue",
            "Income",
            "Gain sharing revenue",
          ],
        }),
        ordinary,
        PL_SECTIONS,
      ),
    ).toBeNull();
  });

  it("filters out a LOW-confidence presentation-only tweak as immaterial", () => {
    const p = normalizeProposal(
      proposal({
        confidence: "LOW",
        recommendedHierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
      }),
      account({ hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"] }),
      PL_SECTIONS,
    );
    expect(p).toBeNull(); // a no-op, discarded before materiality even applies

    const presentationOnly = normalizeProposal(
      proposal({ confidence: "LOW", kind: "ROLLUP_INSERT" }),
      account(),
      PL_SECTIONS,
    )!;
    expect(isMaterial(presentationOnly)).toBe(false);
  });

  it("keeps a MEDIUM-confidence branch move but drops a MEDIUM presentation tweak", () => {
    const moved = normalizeProposal(proposal({ confidence: "MEDIUM" }), account(), PL_SECTIONS)!;
    expect(isMaterial(moved)).toBe(true);

    const cosmetic: ReturnType<typeof normalizeProposal> = {
      ...moved,
      impact: "PRESENTATION",
      confidenceBand: "MEDIUM",
    };
    expect(isMaterial(cosmetic!)).toBe(false);
  });

  it("discards an invalid or missing confidence band outright", () => {
    for (const confidence of [undefined, null, "", "VERY HIGH", 0.95]) {
      expect(normalizeProposal(proposal({ confidence }), account(), PL_SECTIONS)).toBeNull();
    }
  });

  it("never turns free-form garbage into a recommendation", () => {
    const garbage: RawProposal[] = [
      {},
      { id: "acc-1", confidence: "HIGH" },
      { id: "acc-1", confidence: "HIGH", recommendedHierarchy: "not an array" },
      { id: "acc-1", confidence: "HIGH", recommendedHierarchy: [] },
      { id: "acc-1", confidence: "HIGH", recommendedHierarchy: ["Interest Income"] },
      { id: "acc-1", confidence: "HIGH", recommendedHierarchy: ["A", "", "Interest Income"] },
    ];
    for (const raw of garbage) {
      expect(normalizeProposal(raw, account(), PL_SECTIONS)).toBeNull();
    }
    expect(normalizeProposal(null, account(), PL_SECTIONS)).toBeNull();
    expect(normalizeProposal(proposal(), null, PL_SECTIONS)).toBeNull();
  });

  it("refuses a hierarchy that would place the account inside itself", () => {
    expect(
      normalizeProposal(
        proposal({
          recommendedHierarchy: ["Net Income", "Interest Income", "Other", "Interest Income"],
        }),
        account(),
        PL_SECTIONS,
      ),
    ).toBeNull();
  });

  it("refuses a hierarchy deeper than the level columns can hold", () => {
    const tooDeep = [...Array.from({ length: 15 }, (_, i) => `L${i}`), "Interest Income"];
    expect(
      normalizeProposal(proposal({ recommendedHierarchy: tooDeep }), account(), PL_SECTIONS),
    ).toBeNull();
  });

  it("defaults an unrecognised kind to a hierarchy move rather than dropping it", () => {
    const p = normalizeProposal(proposal({ kind: "SOMETHING_NEW" }), account(), PL_SECTIONS)!;
    expect(p.kind).toBe("HIERARCHY_MOVE");
  });
});

describe("resolveSource / resolveImpact", () => {
  it("treats a proposal with no parent path as AI-derived", () => {
    expect(resolveSource(["Interest Income"], PL_SECTIONS)).toBe("AI_REASONABLENESS");
    expect(resolveSource(null, PL_SECTIONS)).toBe("AI_REASONABLENESS");
  });

  it("matches a section case-insensitively", () => {
    expect(
      resolveSource(["NET INCOME", "pretax income", "OTHER INCOME", "X"], PL_SECTIONS),
    ).toBe("DOCUMENT_MATCH");
  });

  it("calls an unchanged parent path presentation-only", () => {
    const a = account();
    expect(resolveImpact("ROLLUP_INSERT", a, a.hierarchy)).toBe("PRESENTATION");
  });

  it("distinguishes a balance-sheet move from a P&L one", () => {
    const bs = account({ statementType: "balance_sheet" });
    expect(resolveImpact("HIERARCHY_MOVE", bs, ["Balance Sheet", "Assets", "Interest Income"])).toBe(
      "BALANCE_SHEET_SECTION",
    );
  });
});

describe("12. stale recommendations are refused", () => {
  const base = {
    hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
    accountType: "income",
    statementType: "profit_loss",
  };

  it("produces an identical fingerprint for an unchanged account", () => {
    expect(classificationFingerprint(base)).toBe(classificationFingerprint({ ...base }));
  });

  it("detects a hierarchy change since generation", () => {
    expect(classificationFingerprint(base)).not.toBe(
      classificationFingerprint({
        ...base,
        hierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
      }),
    );
  });

  it("detects a type or statement change since generation", () => {
    expect(classificationFingerprint(base)).not.toBe(
      classificationFingerprint({ ...base, accountType: "equity" }),
    );
    expect(classificationFingerprint(base)).not.toBe(
      classificationFingerprint({ ...base, statementType: "balance_sheet" }),
    );
  });

  it("does NOT treat case or padding differences as a change", () => {
    // Otherwise every recommendation would go stale the moment an unrelated
    // re-render changed the casing of a label.
    expect(classificationFingerprint(base)).toBe(
      classificationFingerprint({
        ...base,
        hierarchy: ["  net income", "TOTAL REVENUE ", "Income", "interest income"],
        accountType: "INCOME",
      }),
    );
  });
});

describe("10. applying a recommendation", () => {
  const current = ["Net Income", "Total Revenue", "Income", "Interest Income"];

  it("writes the full recommended hierarchy when one is stored", () => {
    const levels = resolveTargetLevels(
      {
        recommended_hierarchy: ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
      },
      current,
      "Interest Income",
    );
    expect(levels).toEqual([
      "Net Income",
      "Pretax Income",
      "Other Income",
      "Interest Income",
    ]);
  });

  it("applies a legacy roll-up-only row as an insert above the account", () => {
    const levels = resolveTargetLevels(
      { recommended_rollup: "Other Income" },
      current,
      "Interest Income",
    );
    expect(levels).toEqual([
      "Net Income",
      "Total Revenue",
      "Income",
      "Other Income",
      "Interest Income",
    ]);
  });

  it("does not insert a legacy roll-up that is already present", () => {
    const already = ["Net Income", "Pretax Income", "Other Income", "Interest Income"];
    expect(
      resolveTargetLevels({ recommended_rollup: "Other Income" }, already, "Interest Income"),
    ).toEqual(already);
  });

  it("refuses unsafe targets before anything is written", () => {
    expect(validateTargetLevels(["Interest Income"], "Interest Income")).toHaveLength(1);
    expect(validateTargetLevels(["A", "Something Else"], "Interest Income")[0]).toContain(
      "does not end at this account",
    );
    expect(
      validateTargetLevels(["A", "Interest Income", "Interest Income"], "Interest Income").join(" "),
    ).toContain("inside itself");
    expect(validateTargetLevels(["A", "", "Interest Income"], "Interest Income").join(" ")).toContain(
      "empty level",
    );
    expect(
      validateTargetLevels(
        [...Array.from({ length: 16 }, (_, i) => `L${i}`), "Interest Income"],
        "Interest Income",
      ).join(" "),
    ).toContain("maximum of 15");
  });

  it("accepts a well-formed target", () => {
    expect(
      validateTargetLevels(
        ["Net Income", "Pretax Income", "Other Income", "Interest Income"],
        "Interest Income",
      ),
    ).toEqual([]);
  });
});

describe("context assembly feeds the model real evidence", () => {
  const padded: CoaRow = {
    id: "acc-1",
    account_name: "Interest Income",
    account_type: "income",
    statement_type: "profit_loss",
    parent_account_id: "cat-1",
    level_1: "Net Income",
    level_2: "Total Revenue",
    level_3: "Income",
    level_4: "Interest Income",
    // The generator repeats the deepest real value across the remaining columns.
    ...Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`level_${i + 5}`, "Interest Income"]),
    ),
  };

  it("collapses padded level columns to the account's real depth", () => {
    expect(columnsToLevels(padded)).toEqual([
      "Net Income",
      "Total Revenue",
      "Income",
      "Interest Income",
    ]);
  });

  it("builds the section catalog from the company's own category nodes, per statement", () => {
    const categories: CoaRow[] = [
      { id: "c1", statement_type: "profit_loss", level_1: "Net Income", level_2: "Other Income" },
      { id: "c2", statement_type: "balance_sheet", level_1: "Balance Sheet", level_2: "Assets" },
      // A duplicate, and a row with no statement — both must be ignored.
      { id: "c3", statement_type: "profit_loss", level_1: "Net Income", level_2: "Other Income" },
      { id: "c4", statement_type: null, level_1: "Orphan" },
    ];
    const catalog = buildSectionCatalog(categories);
    expect(catalog.profit_loss).toEqual([["Net Income", "Other Income"]]);
    expect(catalog.balance_sheet).toEqual([["Balance Sheet", "Assets"]]);
  });

  it("gathers siblings from the shared parent, excluding the account itself", () => {
    const leaves: CoaRow[] = [
      padded,
      { id: "acc-2", account_name: "Product Sales", parent_account_id: "cat-1" },
      { id: "acc-3", account_name: "Elsewhere", parent_account_id: "cat-2" },
    ];
    const index = buildSiblingIndex(leaves);
    const review = toReviewInput(padded, index);
    expect(review.siblings).toEqual(["Product Sales"]);
    expect(review.parent).toBe("Income");
  });

  it("caps siblings so one enormous parent cannot dominate the prompt", () => {
    const many: CoaRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `sib-${i}`,
      account_name: `Sibling ${i}`,
      parent_account_id: "cat-1",
    }));
    const review = toReviewInput(padded, buildSiblingIndex([padded, ...many]));
    expect(review.siblings).toHaveLength(12);
  });
});

describe("the prompt", () => {
  it("tells the model to judge from context, not keywords", () => {
    const prompt = buildReasonablenessPrompt([account()], PL_SECTIONS, "profit_loss");
    expect(prompt).toContain("DO NOT flag an account merely because its name contains");
    expect(prompt).toContain("Gain sharing revenue");
    // The restraint instruction is the counterweight to the candidate list; a
    // prompt with the list and not the restraint is a keyword matcher.
    expect(prompt).toContain("prefer no recommendation");
  });

  it("offers the company's own sections and says not to invent one", () => {
    const prompt = buildReasonablenessPrompt([account()], PL_SECTIONS, "profit_loss");
    expect(prompt).toContain("Net Income > Pretax Income > Other Income");
    expect(prompt).toContain("do not invent a section when a suitable one exists");
  });

  it("says so plainly when the company has no sections to offer", () => {
    expect(buildReasonablenessPrompt([account()], [], "profit_loss")).toContain("(none available)");
  });

  it("names the right statement", () => {
    expect(buildReasonablenessPrompt([account()], [], "balance_sheet")).toContain(
      "EXISTING BALANCE SHEET SECTIONS",
    );
  });

  it("forbids renaming in the instruction the model actually reads", () => {
    expect(buildReasonablenessPrompt([account()], PL_SECTIONS, "profit_loss")).toContain(
      "you are never renaming an account",
    );
  });
});

describe("the API contract the reviewer sees", () => {
  it("exposes statuses uppercase, including legacy ones", () => {
    const pub = (status: string) =>
      toPublicRecommendation({ id: "r1", account_id: "a1", status }).status;
    expect(pub("pending")).toBe("PENDING");
    expect(pub("applied")).toBe("APPLIED");
    expect(pub("rejected")).toBe("REJECTED");
    // The original engine applied on accept, and ignored meant rejected.
    expect(pub("accepted")).toBe("APPLIED");
    expect(pub("ignored")).toBe("REJECTED");
  });

  it("renders a full recommended hierarchy for a legacy roll-up-only row", () => {
    const pub = toPublicRecommendation({
      id: "r1",
      account_id: "a1",
      current_hierarchy: ["Net Income", "Total Revenue", "Income", "Interest Income"],
      recommended_rollup: "Other Income",
      confidence: 0.9,
    });
    expect(pub.recommendedHierarchy).toEqual([
      "Net Income",
      "Total Revenue",
      "Income",
      "Other Income",
      "Interest Income",
    ]);
    // Derived from the score, because legacy rows carry no band.
    expect(pub.confidenceBand).toBe("HIGH");
  });

  it("derives a band from the score for every legacy row", () => {
    const band = (confidence: number) =>
      toPublicRecommendation({ id: "r", account_id: "a", confidence }).confidenceBand;
    expect(band(0.95)).toBe("HIGH");
    expect(band(0.75)).toBe("MEDIUM");
    expect(band(0.5)).toBe("LOW");
  });

  it("prefers the account's adjusted name, as every other screen does", () => {
    const pub = toPublicRecommendation({
      id: "r",
      account_id: "a",
      chart_of_accounts: { account_name: "raw", base_account: "base", adjusted_name: "adjusted" },
    });
    expect(pub.accountName).toBe("adjusted");
  });
});

describe("no second COA engine was introduced", () => {
  const source = readFileSync(join(HERE, "coa-recommendation.ts"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");

  it("contains no hardcoded account-name to section mapping", () => {
    // The target section must always come from the company's own structure. A
    // lookup table here would quietly become a second classification engine.
    for (const banned of [/interest\s*income["'\s]*:/i, /["']retained earnings["']\s*:/i]) {
      expect(banned.test(source)).toBe(false);
    }
  });

  it("validates account and statement types against a closed set", () => {
    expect(source).toContain('new Set(["income", "cogs", "expense", "asset", "liability", "equity"])');
    expect(source).toContain('new Set(["profit_loss", "balance_sheet"])');
  });

  it("writes nothing itself — the decision logic is pure", () => {
    // Every write goes through the service's ports. If this module ever grows
    // an import, that is the signal it has stopped being decision logic.
    expect(/\bimport\s/.test(source)).toBe(false);
  });
});
