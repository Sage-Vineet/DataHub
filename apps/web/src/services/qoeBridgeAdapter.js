/**
 * Adapts a `/qoe/bridge` response into the per-year metric shape the CIM
 * financial autofill consumes.
 *
 * `QE - 0004` requires the CIM's Adjusted EBITDA exhibit to reference the same
 * Add-Back Library records as the QoE bridge rather than a separate copy. This
 * adapter is how that holds: one server-side calculation, two readers. Before
 * it, the CIM re-derived EBITDA in the browser from a second set of label
 * regexes, so the two screens could — and did — disagree.
 */
import { fetchBridge } from "./qoeApi";

function component(bridge, key) {
  const line = (bridge.ebitLines || []).find((l) => l.key === key);
  return line ? line.amounts : {};
}

/** Bridge → `{ [year]: ebitdaData }` in the shape `enrichYearMetric` expects. */
export function bridgeToEbitdaByYear(bridge) {
  if (!bridge) return {};

  const depreciation = component(bridge, "depreciation");
  const amortization = component(bridge, "amortization");
  const interestExpense = component(bridge, "interest_expense");
  const interestIncome = component(bridge, "interest_income");
  const taxes = component(bridge, "income_tax");

  const entries = {};
  for (const period of bridge.periods || []) {
    // Annual columns only — the CIM is a per-fiscal-year exhibit.
    if (period.month !== null) continue;
    const key = String(period.fiscalYear);
    entries[period.fiscalYear] = {
      ebitda: bridge.reportedEbitda?.[key] ?? 0,
      adjustedEbitda: bridge.adjusted?.[key] ?? 0,
      revenue: bridge.revenue?.[key] ?? 0,
      components: {
        netIncome: { value: bridge.netIncome?.amounts?.[key] ?? 0 },
        depreciation: { value: depreciation[key] ?? 0 },
        amortization: { value: amortization[key] ?? 0 },
        interestExpense: { value: interestExpense[key] ?? 0 },
        // Reported as a deduction on the bridge; the CIM wants the magnitude.
        interestIncome: { value: Math.abs(interestIncome[key] ?? 0) },
        taxes: { value: taxes[key] ?? 0 },
      },
    };
  }
  return entries;
}

/** Add-back totals and count per year, from the same bridge response. */
export function bridgeToAdjustmentTotals(bridge, years = []) {
  const totals = {};
  let count = 0;
  if (!bridge) return { totals, count };

  for (const group of bridge.addbackGroups || []) {
    count += group.items.length;
  }
  if (bridge.ownerCompensation) count += 1;

  for (const year of years) {
    const key = String(year);
    const reported = bridge.reportedEbitda?.[key] ?? 0;
    const adjusted = bridge.adjusted?.[key] ?? 0;
    totals[key] = adjusted - reported;
  }
  return { totals, count };
}

/** One request serving both — the CIM and the QoE tab cannot drift apart. */
export async function loadBridgeForCim({ versionId, years, clientId }) {
  const bridge = await fetchBridge(
    { versionId, years, aggregation: "annual", dataSource: "company_financials" },
    { clientId },
  );
  return {
    bridge,
    ebitdaByYear: bridgeToEbitdaByYear(bridge),
    ...bridgeToAdjustmentTotals(bridge, years),
  };
}
