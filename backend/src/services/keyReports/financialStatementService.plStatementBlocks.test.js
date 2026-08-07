// Regression tests for: "the frontend renders Revenue > Net Income > Net Other
// Income > Net Operating Income > Gross Profit as a hierarchy".
//
// CONFIRMED ROOT CAUSE these lock down. A QuickBooks-style Chart of Accounts
// encodes the four calculated statement rows as real category LEVELS, so every
// P&L account's hierarchy_path runs through them:
//
//   … > Net Income > Net Other Income > Net Operating Income > Gross Profit >
//       Income > Company Services > Billing & Collections
//
// Rendering that path literally made "Net Income" the grandparent of Revenue,
// with a "Total Net Income" subtotal repeated at every level (verified against a
// real export: the calculated rows appeared 3-6 times each).
//
// The fix is presentation-only and lives in two places:
//   * buildPlStatement emits `statementBlocks` — the five account blocks and the
//     four calculated rows, computed ONCE, with the calculated-row spine
//     stripped from each block's hierarchy.
//   * keyReportFinancials.buildProfitAndLoss renders those blocks in statement
//     order and emits each calculated row as a flat childless row.
//
// Nothing about COA generation, levels generation, classification or the
// hierarchy itself changes: the same chart_of_accounts rows and the same
// buildDynamicHierarchy tree are used. Every legacy statement field keeps its
// exact previous value, because QoE/EBITDA/KPI/CIM read them.
//
// Verified live against Space X version 2b00b21b: every FY2026 line matches the
// client's own exported Profit & Loss to the cent — Total Income 782,909.20,
// Total Cost of Goods Sold 549,742.69, Gross Profit 233,166.51, Total Expenses
// 163,604.74, Net Operating Income 69,561.77, Net Other Income 11,097.84,
// Net Income 80,659.61.
//
// Run: node --test backend/src/services/keyReports/financialStatementService.plStatementBlocks.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const { buildPlStatement } = require('./financialStatementService.js');

const CALC_ROWS = ['Gross Profit', 'Net Operating Income', 'Net Other Income', 'Net Income'];

// The shared anchor every P&L account carries, then the calculated-row spine.
const ANCHOR = 'Total Liabilities and Equity > Total Equity > Total Equity';
const OPERATING = `${ANCHOR} > Net Income > Net Other Income > Net Operating Income`;
const OTHER = `${ANCHOR} > Net Income > Net Other Income > Net Other Income`;

const leaf = (id, name, type, amount, hierarchy_path) =>
  ({ id, account_name: name, account_type: type, metadata: {}, displayAmount: amount, hierarchy_path });

// Mirrors the live Space X chart of accounts, trimmed to the shape that matters.
function fixtureLeaves() {
  return [
    leaf('i1', 'Billing & Collections', 'income', 1000,
      `${OPERATING} > Gross Profit > Income > Company Services > Billing & Collections`),
    leaf('i2', 'Surcharge Fees', 'income', 50,
      `${OPERATING} > Gross Profit > Income > Surcharge Fees`),
    leaf('c1', 'Offshore IT', 'cogs', 400,
      `${OPERATING} > Cost of Goods Sold > Sage Healthy Global > Offshore IT`),
    leaf('e1', 'Bank Fees', 'expense', 200,
      `${OPERATING} > Expenses > Charges > Bank Fees`),
    // Below the other-income line: no "Net Operating Income" in the path.
    leaf('oi1', 'Other income', 'income', 30, `${OTHER} > Other income`),
    leaf('oe1', 'Other Miscellaneous Expense', 'expense', 10,
      `${OTHER} > Other Expenses > Other Miscellaneous Expense`),
  ];
}

const build = (leaves) => buildPlStatement(
  leaves,
  new Map(leaves.map((l) => [l.id, { ...l, leafAmount: l.displayAmount, children: [] }])),
);

const walk = (nodes, fn, depth = 0) => {
  for (const n of nodes || []) { fn(n, depth); walk(n.children, fn, depth + 1); }
};
const allBlocks = (b) => [b.income, b.costOfSales, b.operatingExpenses, b.otherIncome, b.otherExpenses];

// ── the reported defect ──────────────────────────────────────────────────────

describe('the calculated-row spine never survives as hierarchy', () => {
  const b = build(fixtureLeaves()).statementBlocks;

  test('no calculated row is a container in any block', () => {
    const found = [];
    for (const block of allBlocks(b)) {
      walk(block.hierarchy, (n) => {
        if (n.type === 'container' && CALC_ROWS.includes(n.name)) found.push(n.name);
      });
    }
    assert.deepEqual(found, [], 'these became parents of real accounts');
  });

  test('each section heading is the document\'s own wording, not the spine', () => {
    assert.equal(b.income.label, 'Income');
    assert.equal(b.costOfSales.label, 'Cost of Goods Sold');
    assert.equal(b.operatingExpenses.label, 'Expenses');
  });

  test('the real category depth beneath each heading is preserved', () => {
    const names = [];
    walk(b.income.hierarchy, (n) => names.push(n.name));
    assert.ok(names.includes('Company Services'), 'group level must survive');
    assert.ok(names.includes('Billing & Collections'), 'account must survive');
  });

  test('a posting account named like a calculated row is a leaf and is kept', () => {
    // Only containers are stripped, so no account can ever be lost this way.
    const leaves = [...fixtureLeaves(),
      leaf('i9', 'Net Income', 'income', 7, `${OPERATING} > Gross Profit > Income > Net Income`)];
    const blocks = build(leaves).statementBlocks;
    let kept = false;
    walk(blocks.income.hierarchy, (n) => { if (n.name === 'Net Income' && n.type === 'leaf') kept = true; });
    assert.ok(kept, 'a real account must never be stripped by the presentation rule');
    assert.equal(blocks.income.total, 1057);
  });
});

// ── the operating / other split comes from the COA path ─────────────────────

describe('operating vs other is read from each account\'s own hierarchy_path', () => {
  const b = build(fixtureLeaves()).statementBlocks;

  test('accounts under Net Operating Income are operating', () => {
    assert.equal(b.income.total, 1050);
    assert.equal(b.costOfSales.total, 400);
    assert.equal(b.operatingExpenses.total, 200);
  });

  test('accounts under Net Other Income only are the other block', () => {
    assert.equal(b.otherIncome.total, 30);
    assert.equal(b.otherExpenses.total, 10);
  });

  test('a Chart of Accounts with NO calculated-row spine stays entirely operating', () => {
    // A hand-built COA that never encodes the spine must behave exactly as
    // before, with empty other blocks — never silently reclassified.
    const plain = [
      leaf('i1', 'Sales', 'income', 1000, `${ANCHOR} > Income > Sales`),
      leaf('c1', 'Materials', 'cogs', 400, `${ANCHOR} > Cost of Goods Sold > Materials`),
      leaf('e1', 'Rent', 'expense', 100, `${ANCHOR} > Expenses > Rent`),
    ];
    const blocks = build(plain).statementBlocks;
    assert.equal(blocks.income.total, 1000);
    assert.equal(blocks.otherIncome.total, 0);
    assert.equal(blocks.otherExpenses.total, 0);
    assert.equal(blocks.netOtherIncome, 0);
    assert.equal(blocks.netIncome, 500, '1000 - 400 - 100');
  });
});

// ── the four calculated rows ────────────────────────────────────────────────

describe('the calculated rows follow the standard statement formulas', () => {
  const stmt = build(fixtureLeaves());
  const b = stmt.statementBlocks;

  test('Gross Profit = Total Income - Total Cost of Goods Sold', () => {
    assert.equal(b.grossProfit, 650);
  });
  test('Net Operating Income = Gross Profit - Operating Expenses', () => {
    assert.equal(b.netOperatingIncome, 450);
  });
  test('Net Other Income = Other Income - Other Expenses', () => {
    assert.equal(b.netOtherIncome, 20);
  });
  test('Net Income = Net Operating Income + Net Other Income', () => {
    assert.equal(b.netIncome, 470);
  });

  test('regrouping never changes the bottom line', () => {
    assert.equal(b.netIncome, stmt.netIncome,
      'the blocks only regroup accounts — Net Income must be identical');
  });

  test('every account lands in exactly one block', () => {
    assert.equal(b.income.total + b.otherIncome.total, stmt.revenue.total);
    assert.equal(
      b.costOfSales.total + b.operatingExpenses.total + b.otherExpenses.total,
      stmt.costOfSales.total + stmt.operatingExpenses.total,
    );
  });
});

// ── legacy fields are untouched (QoE / EBITDA / KPI / CIM read them) ────────

describe('every pre-existing statement field keeps its exact value', () => {
  const stmt = build(fixtureLeaves());

  test('revenue/costOfSales/operatingExpenses totals are unchanged', () => {
    assert.equal(stmt.revenue.total, 1080, 'all income incl. other, as before');
    assert.equal(stmt.costOfSales.total, 400);
    assert.equal(stmt.operatingExpenses.total, 210, 'all expense incl. other, as before');
  });

  test('the legacy grossProfit still folds other income in, as before', () => {
    assert.equal(stmt.grossProfit, 680, 'revenue(1080) - cogs(400) — deliberately NOT the block figure');
    assert.notEqual(stmt.grossProfit, stmt.statementBlocks.grossProfit);
  });

  test('operatingIncome / pretaxIncome / netIncome are unchanged', () => {
    assert.equal(stmt.operatingIncome, 470);
    assert.equal(stmt.pretaxIncome, 470);
    assert.equal(stmt.netIncome, 470);
  });

  test('the flat/grouped shapes QoE and EBITDA read still exist', () => {
    assert.ok(Array.isArray(stmt.revenue.accounts));
    assert.ok(Array.isArray(stmt.costOfSales.accounts));
    assert.equal(typeof stmt.operatingExpenses.groups, 'object');
  });
});

// ── the renderer ────────────────────────────────────────────────────────────

describe('the frontend renders the blocks as a real statement', () => {
  const load = () => import(pathToFileURL(
    path.join(__dirname, '..', '..', '..', '..', 'src', 'lib', 'keyReportFinancials.js')).href);

  const response = (statement) => ({
    reports: { profitAndLoss: { yearly: [{ year: 2026, periodLabel: 'FY 2026', statement }] } },
  });
  const flatten = (rows) => {
    const out = [];
    walk(rows, (n, d) => out.push({ name: n.name, depth: d, kids: n.children?.length || 0 }));
    return out;
  };

  test('rows appear in statement order, with each calculated row once', async () => {
    const { transformKeyReportFinancials } = await load();
    const stmt = build(fixtureLeaves());
    const { rows } = transformKeyReportFinancials(response(stmt), { tab: 'Profit & Loss', period: 'Year' });
    assert.deepEqual(rows.map((r) => r.name), [
      'Income', 'Cost of Goods Sold', 'Gross Profit', 'Expenses',
      'Net Operating Income', 'Other Income', 'Other Expenses',
      'Net Other Income', 'Net Income',
    ]);
  });

  test('every calculated row is top-level and NOT expandable', async () => {
    const { transformKeyReportFinancials } = await load();
    const stmt = build(fixtureLeaves());
    const { rows } = transformKeyReportFinancials(response(stmt), { tab: 'Profit & Loss', period: 'Year' });
    for (const name of CALC_ROWS) {
      const hits = flatten(rows).filter((r) => r.name === name);
      assert.equal(hits.length, 1, `${name} must appear exactly once`);
      assert.equal(hits[0].depth, 0, `${name} must never be nested under a section`);
      assert.equal(hits[0].kids, 0, `${name} must have no children (never expandable)`);
    }
  });

  test('each section carries its own trailing subtotal', async () => {
    const { transformKeyReportFinancials } = await load();
    const stmt = build(fixtureLeaves());
    const { rows } = transformKeyReportFinancials(response(stmt), { tab: 'Profit & Loss', period: 'Year' });
    const income = rows.find((r) => r.name === 'Income');
    const last = income.children[income.children.length - 1];
    assert.equal(last.name, 'Total Income');
    assert.equal(last.type, 'total');
    assert.equal(last.amounts.y2026, 1050);
  });

  test('an empty Other block is omitted rather than shown as a zero heading', async () => {
    const { transformKeyReportFinancials } = await load();
    const plain = [
      leaf('i1', 'Sales', 'income', 1000, `${ANCHOR} > Income > Sales`),
      leaf('e1', 'Rent', 'expense', 100, `${ANCHOR} > Expenses > Rent`),
    ];
    const { rows } = transformKeyReportFinancials(response(build(plain)), { tab: 'Profit & Loss', period: 'Year' });
    const names = rows.map((r) => r.name);
    assert.equal(names.includes('Other Income'), false);
    assert.equal(names.includes('Other Expenses'), false);
    assert.ok(names.includes('Net Income'), 'the calculated rows still render');
  });

  test('a cached payload predating statementBlocks still renders', async () => {
    const { transformKeyReportFinancials } = await load();
    const stmt = build(fixtureLeaves());
    delete stmt.statementBlocks;
    const { rows } = transformKeyReportFinancials(response(stmt), { tab: 'Profit & Loss', period: 'Year' });
    assert.ok(rows.length > 0, 'an older cached response must not render an empty statement');
    assert.ok(rows.some((r) => r.name === 'Net Income'));
  });
});
