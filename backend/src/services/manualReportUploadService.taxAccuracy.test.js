// Tax-return reading accuracy, pinned to a real filed 2023 Form 1120-S.
//
// Run: node --test backend/src/services/manualReportUploadService.taxAccuracy.test.js
//
// ── THE RETURN THESE NUMBERS COME FROM ──────────────────────────────────────
// A 194-page filed 2023 S-corporation package (federal 1120-S + AZ/CA/DC/IL/MN/OH/TX
// returns + 4 Schedule K-1s + statements + depreciation schedules). Every figure below
// was read off the printed form, so a failure here means the pipeline disagrees with
// the document — not with an invented fixture.
//
//   Form 1120-S page 1:  1c 9,020,165 · 2 (blank) · 3 9,020,165 · 5 1,613 · 6 9,021,778
//                        7 263,002 · 8 4,547,088 · 12 393,034 · 13 240,911
//                        14 (blank) · 18 410,456 · 20 3,558,374
//                        21 total deductions 9,412,865 · 22 ordinary income -391,087
//   Schedule B line 1:   accounting method = Cash
//   Schedule K:          line 1 -391,087 · 16c 912 · 16d BLANK · line 18 -391,087
//   Schedule M-1:        line 1 net income per books -391,999 · 3b 50 · Stmt 7 862
//                        · line 3 total 912 · line 4 -391,087 · line 8 -391,087
//   Schedule M-2 col(a): 1 402,976 · 4 (391,087) · 5 (912) · 6 10,977
//                        · 7 distributions BLANK · 8 balance 10,977
//   Retained-earnings worksheet: 762,972 + (-391,999) = 370,973  ← confirms M-1 line 1
//
// The deduction lines the form reports separately from officer comp / interest sum to
//   4,547,088 + 393,034 + 410,456 + 3,558,374 = 8,908,952
// and that is the ONLY correct value for "All Other Expenses" on the tax side.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  buildTaxReturnResponseData,
  validateTaxExtraction,
} = require('./manualReportUploadService');

// ── The return as correctly extracted ───────────────────────────────────────
function phoenix2023() {
  return {
    formType: '1120-S',
    year: 2023,
    totalRevenue: 9020165,        // line 1c
    totalCostOfGoodsSold: 0,      // line 2 blank
    grossProfit: 9020165,         // line 3
    netGain4797: 0,               // line 4 blank
    otherIncome: 1613,            // line 5 — state tax refund per Statement 1
    totalIncome: 9021778,         // line 6
    officerWages: 263002,         // line 7
    depreciation: 0,              // line 14 blank
    amortization: 0,
    interestExpense: 240911,      // line 13
    allOtherExpenses: 3558374,    // line 20 "Other deductions" only
    totalDeductions: 9412865,     // line 21
    netIncome: -391087,           // line 22
    reconcilingItems: [{ label: 'Nondeductible Expenses', value: 912 }],
    scheduleM1: { netIncomePerBooks: -391999, reconciledIncome: -391087, lines: [] },
  };
}

const rowOf = (data, label) => data.find((d) => d.label === label);
const valOf = (data, label) => rowOf(data, label).taxReturn;

// ── Every Tax Return row against the FEDERAL Form 1120-S ────────────────────
describe('the Tax Return column reproduces the federal Form 1120-S', () => {
  test('Total Revenue is line 6 TOTAL income, not line 1c gross receipts', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    assert.equal(valOf(data, 'Total Revenue'), 9021778);
    // 9,020,165 is gross receipts. Publishing it under a row captioned "Total
    // Revenue" understated total income by the 1,613 of other income.
    assert.notEqual(valOf(data, 'Total Revenue'), 9020165);
  });

  test('Gross Profit stays line 3 and is NOT raised to total income', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    assert.equal(valOf(data, 'Gross Profit'), 9020165);
    assert.notEqual(valOf(data, 'Gross Profit'), 9021778);
  });

  test('every remaining row matches its printed federal line', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    assert.equal(valOf(data, 'Total Cost of Goods Sold'), 0);        // line 2 blank
    assert.equal(valOf(data, 'Officer Wages'), 263002);              // line 7
    assert.equal(valOf(data, 'Depreciation Expense'), 0);            // line 14 blank
    assert.equal(valOf(data, 'Amortization Expense'), 0);
    assert.equal(valOf(data, 'Total Interest Expense'), 240911);     // line 13
    assert.equal(valOf(data, 'All Other Expenses'), 8908952);        // derived
    assert.equal(valOf(data, 'All Other Income'), 1613);             // lines 4 + 5
    assert.equal(valOf(data, 'Net Income'), -391087);                // line 22
    assert.equal(valOf(data, 'Nondeductible Expenses'), 912);        // Sch K 16c
  });

  test('the P&L is never a source: no P&L figure appears in the tax column', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    // The P&L for this year reports these. None may leak into the tax column.
    const plOnly = [9029536, 7276443, 1753093, 270126, 1865593, -382627];
    for (const row of data) {
      assert.ok(
        !plOnly.includes(row.taxReturn),
        `${row.label} = ${row.taxReturn} is a P&L figure, not a federal return figure`,
      );
    }
  });

  test('ordinary business income and M-1 book income are never merged', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    // -391,087 (page 1 line 22) and -391,999 (Schedule M-1 line 1) differ by the
    // 912 of nondeductible expenses. The Net Income row carries the FORMER only;
    // the latter reaches the page through scheduleM1, on its own section.
    assert.equal(valOf(data, 'Net Income'), -391087);
    assert.notEqual(valOf(data, 'Net Income'), -391999);
    assert.equal(phoenix2023().scheduleM1.netIncomePerBooks, -391999);
  });

  test('no state-return figure appears in the federal tax column', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    // Same captions, different numbers: CA 100S net income after state adjustments,
    // DC D-20 net income, CA Schedule K line 1, CA nondeductible expenses,
    // DC total deductions, CA other deductions total.
    const stateOnly = [-391960, -391100, 2512, 9411265, 3968830, -186810, -17809];
    for (const row of data) {
      assert.ok(
        !stateOnly.includes(row.taxReturn),
        `${row.label} = ${row.taxReturn} is a STATE return figure`,
      );
    }
  });
});

describe('each Tax Return row declares its federal source', () => {
  test('direct rows name the form and line they were read from', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    const revenue = rowOf(data, 'Total Revenue').source;
    assert.equal(revenue.document, 'federal');
    assert.equal(revenue.form, 'Form 1120-S');
    assert.equal(revenue.line, '6');
    assert.equal(revenue.type, 'direct');

    assert.equal(rowOf(data, 'Gross Profit').source.line, '3');
    assert.equal(rowOf(data, 'Officer Wages').source.line, '7');
    assert.equal(rowOf(data, 'Total Interest Expense').source.line, '13');
    assert.equal(rowOf(data, 'Net Income').source.line, '22');
    assert.equal(rowOf(data, 'Net Income').source.caption, 'Ordinary business income (loss)');
  });

  test('All Other Expenses is labelled DERIVED, not a printed line', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    const src = rowOf(data, 'All Other Expenses').source;
    // 8,908,952 is arithmetic over printed figures. It is legitimate to show, but a
    // reviewer must not be sent looking for it on the form.
    assert.equal(src.type, 'derived');
    assert.deepEqual(src.from, [
      'totalDeductions', 'officerWages', 'depreciation', 'amortization', 'interestExpense',
    ]);
  });

  test('All Other Income is labelled derived from lines 4 and 5', () => {
    const src = rowOf(buildTaxReturnResponseData(phoenix2023()), 'All Other Income').source;
    assert.equal(src.type, 'derived');
    assert.equal(src.line, '4 + 5');
  });

  test('a blank line is marked not-reported even though it displays as 0', () => {
    // Line 2 COGS and line 14 depreciation are BLANK on this return. The engine and
    // the variance column need numbers, so the row shows 0 — but the metadata must
    // still say the return reported nothing, or "blank" and "zero" become the same
    // fact and a failed extraction is indistinguishable from a real zero.
    const blanks = { ...phoenix2023() };
    delete blanks.totalCostOfGoodsSold;
    delete blanks.depreciation;
    const data = buildTaxReturnResponseData(blanks);
    assert.equal(valOf(data, 'Total Cost of Goods Sold'), 0);
    assert.equal(rowOf(data, 'Total Cost of Goods Sold').source.reported, false);
    assert.equal(rowOf(data, 'Depreciation Expense').source.reported, false);
    // A figure that WAS read stays reported.
    assert.equal(rowOf(data, 'Total Interest Expense').source.reported, true);
  });

  test('line numbers follow the form type', () => {
    const p = buildTaxReturnResponseData({ ...phoenix2023(), formType: '1065' });
    assert.equal(rowOf(p, 'Total Revenue').source.form, 'Form 1065');
    assert.equal(rowOf(p, 'Total Revenue').source.line, '8');
    assert.equal(rowOf(p, 'Guaranteed Payments').source.line, '10');

    const c = buildTaxReturnResponseData({ ...phoenix2023(), formType: '1120' });
    assert.equal(rowOf(c, 'Total Revenue').source.form, 'Form 1120');
    assert.equal(rowOf(c, 'Total Revenue').source.line, '11');
    assert.equal(rowOf(c, 'Net Income').source.line, '28');
  });
});

describe('the published rows survive a round trip through the validator', () => {
  // The row builder and the reconstruction must agree on what each row MEANS.
  // "Total Revenue" publishes line 6 total income; reading it back into the
  // gross-receipts field made the gross-profit identity fail by exactly the other
  // income, marking a correctly-read return "Needs Review".
  const { enrichTaxYearWithStatus } = require('../routes/manualReportUploads.js');

  test('a correctly-published year comes back Verified', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    const out = enrichTaxYearWithStatus({ year: 2023, data });
    assert.equal(out.status, 'Verified');
  });

  test('gross receipts is absent from the rows and is NOT invented as zero', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    const out = enrichTaxYearWithStatus({ year: 2023, data });
    // Were gross receipts defaulted to 0, formula 1 would report
    // "expected 0, extracted 9,020,165" — a failure the validator manufactured.
    assert.ok(!/Gross Profit mismatch/.test(String(out.status)));
    assert.equal(out.status, 'Verified');
  });

  test('a genuinely broken year still fails', () => {
    const data = buildTaxReturnResponseData({ ...phoenix2023(), netIncome: 9412865 });
    assert.equal(enrichTaxYearWithStatus({ year: 2023, data }).status, 'Needs Review');
  });
});

describe('balance-sheet rows never borrow a tax-return value', () => {
  // Schedule L line 2a (trade notes and accounts receivable) is BLANK on this
  // return, so the tax return supplies no A/R at all. The Cash/Accrual section is
  // sourced from the Balance Sheet and must stay that way — an ending balance of
  // 227,670 is a balance-sheet fact, and it must never be published as though the
  // federal return had reported it.
  test('the tax-return rows contain no A/R, A/P or retention figure', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    for (const row of data) {
      assert.ok(
        !/receivable|payable|retention|retainage/i.test(row.label),
        `${row.label} must not appear in the tax-return rows`,
      );
      // The A/R balances from the balance sheet for this company.
      assert.ok(![227670, 218298].includes(row.taxReturn),
        `${row.label} = ${row.taxReturn} is a balance-sheet figure`);
    }
  });

  test('the export labels the Cash/Accrual columns as balance sheets', () => {
    // Those columns are Beginning BS / Ending BS / Adjustment. Labelling them
    // "P&L | Tax Return | TR Variance" is what made the ending A/R balance read as
    // a claimed Schedule L figure.
    const page = readFileSync(
      join(__dirname, '../../../src/pages/broker/workspace/WorkspaceTaxReconciliation.jsx'),
      'utf8',
    );
    assert.match(page, /sectionHeader\(\["Beginning Balance Sheet", "Ending Balance Sheet"/);
    assert.match(page, /sectionHeader\(\["", "Variance \(calculated\)", "Residual \(calculated\)"\]\)/);
  });
});

describe('page-1 residual is measured from TOTAL income, not gross profit', () => {
  test('All Other Expenses equals the return\'s own deduction lines', () => {
    const data = buildTaxReturnResponseData(phoenix2023());

    // 4,547,088 salaries + 393,034 taxes + 410,456 benefits + 3,558,374 other
    assert.equal(rowOf(data, 'All Other Expenses').taxReturn, 8908952);

    // The old gross-profit base produced 8,907,339 — exactly 1,613 low, because the
    // state tax refund was silently converted from income into an expense.
    assert.notEqual(rowOf(data, 'All Other Expenses').taxReturn, 8907339);
  });

  test('other income is reported as income, on its own row', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    const row = rowOf(data, 'All Other Income');
    assert.ok(row, '"All Other Income" must exist on the tax side, not just the P&L side');
    assert.equal(row.taxReturn, 1613);
  });

  test('the emitted rows still foot to the return\'s bottom line', () => {
    const data = buildTaxReturnResponseData(phoenix2023());
    const v = (l) => rowOf(data, l).taxReturn;
    const derived =
      v('Gross Profit') + v('All Other Income') -
      v('Officer Wages') - v('Depreciation Expense') -
      v('Amortization Expense') - v('Total Interest Expense') -
      v('All Other Expenses');
    assert.equal(derived, -391087, 'must equal Form 1120-S line 22 as printed');
    assert.equal(v('Net Income'), -391087);
  });

  test('net gain from Form 4797 is treated as income too', () => {
    // Same shape with a line-4 gain: it must land in All Other Income and must NOT
    // reduce the expense residual.
    const withGain = {
      ...phoenix2023(),
      netGain4797: 25000,
      totalIncome: 9046778,
      netIncome: -366087,
    };
    const data = buildTaxReturnResponseData(withGain);
    assert.equal(rowOf(data, 'All Other Income').taxReturn, 26613);
    assert.equal(rowOf(data, 'All Other Expenses').taxReturn, 8908952);
  });

  test('partnerships keep Line 21 verbatim ONLY when no printed total was captured', () => {
    // Legacy 1065 behaviour: "Other deductions" (Line 21) shown as-is. It under-reports
    // — salaries, rent, taxes and retirement all fall outside Line 21 — but it is what
    // pre-totalDeductions payloads contain, so it must not change.
    const legacy = {
      ...phoenix2023(), formType: '1065', totalDeductions: 0, allOtherExpenses: 3558374,
    };
    const data = buildTaxReturnResponseData(legacy);
    assert.equal(rowOf(data, 'All Other Expenses').taxReturn, 3558374);
    assert.ok(rowOf(data, 'Guaranteed Payments'), 'officer wages relabelled for 1065');
  });

  test('partnerships WITH a printed total derive the full remainder', () => {
    // Line 22 "Total deductions" is available, so the same anchored derivation applies
    // and the dropped partnership deduction lines are no longer lost.
    const p = { ...phoenix2023(), formType: '1065', allOtherExpenses: 3558374 };
    const data = buildTaxReturnResponseData(p);
    assert.equal(rowOf(data, 'All Other Expenses').taxReturn, 8908952);
  });
});

describe('the validator no longer enforces the wrong residual', () => {
  test('a correctly-read return passes', () => {
    const { status, issues } = validateTaxExtraction(phoenix2023());
    assert.equal(status, 'Verified', `unexpected issues: ${issues.join('; ')}`);
  });

  test('reading "Total deductions" as the bottom line FAILS', () => {
    // The prompt used to name line 21 as netIncome; on the 2023 revision line 21 is
    // Total deductions (9,412,865) and line 22 is the -391,087 bottom line.
    const swapped = { ...phoenix2023(), netIncome: 9412865 };
    const { status } = validateTaxExtraction(swapped);
    assert.equal(status, 'Needs Review');
  });

  test('a component larger than total deductions FAILS', () => {
    // e.g. "Total deductions" misread into the interest field.
    const bad = { ...phoenix2023(), interestExpense: 9412865 };
    const { status, issues } = validateTaxExtraction(bad);
    assert.equal(status, 'Needs Review');
    assert.ok(issues.some((i) => /exceed total deductions/.test(i)));
  });

  test('the failure message names both printed totals, so the retry knows where to look', () => {
    const { issues } = validateTaxExtraction({ ...phoenix2023(), netIncome: -1 });
    const msg = issues.find((i) => /Net Income mismatch/.test(i));
    assert.match(msg, /total income 9021778/);
    assert.match(msg, /total deductions 9412865/);
  });

  test('legacy payloads without totalDeductions still validate on the residual', () => {
    // Extractions made before totalDeductions was requested carry the whole remainder
    // in allOtherExpenses. That contract must keep working.
    const legacy = {
      formType: '1120-S', year: 2022,
      totalRevenue: 9292582, totalCostOfGoodsSold: 0, grossProfit: 9292582,
      netGain4797: 0, otherIncome: 0, totalIncome: 9292582,
      officerWages: 224833, depreciation: 0, amortization: 0,
      interestExpense: 232652, allOtherExpenses: 9121191,
      netIncome: -286094,
    };
    assert.equal(Number(legacy.totalDeductions || 0), 0);
    const { status, issues } = validateTaxExtraction(legacy);
    assert.equal(status, 'Verified', issues.join('; '));
  });
});

describe('a mis-scoped allOtherExpenses can no longer corrupt the page', () => {
  test('the displayed residual comes from the printed total, not from allOtherExpenses', () => {
    // The old pipeline had two contradictory contracts for allOtherExpenses (prompt:
    // "Other deductions" line only; validator: the whole remainder). Whichever value
    // the model returned, the displayed figure is now derived from total deductions,
    // so neither reading can move it.
    for (const misread of [3558374, 8907339, 8908952, 0]) {
      const data = buildTaxReturnResponseData({ ...phoenix2023(), allOtherExpenses: misread });
      assert.equal(
        rowOf(data, 'All Other Expenses').taxReturn, 8908952,
        `allOtherExpenses=${misread} must not change the displayed residual`,
      );
    }
  });

  test('legacy payloads without a printed total fall back to the bottom-line residual', () => {
    const legacy = { ...phoenix2023(), totalDeductions: 0 };
    const data = buildTaxReturnResponseData(legacy);
    // 9,021,778 total income - 263,002 - 240,911 - (-391,087)
    assert.equal(rowOf(data, 'All Other Expenses').taxReturn, 8908952);
  });
});

// ── Prompt-level guards ─────────────────────────────────────────────────────
// These assert the INSTRUCTIONS, because the extraction itself needs a live Gemini
// call. Each one corresponds to a defect observed on the return above.
describe('extraction prompt', () => {
  const src = readFileSync(join(__dirname, 'manualReportUploadService.js'), 'utf8');
  const start = src.indexOf('const TAX_EXTRACTION_PROMPT = `');
  const prompt = src.slice(start, src.indexOf('`.trim();', start));

  test('1120-S deduction lines use the 2023 numbering', () => {
    assert.match(prompt, /Line 20\s+— Other deductions/);
    assert.match(prompt, /Line 21\s+— Total deductions/);
    assert.match(prompt, /Line 22\s+— Ordinary business income/);
    // The old text named line 19 as Other deductions and line 21 as the bottom line.
    assert.ok(!/Line 19\s+— Other deductions/.test(prompt));
    assert.ok(!/Line 21\s+— Ordinary business income/.test(prompt));
  });

  test('captions are authoritative over line numbers', () => {
    // IRS renumbering is the reason the numbers above went stale in the first place.
    assert.match(prompt, /MATCH THE PRINTED CAPTION, NOT THE LINE NUMBER/);
  });

  test('Schedule M-1 is located by form page, not by end of PDF', () => {
    assert.match(prompt, /PAGE 5 OF THE FORM" IS NOT "THE LAST PAGE OF THE PDF/);
    // A 194-page package ends in state returns, each with its own Schedule M-1.
    // \s+ because the prompt is hard-wrapped and the phrase straddles a line break.
    assert.match(prompt, /state\s+Schedule M-1/);
    assert.ok(!/it sits on the LAST page/.test(prompt));
  });

  test('the self-check identity starts at total income', () => {
    assert.match(prompt, /netIncome\s+= totalIncome - totalDeductions/);
    assert.ok(
      !/netIncome\s+= grossProfit - officerWages/.test(prompt),
      'the gross-profit identity is what converted other income into an expense',
    );
  });

  test('the model may not balance the formula by editing allOtherExpenses', () => {
    assert.match(prompt, /Do NOT force formula 3 to balance by ADJUSTING allOtherExpenses/);
  });

  test('Schedule M-2 balances may not be reported as Schedule K distributions', () => {
    // Observed: Schedule K 16d was blank and 10,977 (M-2 col (a) line 8 "Balance at
    // end of tax year") was published to the app as a distribution.
    assert.match(prompt, /Balance at end of tax year/);
    assert.match(prompt, /must NEVER be reported as "Distributions"/);
  });

  test('Schedule M-1 line 1 is never substituted', () => {
    assert.match(prompt, /never to the Ordinary business income figure from page 1/);
    assert.match(prompt, /set "netIncomePerBooks" to null — NOT to 0/);
  });

  test('"SEE STATEMENT n" is resolved, not emitted as a label', () => {
    assert.match(prompt, /Do NOT emit "SEE STATEMENT 7" as a label/);
    assert.match(prompt, /A STATEMENT EXPLAINS ITS PARENT LINE; IT DOES NOT ADD TO IT/);
  });

  test('totalDeductions is in the requested schema', () => {
    assert.match(prompt, /"totalDeductions": 0/);
  });
});

describe('model selection for tax returns', () => {
  const src = readFileSync(join(__dirname, 'manualReportUploadService.js'), 'utf8');
  const decl = src.slice(
    src.indexOf('const TAX_GEMINI_MODELS'),
    src.indexOf('const _taxExtractCache'),
  );

  test('the primary model is not flash-lite', () => {
    const models = [...decl.matchAll(/"(gemini-[^"]+)"/g)].map((m) => m[1]);
    assert.ok(models.length >= 2, 'a fallback chain must remain');
    assert.notEqual(
      models[0], 'gemini-2.5-flash-lite',
      'flash-lite cannot hold a 190-page return\'s form/schedule/line address space',
    );
  });

  test('flash-lite remains only as a last-resort fallback', () => {
    const models = [...decl.matchAll(/"(gemini-[^"]+)"/g)].map((m) => m[1]);
    if (models.includes('gemini-2.5-flash-lite')) {
      assert.equal(models[models.length - 1], 'gemini-2.5-flash-lite');
    }
  });
});
