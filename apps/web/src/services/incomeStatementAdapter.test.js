import { describe, expect, it } from 'vitest';
import {
  periodKeyOf,
  periodLabelOf,
  statementForPeriod,
  toProfitAndLossReport,
} from './incomeStatementAdapter';

/**
 * Figures taken from the seeded engagement, which the engine's own tests tie to
 * the source workbook. The point of pinning them here is the SHAPE: the reports
 * view renders `revenue.accounts`, `costOfSales`, `grossProfit`,
 * `operatingExpenses.groups` and `netIncome`, and a P&L that renders as an empty
 * table is indistinguishable from one that failed to load.
 */
const payload = {
  periods: [
    { fiscalYear: 2024, month: null },
    { fiscalYear: 2025, month: null },
  ],
  revenue: { 2024: 2511741, 2025: 2333399 },
  expenses: { 2024: 2464172.77, 2025: 2163903.1 },
  net_income: { 2024: 47568.23, 2025: 169495.9 },
  lines: [
    { account_id: 'a1', account_name: 'Product sales', account_type: 'income',
      amounts: { 2024: 2000000, 2025: 1900000 }, ledger_amounts: {} },
    { account_id: 'a2', account_name: 'Service revenue', account_type: 'income',
      amounts: { 2024: 511741, 2025: 433399 }, ledger_amounts: {} },
    { account_id: 'a3', account_name: 'Materials', account_type: 'cogs',
      amounts: { 2024: -1200000, 2025: -1000000 }, ledger_amounts: {} },
    { account_id: 'a4', account_name: 'Salaries', account_type: 'expense',
      amounts: { 2024: -1000000, 2025: -900000 }, ledger_amounts: {} },
    { account_id: 'a5', account_name: 'Rent', account_type: 'expense',
      amounts: { 2024: -264172.77, 2025: -263903.1 }, ledger_amounts: {} },
    // A balance-sheet account must never appear on a P&L.
    { account_id: 'a6', account_name: 'Machinery & Equipment', account_type: 'asset',
      amounts: { 2024: 1623750, 2025: 1623750 }, ledger_amounts: {} },
    // No movement in either period.
    { account_id: 'a7', account_name: 'Dormant account', account_type: 'expense',
      amounts: { 2024: 0, 2025: 0 }, ledger_amounts: {} },
  ],
};

describe('statementForPeriod', () => {
  it('groups accounts by their own type, not by the sign of the amount', () => {
    const s = statementForPeriod(payload, '2024');
    expect(s.revenue.accounts.map((a) => a.name)).toEqual(['Product sales', 'Service revenue']);
    expect(s.costOfSales.accounts.map((a) => a.name)).toEqual(['Materials']);
    expect(s.operatingExpenses.groups.Operating.accounts.map((a) => a.name))
      .toEqual(['Salaries', 'Rent']);
  });

  it('shows expenses as positive figures under an Expenses heading', () => {
    const s = statementForPeriod(payload, '2024');
    for (const a of s.operatingExpenses.groups.Operating.accounts) {
      expect(a.amount).toBeGreaterThan(0);
    }
    expect(s.costOfSales.accounts[0].amount).toBe(1200000);
  });

  it('keeps balance-sheet accounts off the P&L entirely', () => {
    const s = statementForPeriod(payload, '2024');
    const everyName = [
      ...s.revenue.accounts,
      ...s.costOfSales.accounts,
      ...s.operatingExpenses.groups.Operating.accounts,
    ].map((a) => a.name);
    expect(everyName).not.toContain('Machinery & Equipment');
  });

  it('omits accounts with no movement rather than listing zero rows', () => {
    const s = statementForPeriod(payload, '2024');
    const names = s.operatingExpenses.groups.Operating.accounts.map((a) => a.name);
    expect(names).not.toContain('Dormant account');
  });

  it('foots: revenue − cost of sales = gross profit, and on to net income', () => {
    const s = statementForPeriod(payload, '2024');
    expect(s.revenue.total).toBe(2511741);
    expect(s.grossProfit).toBe(s.revenue.total - s.costOfSales.total);
    expect(s.grossProfit - s.operatingExpenses.total).toBeCloseTo(s.netIncome, 2);
  });

  it('reports the engine net income, not a recomputed guess', () => {
    expect(statementForPeriod(payload, '2024').netIncome).toBeCloseTo(47568.23, 2);
    expect(statementForPeriod(payload, '2025').netIncome).toBeCloseTo(169495.9, 2);
  });

  it('does not reproduce the revenue-plus-expenses inversion', () => {
    // The inverted extract reports FY2024 as $4,975,913.
    expect(statementForPeriod(payload, '2024').netIncome).toBeLessThan(1_000_000);
  });

  it('produces empty sections rather than throwing on an unknown period', () => {
    const s = statementForPeriod(payload, '1999');
    expect(s.revenue.accounts).toEqual([]);
    expect(s.operatingExpenses.groups).toEqual({});
  });
});

describe('toProfitAndLossReport', () => {
  it('fills the yearly list for an annual payload and leaves monthly empty', () => {
    const r = toProfitAndLossReport(payload, 'annual');
    expect(r.yearly).toHaveLength(2);
    expect(r.monthly).toEqual([]);
    expect(r.yearly[0].periodLabel).toBe('FY2024');
  });

  it('fills the monthly list for a monthly payload', () => {
    const monthly = {
      ...payload,
      periods: [{ fiscalYear: 2025, month: 3 }],
      net_income: { '2025-03': 1234.5 },
      lines: [{ account_id: 'a1', account_name: 'Product sales', account_type: 'income',
        amounts: { '2025-03': 5000 }, ledger_amounts: {} }],
    };
    const r = toProfitAndLossReport(monthly, 'monthly');
    expect(r.yearly).toEqual([]);
    expect(r.monthly).toHaveLength(1);
    expect(r.monthly[0].periodLabel).toBe('Mar 2025');
    expect(r.monthly[0].statement.netIncome).toBe(1234.5);
  });

  it('carries the year and month the reports view filters on', () => {
    // Without these the year selector comes up empty and the statement renders
    // as "FY null" over data that is perfectly present.
    const r = toProfitAndLossReport(payload, 'annual');
    expect(r.yearly.map((e) => e.year)).toEqual([2024, 2025]);
    expect(r.yearly.every((e) => e.monthNumber === null)).toBe(true);

    const monthly = toProfitAndLossReport(
      { ...payload, periods: [{ fiscalYear: 2025, month: 7 }], net_income: { '2025-07': 1 }, lines: [] },
      'monthly',
    );
    expect(monthly.monthly[0].year).toBe(2025);
    expect(monthly.monthly[0].monthNumber).toBe(7);
  });

  it('returns empty lists for a missing or malformed payload', () => {
    expect(toProfitAndLossReport(null)).toEqual({ yearly: [], monthly: [] });
    expect(toProfitAndLossReport({})).toEqual({ yearly: [], monthly: [] });
  });
});

describe('period keys and labels', () => {
  it('keys annually by year and monthly by year-month', () => {
    expect(periodKeyOf({ fiscalYear: 2025, month: null })).toBe('2025');
    expect(periodKeyOf({ fiscalYear: 2025, month: 3 })).toBe('2025-03');
  });

  it('labels a period the way a reader would name it', () => {
    expect(periodLabelOf({ fiscalYear: 2025, month: null })).toBe('FY2025');
    expect(periodLabelOf({ fiscalYear: 2025, month: 12 })).toBe('Dec 2025');
  });
});
