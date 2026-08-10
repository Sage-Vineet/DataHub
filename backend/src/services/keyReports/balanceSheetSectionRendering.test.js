// Regression tests for: the Balance Sheet rendered structural COA hierarchy
// anchors as if they were calculated financial totals, so "Total Liabilities
// and Equity" and "Total Equity" each appeared several times.
//
// ROOT CAUSE (confirmed against the user's own generated export, which showed
// "Total Liabilities and Equity" on 4 separate rows and "Total Equity" on 3):
//
// Every Balance Sheet leaf's stored hierarchy_path begins with its account
// type's fixed GAAP anchor (chartOfAccountsService.fixedPrefixFor) — pure
// classification scaffolding:
//     asset      Total Assets
//     liability  Total Liabilities and Equity > Total Liabilities
//     equity     Total Liabilities and Equity > Total Equity > Equity
// buildBsStatement called buildDynamicHierarchy WITHOUT an anchor depth, so
// those anchors became real report nodes. Three defects followed:
//   1. mergeDynamicHierarchy draws each container as a header AND appends a
//      synthesized rollup child for it — an anchor already named "Total X"
//      therefore rendered "Total X" twice, back to back.
//   2. liabilities and equity are built independently but SHARE a root anchor,
//      so "Total Liabilities and Equity" rendered twice more as sibling roots.
//   3. buildBalanceSheet then appended a further standalone total on top.
//
// THE FIX mirrors what the Profit & Loss has always done (PL_ANCHOR_DEPTH):
// BS_ANCHOR_DEPTH strips each type's anchor, buildDynamicHierarchy reports the
// labels it removed, and the report re-expresses them ONCE each as a section
// header plus a single calculated total. No COA, level, classification or
// accounting logic changes — only the hierarchy→report transformation.
//
// Run: node --test backend/src/services/keyReports/balanceSheetSectionRendering.test.js

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const svc = require("./financialStatementService.js");
const { fixedPrefixFor } = require("../chartOfAccountsService");

// The frontend transform is ESM; the backend is CJS. Loading both here is the
// point — this asserts the WHOLE pipeline (COA hierarchy → buildBsStatement →
// payload → frontend tree transform → renderer row list), not either half in
// isolation, because the duplicate rows were produced jointly by the two.
const FE_PATH = path.join(__dirname, "..", "..", "..", "..", "src", "lib", "keyReportFinancials.js");
let transformKeyReportFinancials;
before(async () => {
  ({ transformKeyReportFinancials } = await import(pathToFileURL(FE_PATH).href));
});

// ── Fixture: the client's real Balance Sheet (Sage Healthy LLC, Jan 2025) ────
// Amounts are the actual figures from their uploaded statement, so the
// reconciliation assertions below are checks against a real balancing sheet
// rather than invented numbers. hierarchy_path carries the genuine anchors.
const A = "Total Assets > Total Assets";
const L = "Total Liabilities and Equity > Total Liabilities";
const E = "Total Liabilities and Equity > Total Equity > Total Equity > Equity";

function makeLeaves(spec) {
  let seq = 0;
  return spec.map(([type, hierarchyPath, amount]) => {
    const parts = hierarchyPath.split(" > ");
    seq += 1;
    return {
      id: `acc-${seq}`,
      account_name: parts[parts.length - 1],
      adjusted_name: null,
      system_id: `BS-${String(seq).padStart(3, "0")}`,
      account_number: null,
      account_type: type,
      hierarchy_path: hierarchyPath,
      level_1: parts[0],
      displayAmount: amount,
      metadata: {},
    };
  });
}

const SAGE_SPEC = [
  ["asset", `${A} > Current Assets > Bank Accounts > PNC Bank (3119) (deleted)`, 70833.06],
  ["asset", `${A} > Current Assets > Bank Accounts > TD Bank (1581)`, 22971.04],
  ["asset", `${A} > Current Assets > Bank Accounts > KeyBank`, 0],
  ["asset", `${A} > Current Assets > Accounts Receivable > Accounts Receivable (A/R)`, 234413.15],
  ["asset", `${A} > Current Assets > Other Current Assets > Accrued Revenue`, 70439.48],
  ["asset", `${A} > Current Assets > Other Current Assets > Payments to deposit`, 510],
  ["asset", `${A} > Other Assets > Investment - Sage Healthy Global`, 6173],
  ["asset", `${A} > Other Assets > Security Deposits`, 29033.19],

  ["liability", `${L} > Current Liabilities > Accounts Payable > Accounts Payable (A/P)`, 17732.11],
  ["liability", `${L} > Current Liabilities > Credit Cards > Credit Card - 8604`, 6110.43],
  ["liability", `${L} > Current Liabilities > Other Current Liabilities > Accrued Expenses`, 4950],
  ["liability", `${L} > Current Liabilities > Other Current Liabilities > American Express`, 8273.95],
  ["liability", `${L} > Long-term Liabilities > Loans - Directors`, 100],
  ["liability", `${L} > Long-term Liabilities > Loans - Marigold Partners Inc.`, 110000],
  ["liability", `${L} > Long-term Liabilities > Loans - Physicians Enterprises LLC`, 110000],

  ["equity", `${E} > Marigold Partners Inc. (55%) > Marigold Partners Inc. - Equity`, 55],
  ["equity", `${E} > Physicians Enterprises LLC (45%) > Physicians Enterprises LLC - Equity`, 45],
  ["equity", `${E} > Retained Earnings`, 159815.4],
  ["equity", `${E} > Net Income`, 17291.03],
];

function buildStatement(spec = SAGE_SPEC) {
  const leaves = makeLeaves(spec);
  return svc.buildBsStatement(leaves, new Map(leaves.map((l) => [l.id, l])));
}

function render(statement, { period = "Year" } = {}) {
  const entry = period === "Year"
    ? { year: 2025, periodLabel: "FY 2025", statement }
    : { year: 2025, monthNumber: 1, statement };
  const bucket = period === "Year" ? { yearly: [entry] } : { monthly: [entry] };
  return transformKeyReportFinancials(
    { reports: { balanceSheet: bucket } },
    { tab: "Balance Sheet", period },
  );
}

// ── Tree walkers ────────────────────────────────────────────────────────────
function walk(rows, fn, depth = 0, parent = null) {
  for (const row of rows) {
    fn(row, depth, parent);
    walk(row.children || [], fn, depth + 1, row);
  }
}
function allRows(rows) { const out = []; walk(rows, (r) => out.push(r)); return out; }
function namesOf(rows) { return allRows(rows).map((r) => r.name); }
function countName(rows, name) { return namesOf(rows).filter((n) => n === name).length; }
function leafRows(rows) {
  return allRows(rows).filter((r) => !r.children?.length && r.type !== "total" && r.type !== "header");
}
const COL = "y2025";
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

// ═══════════════════════════════════════════════════════════════════════════

describe("structural COA anchors never reach the report as rows", () => {
  test("no section hierarchy still contains a fixed GAAP anchor label", () => {
    const s = buildStatement();
    const anchors = new Set([
      ...fixedPrefixFor("asset"), ...fixedPrefixFor("liability"), ...fixedPrefixFor("equity"),
    ].map((x) => x.toLowerCase()));
    // "Equity" is the last EQUITY anchor level and is also a legitimate
    // section label, so it is asserted separately (it must appear as the
    // section header, never as a node inside the tree).
    const collect = (nodes, out = []) => {
      for (const n of nodes) { out.push(n.name); collect(n.children || [], out); }
      return out;
    };
    for (const section of ["assets", "liabilities", "equity"]) {
      for (const name of collect(s[section].hierarchy)) {
        assert.equal(anchors.has(String(name).toLowerCase()), false,
          `${section}.hierarchy still contains the structural anchor "${name}"`);
      }
    }
  });

  test("each section tree starts at the client's OWN first real category", () => {
    const s = buildStatement();
    assert.deepEqual(s.assets.hierarchy.map((n) => n.name), ["Current Assets", "Other Assets"]);
    assert.deepEqual(s.liabilities.hierarchy.map((n) => n.name), ["Current Liabilities", "Long-term Liabilities"]);
    assert.deepEqual(s.equity.hierarchy.map((n) => n.name),
      ["Marigold Partners Inc. (55%)", "Physicians Enterprises LLC (45%)", "Retained Earnings", "Net Income"]);
  });

  test("section labels are split into a header and a total that can never collide", () => {
    const s = buildStatement();
    assert.deepEqual(
      { s: s.assets.sectionLabel, t: s.assets.totalLabel },
      { s: "Assets", t: "Total Assets" },
    );
    assert.deepEqual(
      { s: s.liabilities.sectionLabel, t: s.liabilities.totalLabel },
      { s: "Liabilities", t: "Total Liabilities" },
    );
    assert.deepEqual(
      { s: s.equity.sectionLabel, t: s.equity.totalLabel },
      { s: "Equity", t: "Total Equity" },
    );
    assert.deepEqual(s.liabilitiesAndEquity,
      { sectionLabel: "Liabilities and Equity", totalLabel: "Total Liabilities and Equity" });
  });

  test("labels follow THIS company's own stored anchor wording, not a hardcoded list", () => {
    // Same structural depths, entirely different anchor wording — the report
    // must speak the client's language, which is only possible because the
    // labels come from the removed anchor labels rather than a name lookup.
    const custom = SAGE_SPEC.map(([type, p, amt]) => [
      type,
      p.replace(/Total Assets/g, "Total Resources")
        .replace(/Total Liabilities and Equity/g, "Total Obligations and Capital")
        .replace(/Total Liabilities/g, "Total Obligations")
        .replace(/Total Equity/g, "Total Capital")
        .replace(/(?<= > )Equity(?= > )/g, "Capital"),
      amt,
    ]);
    const s = buildStatement(custom);
    assert.equal(s.assets.sectionLabel, "Resources");
    assert.equal(s.assets.totalLabel, "Total Resources");
    assert.equal(s.liabilities.sectionLabel, "Obligations");
    assert.equal(s.equity.sectionLabel, "Capital");
    assert.equal(s.liabilitiesAndEquity.sectionLabel, "Obligations and Capital");
    assert.equal(s.liabilitiesAndEquity.totalLabel, "Total Obligations and Capital");
  });
});

describe("the rendered report has exactly one total per financial concept", () => {
  test("no row is ever a child with its own parent's exact name", () => {
    const { rows } = render(buildStatement());
    const offenders = [];
    walk(rows, (row, _d, parent) => { if (parent && parent.name === row.name) offenders.push(row.name); });
    assert.deepEqual(offenders, [], `self-repeating parent/child rows: ${JSON.stringify(offenders)}`);
  });

  test("no two sibling rows share a name", () => {
    const { rows } = render(buildStatement());
    const check = (siblings, where) => {
      const seen = new Set();
      for (const n of siblings) {
        assert.equal(seen.has(n.name), false, `duplicate sibling "${n.name}" under ${where}`);
        seen.add(n.name);
        check(n.children || [], n.name);
      }
    };
    check(rows, "(root)");
  });

  test("each headline total appears exactly ONCE in the whole report", () => {
    const { rows } = render(buildStatement());
    for (const label of ["Total Assets", "Total Liabilities", "Total Equity", "Total Liabilities and Equity"]) {
      assert.equal(countName(rows, label), 1, `"${label}" rendered ${countName(rows, label)} times, expected 1`);
    }
  });

  test("the report is two sections: Assets, and Liabilities and Equity", () => {
    const { rows } = render(buildStatement());
    assert.deepEqual(rows.map((r) => r.name), ["Assets", "Liabilities and Equity"]);
  });

  test("Liabilities and Equity closes with its single accounting-equation total", () => {
    const { rows } = render(buildStatement());
    const le = rows.find((r) => r.name === "Liabilities and Equity");
    assert.deepEqual(le.children.map((c) => c.name), ["Liabilities", "Equity", "Total Liabilities and Equity"]);
    assert.equal(le.children[le.children.length - 1].type, "total");
  });
});

describe("values are unchanged and nothing is double-counted", () => {
  test("A = L + E still reconciles", () => {
    const s = buildStatement();
    assert.equal(s.balanced, true);
    assert.ok(near(s.totalAssets, 434372.92), `totalAssets ${s.totalAssets}`);
    assert.ok(near(s.totalLiabilities, 257166.49), `totalLiabilities ${s.totalLiabilities}`);
    assert.ok(near(s.totalEquity, 177206.43), `totalEquity ${s.totalEquity}`);
    assert.ok(near(s.totalLiabilitiesAndEquity, s.totalLiabilities + s.totalEquity));
    assert.ok(near(s.totalAssets, s.totalLiabilitiesAndEquity));
  });

  test("the rendered Total Assets / Total Liabilities and Equity rows agree and balance", () => {
    const { rows } = render(buildStatement());
    const byName = new Map(allRows(rows).map((r) => [r.name, r]));
    assert.ok(near(byName.get("Total Assets").amounts[COL], 434372.92));
    assert.ok(near(byName.get("Total Liabilities and Equity").amounts[COL], 434372.92));
    assert.ok(near(
      byName.get("Total Liabilities").amounts[COL] + byName.get("Total Equity").amounts[COL],
      byName.get("Total Liabilities and Equity").amounts[COL],
    ));
  });

  test("every posting account survives, exactly once", () => {
    const { rows } = render(buildStatement());
    const accounts = leafRows(rows).map((r) => r.name).sort();
    const expected = SAGE_SPEC.map(([, p]) => p.split(" > ").pop()).sort();
    assert.deepEqual(accounts, expected);
    assert.equal(new Set(accounts).size, accounts.length, "an account was rendered more than once");
  });

  test("summing the leaf accounts reproduces each section total (no anchor double-count)", () => {
    const { rows } = render(buildStatement());
    const sumLeaves = (root) => leafRows([root]).reduce((t, r) => t + (r.amounts[COL] || 0), 0);
    const byName = new Map(allRows(rows).map((r) => [r.name, r]));
    assert.ok(near(sumLeaves(byName.get("Assets")), byName.get("Total Assets").amounts[COL]));
    assert.ok(near(sumLeaves(byName.get("Liabilities")), byName.get("Total Liabilities").amounts[COL]));
    assert.ok(near(sumLeaves(byName.get("Equity")), byName.get("Total Equity").amounts[COL]));
    assert.ok(near(sumLeaves(byName.get("Liabilities and Equity")), byName.get("Total Liabilities and Equity").amounts[COL]));
  });
});

describe("the hierarchy stays expandable and works in both period views", () => {
  test("section headers carry children so they remain collapsible", () => {
    const { rows } = render(buildStatement());
    for (const name of ["Assets", "Liabilities and Equity", "Liabilities", "Equity", "Current Assets", "Bank Accounts"]) {
      const row = allRows(rows).find((r) => r.name === name);
      assert.ok(row, `${name} row missing`);
      assert.ok(row.children?.length, `${name} must keep children to stay expandable`);
    }
  });

  test("a real nested category keeps its own distinctly-named subtotal", () => {
    const { rows } = render(buildStatement());
    const bank = allRows(rows).find((r) => r.name === "Bank Accounts");
    const last = bank.children[bank.children.length - 1];
    assert.equal(last.name, "Total Bank Accounts");
    assert.equal(last.type, "total");
    assert.ok(near(last.amounts[COL], 93804.1));
  });

  test("the monthly view renders the same structure", () => {
    const { rows } = render(buildStatement(), { period: "Month" });
    assert.deepEqual(rows.map((r) => r.name), ["Assets", "Liabilities and Equity"]);
    for (const label of ["Total Assets", "Total Equity", "Total Liabilities and Equity"]) {
      assert.equal(countName(rows, label), 1, `"${label}" duplicated in the monthly view`);
    }
    const offenders = [];
    walk(rows, (row, _d, parent) => { if (parent && parent.name === row.name) offenders.push(row.name); });
    assert.deepEqual(offenders, []);
  });
});
