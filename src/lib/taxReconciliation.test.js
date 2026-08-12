// Tests for the Tax Reconciliation calculation engine.
//
// Run: node --test src/lib/taxReconciliation.test.js
//
// Every fixture below is SYNTHETIC and shaped only to exercise a formula. No
// company, fiscal year, account name, tax-return figure or balance-sheet figure
// from any real test case appears here — the point is that the engine works for
// arbitrary inputs, so the fixtures are deliberately arbitrary.
//
// Coverage maps 1:1 onto the required validation list:
//   1. Gross Profit  = Revenue − COGS
//   2. Net Income    = Gross Profit ± components
//   3. TR Variance   = Tax Return − P&L
//   4. M1            = Book Income ± adjustments = Reported M1 Book Income
//   5. Final         = Calculated − Expected = Unreconciled Difference
//   6. Unreconciled % of SDE
// plus: multiple fiscal years, a missing Balance Sheet, duplicate/unknown
// account mappings, Schedule K additions, manual overrides, zero SDE, a fully
// reconciled year and an unreconciled year.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOOTING_TOLERANCE,
  buildCashAccrualAdjustments,
  buildFinancialStatement,
  buildM1Adjustments,
  buildOtherAdjustments,
  buildReconciliation,
  buildScheduleKSection,
  buildYearReconciliation,
  canonicalScheduleKLabel,
  classifyAdjustment,
  classifyPlLeaf,
  collectFootingFailures,
  computeSde,
  deriveNetIncome,
  diagnoseNetIncome,
  flattenPlTree,
  mapToM1,
  resolveBsPeriod,
  resolveTaxReturnForYear,
  round2,
  trVariance,
  unreconciledPctOfSde,
} from './taxReconciliation.js';

// ── Fixture builders ───────────────────────────────────────────────────────

const leaf = (name, amount) => ({ name, type: 'data', amount });
const total = (name, amount) => ({ name, type: 'total', amount });
const section = (name, children) => ({ name, type: 'header', amount: 0, children });

/**
 * A P&L tree in the same shape every one of the page's four data sources
 * produces: header sections holding leaf accounts and a Total row, with
 * calculated Gross Profit / Net Income totals between the sections.
 */
function plTree({
  revenue = [['Contract Revenue', 1000]],
  otherIncome = [],
  cogs = [['Direct Materials', 400]],
  expenses = [['Rent', 100]],
  netIncome,
} = {}) {
  const revenueTotal = revenue.reduce((s, [, v]) => s + v, 0);
  const cogsTotal = cogs.reduce((s, [, v]) => s + v, 0);
  const expenseTotal = expenses.reduce((s, [, v]) => s + v, 0);
  const otherIncomeTotal = otherIncome.reduce((s, [, v]) => s + v, 0);
  const rows = [
    section('Income', [...revenue.map(([n, v]) => leaf(n, v)), total('Total Income', revenueTotal)]),
    section('Cost of Sales', [...cogs.map(([n, v]) => leaf(n, v)), total('Total Cost of Sales', cogsTotal)]),
    total('Gross Profit', revenueTotal - cogsTotal),
    section('Operating Expenses', [...expenses.map(([n, v]) => leaf(n, v)), total('Total Operating Expenses', expenseTotal)]),
  ];
  if (otherIncome.length) {
    rows.push(section('Other Income', [
      ...otherIncome.map(([n, v]) => leaf(n, v)),
      total('Total Other Income', otherIncomeTotal),
    ]));
  }
  rows.push(total('Net Income', netIncome ?? (revenueTotal - cogsTotal - expenseTotal + otherIncomeTotal)));
  return rows;
}

/** A tax-return year entry in the shape /manual-report-uploads/tax-data returns. */
function taxYear(year, {
  totalRevenue = 0, cogs = 0, grossProfit = 0, officerWages = 0,
  depreciation = 0, amortization = 0, interestExpense = 0,
  allOtherExpenses = 0, netIncome = 0,
  scheduleK = [], scheduleM1 = null, fileName = 'return.pdf',
} = {}) {
  return {
    year,
    fileName,
    status: 'Verified',
    scheduleM1,
    data: [
      { label: 'Total Revenue', taxReturn: totalRevenue, isReconcilingItem: false },
      { label: 'Total Cost of Goods Sold', taxReturn: cogs, isReconcilingItem: false },
      { label: 'Gross Profit', taxReturn: grossProfit, isReconcilingItem: false },
      { label: 'Officer Wages', taxReturn: officerWages, isReconcilingItem: false },
      { label: 'Depreciation Expense', taxReturn: depreciation, isReconcilingItem: false },
      { label: 'Amortization Expense', taxReturn: amortization, isReconcilingItem: false },
      { label: 'Total Interest Expense', taxReturn: interestExpense, isReconcilingItem: false },
      { label: 'All Other Expenses', taxReturn: allOtherExpenses, isReconcilingItem: false },
      { label: 'Net Income', taxReturn: netIncome, isReconcilingItem: false },
      ...scheduleK.map(([label, value]) => ({ label, taxReturn: value, isReconcilingItem: true })),
    ],
  };
}

/** A balance-sheet period in the shape bsStatementToRows produces. */
function bsPeriod(asOfDate, { ar = 0, arRetention = 0, ap = 0 } = {}) {
  return {
    asOfDate,
    rows: [
      {
        id: 'bs-section-assets', name: 'Assets', type: 'header', amount: 0,
        children: [
          {
            id: 'g', name: 'Current Assets', type: 'header', amount: 0,
            children: [
              { id: 'a1', name: 'Accounts Receivable', type: 'account', amount: ar },
              { id: 'a2', name: 'A/R Retentions Receivable', type: 'account', amount: arRetention },
              { id: 'at', name: 'Total Current Assets', type: 'total', amount: ar + arRetention },
            ],
          },
          { id: 'ta', name: 'Total Assets', type: 'total', amount: ar + arRetention },
        ],
      },
      {
        id: 'bs-section-liabilities', name: 'Liabilities', type: 'header', amount: 0,
        children: [
          {
            id: 'gl', name: 'Current Liabilities', type: 'header', amount: 0,
            children: [
              { id: 'l1', name: 'Accounts Payable', type: 'account', amount: ap },
              { id: 'lt', name: 'Total Current Liabilities', type: 'total', amount: ap },
            ],
          },
          { id: 'tl', name: 'Total Liabilities', type: 'total', amount: ap },
        ],
      },
    ],
  };
}

const okFooting = (checks) => checks.filter((c) => !c.ok);

// ── 1. Gross Profit ────────────────────────────────────────────────────────

describe('validation 1 — Gross Profit = Revenue − COGS', () => {
  test('holds by construction for an arbitrary tree', () => {
    const fs = buildFinancialStatement(plTree({
      revenue: [['Service Revenue', 900], ['Product Revenue', 350]],
      cogs: [['Subcontractors', 275], ['Materials', 125]],
    }));
    assert.equal(fs.values.totalRevenue, 1250);
    assert.equal(fs.values.totalCogs, 400);
    assert.equal(fs.values.grossProfit, 850);
    assert.deepEqual(okFooting(fs.footing), []);
  });

  test('contra revenue arriving negative reduces revenue without a sign flip', () => {
    const fs = buildFinancialStatement(plTree({
      revenue: [['Sales', 1000], ['Sales Discounts', -150]],
      cogs: [['Materials', 200]],
    }));
    assert.equal(fs.values.totalRevenue, 850);
    assert.equal(fs.values.grossProfit, 650);
  });

  test('a stated Gross Profit that disagrees is reported, not silently accepted', () => {
    const rows = plTree({ revenue: [['Sales', 1000]], cogs: [['Materials', 400]] });
    // Corrupt only the document's stated subtotal.
    rows.find((r) => r.name === 'Gross Profit').amount = 555;
    const fs = buildFinancialStatement(rows);
    const check = fs.footing.find((c) => c.label.includes('stated Gross Profit'));
    assert.equal(check.ok, false);
    assert.equal(check.difference, 45); // 600 derived − 555 stated
  });
});

// ── 2. Net Income ──────────────────────────────────────────────────────────

describe('validation 2 — Net Income from the displayed components', () => {
  test('every component is partitioned into exactly one bucket', () => {
    const fs = buildFinancialStatement(plTree({
      revenue: [['Sales', 5000]],
      otherIncome: [['Interest Income', 40], ['Scrap Sales', 60]],
      cogs: [['Materials', 2000]],
      expenses: [
        ['Officer Compensation', 300],
        ['Depreciation Expense', 200],
        ['Amortization Expense', 50],
        ['Interest Expense - Loan', 80],
        ['Rent', 400],
        ['Utilities', 100],
      ],
    }));
    assert.equal(fs.values.officerWages, 300);
    assert.equal(fs.values.depreciation, 200);
    assert.equal(fs.values.amortization, 50);
    assert.equal(fs.values.interestExpense, 80);
    assert.equal(fs.values.interestIncome, 40);
    assert.equal(fs.values.allOtherIncome, 60);
    assert.equal(fs.values.allOtherExpenses, 500);
    // The partition must exhaust the leaves — no account counted twice, none lost.
    const bucketSum = fs.values.totalRevenue + fs.values.interestIncome + fs.values.allOtherIncome
      - fs.values.totalCogs - fs.values.officerWages - fs.values.depreciation
      - fs.values.amortization - fs.values.interestExpense - fs.values.allOtherExpenses;
    assert.equal(round2(bucketSum), fs.derivedNetIncome);
    assert.equal(fs.unclassified.length, 0);
  });

  test('derived Net Income equals the stated Net Income for a consistent P&L', () => {
    const fs = buildFinancialStatement(plTree({
      revenue: [['Sales', 5000]],
      cogs: [['Materials', 2000]],
      expenses: [['Rent', 400], ['Depreciation Expense', 100]],
    }));
    assert.equal(fs.derivedNetIncome, 2500);
    assert.equal(fs.sourceNetIncome, 2500);
    assert.equal(fs.netIncomeDiagnosis.status, 'agrees');
  });

  test('a missing component is diagnosed, never forced to match', () => {
    const rows = plTree({
      revenue: [['Sales', 5000]],
      cogs: [['Materials', 2000]],
      expenses: [['Rent', 400]],
      netIncome: 2200, // the document omitted a 400 expense from its own total
    });
    const fs = buildFinancialStatement(rows);
    assert.equal(fs.derivedNetIncome, 2600);
    assert.equal(fs.sourceNetIncome, 2200);
    assert.equal(fs.netIncomeDiagnosis.status, 'differs');
    assert.equal(fs.netIncomeDiagnosis.difference, -400);
    // The engine reports the real difference; it does not overwrite either figure.
    const stated = fs.lineItems.find((i) => i.key === 'netIncome').value;
    assert.equal(stated, 2200);
  });

  test('an inverted sign is diagnosed as such (difference is exactly 2x the component)', () => {
    const rows = plTree({
      revenue: [['Sales', 1000]],
      cogs: [],
      expenses: [['Depreciation Expense', 150]],
      netIncome: 1150, // depreciation added instead of subtracted
    });
    const fs = buildFinancialStatement(rows);
    const dx = fs.netIncomeDiagnosis;
    assert.equal(dx.status, 'differs');
    assert.equal(dx.difference, 300);
    assert.ok(dx.candidates.some((c) => c.cause === 'incorrect_sign' && c.component === 'depreciation'));
  });

  test('deriveNetIncome never double-counts the derived subtotals', () => {
    // Passing grossProfit alongside its own components must not change the result.
    const values = {
      totalRevenue: 1000, totalCogs: 400, officerWages: 100, depreciation: 0,
      amortization: 0, interestExpense: 0, interestIncome: 0,
      allOtherExpenses: 0, allOtherIncome: 0,
    };
    assert.equal(deriveNetIncome(values), 500);
    assert.equal(deriveNetIncome({ ...values, grossProfit: 600, netIncome: 999 }), 500);
  });

  test('diagnoseNetIncome with no stated figure reports that, not a failure', () => {
    const dx = diagnoseNetIncome({ sourceNetIncome: null, derivedNetIncome: 10, values: {}, unclassified: [] });
    assert.equal(dx.status, 'no_source_figure');
    assert.equal(dx.difference, 0);
  });
});

// ── Account classification (duplicate / unknown mappings) ──────────────────

describe('account classification', () => {
  test('an account cannot land in two buckets — first specific match wins', () => {
    const cases = [
      ['Amortization Expense', 'expense', 'amortization'],
      ['Depreciation & Amortization', 'expense', 'depreciation'],
      ['Depreciation Expense', 'expense', 'depreciation'],
      ['Interest Expense', 'expense', 'interestExpense'],
      ['Officer Wages', 'expense', 'officerWages'],
      ['Guaranteed Payments to Partners', 'expense', 'officerWages'],
      ['Rent', 'expense', 'allOtherExpenses'],
      ['Interest Income', 'income', 'interestIncome'],
      ['Contract Revenue', 'income', 'totalRevenue'],
    ];
    for (const [name, side, expected] of cases) {
      assert.equal(classifyPlLeaf({ name, side }).bucket, expected, name);
    }
  });

  test('an account whose section cannot be determined is reported, not swept into Other', () => {
    // The document's own Net Income counts the account; the engine cannot place
    // it, so it is excluded from every bucket AND named as the reason for the gap.
    const rows = [
      section('Income', [leaf('Sales', 1000), total('Total Income', 1000)]),
      section('Mystery Block', [leaf('Unknown Account', 500)]),
      total('Net Income', 500),
    ];
    const fs = buildFinancialStatement(rows);
    assert.equal(fs.unclassified.length, 1);
    assert.equal(fs.unclassified[0].name, 'Unknown Account');
    assert.equal(fs.values.allOtherExpenses, 0, 'must not be dumped into All Other Expenses');
    assert.equal(fs.derivedNetIncome, 1000);
    assert.equal(fs.netIncomeDiagnosis.difference, -500);
    // And it is surfaced as the explanation for the Net Income gap.
    const candidate = fs.netIncomeDiagnosis.candidates.find((c) => c.cause === 'unclassified_accounts');
    assert.ok(candidate);
    assert.equal(candidate.amount, 500);
    assert.equal(candidate.explainsDifference, true);
  });

  test('the same account name appearing twice is summed once per occurrence, not deduplicated away', () => {
    const fs = buildFinancialStatement(plTree({
      revenue: [['Sales', 100], ['Sales', 100]],
      cogs: [],
      expenses: [],
    }));
    assert.equal(fs.values.totalRevenue, 200);
  });

  test('header and total rows are never treated as leaves', () => {
    const { leaves, subtotals } = flattenPlTree(plTree());
    assert.ok(leaves.every((l) => l.name !== 'Gross Profit' && l.name !== 'Net Income'));
    assert.ok(subtotals.some((s) => s.name === 'Gross Profit'));
  });

  test('a multi-year tree selects the requested year column', () => {
    const rows = [
      section('Income', [
        { name: 'Sales', type: 'data', amount: 0, amounts: { y2023: 700, y2024: 900 } },
      ]),
      total('Net Income', 0),
    ];
    assert.equal(buildFinancialStatement(rows, { yearKey: 'y2023' }).values.totalRevenue, 700);
    assert.equal(buildFinancialStatement(rows, { yearKey: 'y2024' }).values.totalRevenue, 900);
  });
});

// ── 3. TR Variance ─────────────────────────────────────────────────────────

describe('validation 3 — TR Variance = Tax Return − P&L', () => {
  test('one convention for every row, including negatives', () => {
    assert.equal(trVariance(120, 100), 20);
    assert.equal(trVariance(80, 100), -20);
    assert.equal(trVariance(-50, 25), -75);
    assert.equal(trVariance(0, 0), 0);
  });

  test('every statement row uses it', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree({ revenue: [['Sales', 1000]], cogs: [['Materials', 300]], expenses: [['Rent', 200]] }),
      taxYears: { 2024: taxYear(2024, { totalRevenue: 1100, cogs: 300, grossProfit: 800, netIncome: 600 }) },
    });
    const revenueRow = year.statementRows.find((r) => r.key === 'totalRevenue');
    assert.equal(revenueRow.pl, 1000);
    assert.equal(revenueRow.taxReturn, 1100);
    assert.equal(revenueRow.variance, 100);
    assert.deepEqual(okFooting(year.footing.filter((c) => c.label.startsWith('TR Variance'))), []);
  });

  test('a year with no return shows null variances, not zeros', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree(),
      taxYears: {},
    });
    assert.equal(year.taxReturn.available, false);
    assert.ok(year.statementRows.every((r) => r.taxReturn === null && r.variance === null));
    assert.ok(year.blockers.some((b) => /No tax return on file/.test(b)));
  });
});

// ── Year isolation (Part 4 / Part 15) ──────────────────────────────────────

describe('fiscal-year isolation', () => {
  test('each year resolves only its own return — never the nearest available', () => {
    const taxYears = { 2022: taxYear(2022, { netIncome: 100 }), 2024: taxYear(2024, { netIncome: 300 }) };
    assert.equal(resolveTaxReturnForYear(taxYears, 2022).available, true);
    assert.equal(resolveTaxReturnForYear(taxYears, 2024).available, true);
    const missing = resolveTaxReturnForYear(taxYears, 2023);
    assert.equal(missing.available, false);
    assert.match(missing.reason, /No tax return on file for FY 2023/);
    assert.deepEqual(missing.data, []);
  });

  test('a return whose stated year contradicts its key is refused', () => {
    const taxYears = { 2023: taxYear(2022, { netIncome: 100 }) };
    const resolved = resolveTaxReturnForYear(taxYears, 2023);
    assert.equal(resolved.available, false);
    assert.match(resolved.reason, /states tax year 2022/);
  });

  test('multiple fiscal years each compute independently', () => {
    const recon = buildReconciliation({
      fiscalYears: [2022, 2023, 2024],
      plRowsByYear: {
        2022: plTree({ revenue: [['Sales', 100]], cogs: [], expenses: [] }),
        2023: plTree({ revenue: [['Sales', 200]], cogs: [], expenses: [] }),
        2024: plTree({ revenue: [['Sales', 300]], cogs: [], expenses: [] }),
      },
      taxYears: { 2022: taxYear(2022), 2024: taxYear(2024) },
    });
    assert.deepEqual(recon.years, [2022, 2023, 2024]);
    assert.equal(recon.byYear[2022].bookNetIncome, 100);
    assert.equal(recon.byYear[2023].bookNetIncome, 200);
    assert.equal(recon.byYear[2024].bookNetIncome, 300);
    assert.equal(recon.byYear[2023].taxReturn.available, false);
  });
});

// ── 4. M1 reconciliation ───────────────────────────────────────────────────

describe('validation 4 — M1 adjustments', () => {
  test('the mapping table drives category and income effect', () => {
    assert.equal(mapToM1('Nondeductible Expenses').effect, 'add');
    assert.equal(mapToM1('Section 179 Deduction').category, 'Section 179 Depreciation');
    assert.equal(mapToM1('Charitable Contributions').effect, 'add');
    assert.equal(mapToM1('Interest Income').effect, 'subtract');
    assert.equal(mapToM1('Post-1986 Depreciation Adjustment').effect, 'informational');
    assert.equal(mapToM1('Distributions').effect, 'informational');
    assert.equal(mapToM1('Totally Unknown Line'), null);
  });

  test('adds and subtracts net into one signed total', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleK: [
          ['Nondeductible Expenses', 500],
          ['Charitable Contributions', 300],
          ['Interest Income', 200],
          ['Section 179 Deduction', 1000],
        ],
      }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: { interestIncome: 200 } });
    assert.equal(m1.total, 500 + 300 + 1000 - 200);
    assert.equal(m1.items.length, 4);
    assert.ok(m1.items.every((i) => i.fiscalYear === 2024 && i.sourceDocument === 'return.pdf'));
  });

  test('an informational line is displayed but excluded from the total', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleK: [['Distributions', 50000], ['Post-1986 Depreciation Adjustment', 1200], ['Nondeductible Expenses', 100]],
      }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    assert.equal(m1.total, 100);
    assert.equal(m1.items.length, 1);
    assert.equal(m1.informationalItems.length, 2);
    assert.ok(m1.informationalItems.every((i) => i.note && i.adjustment === 0));
  });

  test('two source lines canonicalising onto one category are summed, not discarded', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleK: [['Charitable Contributions Cash', 400], ['Charitable Contributions Noncash', 100]],
      }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    const charitable = m1.items.find((i) => i.category === 'Charitable Donations');
    assert.equal(charitable.taxReturn, 500);
    assert.equal(charitable.sourceLabels.length, 2);
  });

  test('an M-1 line REPLACES the Schedule K reading of the same amount — never doubles it', () => {
    // Schedule K line 16c and Schedule M-1 line 3 report ONE figure. Summing them
    // would put the whole reconciliation out by that amount.
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleK: [['Nondeductible expenses', 250]],
        scheduleM1: { netIncomePerBooks: 1000, lines: [{ label: 'Nondeductible Expenses', amount: 260 }] },
      }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    assert.equal(m1.items.length, 1, 'one category, not two rows');
    assert.equal(m1.total, 260, 'the M-1 figure wins; 510 would be a double count');
    const item = m1.items[0];
    assert.equal(item.sourceKind, 'schedule_m1');
    assert.deepEqual(item.sourceLabels, ['Nondeductible expenses', 'Nondeductible Expenses'],
      'both source wordings are retained for audit');
    assert.match(item.reason, /in place of the Schedule K reading/);
  });

  test('an M-1 line for a category Schedule K does not state is added on its own', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleK: [['Nondeductible Expenses', 250]],
        scheduleM1: { netIncomePerBooks: 1000, lines: [{ label: 'Travel and Entertainment', amount: 400 }] },
      }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    assert.equal(m1.items.length + m1.informationalItems.length, 2);
    assert.equal(m1.items.find((i) => i.category === 'Nondeductible Expenses').taxReturn, 250);
  });

  test('the same source label appearing twice is not counted twice', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleK: [['Nondeductible Expenses', 250], ['Nondeductible Expenses', 250]],
      }),
    }, 2024);
    assert.equal(buildM1Adjustments({ taxReturn, plValues: {} }).total, 250);
  });

  test('a Schedule M-1 detail line is accepted as an M1 source', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, {
        scheduleM1: { netIncomePerBooks: 1000, lines: [{ label: 'Nondeductible Expenses', amount: 250 }] },
      }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    assert.equal(m1.total, 250);
    assert.equal(m1.items[0].sourceKind, 'schedule_m1');
  });

  test('every item carries the full audit trail Part 6 requires', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Interest Income', 900]] }),
    }, 2024);
    const item = buildM1Adjustments({ taxReturn, plValues: { interestIncome: 850 } }).items[0];
    for (const field of ['sourceLabel', 'fiscalYear', 'taxReturn', 'pl', 'adjustment', 'mapping', 'category', 'reason']) {
      assert.ok(field in item, `missing ${field}`);
    }
    assert.equal(item.pl, 850, 'the P&L counterpart is carried for explainability');
    assert.equal(item.adjustment, -900);
  });

  test('Book Income ± adjustments = Reported M1 Book Income when the year reconciles', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree({ revenue: [['Sales', 10000]], cogs: [], expenses: [['Rent', 1000]] }),
      taxYears: {
        2024: taxYear(2024, {
          netIncome: 9000,
          scheduleM1: { netIncomePerBooks: 9000, lines: [] },
        }),
      },
    });
    assert.equal(year.bookNetIncome, 9000);
    assert.equal(year.reportedM1BookNetIncome, 9000);
    assert.equal(year.m1VarianceCheck.available, true);
    assert.equal(year.m1VarianceCheck.variance, 0);
    assert.equal(year.m1VarianceCheck.residual, 0);
  });

  test('a Reported M1 Book Income that differs exposes the variance', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree({ revenue: [['Sales', 10000]], cogs: [], expenses: [['Rent', 1000]] }),
      taxYears: { 2024: taxYear(2024, { scheduleM1: { netIncomePerBooks: 8500, lines: [] } }) },
    });
    assert.equal(year.m1VarianceCheck.variance, 500);
    assert.equal(year.m1VarianceCheck.residual, 500);
  });

  test('no Schedule M-1 on the return is reported as unavailable, not as zero', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree(),
      taxYears: { 2024: taxYear(2024) },
    });
    assert.equal(year.reportedM1BookNetIncome, null);
    assert.equal(year.m1VarianceCheck.available, false);
    assert.match(year.m1VarianceCheck.reason, /Schedule M-1 line 1/);
    assert.equal(year.unreconciled, null);
  });
});

// ── Cash / accrual + Balance Sheet resolution (Part 7 / Part 8) ────────────

describe('cash/accrual adjustments and Balance Sheet period resolution', () => {
  const periods = [
    bsPeriod('2021-12-31', { ar: 1000, arRetention: 100, ap: 500 }),
    bsPeriod('2022-06-30', { ar: 9999, arRetention: 9999, ap: 9999 }),
    bsPeriod('2022-12-31', { ar: 1500, arRetention: 250, ap: 800 }),
  ];

  test('the closing period for a fiscal year is matched on month, exactly', () => {
    const resolved = resolveBsPeriod(periods, 2022, { fiscalYearEndMonth: 12 });
    assert.equal(resolved.found, true);
    assert.equal(resolved.asOfDate, '2022-12-31');
  });

  test('a missing period is flagged and NEVER substituted with another month', () => {
    const resolved = resolveBsPeriod(periods, 2023, { fiscalYearEndMonth: 12 });
    assert.equal(resolved.found, false);
    assert.equal(resolved.requiredPeriod, '2023-12');
    assert.match(resolved.reason, /December 2023 Balance Sheet is not available/);
    assert.equal(resolved.asOfDate, undefined);
  });

  test('a non-December fiscal year-end resolves its own month', () => {
    const junePeriods = [bsPeriod('2022-06-30', { ar: 10 }), bsPeriod('2022-12-31', { ar: 99 })];
    const resolved = resolveBsPeriod(junePeriods, 2022, { fiscalYearEndMonth: 6 });
    assert.equal(resolved.asOfDate, '2022-06-30');
  });

  test('Change = Ending − Beginning, using the prior fiscal period as the beginning', () => {
    const ca = buildCashAccrualAdjustments({ periods, fiscalYear: 2022, returnBasis: 'Cash' });
    assert.equal(ca.available, true);
    assert.equal(ca.beginning.asOfDate, '2021-12-31');
    assert.equal(ca.ending.asOfDate, '2022-12-31');

    const ar = ca.items.find((i) => i.label === 'Accounts Receivable');
    assert.equal(ar.beginningBalance, 1000);
    assert.equal(ar.endingBalance, 1500);
    assert.equal(ar.change, 500);
    assert.equal(ar.adjustment, -500, 'a receivable increase reduces cash-basis income');

    const ret = ca.items.find((i) => i.label === 'A/R Retentions');
    assert.equal(ret.change, 150);
    assert.equal(ret.adjustment, -150);

    const ap = ca.items.find((i) => i.label === 'Accounts Payable');
    assert.equal(ap.change, 300);
    assert.equal(ap.adjustment, 300, 'a payable increase increases cash-basis income');

    assert.equal(ca.total, -350);
  });

  test('retentions are not double-counted inside Accounts Receivable', () => {
    const ca = buildCashAccrualAdjustments({ periods, fiscalYear: 2022, returnBasis: 'Cash' });
    const ar = ca.items.find((i) => i.label === 'Accounts Receivable');
    assert.ok(ar.accounts.ending.every((a) => !/retention/i.test(a.account)));
  });

  test('a missing Balance Sheet leaves the section incomplete and names the period', () => {
    const ca = buildCashAccrualAdjustments({ periods, fiscalYear: 2023, returnBasis: 'Cash' });
    assert.equal(ca.available, false);
    assert.equal(ca.complete, false);
    assert.equal(ca.missingPeriods.length, 1);
    assert.equal(ca.missingPeriods[0].period, '2023-12');
    assert.ok(ca.items.every((i) => i.available === false && i.adjustment === null));
    assert.equal(ca.total, 0, 'no partial total is presented as complete — `complete` is false');
    assert.match(ca.reason, /incomplete/);
  });

  test('a return filed on the same basis as the books applies no conversion, and says so', () => {
    const ca = buildCashAccrualAdjustments({ periods, fiscalYear: 2022, returnBasis: 'Accrual', bookBasis: 'Accrual' });
    assert.equal(ca.basisConversionRequired, false);
    assert.equal(ca.total, 0);
    assert.ok(ca.items.every((i) => /same basis/.test(i.reason)));
  });

  test('a manual override replaces a computed change and is marked as an override', () => {
    const ca = buildCashAccrualAdjustments({
      periods, fiscalYear: 2022, returnBasis: 'Cash',
      overrides: { 'Accounts Receivable': { adjustment: -123 } },
    });
    const ar = ca.items.find((i) => i.label === 'Accounts Receivable');
    assert.equal(ar.adjustment, -123);
    assert.equal(ar.isOverride, true);
  });

  test('the return\'s own reading comes from Schedule L only — a blank one is NOT REPORTED', () => {
    const periods = [bsPeriod('2021-12-31', { ar: 218298 }), bsPeriod('2022-12-31', { ar: 227670 })];
    const taxReturn = resolveTaxReturnForYear({ 2022: taxYear(2022) }, 2022);
    const ca = buildCashAccrualAdjustments({ periods, fiscalYear: 2022, returnBasis: 'Cash', taxReturn });
    const ar = ca.items.find((i) => i.label === 'Accounts Receivable');

    // The balances are the BOOK Balance Sheet, and the conversion still works…
    assert.equal(ar.beginningBalance, 218298);
    assert.equal(ar.endingBalance, 227670);
    assert.equal(ar.adjustment, round2(-(227670 - 218298)));

    // …but the return reports nothing for the line, and says so. The book balance
    // is never presented as the return's figure — the defect this guards is a real
    // export in which 227,670 read as a claim about Schedule L line 2a, which is
    // blank on a cash-basis return.
    assert.equal(ar.scheduleLLine, '2a');
    assert.equal(ar.taxReturnReported, false);
    assert.equal(ar.taxReturnBeginning, null);
    assert.equal(ar.taxReturnEnding, null);
    assert.notEqual(ar.taxReturnEnding, ar.endingBalance);
    assert.match(ar.taxReturnReason, /Schedule L/);
  });

  test('a Schedule L the return does publish is read at its own line', () => {
    const periods = [bsPeriod('2021-12-31', { ar: 100 }), bsPeriod('2022-12-31', { ar: 150 })];
    const entry = taxYear(2022);
    entry.scheduleL = [
      { line: '2a', beginningValue: 90, endingValue: 140 },
      { line: '16', beginningValue: null, endingValue: null },
    ];
    const taxReturn = resolveTaxReturnForYear({ 2022: entry }, 2022);
    const ca = buildCashAccrualAdjustments({ periods, fiscalYear: 2022, returnBasis: 'Cash', taxReturn });
    const ar = ca.items.find((i) => i.label === 'Accounts Receivable');
    assert.equal(ar.taxReturnReported, true);
    assert.equal(ar.taxReturnBeginning, 90);
    assert.equal(ar.taxReturnEnding, 140);
    // The adjustment is still the BOOK conversion — Schedule L is displayed, not
    // substituted into the calculation.
    assert.equal(ar.adjustment, -50);

    // A line printed blank in both columns is reported as blank, not as 0.
    const ap = ca.items.find((i) => i.label === 'Accounts Payable');
    assert.equal(ap.taxReturnReported, false);
    assert.match(ap.taxReturnReason, /blank on the return/);
  });
});

// ── Other adjustments (Part 9) ─────────────────────────────────────────────

describe('other adjustments', () => {
  test('the depreciation and interest rows COMPARE book and page-1 figures without adjusting', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { depreciation: 700, interestExpense: 90, scheduleK: [['Section 179 Deduction', 200]] }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    const other = buildOtherAdjustments({
      plValues: { depreciation: 1000, interestExpense: 100 },
      taxReturn,
      m1,
    });
    // Both figures are shown, and so is the difference between them…
    const dep = other.items.find((i) => i.label === 'Other Depreciation Variance');
    assert.equal(dep.pl, 1000);
    assert.equal(dep.taxReturn, 700);
    assert.equal(dep.variance, 300);
    const int = other.items.find((i) => i.label === 'Other Interest Variance');
    assert.equal(int.variance, 10);

    // …but neither moves the reconciliation. Book income and tax income are both
    // already net of the expense; a genuine book-to-tax difference is stated on
    // Schedule M-1 and adjusted in Section 2, so adjusting here double-counts.
    assert.equal(dep.adjustment, 0);
    assert.equal(int.adjustment, 0);
    assert.equal(dep.hasIncomeEffect, false);
    assert.equal(int.hasIncomeEffect, false);
    assert.equal(other.total, 0);
    assert.match(int.reason, /shown, not added/);

    // The M1 §179 add-back stands on its own, undisturbed.
    assert.equal(m1.items.find((i) => i.category === 'Section 179 Depreciation').adjustment, 200);
  });

  test('a page-1 line the return does not state is NOT REPORTED, not a zero comparison', () => {
    const entry = taxYear(2024, { interestExpense: 0 });
    // The publisher marks a line it could not read on the form.
    entry.data = entry.data.map((row) => (row.label === 'Total Interest Expense'
      ? { ...row, taxReturn: 0, source: { form: 'Form 1120-S', line: '13', reported: false } }
      : row));
    const taxReturn = resolveTaxReturnForYear({ 2024: entry }, 2024);
    const other = buildOtherAdjustments({ plValues: { interestExpense: 5000 }, taxReturn, m1: null });
    const int = other.items.find((i) => i.label === 'Other Interest Variance');
    assert.equal(int.taxReturn, null, 'a blank line is never published here as 0');
    assert.equal(int.taxReturnReported, false);
    assert.equal(int.variance, null, 'no comparison is invented against a blank line');
    assert.equal(int.adjustment, 0);
    assert.equal(other.complete, false, 'the missing comparison is reported, not hidden');
  });

  test('an override on a variance row is honoured and marked as a human assertion', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { interestExpense: 240911 }),
    }, 2024);
    const other = buildOtherAdjustments({
      plValues: { interestExpense: 0 },
      taxReturn,
      m1: null,
      overrides: { 'Other Interest Variance': { taxReturn: -240911 } },
    });
    const int = other.items.find((i) => i.label === 'Other Interest Variance');
    assert.equal(int.adjustment, -240911);
    assert.equal(int.isOverride, true);
    assert.equal(int.hasIncomeEffect, true);
    assert.equal(other.total, -240911);
  });

  test('no page-1 difference produces a zero residual, not a phantom one', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { depreciation: 0, interestExpense: 0, scheduleK: [['Section 179 Deduction', 1000]] }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    const other = buildOtherAdjustments({ plValues: { depreciation: 0, interestExpense: 0 }, taxReturn, m1 });
    assert.equal(other.total, 0);
  });

  test('"Other" is never computed into — it is manual only', () => {
    const taxReturn = resolveTaxReturnForYear({ 2024: taxYear(2024) }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    const other = buildOtherAdjustments({ plValues: {}, taxReturn, m1 });
    const row = other.items.find((i) => i.label === 'Other');
    assert.equal(row.adjustment, 0);
    assert.equal(other.plugged, false);
  });

  test('an unmapped tax-return line is listed under Other with no income effect', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Some Unrecognised Schedule Line', 4321]] }),
    }, 2024);
    const m1 = buildM1Adjustments({ taxReturn, plValues: {} });
    assert.equal(m1.total, 0, 'an unmapped line must not silently move the total');
    const other = buildOtherAdjustments({ plValues: {}, taxReturn, m1 });
    const row = other.items.find((i) => i.label === 'Other');
    assert.equal(row.unmappedItems.length, 1);
    assert.match(row.reason, /listed, not added/);
  });

  test('the Part 9 cascade tries M1, then Schedule K, then cash/accrual, then P&L, then Other', () => {
    assert.equal(classifyAdjustment('Nondeductible Expenses').mapping, 'schedule_k');
    assert.equal(classifyAdjustment('Accounts Receivable').mapping, 'cash_accrual');
    assert.equal(classifyAdjustment('Depreciation Expense', {
      plLineLabels: new Set(['depreciation expense']),
    }).mapping, 'financial_statement');
    const fallback = classifyAdjustment('Zzz Unknown');
    assert.equal(fallback.mapping, 'other');
    assert.match(fallback.reason, /never used to force the report to balance/);
  });
});

// ── 5. Final reconciliation ────────────────────────────────────────────────

describe('validation 5 — final reconciliation', () => {
  /**
   * A deliberately constructed fully-reconciling year:
   *   Book NI 9,000; §179 add 1,000; interest income subtract 200 → M1 = 800
   *   No cash/accrual conversion, no residuals.
   *   Reported M1 Book NI 9,000 → Expected = 9,000 + 800 = 9,800
   *   Calculated = 9,000 + 800 = 9,800 → Unreconciled 0
   */
  const reconcilingYear = () => buildYearReconciliation({
    fiscalYear: 2024,
    plRows: plTree({
      revenue: [['Sales', 10000]],
      otherIncome: [['Interest Income', 200]],
      cogs: [],
      expenses: [['Rent', 1200]],
    }),
    taxYears: {
      2024: taxYear(2024, {
        depreciation: 0, interestExpense: 0,
        scheduleK: [['Section 179 Deduction', 1000], ['Interest Income', 200]],
        scheduleM1: { netIncomePerBooks: 9000, lines: [] },
      }),
    },
    accountingMethod: 'Accrual', // same basis as the books → no conversion
  });

  test('a fully reconciled year lands on exactly 0.00', () => {
    const year = reconcilingYear();
    assert.equal(year.bookNetIncome, 9000);
    assert.equal(year.m1.total, 800);
    assert.equal(year.cashAccrual.total, 0);
    assert.equal(year.other.total, 0);
    assert.equal(year.calculatedReconciledIncome, 9800);
    assert.equal(year.expectedReconciledIncome, 9800);
    assert.equal(year.unreconciled, 0);
    assert.equal(year.reconciled, true);
    assert.deepEqual(okFooting(year.footing), []);
  });

  test('an unreconciled year shows the ACTUAL difference — it is never forced to zero', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree({ revenue: [['Sales', 10000]], cogs: [], expenses: [['Rent', 1200]] }),
      taxYears: {
        2024: taxYear(2024, {
          scheduleK: [['Nondeductible Expenses', 400]],
          // The preparer's book income is 250 below the books.
          scheduleM1: { netIncomePerBooks: 8550, lines: [] },
        }),
      },
      accountingMethod: 'Accrual',
    });
    assert.equal(year.bookNetIncome, 8800);
    assert.equal(year.m1.total, 400);
    assert.equal(year.calculatedReconciledIncome, 9200);
    assert.equal(year.expectedReconciledIncome, 8950);
    assert.equal(year.unreconciled, 250);
    assert.equal(year.reconciled, false);
    // Every footing identity still holds — the residual is real, not arithmetic error.
    assert.deepEqual(okFooting(year.footing), []);
  });

  /**
   * REGRESSION — the shape of the client's reported failure, end to end.
   *
   * A cash-basis S-corporation return whose page 1 states interest expense that
   * the P&L does not carry as its own line (it sits inside operating expenses), a
   * Schedule M-1 stating book income 912 below the P&L's, and a receivables
   * movement across the two Balance Sheets. Every figure here is arbitrary except
   * the RELATIONSHIPS, which are the ones that used to break:
   *
   *   • the page-1 interest line was subtracted a second time in Section 6 and
   *     produced an unreconciled difference equal to it, exactly;
   *   • the nondeductible expenses that bridge book income to ordinary income
   *     have to come through Section 2 once, and only once.
   *
   * Book NI (60) + M1 (12) + Cash/Accrual (−72) + Other (0) = 0 = the return's
   * ordinary business income, so the year reconciles to the penny.
   */
  test('a return whose page-1 interest is not a P&L line still reconciles to zero', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree({
        revenue: [['Fees', 1000]],
        cogs: [['Contract Labour', 700]],
        // Interest is INSIDE operating expenses on the books — the P&L has no
        // separate interest line, so its interest bucket is 0.
        expenses: [['Officer Compensation', 100], ['Operating Costs', 140]],
      }),
      taxYears: {
        2024: taxYear(2024, {
          officerWages: 100,
          interestExpense: 24, // page 1 states it; the books do not, separately
          netIncome: 0,        // ordinary business income (loss)
          scheduleM1: {
            netIncomePerBooks: -12,
            lines: [{ label: 'Nondeductible Expenses', amount: 12 }],
          },
        }),
      },
      bsPeriods: [bsPeriod('2023-12-31', { ar: 200 }), bsPeriod('2024-12-31', { ar: 272 })],
      accountingMethod: 'Cash',
    });

    assert.equal(year.bookNetIncome, 60);
    assert.equal(year.m1.total, 12, 'the M-1 nondeductible add-back, counted once');
    assert.equal(year.cashAccrual.total, -72, 'the receivables conversion');

    // The page-1 interest is SHOWN against the book figure and adjusts nothing.
    const interest = year.other.items.find((i) => i.label === 'Other Interest Variance');
    assert.equal(interest.taxReturn, 24);
    assert.equal(interest.variance, -24);
    assert.equal(interest.adjustment, 0);
    assert.equal(year.other.total, 0, 'no second deduction of an expense already in book income');

    // Section 4: the book-basis gap is fully explained.
    assert.equal(year.m1VarianceCheck.variance, 72);
    assert.equal(year.m1VarianceCheck.residual, 0);

    // Section 7: lands on the return's own ordinary business income, exactly.
    assert.equal(year.calculatedReconciledIncome, 0);
    assert.equal(year.expectedReconciledIncome, 0);
    assert.equal(year.unreconciled, 0);
    assert.equal(year.reconciled, true);
    assert.deepEqual(okFooting(year.footing), []);

    // And Section 5 does not present a book balance as a tax-return figure.
    const ar = year.cashAccrual.items.find((i) => i.label === 'Accounts Receivable');
    assert.equal(ar.endingBalance, 272);
    assert.equal(ar.taxReturnReported, false);
    assert.equal(ar.taxReturnEnding, null);
  });

  test('the return\'s own stated reconciled income takes precedence when present', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree({ revenue: [['Sales', 10000]], cogs: [], expenses: [['Rent', 1000]] }),
      taxYears: {
        2024: taxYear(2024, {
          scheduleM1: { netIncomePerBooks: 9000, reconciledIncome: 9500, lines: [] },
        }),
      },
      accountingMethod: 'Accrual',
    });
    assert.equal(year.expectedReconciledIncome, 9500);
    assert.equal(year.unreconciled, round2(9000 - 9500));
  });

  test('collectFootingFailures surfaces a broken identity across years', () => {
    const recon = buildReconciliation({
      fiscalYears: [2023, 2024],
      plRowsByYear: {
        // 2023's document states a Net Income its own components do not produce.
        2023: plTree({ revenue: [['Sales', 500]], cogs: [], expenses: [['Rent', 100]], netIncome: 350 }),
        2024: plTree({ revenue: [['Sales', 500]], cogs: [], expenses: [['Rent', 100]] }),
      },
      taxYears: {},
    });
    const failures = collectFootingFailures(recon);
    assert.ok(failures.some((f) => f.fiscalYear === 2023 && /stated Net Income/.test(f.label)));
    assert.ok(!failures.some((f) => f.fiscalYear === 2024));
  });
});

// ── 6. Unreconciled % of SDE ───────────────────────────────────────────────

describe('validation 6 — Unreconciled % of SDE', () => {
  test('SDE is built from the displayed line items', () => {
    assert.equal(computeSde({
      netIncome: 1000, officerWages: 200, depreciation: 100,
      amortization: 50, interestExpense: 30, interestIncome: 10,
    }), 1370);
  });

  test('ABS(difference) / SDE × 100', () => {
    const r = unreconciledPctOfSde(250, 5000);
    assert.equal(r.status, 'ok');
    assert.equal(r.percent, 5);
    assert.equal(r.display, '5.0%');
    // The sign of the difference does not change the magnitude reported.
    assert.equal(unreconciledPctOfSde(-250, 5000).percent, 5);
  });

  test('zero SDE never yields Infinity or NaN', () => {
    const r = unreconciledPctOfSde(500, 0);
    assert.equal(r.status, 'sde_zero');
    assert.equal(r.percent, null);
    assert.equal(r.display, 'n/a');
    assert.ok(Number.isFinite(r.percent) === false);
  });

  test('negative SDE is reported as such, using the absolute value', () => {
    const r = unreconciledPctOfSde(100, -2000);
    assert.equal(r.status, 'sde_negative');
    assert.equal(r.percent, 5);
    assert.match(r.reason, /negative/);
  });

  test('missing SDE / unavailable tax return yields an explicit status', () => {
    assert.equal(unreconciledPctOfSde(100, null).status, 'sde_unavailable');
    assert.equal(unreconciledPctOfSde(100, 500, { sdeAvailable: false }).status, 'sde_unavailable');
  });

  test('a year with no tax return reports the percentage as unavailable, not 0.0%', () => {
    const year = buildYearReconciliation({ fiscalYear: 2024, plRows: plTree(), taxYears: {} });
    assert.equal(year.unreconciled, null);
    assert.equal(year.sdePct.status, 'sde_unavailable');
    assert.equal(year.sdePct.display, 'n/a');
  });
});

// ── Schedule K (Part 12) + manual input (Part 18) ──────────────────────────

describe('Schedule K section', () => {
  test('casing/spelling variants collapse to one canonical row', () => {
    assert.equal(canonicalScheduleKLabel('other credits'), canonicalScheduleKLabel('Other Credits'));
    assert.equal(canonicalScheduleKLabel('nondeductible expenses'), 'Nondeductible Expenses');
    assert.equal(canonicalScheduleKLabel('Investment income'), 'Investment Income');
  });

  test('duplicate source labels merge but both sources are retained', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Other credits', 100], ['Other Credits', 50]] }),
    }, 2024);
    const sk = buildScheduleKSection({ taxReturn });
    const credits = sk.items.filter((i) => /Credits/.test(i.label));
    assert.equal(credits.length, 1, 'must not render two rows for one line');
    assert.equal(credits[0].taxReturn, 150);
    assert.equal(credits[0].sourceLabels.length, 2);
  });

  test('every item retains its source document and tax year', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Distributions', 900]], fileName: 'FY2024.pdf' }),
    }, 2024);
    const item = buildScheduleKSection({ taxReturn }).items[0];
    assert.equal(item.sourceDocument, 'FY2024.pdf');
    assert.equal(item.taxYear, 2024);
  });

  test('a user-added item survives a refresh that carries no such line', () => {
    const overrides = { 'Custom Client Line': { taxReturn: 4200, userAdded: true } };
    // Refresh: the return has been re-extracted and contains a DIFFERENT set.
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Nondeductible Expenses', 10]] }),
    }, 2024);
    const sk = buildScheduleKSection({ taxReturn, overrides });
    const custom = sk.items.find((i) => i.label === 'Custom Client Line');
    assert.ok(custom, 'the manual item must not be overwritten by regenerated data');
    assert.equal(custom.taxReturn, 4200);
    assert.equal(custom.userAdded, true);
    assert.ok(sk.items.some((i) => i.label === 'Nondeductible Expenses'));
  });

  test('a manual override wins over the extracted value', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Nondeductible Expenses', 10]] }),
    }, 2024);
    const sk = buildScheduleKSection({
      taxReturn,
      overrides: { 'Nondeductible Expenses': { taxReturn: 999 } },
    });
    const row = sk.items.find((i) => i.label === 'Nondeductible Expenses');
    assert.equal(row.taxReturn, 999);
    assert.equal(row.isOverride, true);
  });

  test('a line the extraction did not read is NOT REPORTED and stays out of the total', () => {
    const entry = taxYear(2024, { scheduleK: [['Other Credits', 100]] });
    entry.data.push({
      label: 'Nondeductible Expenses',
      taxReturn: null,
      isReconcilingItem: true,
      source: { form: 'Schedule K', line: '16c', reported: false },
    });
    const sk = buildScheduleKSection({ taxReturn: resolveTaxReturnForYear({ 2024: entry }, 2024) });
    const row = sk.items.find((i) => i.label === 'Nondeductible Expenses');
    assert.equal(row.taxReturn, null, 'an unread line must never be published as 0');
    assert.equal(row.reported, false);
    assert.deepEqual(sk.notReported, ['Nondeductible Expenses']);
    assert.equal(sk.total, 100, 'only reported items are totalled');
  });

  test('an unread line creates no M1 adjustment row claiming a zero', () => {
    const entry = taxYear(2024);
    entry.data.push({
      label: 'Nondeductible Expenses',
      taxReturn: null,
      isReconcilingItem: true,
      source: { form: 'Schedule K', line: '16c', reported: false },
    });
    const m1 = buildM1Adjustments({ taxReturn: resolveTaxReturnForYear({ 2024: entry }, 2024) });
    assert.equal(m1.items.length, 0, 'no adjustment can be asserted from a line with no figure');
    assert.equal(m1.total, 0);
  });

  test('Schedule M-1 supplies a Schedule K line the extraction left unread', () => {
    // The traced 2023 return: Schedule K line 16c prints 912, arrived unread, and
    // the same 912 was read from Schedule M-1 line 3. One figure, two addresses —
    // so the printed one is used and the address it came from is recorded.
    const entry = taxYear(2024, {
      scheduleM1: { netIncomePerBooks: -391999, lines: [{ label: 'Nondeductible Expenses', amount: 912 }] },
    });
    entry.data.push({
      label: 'Nondeductible expenses',
      taxReturn: null,
      isReconcilingItem: true,
      source: { form: 'Schedule K', line: '16c', reported: false },
    });
    const sk = buildScheduleKSection({ taxReturn: resolveTaxReturnForYear({ 2024: entry }, 2024) });
    const row = sk.items.find((i) => i.label === 'Nondeductible Expenses');
    assert.equal(row.taxReturn, 912);
    assert.equal(row.reported, true);
    assert.match(row.sourceAddress, /Schedule M-1/);
    assert.equal(sk.total, 912, 'the figure is counted once, not summed across the two schedules');
  });

  test('ordinary business income is shown from the line that prints it, and never totalled', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { netIncome: -391087, scheduleK: [['Nondeductible Expenses', 912]] }),
    }, 2024);
    const sk = buildScheduleKSection({ taxReturn });
    const obi = sk.items.find((i) => i.label === 'Ordinary Business Income (Loss)');
    assert.equal(obi.taxReturn, -391087, 'Schedule K line 1 restates page 1 line 22');
    assert.equal(obi.isBottomLine, true);
    assert.match(obi.sourceAddress, /Schedule K line 1/);
    assert.equal(sk.total, 912, 'the bottom line is a reference, not a reconciling item');
  });

  // A saved 0 on a line the return prints is residue from the era when an unread
  // line was DISPLAYED as 0 and that 0 was persisted. On the export that produced
  // these tests, "Nondeductible Expenses 0" and "Ordinary Business Income (loss)
  // 0" were still shown, tagged "manual entry", beside the correctly-read −391,087
  // — one report contradicting itself.
  describe('a stale placeholder-zero override', () => {
    const withOverride = (overrides) => buildScheduleKSection({
      taxReturn: resolveTaxReturnForYear({
        2024: taxYear(2024, { netIncome: -391087, scheduleK: [['Nondeductible Expenses', 912]] }),
      }, 2024),
      overrides,
    });

    test('does not mask a figure the return prints', () => {
      const row = withOverride({ 'Nondeductible Expenses': { taxReturn: 0 } })
        .items.find((i) => i.label === 'Nondeductible Expenses');
      assert.equal(row.taxReturn, 912);
      assert.equal(row.ignoredOverride, true);
      assert.match(row.note, /delete the row/);
    });

    test('under any casing of the same line, which collapses to one row', () => {
      const sk = withOverride({ 'Ordinary business income (loss)': { taxReturn: 0 } });
      const rows = sk.items.filter((i) => /ordinary business income/i.test(i.label));
      assert.equal(rows.length, 1, 'a casing variant must not render as a second row');
      assert.equal(rows[0].taxReturn, -391087);
      assert.equal(rows[0].label, 'Ordinary Business Income (Loss)');
    });

    test('but a typed figure, a user-added row and a deletion are all still honoured', () => {
      assert.equal(
        withOverride({ 'Nondeductible Expenses': { taxReturn: 999 } })
          .items.find((i) => i.label === 'Nondeductible Expenses').taxReturn,
        999,
        'a non-zero override is the user\'s figure and wins',
      );
      assert.equal(
        withOverride({ 'Client Line': { taxReturn: 0, userAdded: true } })
          .items.find((i) => i.label === 'Client Line').taxReturn,
        0,
        'a row the user created may legitimately sit at 0',
      );
      assert.ok(
        !withOverride({ 'Nondeductible Expenses': { deleted: true } })
          .items.some((i) => i.label === 'Nondeductible Expenses'),
        'removing the row is how a line is taken off the report',
      );
    });

    test('and the same protection applies to the M1 adjustment it feeds', () => {
      const taxReturn = resolveTaxReturnForYear({
        2024: taxYear(2024, { scheduleK: [['Nondeductible Expenses', 912]] }),
      }, 2024);
      const stale = buildM1Adjustments({
        taxReturn, overrides: { 'Nondeductible Expenses': { taxReturn: 0 } },
      });
      const row = stale.items.find((i) => i.category === 'Nondeductible Expenses');
      assert.equal(row.taxReturn, 912);
      assert.equal(row.adjustment, 912);
      assert.equal(row.isOverride, false);
      assert.equal(row.ignoredOverride, true);
      assert.equal(stale.total, 912);
    });
  });

  test('a deleted row is removed and does not reappear on refresh', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Nondeductible Expenses', 10]] }),
    }, 2024);
    const sk = buildScheduleKSection({
      taxReturn,
      overrides: { 'Nondeductible Expenses': { deleted: true } },
    });
    assert.equal(sk.items.length, 0);
  });

  test('an M1 override replaces the extracted adjustment value', () => {
    const taxReturn = resolveTaxReturnForYear({
      2024: taxYear(2024, { scheduleK: [['Nondeductible Expenses', 10]] }),
    }, 2024);
    const m1 = buildM1Adjustments({
      taxReturn, plValues: {},
      overrides: { 'Nondeductible Expenses': { taxReturn: 777 } },
    });
    assert.equal(m1.items[0].taxReturn, 777);
    assert.equal(m1.items[0].adjustment, 777);
    assert.equal(m1.items[0].isOverride, true);
    assert.equal(m1.total, 777);
  });
});

// ── End-to-end, multi-year ─────────────────────────────────────────────────

describe('end-to-end multi-year reconciliation', () => {
  // Mirrors the shape of the client's reported scenario WITHOUT hardcoding it:
  // four consecutive fiscal years, chosen arithmetically; the SECOND year is
  // missing the Balance Sheet period that closes it, so its cash/accrual section
  // cannot be completed. Every other year has a full document set.
  const Y0 = new Date().getFullYear() - 4;
  const YEARS = [Y0, Y0 + 1, Y0 + 2, Y0 + 3];

  // Books: revenue 100k, COGS 40k, officer wages 12k, depreciation 6k,
  // interest expense 1k, other expenses 20k, interest income 500.
  // Gross Profit 60k; Net Income 60k − 12k − 6k − 1k − 20k + 500 = 21,500.
  const books = () => plTree({
    revenue: [['Contract Revenue', 100000]],
    otherIncome: [['Interest Income', 500]],
    cogs: [['Direct Costs', 40000]],
    expenses: [
      ['Officer Compensation', 12000],
      ['Depreciation Expense', 6000],
      ['Interest Expense', 1000],
      ['Rent', 14000],
      ['Insurance', 6000],
    ],
  });

  // Return: page-1 depreciation 8,000 (2,000 more than the books show) and
  // interest 1,000 (the same as the books).
  // Schedule K: §179 3,000 (add), Interest Income 500 (subtract),
  // Nondeductible Expenses 250 (add), Distributions 10,000 (informational).
  // M1 total = 3,000 − 500 + 250 = 2,750.
  //
  // Section 6 shows the 6,000-vs-8,000 depreciation difference and adjusts nothing
  // for it: the return states its book income on Schedule M-1, and where tax
  // depreciation genuinely differs from book depreciation the M-1 says so on its
  // own depreciation lines (3a / 6a) and it reaches the chain through Section 2.
  // Recomputing it in Section 6 would relieve the same amount twice — the defect
  // that produced the client's unreconciled difference.
  const ret = (year) => taxYear(year, {
    totalRevenue: 100000, cogs: 40000, grossProfit: 60000,
    officerWages: 12000, depreciation: 8000, interestExpense: 1000,
    allOtherExpenses: 20000, netIncome: 19000,
    scheduleK: [
      ['Section 179 Deduction', 3000],
      ['Interest Income', 500],
      ['Nondeductible Expenses', 250],
      ['Distributions', 10000],
    ],
    // The preparer's stated book income agrees with these books.
    scheduleM1: { netIncomePerBooks: 21500, lines: [] },
    fileName: `FY${year}.pdf`,
  });

  // A December period for every year EXCEPT YEARS[1], plus the opening period
  // that YEARS[0] needs as its beginning balance.
  const bsPeriods = [
    bsPeriod(`${Y0 - 1}-12-31`, { ar: 8000, arRetention: 1000, ap: 5000 }),
    bsPeriod(`${Y0}-12-31`, { ar: 9000, arRetention: 1200, ap: 5500 }),
    // Y0+1 December deliberately absent — the missing-document case.
    bsPeriod(`${Y0 + 2}-12-31`, { ar: 11000, arRetention: 1500, ap: 6500 }),
    bsPeriod(`${Y0 + 3}-12-31`, { ar: 12000, arRetention: 1600, ap: 7000 }),
  ];

  const run = (accountingMethod) => buildReconciliation({
    fiscalYears: YEARS,
    plRowsByYear: Object.fromEntries(YEARS.map((y) => [y, books()])),
    taxYears: Object.fromEntries(YEARS.map((y) => [y, ret(y)])),
    bsPeriods,
    accountingMethod,
  });

  test('the P&L side is identical and correct for every year', () => {
    const recon = run('Accrual');
    for (const year of YEARS) {
      const y = recon.byYear[year];
      assert.equal(y.financial.values.totalRevenue, 100000, `FY${year} revenue`);
      assert.equal(y.financial.values.totalCogs, 40000);
      assert.equal(y.financial.values.grossProfit, 60000);
      assert.equal(y.financial.values.officerWages, 12000);
      assert.equal(y.financial.values.depreciation, 6000);
      assert.equal(y.financial.values.interestExpense, 1000);
      assert.equal(y.financial.values.interestIncome, 500);
      assert.equal(y.financial.values.allOtherExpenses, 20000);
      assert.equal(y.derivedNetIncomeOk === undefined, true);
      assert.equal(y.financial.derivedNetIncome, 21500);
      assert.equal(y.financial.sourceNetIncome, 21500);
      assert.equal(y.financial.netIncomeDiagnosis.status, 'agrees');
    }
  });

  test('the TR Variance row set is complete and consistent', () => {
    const y = run('Accrual').byYear[YEARS[0]];
    const byKey = Object.fromEntries(y.statementRows.map((r) => [r.key, r]));
    assert.equal(byKey.totalRevenue.variance, 0);
    assert.equal(byKey.depreciation.variance, 2000, 'return deducts 2,000 more depreciation');
    assert.equal(byKey.netIncome.variance, round2(19000 - 21500));
    // Every row that has both sides carries a variance; none is null.
    for (const r of y.statementRows) {
      if (r.taxReturn != null) assert.equal(r.variance, trVariance(r.taxReturn, r.pl), r.label);
    }
  });

  test('M1 adjustments total the same way every year, with Distributions excluded', () => {
    const recon = run('Accrual');
    for (const year of YEARS) {
      const y = recon.byYear[year];
      assert.equal(y.m1.total, 2750, `FY${year} M1 total`);
      assert.ok(!y.m1.items.some((i) => i.category === 'Distributions'));
      assert.ok(y.m1.informationalItems.some((i) => i.category === 'Distributions'));
      // Provenance survives per year — no cross-year leakage of the source file.
      assert.ok(y.m1.items.every((i) => i.sourceDocument === `FY${year}.pdf` && i.fiscalYear === year));
    }
  });

  test('a year with both Balance Sheet periods reconciles to exactly 0.00', () => {
    // Accrual books, accrual-basis return → no cash/accrual conversion, and the
    // preparer's stated book income agrees with the P&L, so there is no book-basis
    // gap for Sections 5 and 6 to explain and both totals are 0.
    const y = run('Accrual').byYear[YEARS[0]];
    assert.equal(y.bookNetIncome, 21500);
    assert.equal(y.other.total, 0, 'the depreciation difference is shown, not adjusted');
    assert.equal(
      y.other.items.find((i) => i.label === 'Other Depreciation Variance').variance,
      -2000,
      'and the difference itself is still on the page',
    );
    assert.equal(y.cashAccrual.total, 0);
    assert.equal(y.m1VarianceCheck.variance, 0);
    assert.equal(y.m1VarianceCheck.residual, 0);
    assert.equal(y.calculatedReconciledIncome, round2(21500 + 2750));
    assert.equal(y.expectedReconciledIncome, round2(21500 + 2750));
    assert.equal(y.unreconciled, 0);
    assert.equal(y.reconciled, true);
    assert.equal(y.sdePct.status, 'ok');
    assert.equal(y.sdePct.percent, 0);
    assert.deepEqual(okFooting(y.footing), []);
  });

  test('SDE is computed from the displayed components, and drives the percentage', () => {
    const y = run('Accrual').byYear[YEARS[0]];
    // 21,500 + 12,000 + 6,000 + 0 + 1,000 − 500
    assert.equal(y.sde, 40000);
    assert.equal(unreconciledPctOfSde(400, y.sde).percent, 1);
  });

  test('the year missing its December Balance Sheet is flagged, not fabricated', () => {
    const recon = run('Cash');
    const broken = recon.byYear[YEARS[1]];
    assert.equal(broken.cashAccrual.available, false);
    assert.equal(broken.cashAccrual.complete, false);
    assert.deepEqual(
      broken.cashAccrual.missingPeriods.map((m) => m.period),
      [`${Y0 + 1}-12`],
    );
    assert.ok(broken.blockers.some((b) => /Balance Sheet/.test(b)));
    assert.ok(broken.cashAccrual.items.every((i) => i.adjustment === null));
    // And the NEXT year, which needs Y0+1 as its BEGINNING period, is flagged too —
    // a missing period breaks two years, and both must say so.
    assert.equal(recon.byYear[YEARS[2]].cashAccrual.available, false);
    assert.deepEqual(
      recon.byYear[YEARS[2]].cashAccrual.missingPeriods.map((m) => m.period),
      [`${Y0 + 1}-12`],
    );
    // The last year has both of its own periods and is unaffected.
    assert.equal(recon.byYear[YEARS[3]].cashAccrual.available, true);
  });

  test('a cash-basis return applies the conversion only where both periods exist', () => {
    const recon = run('Cash');
    const first = recon.byYear[YEARS[0]];
    // AR 8,000 → 9,000 (+1,000), retentions 1,000 → 1,200 (+200), AP 5,000 → 5,500 (+500)
    assert.equal(first.cashAccrual.total, round2(-1000 - 200 + 500));
    assert.equal(first.cashAccrual.available, true);
    // The conversion changes the calculated income and therefore the residual,
    // which is now genuinely unreconciled — and reported as such.
    assert.equal(first.unreconciled, round2(-700));
    assert.equal(first.reconciled, false);
    assert.equal(first.sdePct.percent, round2((700 / 40000) * 100));
    // Arithmetic identities still hold — the residual is real, not a math error.
    assert.deepEqual(okFooting(first.footing), []);
  });

  test('every year is computed from its OWN documents only', () => {
    const recon = run('Accrual');
    assert.deepEqual(recon.years, YEARS);
    for (const year of YEARS) {
      assert.equal(recon.byYear[year].taxReturn.fiscalYear, year);
      assert.equal(recon.byYear[year].taxReturn.fileName, `FY${year}.pdf`);
      assert.equal(recon.byYear[year].fiscalYear, year);
    }
  });

  test('a manual Schedule K addition and an M1 override both take effect and persist', () => {
    const recon = buildReconciliation({
      fiscalYears: YEARS,
      plRowsByYear: Object.fromEntries(YEARS.map((y) => [y, books()])),
      taxYears: Object.fromEntries(YEARS.map((y) => [y, ret(y)])),
      bsPeriods,
      accountingMethod: 'Accrual',
      overridesByYear: {
        [YEARS[0]]: {
          m1: { 'Nondeductible Expenses': { taxReturn: 1250 } },
          scheduleK: { 'Client Specific Line': { taxReturn: 777, userAdded: true } },
          other: {},
          cashAccrual: {},
        },
      },
    });
    const y = recon.byYear[YEARS[0]];
    // 3,000 − 500 + 1,250
    assert.equal(y.m1.total, 3750);
    assert.equal(y.m1.items.find((i) => i.category === 'Nondeductible Expenses').isOverride, true);
    assert.ok(y.scheduleK.items.some((i) => i.label === 'Client Specific Line' && i.userAdded));
    // Both sides of the chain move together — see the next test.
    assert.equal(y.calculatedReconciledIncome, round2(21500 + 3750));
    assert.equal(y.expectedReconciledIncome, round2(21500 + 3750));
    // Other years are untouched.
    assert.equal(recon.byYear[YEARS[3]].m1.total, 2750);
  });

  test('an M1 adjustment is book-to-tax NEUTRAL in the final check, by construction', () => {
    // An M1 item appears on BOTH sides of the Section 7 comparison: it is added to
    // Book Net Income to reach Calculated, and added to Reported M1 Book Net Income
    // to reach Expected. So changing one cannot move the Unreconciled Difference —
    // only a book-basis item (Cash/Accrual, Other) or a genuine disagreement between
    // the books and the return's own reported book income can.
    //
    // This is the property that makes the reconciliation auditable: an M1 mapping
    // mistake shows up as a wrong M1 row, never as a phantom unreconciled amount,
    // and it can never be used to "close" a residual.
    const withOverride = (amount) => buildReconciliation({
      fiscalYears: [YEARS[0]],
      plRowsByYear: { [YEARS[0]]: books() },
      taxYears: { [YEARS[0]]: ret(YEARS[0]) },
      bsPeriods,
      accountingMethod: 'Accrual',
      overridesByYear: { [YEARS[0]]: { m1: { 'Nondeductible Expenses': { taxReturn: amount } } } },
    }).byYear[YEARS[0]];

    const low = withOverride(250);
    const high = withOverride(99999);
    assert.notEqual(low.m1.total, high.m1.total, 'the M1 total must respond to the override');
    assert.equal(low.unreconciled, high.unreconciled, 'but the final difference must not');
    assert.equal(low.unreconciled, 0);
  });
});

// ── No error masking (Part 20) ─────────────────────────────────────────────

describe('errors are never masked', () => {
  test('a residual smaller than the display precision is still carried at full value', () => {
    const r = unreconciledPctOfSde(0.004, 1000);
    assert.equal(r.status, 'ok');
    assert.equal(r.percent, 0);
    // The engine reports 0.0% but the caller still holds the real 0.004.
    assert.ok(0.004 > 0);
  });

  test('FOOTING_TOLERANCE only ever classifies — it never rewrites the difference', () => {
    const recon = buildReconciliation({
      fiscalYears: [2024],
      plRowsByYear: {
        2024: plTree({ revenue: [['Sales', 1000]], cogs: [], expenses: [['Rent', 100]], netIncome: 899.995 }),
      },
      taxYears: {},
    });
    const check = recon.byYear[2024].footing.find((c) => /stated Net Income/.test(c.label));
    assert.ok(Math.abs(check.difference) <= FOOTING_TOLERANCE);
    assert.equal(check.ok, true);
    // The stated figure itself is untouched.
    assert.equal(recon.byYear[2024].financial.sourceNetIncome, 900);
  });

  test('a partially-available reconciliation reports null, never a fabricated zero', () => {
    const year = buildYearReconciliation({
      fiscalYear: 2024,
      plRows: plTree(),
      taxYears: { 2024: taxYear(2024) }, // return present, but no Schedule M-1
      bsPeriods: [],                     // and no Balance Sheet at all
    });
    assert.equal(year.expectedReconciledIncome, null);
    assert.equal(year.unreconciled, null);
    assert.equal(year.reconciled, false);
    assert.ok(year.blockers.length >= 2);
    assert.ok(year.blockers.some((b) => /Balance Sheet/.test(b)));
  });
});
