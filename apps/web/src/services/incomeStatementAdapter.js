/**
 * Shape the engine's income statement the way the reports view renders it.
 *
 * `buildIncomeStatement` returns a flat set of signed per-account amounts, which
 * is the right shape for a calculation and the wrong one for a P&L: a reader
 * expects Income, Cost of Goods Sold, Gross Profit, Expenses, Net Income, with
 * accounts underneath each. This groups the former into the latter.
 *
 * The grouping key is the account's own `account_type` from the chart of
 * accounts. It is never inferred from the sign of the amount — that inference is
 * exactly what produced the `profit_loss_entries` inversion the engine warns
 * about, where FY2024 reports $4,975,913 against a true net income of $47,568.
 *
 * Amounts arrive signed (revenue positive, expenses negative). A P&L shows
 * expenses as positive figures under an "Expenses" heading, so they are flipped
 * for presentation only — the signed values stay authoritative for arithmetic.
 */

/** Account types that belong on the P&L, and the section each one lands in. */
const SECTION_BY_TYPE = {
  income: 'revenue',
  revenue: 'revenue',
  cogs: 'costOfSales',
  cost_of_sales: 'costOfSales',
  expense: 'operatingExpenses',
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The period key the engine uses: "2025" annually, "2025-03" monthly. */
export function periodKeyOf(period) {
  return period.month === null || period.month === undefined
    ? String(period.fiscalYear)
    : `${period.fiscalYear}-${String(period.month).padStart(2, '0')}`;
}

/** Human label for a period column. */
export function periodLabelOf(period) {
  if (period.month === null || period.month === undefined) return `FY${period.fiscalYear}`;
  const month = new Date(Date.UTC(2000, period.month - 1, 1))
    .toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${month} ${period.fiscalYear}`;
}

/**
 * One period's statement, in the shape `ProfitLossTable` renders.
 *
 * Expenses are grouped by account type rather than by a bespoke taxonomy: the
 * chart of accounts is the only grouping the data actually carries, and
 * inventing categories here would be presenting a structure the ledger does not
 * support.
 */
export function statementForPeriod(payload, key) {
  const sections = { revenue: [], costOfSales: [], operatingExpenses: [] };

  for (const line of payload.lines || []) {
    const section = SECTION_BY_TYPE[String(line.account_type || '').toLowerCase()];
    if (!section) continue; // balance-sheet accounts have no place on a P&L

    const signed = Number(line.amounts?.[key] ?? 0);
    if (signed === 0) continue; // an account with no movement is noise

    sections[section].push({
      name: line.account_name,
      // Presentation flips expenses positive; revenue is already positive.
      amount: round2(section === 'revenue' ? signed : -signed),
    });
  }

  for (const list of Object.values(sections)) {
    list.sort((a, b) => b.amount - a.amount);
  }

  const total = (list) => round2(list.reduce((sum, a) => sum + a.amount, 0));
  const revenueTotal = total(sections.revenue);
  const cosTotal = total(sections.costOfSales);
  const opexTotal = total(sections.operatingExpenses);

  return {
    revenue: { accounts: sections.revenue, total: revenueTotal },
    costOfSales: { accounts: sections.costOfSales, total: cosTotal },
    grossProfit: round2(revenueTotal - cosTotal),
    // A single "Operating" group: the ledger carries no sub-grouping, and
    // fabricating one would imply a structure the data cannot back.
    operatingExpenses: {
      groups: sections.operatingExpenses.length
        ? { Operating: { accounts: sections.operatingExpenses, total: opexTotal } }
        : {},
      total: opexTotal,
    },
    netIncome: round2(payload.net_income?.[key] ?? revenueTotal - cosTotal - opexTotal),
  };
}

/**
 * Convert the whole payload into the `{ yearly, monthly }` entries the reports
 * view consumes. Whichever aggregation was requested fills its own list; the
 * other stays empty rather than being faked from the one we have.
 */
export function toProfitAndLossReport(payload, aggregation = 'annual') {
  if (!payload || !Array.isArray(payload.periods)) return { yearly: [], monthly: [] };

  const entries = payload.periods.map((period) => {
    const key = periodKeyOf(period);
    return {
      period: key,
      periodLabel: periodLabelOf(period),
      // `year` and `monthNumber` are what the reports view filters and groups on
      // — without them every entry looks like it belongs to no year, the year
      // selector comes up empty, and the statement renders as "FY null".
      year: period.fiscalYear,
      monthNumber: period.month ?? null,
      statement: statementForPeriod(payload, key),
    };
  });

  return aggregation === 'monthly'
    ? { yearly: [], monthly: entries }
    : { yearly: entries, monthly: [] };
}
