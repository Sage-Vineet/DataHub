import { forDataSource, resolveAddback, type ResolvedAddback } from "./addbacks.js";
import {
  EBIT_ROLE_ORDER,
  ROLE_DEFAULT_COMMENTARY,
  ROLE_LABELS,
  accountsByRole,
  roleSign,
  unflaggedProfitLossAccounts,
} from "./coa-roles.js";
import { buildIncomeStatement } from "./income-statement.js";
import { buildPeriods, emptyAmounts, periodKeyFor, roundAmounts, sumAmounts } from "./periods.js";
import type {
  Account,
  Addback,
  Aggregation,
  BridgeGroup,
  BridgeLineItem,
  BridgeResult,
  DataSource,
  EarningsMetric,
  GlEntry,
} from "./types.js";

export interface BridgeInput {
  accounts: Account[];
  entries: GlEntry[];
  addbacks?: Addback[];
  selectedYears: number[];
  aggregation?: Aggregation;
  dataSource?: DataSource;
  metric?: EarningsMetric;
  /**
   * One market-rate replacement salary. Adjusted EBITDA adds back owner
   * compensation NET of this figure; SDE adds back the full amount. This is the
   * only structural difference between the two metrics.
   */
  marketRateReplacementSalary?: number | null;
}

const METRIC_LABELS: Record<EarningsMetric, string> = {
  adjusted_ebitda: "Adjusted EBITDA",
  sde: "Seller's Discretionary Earnings",
};

export function buildBridge(input: BridgeInput): BridgeResult {
  const {
    accounts,
    entries,
    addbacks = [],
    selectedYears,
    aggregation = "annual",
    dataSource = "company_financials",
    metric = "adjusted_ebitda",
    marketRateReplacementSalary = null,
  } = input;

  const periods = buildPeriods(entries, selectedYears, aggregation);
  const statement = buildIncomeStatement(accounts, entries, periods, aggregation);
  const keyFor = (entry: GlEntry) => periodKeyFor(entry, aggregation);

  // ── Net income ────────────────────────────────────────────────────────────
  const netIncome: BridgeLineItem = {
    key: "net_income",
    label: "Net Income",
    amounts: statement.netIncome,
    commentary:
      dataSource === "tax_return"
        ? "Sourced from Tax Return"
        : "Sourced from Company Financials",
  };

  // ── EBIT lines, itemized and never pre-aggregated ─────────────────────────
  const byRole = accountsByRole(accounts);
  const ebitLines: BridgeLineItem[] = [];
  for (const role of EBIT_ROLE_ORDER) {
    const roleAccounts = byRole.get(role);
    if (!roleAccounts || roleAccounts.length === 0) continue;
    const amounts = emptyAmounts(periods);
    for (const account of roleAccounts) {
      const ledger = statement.ledgerByAccount.get(account.id);
      if (ledger) sumAmounts(amounts, ledger, roleSign(role));
    }
    ebitLines.push({
      key: role,
      label: ROLE_LABELS[role],
      amounts: roundAmounts(amounts),
      commentary: ROLE_DEFAULT_COMMENTARY[role],
    });
  }

  // ── Reported EBITDA ───────────────────────────────────────────────────────
  const reportedEbitda = emptyAmounts(periods);
  sumAmounts(reportedEbitda, statement.netIncome);
  for (const line of ebitLines) sumAmounts(reportedEbitda, line.amounts);

  // ── Add-backs, grouped under user-defined subtotal headers ─────────────────
  const applicable = forDataSource(addbacks, dataSource);
  const resolved: ResolvedAddback[] = applicable.map((addback) =>
    resolveAddback(addback, entries, statement, periods, keyFor),
  );

  const ownerCompResolved = resolved.filter(
    (r) => r.addback.typeKey === "officer_compensation",
  );
  const regular = resolved.filter((r) => r.addback.typeKey !== "officer_compensation");

  const groupsById = new Map<string | null, ResolvedAddback[]>();
  for (const item of regular) {
    const id = item.addback.groupId ?? null;
    const bucket = groupsById.get(id);
    if (bucket) bucket.push(item);
    else groupsById.set(id, [item]);
  }

  const addbackGroups: BridgeGroup[] = [...groupsById.entries()].map(([id, items]) => {
    const subtotals = emptyAmounts(periods);
    for (const item of items) sumAmounts(subtotals, item.amounts);
    return {
      id,
      label: id === null ? null : (items[0]?.addback.groupLabel ?? null),
      items: items.map((item) => ({
        key: item.addback.id,
        label: item.addback.name,
        amounts: item.amounts,
        commentary: item.addback.commentary ?? null,
      })),
      subtotals: roundAmounts(subtotals),
    };
  });

  // ── Owner compensation: the sole Adjusted EBITDA vs SDE difference ─────────
  let ownerCompensation: BridgeLineItem | null = null;
  if (ownerCompResolved.length > 0) {
    const amounts = emptyAmounts(periods);
    for (const item of ownerCompResolved) sumAmounts(amounts, item.amounts);

    if (metric === "adjusted_ebitda" && marketRateReplacementSalary) {
      // Net of ONE replacement salary per fiscal year, prorated across months.
      const monthsPerYear = new Map<number, number>();
      for (const period of periods) {
        monthsPerYear.set(period.fiscalYear, (monthsPerYear.get(period.fiscalYear) ?? 0) + 1);
      }
      for (const period of periods) {
        const key =
          period.month === null
            ? String(period.fiscalYear)
            : `${period.fiscalYear}-${String(period.month).padStart(2, "0")}`;
        const share = marketRateReplacementSalary / (monthsPerYear.get(period.fiscalYear) ?? 1);
        amounts[key] = (amounts[key] ?? 0) - share;
      }
    }

    ownerCompensation = {
      key: "owner_compensation",
      label:
        metric === "adjusted_ebitda"
          ? "Owner Compensation (net of market-rate replacement)"
          : "Owner Compensation",
      amounts: roundAmounts(amounts),
      commentary: ROLE_DEFAULT_COMMENTARY.owner_compensation,
    };
  }

  // ── Adjusted EBITDA / SDE and margin ──────────────────────────────────────
  const adjusted = emptyAmounts(periods);
  sumAmounts(adjusted, reportedEbitda);
  for (const group of addbackGroups) sumAmounts(adjusted, group.subtotals);
  if (ownerCompensation) sumAmounts(adjusted, ownerCompensation.amounts);

  const margin = Object.fromEntries(
    Object.keys(adjusted).map((key) => {
      const revenue = statement.revenue[key] ?? 0;
      return [key, revenue === 0 ? 0 : ((adjusted[key] ?? 0) / revenue) * 100];
    }),
  );

  return {
    periods,
    netIncome,
    ebitLines,
    reportedEbitda: roundAmounts(reportedEbitda),
    addbackGroups,
    ownerCompensation,
    adjusted: roundAmounts(adjusted),
    metric,
    metricLabel: METRIC_LABELS[metric],
    revenue: statement.revenue,
    margin: roundAmounts(margin),
    unflaggedAccounts: unflaggedProfitLossAccounts(accounts),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      statementType: a.statementType,
      ebitdaRole: a.ebitdaRole ?? null,
    })),
  };
}
