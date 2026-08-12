// ============================================================================
// Tax Reconciliation — source adapters
//
// Turns each of the page's data sources into the three inputs the calculation
// engine (`taxReconciliation.js`) consumes:
//
//     plRowsByYear : { [fiscalYear]: <hierarchical P&L row tree> }
//     taxYears     : { [fiscalYear]: { year, fileName, scheduleM1, data[] } }
//     bsPeriods    : [ { asOfDate, rows, source } ]
//
// The page previously collapsed each year's P&L into ten pre-searched numbers
// before anything could be validated, which is what made Net Income
// unverifiable (the components were gone by the time the page had them). These
// adapters keep the RAW row tree per year and hand it to the engine, so the
// classification and every footing check run against the real statement.
//
// Nothing here does arithmetic. Fetching lives in the page; these functions are
// pure so they can be reasoned about (and tested) independently of the network.
// ============================================================================

/**
 * Fiscal years present across every source, de-duplicated and ascending.
 * A year with a P&L but no return, or a return but no P&L, still gets a column —
 * it is then rendered with the missing side explicitly marked unavailable rather
 * than dropped (which is how a year silently disappeared before).
 */
export function unionFiscalYears(...sources) {
  const years = new Set();
  for (const source of sources) {
    for (const key of Object.keys(source || {})) {
      const y = Number(key);
      if (Number.isInteger(y) && y >= 1900 && y <= 2100) years.add(y);
    }
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * Normalise a `/manual-report-uploads/tax-data` response into `taxYears`.
 *
 * Carries `scheduleM1` through untouched (including `null`), because a null
 * Schedule M-1 and a Schedule M-1 stating zero are different facts and the
 * engine reports them differently — see resolveTaxReturnForYear.
 */
export function normalizeTaxYears(response) {
  const out = {};
  const years = response?.success && response.years ? response.years : {};
  for (const [key, entry] of Object.entries(years)) {
    const year = Number(entry?.year ?? key);
    if (!Number.isInteger(year)) continue;
    out[year] = {
      year,
      fileName: entry?.fileName || null,
      status: entry?.status || null,
      scheduleM1: entry?.scheduleM1 ?? null,
      // Schedule L — the return's own balance sheet. Carried through untouched
      // (including `null`) because the Cash/Accrual section states what the RETURN
      // reports for A/R and A/P separately from the book Balance Sheet it computes
      // the conversion from. A missing Schedule L must read "Not Reported", never
      // borrow the book balance — see taxReconciliation.readScheduleLLine.
      scheduleL: entry?.scheduleL ?? entry?.schedule_l ?? null,
      data: Array.isArray(entry?.data) ? entry.data : [],
    };
  }
  return out;
}

/**
 * Collect every Balance Sheet period a `/reports/balance-sheet` response holds.
 *
 * Both grains are included, monthly first: a fiscal year's closing period is
 * matched on its exact month (engine `resolveBsPeriod`), so a monthly export
 * supplies e.g. the December period directly, and a year-only Balance Sheet
 * supplies it via its own year-end `asOfDate`. Both are real periods from the
 * document set — no period is ever synthesized to fill a gap.
 *
 * `statement` is converted to the same row-tree shape the engine's
 * `flattenBsTree` walks (`bsStatementToRows`'s output), which the endpoint
 * already returns per-period for the yearly grain and which we rebuild for the
 * monthly grain from each month's `statement`.
 */
export function collectBsPeriods(response) {
  const periods = [];
  const seen = new Set();

  const push = (asOfDate, rows, source) => {
    if (!asOfDate || !rows?.length) return;
    const key = `${asOfDate}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    periods.push({ asOfDate: String(asOfDate).slice(0, 10), rows, source });
  };

  for (const entry of response?.monthly || []) {
    push(entry?.asOfDate, bsStatementToRowTree(entry?.statement), 'monthly');
  }
  for (const entry of response?.yearly || []) {
    push(entry?.asOfDate, bsStatementToRowTree(entry?.statement), 'yearly');
  }
  // A single-year response also exposes the tree directly.
  if (!periods.length && response?.hierarchicalRows?.length && response?.years?.length === 1) {
    push(`${response.years[0]}-12-31`, response.hierarchicalRows, 'report');
  }

  return periods.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
}

/**
 * Rebuild the section/hierarchy row tree from a balance-sheet statement.
 *
 * Mirrors keyReportReportService.bsStatementToRows — the shape the Balance Sheet
 * tab and CIM autofill already read — so the engine walks exactly the tree the
 * rest of the product does, rather than a second, divergent interpretation of
 * the same statement.
 */
export function bsStatementToRowTree(statement) {
  if (!statement) return [];
  const section = (key, label, node, total) => ({
    id: `bs-section-${key}`,
    name: label,
    type: 'header',
    amount: Number(total) || 0,
    children: [
      ...(node?.hierarchy || []),
      { id: `bs-total-${key}`, name: `Total ${label}`, type: 'total', amount: Number(total) || 0 },
    ],
  });
  return [
    section('assets', 'Assets', statement.assets, statement.totalAssets),
    section('liabilities', 'Liabilities', statement.liabilities, statement.totalLiabilities),
    section('equity', 'Equity', statement.equity, statement.totalEquity),
  ];
}

/**
 * Split the persisted flat override map into the engine's per-section buckets.
 *
 * The stored shape is `{ [year]: { [label]: { taxReturn, pl, userAdded?, deleted? } } }`
 * and predates the sectioned layout, so every bucket receives the SAME map: the
 * engine looks each label up by name and the label namespaces do not overlap
 * (cash/accrual rows are balance-sheet captions, Other rows are the template's
 * three residual captions, M1/Schedule K rows are tax-line categories). Passing
 * the map through unchanged is what keeps overrides a user saved before this
 * change working, which Part 18 requires.
 */
export function toEngineOverrides(overridesByYear) {
  const out = {};
  for (const [year, map] of Object.entries(overridesByYear || {})) {
    out[year] = { m1: map, cashAccrual: map, other: map, scheduleK: map };
  }
  return out;
}
