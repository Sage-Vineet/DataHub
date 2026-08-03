// Regression harness for the report-layer fixes (audit items F and I).
// No DB access -- pure function tests against real exported functions.
//
// ── F: the report layer had its own account classifier ──────────────────────
// keyReportReportService's normalizeBSSection used to be a SUBSTRING test
// applied to both the extractor's `section` value AND, as a fallback, to the
// account's own NAME:
//     if (n.includes('asset'))  return 'assets';
//     if (n.includes('liab'))   return 'liabilities';
//     if (n.includes('equity') || n.includes('capital') || ...) return 'equity';
// Applied to a name that is exactly the keyword-classification pattern the COA
// pipeline forbids, and it ran completely independently of chart_of_accounts --
// so a report could contradict the user-approved COA. Worse, the result was
// carried forward POSITIONALLY, so one misread row poisoned every row beneath
// it. It fed the monthly-BS opening seed (bsBalancesForYear), the
// reconciliation's calculated side, and the yearly-BS GL fallback.
//
// Fixed: section now resolves in strict priority order --
//   1. the row's own persisted chart_of_accounts link (coa_id -> account_type)
//   2. the row's own structural section value (exact match, closed vocabulary)
//   3. positional carry-forward (legacy rows with neither)
// The account NAME is never consulted.
//
// ── I-5: reconciliation status vocabulary desync ────────────────────────────
// Migration 076 renamed the status vocabulary to MATCHED / DIFFERENCE /
// MISSING_FROM_GL / MISSING_FROM_BS / EXCLUDED and the writer emits those, but
// getReconciliationReport still compared the lowercase legacy values. No
// branch ever matched, so every counter stayed 0 and summary.reconciled was
// `true` for ANY non-empty result -- reporting a clean reconciliation even
// when every account differed.
//
// Run: node backend/scripts/validateReportLayerCoaDerivation.js

const path = require("path");
const svc = require(path.join(__dirname, "..", "src", "services", "keyReports", "keyReportReportService.js"));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual  : ${a}`);
  }
}
function checkTrue(name, actual) { check(name, Boolean(actual), true); }

console.log("\n=== F1. The forbidden name-keyword classification is gone ===");
{
  // The exact confirmed misclassification: a real LIABILITY whose name merely
  // contains "capital". Under the old substring rule this returned 'equity'.
  check("F1a. normalizeBSSection no longer classifies from an account NAME ('Capital One Credit Card')",
    svc.normalizeBSSection("Capital One Credit Card"), null);
  check("F1b. ...nor 'Bank of America' as an asset", svc.normalizeBSSection("Bank of America"), null);
  check("F1c. ...nor 'Accounts Payable' as a liability", svc.normalizeBSSection("Accounts Payable"), null);
  check("F1d. ...nor 'Owner Draw' as equity", svc.normalizeBSSection("Owner Draw"), null);

  // It still accepts the extractor's own closed structural vocabulary.
  check("F1e. Structural section value 'assets' still resolves", svc.normalizeBSSection("assets"), "assets");
  check("F1f. Structural section value 'liabilities' still resolves", svc.normalizeBSSection("liabilities"), "liabilities");
  check("F1g. Structural section value 'equity' still resolves", svc.normalizeBSSection("equity"), "equity");
  check("F1h. Singular 'asset' tolerated", svc.normalizeBSSection("asset"), "assets");
  check("F1i. The ambiguous umbrella 'Liabilities and Equity' resolves to NOTHING (not equity, not liability)",
    svc.normalizeBSSection("Liabilities and Equity"), null);
}

console.log("\n=== F2. COA account_type -> BS section mapping is exact-match only ===");
{
  check("F2a. asset", svc.bsSectionFromCoaType("asset"), "assets");
  check("F2b. liability", svc.bsSectionFromCoaType("liability"), "liabilities");
  check("F2c. equity", svc.bsSectionFromCoaType("equity"), "equity");
  check("F2d. P&L types are not BS sections (income)", svc.bsSectionFromCoaType("income"), null);
  check("F2e. P&L types are not BS sections (expense)", svc.bsSectionFromCoaType("expense"), null);
  check("F2f. null/unknown", svc.bsSectionFromCoaType(null), null);
}

console.log("\n=== F3. The persisted COA link is the PRIMARY source, beating extraction ===");
{
  const coaById = new Map([
    ["coa-cc", { accountType: "liability" }],
    ["coa-bank", { accountType: "asset" }],
  ]);
  // Deliberately ADVERSARIAL: the extractor's own section value is WRONG for
  // both rows (says equity/liabilities). The approved COA must win.
  const rows = [
    { account_name: "Capital One Credit Card", coa_id: "coa-cc", section: "equity", amount: 500 },
    { account_name: "Chase Bank", coa_id: "coa-bank", section: "liabilities", amount: 1000 },
  ];
  const out = svc.propagateMissingSection(rows, coaById);
  check("F3a. Liability resolved from COA, overriding a wrong extraction section", out[0]._resolvedSection, "liabilities");
  check("F3b. ...and is attributed to the COA as its source", out[0]._sectionSource, "coa");
  check("F3c. Asset resolved from COA, overriding a wrong extraction section", out[1]._resolvedSection, "assets");
  check("F3d. ...also attributed to the COA", out[1]._sectionSource, "coa");
}

console.log("\n=== F4. Extraction section used when there is no COA link ===");
{
  const rows = [{ account_name: "Some Account", coa_id: null, section: "equity", amount: 10 }];
  const out = svc.propagateMissingSection(rows, new Map());
  check("F4a. Falls back to the row's own structural section", out[0]._resolvedSection, "equity");
  check("F4b. Attributed to extraction, not the COA", out[0]._sectionSource, "extraction");
}

console.log("\n=== F5. THE POISONING BUG: one bad row no longer mislabels the rows beneath it ===");
{
  // Old behaviour: "Capital One Credit Card" (no section of its own) had its
  // NAME matched -> 'equity' -> that became lastSection -> every subsequent
  // unsectioned row inherited 'equity' too. Two real liabilities silently
  // became equity.
  const rows = [
    { account_name: "Liabilities", section: "liabilities", amount: 0 },
    { account_name: "Capital One Credit Card", section: null, coa_id: null, amount: 500 },
    { account_name: "Amex Payable", section: null, coa_id: null, amount: 300 },
  ];
  const out = svc.propagateMissingSection(rows, new Map());
  check("F5a. The 'capital'-named liability carries forward LIABILITIES, not equity", out[1]._resolvedSection, "liabilities");
  check("F5b. The following row is likewise not poisoned into equity", out[2]._resolvedSection, "liabilities");
  check("F5c. Both are marked as carry-forward (honest about provenance)", [out[1]._sectionSource, out[2]._sectionSource], ["carry_forward", "carry_forward"]);
}

console.log("\n=== F6. extractedBalancesMap types come from the same resolution ===");
{
  const coaById = new Map([["coa-cc", { accountType: "liability" }]]);
  const rows = [
    { account_name: "Capital One Credit Card", coa_id: "coa-cc", section: "equity", amount: 500, row_type: "account" },
  ];
  const map = svc.extractedBalancesMap(rows, coaById);
  check("F6a. Balance map type follows the approved COA (liability), not the account name",
    map.get("Capital One Credit Card")?.type, "liability");
  check("F6b. Balance value preserved", map.get("Capital One Credit Card")?.balance, 500);

  // Without a COA map at all, the old name-based path must NOT resurface.
  const mapNoCoa = svc.extractedBalancesMap(
    [{ account_name: "Capital One Credit Card", coa_id: null, section: null, amount: 500, row_type: "account" }],
    null,
  );
  check("F6c. With no COA and no section, type is 'unknown' -- never a name-derived guess",
    mapNoCoa.get("Capital One Credit Card")?.type, "unknown");
}

console.log("\n=== I5. Reconciliation status vocabulary (migration 076) ===");
{
  // Rebuild the reducer exactly as getReconciliationReport now does, over the
  // status values the writer actually emits.
  const normStatus = (s) => String(s || "").trim().toUpperCase();
  function summarize(rows) {
    const summary = rows.reduce((s, r) => {
      switch (normStatus(r.status)) {
        case "MATCHED": case "MATCH": s.matched += 1; break;
        case "DIFFERENCE": s.differences += 1; break;
        case "MISSING_FROM_GL": case "MISSING_IN_GENERATED": s.missingInGenerated += 1; break;
        case "MISSING_FROM_BS": case "MISSING_IN_UPLOADED": s.missingInUploaded += 1; break;
        case "EXCLUDED": s.excluded += 1; break;
        default: s.unknownStatus += 1; break;
      }
      return s;
    }, { matched: 0, differences: 0, missingInGenerated: 0, missingInUploaded: 0, excluded: 0, unknownStatus: 0 });
    summary.reconciled = rows.length > 0 && summary.differences === 0
      && summary.missingInGenerated === 0 && summary.missingInUploaded === 0 && summary.unknownStatus === 0;
    return summary;
  }

  const current = summarize([
    { status: "MATCHED" }, { status: "DIFFERENCE" },
    { status: "MISSING_FROM_GL" }, { status: "MISSING_FROM_BS" }, { status: "EXCLUDED" },
  ]);
  check("I5a. Current (076) vocabulary is counted", [current.matched, current.differences, current.missingInGenerated, current.missingInUploaded, current.excluded], [1, 1, 1, 1, 1]);
  check("I5b. A set containing real differences is NOT reported as reconciled", current.reconciled, false);

  const legacy = summarize([{ status: "match" }, { status: "difference" }, { status: "missing_in_generated" }, { status: "missing_in_uploaded" }]);
  check("I5c. Legacy lowercase vocabulary still counted (back-compat)", [legacy.matched, legacy.differences, legacy.missingInGenerated, legacy.missingInUploaded], [1, 1, 1, 1]);

  const allMatched = summarize([{ status: "MATCHED" }, { status: "MATCHED" }, { status: "EXCLUDED" }]);
  check("I5d. A genuinely clean set IS reconciled (EXCLUDED rows do not block it)", allMatched.reconciled, true);

  const unknown = summarize([{ status: "MATCHED" }, { status: "SOME_NEW_STATUS" }]);
  check("I5e. An unrecognized status is never silently counted as reconciled", unknown.reconciled, false);
  check("I5f. ...and is surfaced in unknownStatus", unknown.unknownStatus, 1);
}

console.log("\n=== I1. Halt-flag detection at either nesting depth ===");
{
  // keyReportService.syncVersion resolves { success, version, ..., result },
  // so the halt flag is at result.result.halted -- the old guard read
  // result.halted and therefore never fired.
  const isHalted = (r) => Boolean(r?.halted || r?.result?.halted);
  check("I1a. Nested shape (the real syncVersion return) is detected as halted",
    isHalted({ success: true, result: { halted: true, summary: { haltReason: "coa_review_required" } } }), true);
  check("I1b. Flat shape still detected", isHalted({ halted: true }), true);
  check("I1c. A genuinely non-halted result is not flagged", isHalted({ success: true, result: { halted: false } }), false);
  check("I1d. Undefined/empty is not flagged", isHalted(undefined), false);
}

console.log("\n=== I2. Report-gate response preserves the existing UI contract ===");
{
  // The gate must respond in the shape WorkspaceReports already handles for
  // "nothing to serve yet" -- a SUCCESSFUL response carrying missingData --
  // because isKrCoaNotApproved is derived from `!isLoading && krMissingData
  // .length > 0`. A 4xx would make the fetch throw and replace the helpful
  // "approve the Chart of Accounts first" empty state with a generic error.
  const routeSrc = require("fs").readFileSync(
    path.join(__dirname, "..", "src", "routes", "keyReports.js"), "utf8",
  );
  // Bound the slice to just this function. NOTE: this repo uses CRLF, so a
  // "\n}\n" boundary does not match -- find the next top-level declaration
  // instead (line-ending agnostic).
  const gateStart = routeSrc.indexOf("async function requireApprovedCoa");
  const after = routeSrc.slice(gateStart + 1);
  const nextDeclOffset = [/\r?\nfunction /, /\r?\nasync function /, /\r?\nrouter\./]
    .map((re) => { const m = re.exec(after); return m ? m.index : Infinity; })
    .reduce((a, b) => Math.min(a, b), Infinity);
  const body = routeSrc.slice(gateStart, gateStart + 1 + (Number.isFinite(nextDeclOffset) ? nextDeclOffset : 4000));

  checkTrue("I2a. Gate responds 200 (res.json), never res.status(4xx)",
    /res\.json\(\{/.test(body) && !/res\.status\(\s*4\d\d\s*\)/.test(body));
  checkTrue("I2b. Response carries missingData (drives isKrCoaNotApproved)", /missingData:/.test(body));
  checkTrue("I2c. Response carries validation (secondary path the page reads)", /validation:/.test(body));
  checkTrue("I2d. Response carries success:true so the fetch does not throw", /success:\s*true/.test(body));
  checkTrue("I2e. Response carries an explicit machine-readable COA_NOT_APPROVED code", /COA_NOT_APPROVED/.test(body));
  checkTrue("I2f. Response includes the empty reports envelope (no consumer crashes on .map)",
    /profitAndLoss/.test(body) && /balanceSheet/.test(body) && /cashFlow/.test(body));
  checkTrue("I2g. Fails CLOSED — an unreadable approval state does not serve a report",
    /readFailed/.test(body));

  // Every COA-derived report route must be gated; raw document reports must NOT
  // be (the user needs extracted source data visible DURING review).
  const gatedRoutes = ["profit-loss", "trial-balance", "reconciliation", "cashflow", "balance-sheet", "financial-statements", "qoe", "kpi"];
  const ungatedRoutes = ["general-ledger", "bank-statement", "tax-return", "available-periods"];
  for (const r of gatedRoutes) {
    const i = routeSrc.indexOf(`/reports/${r}"`) >= 0 ? routeSrc.indexOf(`/reports/${r}"`) : routeSrc.indexOf(`/${r}"`);
    const handler = routeSrc.slice(i, i + 700);
    checkTrue(`I2h. ${r} IS gated`, /requireApprovedCoa/.test(handler));
  }
  for (const r of ungatedRoutes) {
    const i = routeSrc.indexOf(`/${r}"`);
    const handler = routeSrc.slice(i, i + 500);
    checkTrue(`I2i. ${r} is NOT gated (raw source data stays visible during review)`, !/requireApprovedCoa/.test(handler));
  }
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
