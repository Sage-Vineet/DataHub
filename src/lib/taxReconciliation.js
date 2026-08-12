// ============================================================================
// Tax Reconciliation — calculation engine
//
// Every number rendered on the Tax Reconciliation page is produced here. The
// module is deliberately PURE (no fetch, no React, no DOM) so the whole
// reconciliation can be executed and asserted in `taxReconciliation.test.js`.
//
// WHY THIS MODULE EXISTS (the client's UAT findings, and what each caused)
// ---------------------------------------------------------------------------
//  1. "Numbers do not foot." The page derived each line item by SEARCHING the
//     P&L for a label ("total expenses", "depreciation", …) with a bidirectional
//     substring test, then computed
//         allOtherExpenses = max(0, totalExpenses - knownExpenses)
//     Three independent defects in one expression:
//       • the same account could match two different line items (an account can
//         satisfy two patterns), so it was counted twice;
//       • an account matching NO pattern silently vanished from every bucket;
//       • max(0, …) clamped a legitimately negative residual to zero, which is
//         exactly the "hide the error" behaviour Part 20 forbids.
//     Gross Profit and Net Income could therefore never be guaranteed to foot.
//     FIX: the engine PARTITIONS the P&L's leaf accounts — every leaf lands in
//     exactly one bucket, and the buckets sum to the statement by construction
//     (classifyPlLeaf + buildFinancialStatement). Nothing is searched for, and
//     nothing is clamped.
//
//  2. "Net Income pulls correctly but is not derivable from the displayed P&L."
//     Nothing ever recomputed Net Income. FIX: deriveNetIncome() rebuilds it
//     from the displayed components and diagnoseNetIncome() reports the actual
//     signed difference plus the most likely cause (unclassified account,
//     duplicated account, wrong sign). The difference is EXPOSED, never forced.
//
//  3. "Reconciling items do not equal the total variance." getReconCheck() was
//         taxNetIncome - plNetIncome - sum(ScheduleK rows)
//     which mixes two different reconciliations: Schedule K distributive-share
//     items do not bridge book Net Income to tax Net Income, and no M-1,
//     cash/accrual or residual adjustment participated at all. FIX: one signed
//     chain (buildReconciliation) in which every term is an ADJUSTMENT in the
//     single convention documented under SIGN CONVENTIONS below.
//
//  4. "Unreconciled % of SDE" was the literal string "0.0%" in the JSX, and the
//     Excel/PDF exports divided by book Net Income instead of SDE. FIX:
//     computeSde() + unreconciledPctOfSde(), with every degenerate denominator
//     (zero / missing / negative SDE) returned as an explicit status instead of
//     Infinity or NaN.
//
// SIGN CONVENTIONS (one convention, applied everywhere — Part 5 / Part 10)
// ---------------------------------------------------------------------------
//  P&L / tax-return magnitudes: revenue, COGS and every expense arrive as
//  POSITIVE magnitudes and are combined by the statement formula. This is the
//  convention the source data already uses — see financialStatementService's
//  buildPlStatement (`operatingIncome = grossProfit - totalExpenses`) and
//  manualReportUploadService's validateTaxExtraction
//  (`netIncome = grossProfit - wages - dep - amor - interest - other`).
//  A contra-revenue or credit balance arrives negative from the source and is
//  carried through unchanged — it is never sign-flipped here.
//
//  TR Variance = Tax Return − P&L. Positive means the return reports MORE than
//  the books. This matches the convention already established in the page and
//  in its exports (`variance: taxReturn - pl`) and is used for every row without
//  exception.
//
//  ADJUSTMENT = the signed amount that moves BOOK income toward TAX income.
//  Consequently, for any line item that exists on both sides, its adjustment IS
//  its TR Variance — the two conventions are the same statement, so no row on
//  this page is ever computed under the opposite convention.
//
// THE RECONCILIATION CHAIN (Part 10)
// ---------------------------------------------------------------------------
//     Book Net Income (per P&L)
//   + Cash/Accrual adjustments        (basis conversion — Section 5)
//   + Other adjustments               (residual book-basis items — Section 6)
//   ------------------------------------------------------------------
//   = should equal  Reported M1 Book Net Income   (Schedule M-1 line 1)
//                                                 → Section 4 M1 Variance Check
//   + M1 adjustments                  (Schedule M-1 lines 2/3/5/6 — Section 2)
//   ------------------------------------------------------------------
//   = Calculated Reconciled Income
//   − Expected Reconciled Income      (the return's own reconciled figure)
//   = Unreconciled Difference                     → Section 7
//
//  The chain is anchored on Schedule M-1 because the client asked for the M1
//  mapping to be "the starting point for determining what should and should not
//  be included" (Part 6). M-1 line 1 "Net income (loss) per books" is the only
//  figure on a return that states what the preparer believed the books said, so
//  it is the correct anchor for a book-to-tax check.
//
//  Nothing in this module rounds a difference away, substitutes a neighbouring
//  fiscal year, or routes an unexplained amount into "Other" to make the report
//  balance. When a source is absent the result carries `available: false` and a
//  human-readable reason, and the dependent totals carry that reason forward.
// ============================================================================

// ── Numeric helpers ────────────────────────────────────────────────────────

/** Coerce anything to a finite number. Non-numeric / NaN / Infinity → 0. */
export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cent-level rounding. Applied ONLY to a final displayed/compared figure so
 * that IEEE-754 drift across a long summation chain cannot masquerade as a real
 * unreconciled difference. It never collapses a difference larger than half a
 * cent — see FOOTING_TOLERANCE.
 */
export function round2(value) {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}

/**
 * The largest difference attributable to representation/rounding rather than to
 * a genuine reconciliation failure. Half a cent per side of a comparison.
 *
 * This is a REPORTING threshold only: `footing.difference` always carries the
 * real signed amount, and `footing.ok` merely says whether it is within the
 * tolerance. No code path ever assigns the difference itself to zero.
 */
export const FOOTING_TOLERANCE = 0.01;

/**
 * A user override's numeric value, or `null` when there is no live override.
 *
 * Accepts both `{ adjustment }` and `{ taxReturn }`, because the persisted
 * override table (`tax_reconciliation_overrides`, written by the page's inline
 * editor) has always used `taxReturn` as its value field. Reading only
 * `adjustment` would silently ignore every override a user had already saved —
 * which Part 18 forbids.
 */
function overrideAmount(override) {
  if (!override || override.deleted) return null;
  const raw = override.adjustment != null ? override.adjustment : override.taxReturn;
  if (raw == null || raw === '') return null;
  return round2(num(raw));
}

/**
 * A persisted override of exactly 0 sitting on a line the return PRINTS.
 *
 * ── WHY THIS IS NOT TREATED AS A USER'S FIGURE (a real, traced case) ────────
 * The page used to render a Schedule K line the extraction had not read as `0`,
 * and those zeros were saved into `tax_reconciliation_overrides`. They then
 * outlive the fix: the extraction is corrected, the return's own 912 (Schedule K
 * 16c / M-1 line 3) and −391,087 (Schedule K line 1) are read correctly — and a
 * stored `0` overwrites both again. On the export that produced this rule,
 * "Nondeductible Expenses 0" and "Ordinary Business Income (loss) 0" were still
 * shown, tagged "manual entry", while Section 2 displayed the same nondeductible
 * expenses as 912 — the report contradicting itself.
 *
 * A saved 0 against a line that prints a figure carries no information a user
 * could have intended: "this line is nil" is expressed by REMOVING the row (the
 * grid has a delete control, and a deletion is honoured permanently). So a
 * placeholder zero is ignored in favour of the printed figure, and the row says
 * so rather than the override being deleted behind the user's back.
 *
 * Deliberately narrow — an override is still authoritative when it is
 *   • non-zero (any typed figure, including one that contradicts the return), or
 *   • `userAdded` (a row the user created, which may legitimately sit at 0), or
 *   • on a line the return does NOT print (nothing to prefer over it).
 */
function isPlaceholderZeroOverride(override, printedValue) {
  if (!override || override.deleted || override.userAdded) return false;
  const value = overrideAmount(override);
  if (value == null || value !== 0) return false;
  return printedValue != null && round2(num(printedValue)) !== 0;
}

/** A footing assertion: the actual signed difference is always preserved. */
function foots(label, actual, expected, detail = null) {
  const difference = round2(num(actual) - num(expected));
  return {
    label,
    actual: round2(actual),
    expected: round2(expected),
    difference,
    ok: Math.abs(difference) <= FOOTING_TOLERANCE,
    ...(detail ? { detail } : {}),
  };
}

const normalizeLabel = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ── P&L line items (Part 2) ────────────────────────────────────────────────

/**
 * The financial-statement block, in the client's template order. `sign` is the
 * coefficient the line carries in the Net Income formula, so deriveNetIncome
 * below is a single fold over this table rather than a hand-written expression
 * that can drift out of step with the rendered rows.
 *
 * `derived: true` marks a row that is itself a calculated subtotal and must
 * therefore NOT also be folded into the Net Income sum (that would double-count
 * its components — one of the causes of finding #1).
 */
export const PL_LINE_ITEMS = Object.freeze([
  { key: 'totalRevenue', label: 'Total Revenue', sign: +1 },
  { key: 'totalCogs', label: 'Total Cost of Goods Sold', sign: -1 },
  { key: 'grossProfit', label: 'Gross Profit', derived: true, subtotal: true },
  { key: 'officerWages', label: 'Officer Wages', sign: -1 },
  { key: 'depreciation', label: 'Depreciation Expense', sign: -1 },
  { key: 'amortization', label: 'Amortization Expense', sign: -1 },
  { key: 'interestExpense', label: 'Total Interest Expense', sign: -1 },
  { key: 'interestIncome', label: 'Total Interest Income', sign: +1 },
  { key: 'allOtherExpenses', label: 'All Other Expenses', sign: -1 },
  { key: 'allOtherIncome', label: 'All Other Income', sign: +1 },
  { key: 'netIncome', label: 'Net Income', derived: true, subtotal: true },
]);

/** Buckets a P&L leaf account can be partitioned into. */
export const PL_BUCKETS = Object.freeze([
  'totalRevenue',
  'totalCogs',
  'officerWages',
  'depreciation',
  'amortization',
  'interestExpense',
  'interestIncome',
  'allOtherExpenses',
  'allOtherIncome',
]);

// Bounded, ordered classifiers. ORDER MATTERS: the first match wins, and the
// more specific pattern is listed first, so "investment interest expense" can
// never be read as interest income and "amortization" is never swallowed by
// "depreciation & amortization".
//
// These patterns only ever classify a name the SOURCE DOCUMENT already assigned
// to a section (income / COGS / expense) — they never invent a section, and they
// never move an account between the revenue and expense sides. That is what
// makes the partition safe: a misfire can only mis-file an account WITHIN its
// own side of the statement, and the footing checks then surface it.
const OFFICER_WAGES_RE =
  /officer|shareholder (?:wage|salar|compensation)|owner (?:wage|salar|compensation|draw)|guaranteed payment/i;
const AMORTIZATION_RE = /amorti[sz]/i;
const DEPRECIATION_RE = /depreciat|\bdepr\b/i;
const INTEREST_RE = /interest/i;
const INTEREST_INCOME_RE = /interest (?:income|earned|revenue)|income from interest/i;
const INVESTMENT_INTEREST_RE = /investment interest/i;

/**
 * Section vocabulary. `sectionPath` is the chain of header names the leaf sits
 * under in the source document's own tree, so this reads real document
 * structure rather than guessing from the account's own name.
 */
const OTHER_BLOCK_RE = /^other\s+(income|expense)/i;
const COGS_SECTION_RE = /cost of (?:goods sold|sales|revenue)|^cogs$/i;
const INCOME_SECTION_RE = /^(income|revenue|sales)$|total (?:income|revenue)/i;
const EXPENSE_SECTION_RE = /expense|^cost /i;

/**
 * Which side of the statement a leaf belongs to, taken from its ancestry.
 * Returns 'income' | 'cogs' | 'expense' | null (null = cannot be placed, which
 * is reported rather than guessed).
 */
export function plSideFromSectionPath(sectionPath = []) {
  for (let i = sectionPath.length - 1; i >= 0; i -= 1) {
    const name = String(sectionPath[i] || '');
    if (!name) continue;
    if (COGS_SECTION_RE.test(name)) return 'cogs';
    if (OTHER_BLOCK_RE.test(name)) return /income/i.test(name) ? 'income' : 'expense';
    if (INCOME_SECTION_RE.test(name)) return 'income';
    if (EXPENSE_SECTION_RE.test(name)) return 'expense';
  }
  return null;
}

/** True when the leaf sits inside the statement's "Other Income/Expenses" block. */
function inOtherBlock(sectionPath = []) {
  return sectionPath.some((name) => OTHER_BLOCK_RE.test(String(name || '')));
}

/**
 * Partition a single P&L leaf account into exactly one bucket.
 *
 * @param {{name: string, sectionPath?: string[], side?: string}} leaf
 * @returns {{bucket: string|null, reason: string}} `bucket: null` means the leaf
 *   could not be placed — it is then reported as unclassified (and EXCLUDED
 *   from every total, so the footing check exposes it) rather than being
 *   silently swept into All Other Expenses.
 */
export function classifyPlLeaf(leaf) {
  const name = String(leaf?.name || '');
  const sectionPath = Array.isArray(leaf?.sectionPath) ? leaf.sectionPath : [];
  const side = leaf?.side || plSideFromSectionPath(sectionPath);

  if (!side) {
    return { bucket: null, reason: 'no income/COGS/expense section in the account\'s own ancestry' };
  }

  if (side === 'cogs') return { bucket: 'totalCogs', reason: 'Cost of Sales section' };

  if (side === 'income') {
    // Interest income is a distinct template line, and it must be recognised
    // BEFORE the generic other-income test so it is never folded away.
    if (INTEREST_INCOME_RE.test(name) || (INTEREST_RE.test(name) && !INVESTMENT_INTEREST_RE.test(name))) {
      return { bucket: 'interestIncome', reason: 'interest income account' };
    }
    if (inOtherBlock(sectionPath)) return { bucket: 'allOtherIncome', reason: 'Other Income block' };
    return { bucket: 'totalRevenue', reason: 'operating revenue' };
  }

  // side === 'expense'
  if (OFFICER_WAGES_RE.test(name)) return { bucket: 'officerWages', reason: 'officer/owner compensation' };
  // Amortization first: "Depreciation & Amortization" is a depreciation account
  // in every chart we have seen, but a standalone "Amortization Expense" must
  // not be captured by DEPRECIATION_RE's broader pattern.
  if (AMORTIZATION_RE.test(name) && !DEPRECIATION_RE.test(name)) {
    return { bucket: 'amortization', reason: 'amortization account' };
  }
  if (DEPRECIATION_RE.test(name)) return { bucket: 'depreciation', reason: 'depreciation account' };
  if (INTEREST_RE.test(name)) return { bucket: 'interestExpense', reason: 'interest expense account' };
  return { bucket: 'allOtherExpenses', reason: 'operating expense (residual)' };
}

/**
 * Flatten a source P&L tree into leaf accounts, carrying each leaf's real
 * ancestor chain.
 *
 * Handles every row shape the page's four data sources produce, all of which
 * share `{ name, type, amount, children }`:
 *   • Key Reports  — keyReportReportService.plYearlyToRows
 *   • Manual GL    — getManualStagedProfitLossSummary().hierarchicalRows
 *   • Manual Upload— /manual-report-uploads/pl-for-tax
 *   • QB Manual    — qb_synced_reports profit_and_loss rows
 *
 * `type: 'total'` and `type: 'header'` rows are SUBTOTALS, never leaves —
 * including them is what made the old implementation double-count. They are
 * returned separately as `subtotals` so the document's own stated Gross Profit
 * / Net Income can be compared against the derived figures.
 *
 * @param {Array} rows
 * @param {{yearKey?: string}} [options] When the tree carries multi-year
 *   `amounts` maps (Key Reports' `amounts: { y2024: n }`), `yearKey` selects the
 *   column. Without it, `amount` is used.
 */
export function flattenPlTree(rows, { yearKey = null } = {}) {
  const leaves = [];
  const subtotals = [];

  const amountOf = (row) => {
    if (yearKey && row?.amounts && Object.prototype.hasOwnProperty.call(row.amounts, yearKey)) {
      return num(row.amounts[yearKey]);
    }
    return num(row?.amount);
  };

  const walk = (list, sectionPath) => {
    for (const row of list || []) {
      if (!row) continue;
      const name = String(row.name ?? row.label ?? '').trim();
      if (!name) continue;
      const type = String(row.type || 'data').toLowerCase();
      const children = Array.isArray(row.children) ? row.children : [];

      if (type === 'header' || children.length) {
        subtotals.push({ name, sectionPath, amount: amountOf(row), type: 'header' });
        walk(children, [...sectionPath, name]);
        continue;
      }
      if (type === 'total') {
        subtotals.push({ name, sectionPath, amount: amountOf(row), type: 'total' });
        continue;
      }
      leaves.push({ name, sectionPath, amount: amountOf(row) });
    }
  };

  walk(rows, []);
  return { leaves, subtotals };
}

/** Locate a stated subtotal by name, preferring the last (outermost) match. */
function findSubtotal(subtotals, patterns) {
  const matches = (subtotals || []).filter((row) => {
    const key = normalizeLabel(row.name);
    return patterns.some((rx) => rx.test(key));
  });
  return matches.length ? matches[matches.length - 1] : null;
}

const GROSS_PROFIT_STATED_RE = [/^gross (?:profit|margin)$/, /^total gross profit$/];
const NET_INCOME_STATED_RE = [/^net (?:income|loss|earnings|profit)$/, /^net income loss$/];

/**
 * Build the Section 1 financial-statement block from a source P&L tree.
 *
 * The returned `values` are a PARTITION of the tree's leaves, so:
 *   grossProfit = totalRevenue − totalCogs                      (exact)
 *   netIncome   = Σ(line.sign × line.value) over non-derived lines (exact)
 * both hold by construction. `footing` records those two identities anyway, plus
 * the comparison against whatever Gross Profit / Net Income the source document
 * states for itself — which is the check that actually surfaces a source-data
 * problem (finding #2).
 */
export function buildFinancialStatement(rows, { yearKey = null } = {}) {
  const { leaves, subtotals } = flattenPlTree(rows, { yearKey });

  const values = Object.fromEntries(PL_BUCKETS.map((k) => [k, 0]));
  const provenance = Object.fromEntries(PL_BUCKETS.map((k) => [k, []]));
  const unclassified = [];

  for (const leaf of leaves) {
    const { bucket, reason } = classifyPlLeaf(leaf);
    if (!bucket) {
      unclassified.push({ ...leaf, reason });
      continue;
    }
    values[bucket] = round2(values[bucket] + leaf.amount);
    provenance[bucket].push({ account: leaf.name, amount: leaf.amount, sectionPath: leaf.sectionPath, reason });
  }

  const grossProfit = round2(values.totalRevenue - values.totalCogs);
  const derivedNetIncome = deriveNetIncome({ ...values, grossProfit });

  const statedGrossProfit = findSubtotal(subtotals, GROSS_PROFIT_STATED_RE);
  const statedNetIncome = findSubtotal(subtotals, NET_INCOME_STATED_RE);

  const lineItems = PL_LINE_ITEMS.map((item) => ({
    ...item,
    value:
      item.key === 'grossProfit' ? grossProfit
        : item.key === 'netIncome' ? (statedNetIncome ? round2(statedNetIncome.amount) : derivedNetIncome)
          : round2(values[item.key]),
  }));

  const footing = [
    foots('Gross Profit = Total Revenue − Total Cost of Goods Sold', grossProfit,
      round2(values.totalRevenue - values.totalCogs)),
    foots('Net Income = Gross Profit − expenses + other income', derivedNetIncome,
      deriveNetIncome({ ...values, grossProfit })),
  ];

  if (statedGrossProfit) {
    footing.push(foots(
      'Gross Profit agrees with the P&L\'s stated Gross Profit',
      grossProfit, round2(statedGrossProfit.amount),
      `stated as "${statedGrossProfit.name}"`,
    ));
  }

  const netIncomeCheck = statedNetIncome
    ? foots(
      'Net Income agrees with the P&L\'s stated Net Income',
      derivedNetIncome, round2(statedNetIncome.amount),
      `stated as "${statedNetIncome.name}"`,
    )
    : null;
  if (netIncomeCheck) footing.push(netIncomeCheck);

  return {
    values: { ...values, grossProfit },
    lineItems,
    provenance,
    unclassified,
    leafCount: leaves.length,
    sourceNetIncome: statedNetIncome ? round2(statedNetIncome.amount) : null,
    derivedNetIncome,
    netIncomeDiagnosis: diagnoseNetIncome({
      sourceNetIncome: statedNetIncome ? round2(statedNetIncome.amount) : null,
      derivedNetIncome,
      values,
      unclassified,
    }),
    footing,
  };
}

/**
 * Net Income rebuilt from the displayed components (Part 3).
 *
 * Folds PL_LINE_ITEMS' own `sign` coefficients so this can never drift out of
 * step with the rendered rows, and skips `derived` rows so a subtotal is never
 * added on top of the components it already summarises.
 */
export function deriveNetIncome(values) {
  let total = 0;
  for (const item of PL_LINE_ITEMS) {
    if (item.derived) continue;
    total += item.sign * num(values?.[item.key]);
  }
  return round2(total);
}

/**
 * Explain a source-vs-derived Net Income difference (Part 3) instead of forcing
 * the two to agree. Returns the actual signed difference plus the candidate
 * causes, ordered by how closely each one accounts for the gap.
 */
export function diagnoseNetIncome({ sourceNetIncome, derivedNetIncome, values, unclassified }) {
  if (sourceNetIncome == null) {
    return {
      status: 'no_source_figure',
      difference: 0,
      message: 'The P&L states no Net Income line; the derived figure is shown and used.',
      candidates: [],
    };
  }
  const difference = round2(num(sourceNetIncome) - num(derivedNetIncome));
  if (Math.abs(difference) <= FOOTING_TOLERANCE) {
    return { status: 'agrees', difference, message: 'Derived Net Income agrees with the P&L.', candidates: [] };
  }

  const candidates = [];
  const unclassifiedTotal = round2((unclassified || []).reduce((s, r) => s + num(r.amount), 0));
  if (unclassified?.length) {
    candidates.push({
      cause: 'unclassified_accounts',
      amount: unclassifiedTotal,
      detail:
        `${unclassified.length} account(s) could not be placed in any section and are excluded from every ` +
        `total: ${unclassified.slice(0, 8).map((r) => r.name).join(', ')}` +
        `${unclassified.length > 8 ? ', …' : ''}.`,
      explainsDifference: Math.abs(round2(unclassifiedTotal - difference)) <= FOOTING_TOLERANCE
        || Math.abs(round2(unclassifiedTotal + difference)) <= FOOTING_TOLERANCE,
    });
  }

  // A difference of exactly 2× a component is the signature of that component
  // carrying the wrong sign; a difference of exactly 1× it is the signature of
  // the component being missing from, or duplicated in, the sum.
  for (const key of PL_BUCKETS) {
    const v = round2(num(values?.[key]));
    if (Math.abs(v) <= FOOTING_TOLERANCE) continue;
    if (Math.abs(round2(Math.abs(difference) - Math.abs(2 * v))) <= FOOTING_TOLERANCE) {
      candidates.push({
        cause: 'incorrect_sign',
        component: key,
        amount: v,
        detail: `The difference is exactly twice ${key} (${v}) — that component's sign is inverted.`,
        explainsDifference: true,
      });
    } else if (Math.abs(round2(Math.abs(difference) - Math.abs(v))) <= FOOTING_TOLERANCE) {
      candidates.push({
        cause: difference > 0 ? 'missing_component' : 'duplicated_component',
        component: key,
        amount: v,
        detail:
          `The difference equals ${key} (${v}) — that component is ` +
          `${difference > 0 ? 'missing from' : 'counted twice in'} the statement.`,
        explainsDifference: true,
      });
    }
  }

  candidates.sort((a, b) => Number(b.explainsDifference) - Number(a.explainsDifference));
  return {
    status: 'differs',
    difference,
    message:
      `The P&L states Net Income of ${sourceNetIncome} but the displayed components derive ` +
      `${derivedNetIncome} — a difference of ${difference}.`,
    candidates,
  };
}

// ── Tax return side (Part 4) ───────────────────────────────────────────────

/**
 * Resolve the tax return for ONE fiscal year, with no nearest-year fallback.
 *
 * The page's four loaders already key tax data by year (`taxRes.years[year]`),
 * so mixing years is only possible by reading the wrong key. This wrapper makes
 * that impossible for callers and returns an explicit unavailable result — which
 * the UI renders as "no return on file" rather than as zeros (Part 4).
 */
export function resolveTaxReturnForYear(taxYears, fiscalYear) {
  const year = Number(fiscalYear);
  const entry = taxYears?.[year] ?? taxYears?.[String(year)] ?? null;
  if (!entry) {
    return {
      available: false,
      fiscalYear: year,
      reason: `No tax return on file for FY ${year}.`,
      data: [],
      byLabel: new Map(),
    };
  }
  const rowYear = Number(entry.year ?? entry.taxYear ?? year);
  if (rowYear && rowYear !== year) {
    // A return whose own stated year contradicts the key it is filed under is
    // never silently accepted — that is precisely how one year's figures leak
    // into another's column.
    return {
      available: false,
      fiscalYear: year,
      reason:
        `The return filed under FY ${year} states tax year ${rowYear}. ` +
        `It is not used for FY ${year}; re-link the correct return in Key Reports.`,
      data: [],
      byLabel: new Map(),
    };
  }
  const data = Array.isArray(entry.data) ? entry.data : [];
  return {
    available: true,
    fiscalYear: year,
    fileName: entry.fileName || null,
    status: entry.status || null,
    scheduleM1: entry.scheduleM1 || entry.schedule_m1 || null,
    // Schedule L (the return's own balance sheet) is carried when the extraction
    // published it. It is the ONLY admissible source for a tax-return balance in
    // the Cash/Accrual section — the book Balance Sheet is a different document
    // and must never be presented as a return figure.
    scheduleL: entry.scheduleL || entry.schedule_l || null,
    data,
    byLabel: new Map(data.map((row) => [normalizeLabel(row.label), row])),
    reason: null,
  };
}

/**
 * Read ONE line of the return, distinguishing "the return states x" from "the
 * return does not state this line at all".
 *
 * The publisher marks a row it could not read on the form as
 * `source.reported: false` and carries a display 0 (see manualReportUploadService
 * `taxPage1Rows`/`buildTaxReturnResponseData`). Treating that 0 as a reading is
 * how a blank form line becomes a confident tax-return figure on screen, so every
 * consumer in this module goes through here instead of touching `row.taxReturn`:
 *
 *   { reported: true,  value: <number> }  the figure printed at that line
 *   { reported: false, value: null }      blank / absent — rendered "Not Reported"
 */
export function readTaxReturnLine(taxReturn, label) {
  if (!taxReturn?.available) {
    return { reported: false, value: null, source: null, reason: taxReturn?.reason || 'No tax return available.' };
  }
  const row = taxReturn.byLabel.get(normalizeLabel(label));
  if (!row) {
    return { reported: false, value: null, source: null, reason: `The return states no "${label}" line.` };
  }
  const printed = row.source?.reported !== false && row.taxReturn != null && row.taxReturn !== '';
  return {
    reported: printed,
    value: printed ? round2(num(row.taxReturn)) : null,
    source: row.source || null,
    reason: printed ? null : `"${label}" is blank on the return, so no figure is reported for it.`,
  };
}

/** TR Variance — the page's single variance convention. */
export function trVariance(taxReturnAmount, plAmount) {
  return round2(num(taxReturnAmount) - num(plAmount));
}

// ── M1 adjustments (Part 6) ────────────────────────────────────────────────

/**
 * How a tax-return / Schedule K line participates in the book-to-tax bridge.
 *
 *  'add'           — recorded on the books but not deducted in ordinary
 *                    business income, so it is added back going book → tax.
 *  'subtract'      — included in book income but separately stated (removed
 *                    from ordinary business income), so it is subtracted.
 *  'informational' — carries NO income effect: an AMT disclosure, an equity
 *                    movement, a credit, or a restatement of an amount already
 *                    counted under another line. It is DISPLAYED with its source
 *                    and tax year and excluded from the M1 total.
 *
 * `informational` is the mechanism that keeps this honest. The alternative — the
 * old behaviour — was to treat every unmatched Schedule K line as an income
 * adjustment, which is what made the reconciliation drift and what Part 9
 * forbids. An informational row is visible and explained; it just cannot move
 * the total.
 */
export const M1_EFFECTS = Object.freeze({ ADD: 'add', SUBTRACT: 'subtract', INFO: 'informational' });

/**
 * M1 mapping table (Part 6). Ordered — first match wins, most specific first.
 * Patterns run against a normalised label, so casing/punctuation variants of the
 * same line ("Other credits" vs "Other Credits") collapse onto one entry, which
 * is the duplicate-category problem in Part 12.
 */
const M1_MAP = Object.freeze([
  // ── Separately stated INCOME: in book income, out of ordinary income ──
  { rx: /^tax exempt interest income$/, category: 'Tax-Exempt Interest Income', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5' },
  { rx: /^other tax exempt income$/, category: 'Other Tax-Exempt Income', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5' },
  { rx: /investment interest expense/, category: 'Investment Interest Expense', effect: M1_EFFECTS.ADD, m1Line: 'M-1 line 3' },
  { rx: /^interest income$/, category: 'Interest Income per Tax Return', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5', scheduleK: true },
  { rx: /dividend/, category: 'Dividend Income', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5', scheduleK: true },
  { rx: /^royalties$/, category: 'Royalties', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5', scheduleK: true },
  { rx: /capital gain|section 1231|unrecaptured section 1250|collectibles/, category: 'Capital Gain (Loss)', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5', scheduleK: true },
  { rx: /net rental|rental real estate|rental income/, category: 'Rental Income (Loss)', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5', scheduleK: true },
  { rx: /^other income( loss)?$/, category: 'Other Income (Loss)', effect: M1_EFFECTS.SUBTRACT, m1Line: 'M-1 line 5', scheduleK: true },

  // ── Separately stated DEDUCTIONS: book expense, out of ordinary income ──
  { rx: /section 179/, category: 'Section 179 Depreciation', effect: M1_EFFECTS.ADD, m1Line: 'M-1 line 3', scheduleK: true },
  { rx: /charitable|contributions? charitable/, category: 'Charitable Donations', effect: M1_EFFECTS.ADD, m1Line: 'M-1 line 3', scheduleK: true },
  { rx: /section 59 e 2/, category: 'Section 59(e)(2) Expenditures', effect: M1_EFFECTS.ADD, m1Line: 'M-1 line 3', scheduleK: true },
  { rx: /^other deductions$/, category: 'Other Deductions', effect: M1_EFFECTS.ADD, m1Line: 'M-1 line 3', scheduleK: true },
  { rx: /nondeductible expense/, category: 'Nondeductible Expenses', effect: M1_EFFECTS.ADD, m1Line: 'M-1 line 3', scheduleK: true },

  // ── Informational: no income effect (see M1_EFFECTS doc comment) ──
  { rx: /post 1986 depreciation/, category: 'Post-1986 Depreciation', effect: M1_EFFECTS.INFO, note: 'AMT disclosure (Schedule K AMT items) — no effect on ordinary business income.', scheduleK: true },
  { rx: /adjusted gain or loss|depletion|oil gas geothermal|other amt item/, category: 'AMT Items', effect: M1_EFFECTS.INFO, note: 'AMT disclosure — no effect on ordinary business income.', scheduleK: true },
  { rx: /^distributions/, category: 'Distributions', effect: M1_EFFECTS.INFO, note: 'Equity distribution, not an income or expense item.', scheduleK: true },
  { rx: /repayment of loans/, category: 'Repayment of Loans from Shareholders', effect: M1_EFFECTS.INFO, note: 'Equity/loan movement, not an income or expense item.', scheduleK: true },
  { rx: /^investment income$/, category: 'Investment Income', effect: M1_EFFECTS.INFO, note: 'Restates portfolio income already adjusted under Interest Income / Dividend Income — counting it again would double-adjust.', scheduleK: true },
  { rx: /^investment expenses$/, category: 'Investment Expenses', effect: M1_EFFECTS.INFO, note: 'Restates an amount already adjusted under Investment Interest Expense.', scheduleK: true },
  { rx: /credit/, category: 'Credits', effect: M1_EFFECTS.INFO, note: 'Tax credit — reduces tax, not book or taxable income.', scheduleK: true },
  { rx: /foreign tax/, category: 'Foreign Taxes Paid or Accrued', effect: M1_EFFECTS.INFO, note: 'Creditable tax, not an income adjustment.', scheduleK: true },
  { rx: /self employment|gross farming|gross nonfarm/, category: 'Self-Employment Items', effect: M1_EFFECTS.INFO, note: 'Self-employment disclosure — no effect on ordinary business income.', scheduleK: true },
  { rx: /guaranteed payment/, category: 'Guaranteed Payments', effect: M1_EFFECTS.INFO, note: 'Already reported on page 1 and shown as Officer Wages in the financial statement section.', scheduleK: true },
  { rx: /^other items and amounts$/, category: 'Other Items and Amounts', effect: M1_EFFECTS.INFO, note: 'Unclassified Schedule K disclosure — no stated income effect.', scheduleK: true },
  // Schedule K line 1 / page 1 line 22. Listed so that every wording of it —
  // "Ordinary business income (loss)", "Ordinary Business Income (Loss)" — lands
  // on ONE category. Two rows differing only by the case of "(loss)" is the
  // duplicate-category defect, and it was visible on a real export beside the
  // correctly-read figure. It carries no income effect: it is the tax bottom line
  // the reconciliation targets, not an adjustment to it.
  { rx: /^ordinary business income( loss)?$/, category: 'Ordinary Business Income (Loss)', effect: M1_EFFECTS.INFO, note: 'Schedule K line 1 restates page 1 line 22 — the figure the reconciliation targets, not an adjustment to it.', scheduleK: true },
]);

/**
 * Map a tax-return / Schedule K label onto its M1 category and income effect.
 * Returns `null` when nothing matches, which is what routes the item into the
 * Section 6 "Other" bucket — but only after Part 9's full mapping cascade has
 * been attempted (see classifyAdjustment).
 */
export function mapToM1(label) {
  const key = normalizeLabel(label);
  if (!key) return null;
  for (const entry of M1_MAP) {
    if (entry.rx.test(key)) {
      return {
        category: entry.category,
        effect: entry.effect,
        m1Line: entry.m1Line || null,
        note: entry.note || null,
        scheduleK: Boolean(entry.scheduleK),
      };
    }
  }
  return null;
}

/** Canonical label for a Schedule K line — collapses casing/spelling variants (Part 12). */
export function canonicalScheduleKLabel(label) {
  const mapped = mapToM1(label);
  if (mapped) return mapped.category;
  const raw = String(label || '').trim();
  if (!raw) return '';
  // Title-case the first letter of each word so "other credits" and "Other
  // Credits" cannot appear as two rows, while preserving the source identity
  // (which is carried separately on every item as `sourceLabel`).
  return raw.replace(/\S+/g, (word) => (word.length > 3 || /^[A-Z]/.test(word)
    ? word.charAt(0).toUpperCase() + word.slice(1)
    : word));
}

/**
 * Part 9's mapping cascade, in order: M1 → Schedule K → cash/accrual → known
 * P&L/tax classification → Other. `Other` is the LAST resort and always carries
 * the reason it landed there.
 */
export function classifyAdjustment(label, { plLineLabels = new Set() } = {}) {
  const m1 = mapToM1(label);
  if (m1) {
    return {
      mapping: m1.scheduleK ? 'schedule_k' : 'm1',
      category: m1.category,
      effect: m1.effect,
      m1Line: m1.m1Line,
      note: m1.note,
      reason: `Matched the M1 schedule mapping (${m1.category}).`,
    };
  }
  const key = normalizeLabel(label);
  if (CASH_ACCRUAL_MAP.some((e) => e.rx.test(key))) {
    return {
      mapping: 'cash_accrual',
      category: canonicalScheduleKLabel(label),
      effect: M1_EFFECTS.INFO,
      reason: 'Balance-sheet driven cash/accrual item — calculated in the Cash/Accrual section.',
    };
  }
  if (plLineLabels.has(key)) {
    return {
      mapping: 'financial_statement',
      category: canonicalScheduleKLabel(label),
      effect: M1_EFFECTS.INFO,
      reason: 'Already reported as a financial-statement line item; its variance is shown there.',
    };
  }
  return {
    mapping: 'other',
    category: canonicalScheduleKLabel(label),
    effect: M1_EFFECTS.INFO,
    reason:
      'No M1, Schedule K, cash/accrual or financial-statement mapping matched. Shown under Other ' +
      'Adjustments with no income effect until it is mapped — it is never used to force the report to balance.',
  };
}

/**
 * Build Section 2 (M1 Adjustments) for one fiscal year.
 *
 * Every returned item carries the full audit trail Part 6 requires: source,
 * fiscal year, tax return value, P&L value where applicable, adjustment amount,
 * mapping/category and the account or Schedule K source.
 *
 * @param {object} args
 * @param {ReturnType<typeof resolveTaxReturnForYear>} args.taxReturn
 * @param {object} args.plValues buildFinancialStatement().values
 * @param {object} [args.overrides] user-entered values, keyed by canonical label
 */
export function buildM1Adjustments({ taxReturn, plValues = {}, overrides = {} }) {
  if (!taxReturn?.available) {
    return {
      available: false,
      reason: taxReturn?.reason || 'No tax return available.',
      items: [],
      total: 0,
      informationalItems: [],
    };
  }

  const plLineLabels = new Set(PL_LINE_ITEMS.map((i) => normalizeLabel(i.label)));
  const byCategory = new Map();

  /**
   * Record one source line against its M1 category.
   *
   * `mode` decides what happens when the category already holds a value:
   *
   *   'sum'     — a DIFFERENT source line in the same category (Schedule K 13a
   *               "Charitable Contributions Cash" and 13b "…Noncash" both map to
   *               Charitable Donations). Two real amounts, so they add.
   *   'replace' — the SAME amount restated on another schedule. Schedule M-1
   *               line 3's "Nondeductible Expenses" and Schedule K line 16c's are
   *               one figure reported in two places; adding them would DOUBLE the
   *               adjustment and put the whole reconciliation out by that amount.
   *               M-1 is the client's stated starting point (Part 6), so it wins.
   */
  const consider = (sourceLabel, taxValue, sourceKind, mode) => {
    const classification = classifyAdjustment(sourceLabel, { plLineLabels });
    if (classification.mapping === 'financial_statement' || classification.mapping === 'cash_accrual') return;

    const category = classification.category;
    const existing = byCategory.get(category);
    if (existing) {
      if (mode === 'replace') {
        existing.taxReturn = round2(num(taxValue));
        existing.sourceKind = sourceKind;
        existing.m1Line = classification.m1Line || existing.m1Line;
        if (!existing.sourceLabels.includes(sourceLabel)) existing.sourceLabels.push(sourceLabel);
        existing.reason =
          `${classification.reason} Schedule M-1 states this line directly, so its figure is used ` +
          `in place of the Schedule K reading of the same amount.`;
      } else if (!existing.sourceLabels.includes(sourceLabel)) {
        existing.taxReturn = round2(existing.taxReturn + num(taxValue));
        existing.sourceLabels.push(sourceLabel);
      }
      return;
    }
    byCategory.set(category, {
      category,
      sourceLabel,
      sourceLabels: [sourceLabel],
      sourceKind,
      mapping: classification.mapping,
      effect: classification.effect,
      m1Line: classification.m1Line || null,
      note: classification.note || null,
      reason: classification.reason,
      taxReturn: round2(num(taxValue)),
    });
  };

  for (const row of taxReturn.data) {
    if (!row?.isReconcilingItem) continue;
    // A line the extraction did not read carries no figure, so it cannot carry an
    // adjustment either. Treating it as 0 would put a row claiming "the return
    // adjusts nothing here" beside a Schedule K line that prints 912 — a zero
    // nobody can distinguish from a preparer's nil. If another schedule states the
    // same line (M-1 below), that reading creates the row instead.
    if (row.source?.reported === false || row.taxReturn == null) continue;
    consider(row.label, row.taxReturn, 'schedule_k', 'sum');
  }
  // Schedule M-1 detail lines, when the return's M-1 was extracted. These are the
  // client's stated starting point (Part 6), so an M-1 line REPLACES a Schedule K
  // line that canonicalises onto the same category rather than adding to it — the
  // two schedules report the same figure, not two figures.
  for (const line of taxReturn.scheduleM1?.lines || []) {
    consider(line.label, line.amount, 'schedule_m1', 'replace');
  }

  const items = [];
  const informationalItems = [];

  for (const entry of byCategory.values()) {
    const override = overrides?.[entry.category];
    if (override?.deleted) continue;
    // A 0 saved against a line the return prints is residue from the era when an
    // unread line was displayed as 0 — see isPlaceholderZeroOverride.
    const ignoredOverride = isPlaceholderZeroOverride(override, entry.taxReturn);
    const overrideValue = ignoredOverride ? null : overrideAmount(override);
    const taxValue = overrideValue != null ? overrideValue : entry.taxReturn;

    // P&L counterpart where one exists — interest income is the case the client
    // called out ("Interest Income per tax returns"), and showing the book figure
    // beside it is what makes the residual in Section 6 explainable.
    const plValue = entry.category === 'Interest Income per Tax Return'
      ? round2(num(plValues.interestIncome))
      : null;

    const sign = entry.effect === M1_EFFECTS.ADD ? +1 : entry.effect === M1_EFFECTS.SUBTRACT ? -1 : 0;
    const item = {
      ...entry,
      fiscalYear: taxReturn.fiscalYear,
      sourceDocument: taxReturn.fileName || null,
      taxReturn: taxValue,
      pl: plValue,
      adjustment: round2(sign * taxValue),
      hasIncomeEffect: sign !== 0,
      isOverride: Boolean(override && !override.deleted) && !ignoredOverride,
      ignoredOverride,
      ...(ignoredOverride
        ? {
          reason: `${entry.reason} A saved value of 0 for this line is ignored in favour of the `
            + 'figure the return prints; delete the row if the line should not appear.',
        }
        : {}),
    };
    if (item.hasIncomeEffect) items.push(item);
    else informationalItems.push(item);
  }

  const ordered = [...items].sort((a, b) => a.category.localeCompare(b.category));
  const total = round2(ordered.reduce((s, i) => s + i.adjustment, 0));

  return {
    available: true,
    reason: null,
    items: ordered,
    informationalItems: informationalItems.sort((a, b) => a.category.localeCompare(b.category)),
    total,
    footing: foots('M1 Adjustments total = sum of its income-effect items', total,
      round2(ordered.reduce((s, i) => s + i.adjustment, 0))),
  };
}

// ── Cash / accrual adjustments (Part 7) ────────────────────────────────────

/**
 * The client's template rows, each resolved from the Balance Sheet by a bounded
 * pattern over the account's own name WITHIN its balance-sheet section — never
 * from the account name alone (an "A/R Retention" liability must not be read as
 * a receivable).
 *
 * `sign` is the coefficient the PERIOD CHANGE carries when converting accrual
 * books to a cash-basis return:
 *     Cash income = Accrual income − ΔReceivables + ΔPayables
 * Retentions receivable behave as receivables. This is one convention applied to
 * all three rows (Part 7).
 */
const CASH_ACCRUAL_MAP = Object.freeze([
  { rx: /(?:a\s*\/?\s*r|accounts? receivable).*(?:retention|retainage)|retention.*receivable|retainage receivable/, label: 'A/R Retentions', section: 'assets', sign: -1, scheduleLLine: null, scheduleLCaption: null },
  { rx: /accounts? receivable|^a\s*\/?\s*r$|trade receivable/, label: 'Accounts Receivable', section: 'assets', sign: -1, scheduleLLine: '2a', scheduleLCaption: 'Trade notes and accounts receivable' },
  { rx: /accounts? payable|^a\s*\/?\s*p$|trade payable/, label: 'Accounts Payable', section: 'liabilities', sign: +1, scheduleLLine: '16', scheduleLCaption: 'Accounts payable' },
]);

/**
 * The RETURN's own reading for a cash/accrual row, from Schedule L only.
 *
 * ── WHY THIS EXISTS (a real, traced misreading) ─────────────────────────────
 * The three Cash/Accrual rows are computed from the BOOK Balance Sheet, and the
 * grid's global column header says "Tax Return" over the middle slot. On a real
 * export, Accounts Receivable therefore read "218,298 | 227,670" as if 227,670
 * were Schedule L line 2a — which is BLANK on that return, because the return was
 * filed on the cash basis. The balances were correctly sourced; presenting one of
 * them under a tax-return heading was not.
 *
 * So the return's position on these lines is now read separately and only from
 * Schedule L. When the extraction published no Schedule L (or the line is blank),
 * the answer is NOT REPORTED — never the book balance, and never 0. A blank
 * Schedule L line on a cash-basis return is a fact about the return, and it is
 * the fact the reviewer needs to see next to a book-basis conversion.
 *
 * Accepts either shape the publisher may use:
 *   [{ line: '2a', beginningValue: n|null, ending_value: n|null }, …]
 *   { '2a': { beginning: n|null, ending: n|null } }
 */
export function readScheduleLLine(scheduleL, line) {
  const notReported = (reason) => ({ reported: false, beginning: null, ending: null, reason });
  if (!line) {
    return notReported('This row has no single Schedule L line on the return; the return reports no equivalent.');
  }
  if (!scheduleL) {
    return notReported(
      `Schedule L was not published with this return, so its line ${line} cannot be read. `
      + 'The adjustment is computed from the Balance Sheet, which is a separate document.',
    );
  }
  const wanted = String(line).toLowerCase();
  const entry = Array.isArray(scheduleL)
    ? scheduleL.find((row) => String(row?.line ?? '').toLowerCase() === wanted)
    : (scheduleL[line] ?? scheduleL[wanted] ?? null);
  if (!entry) return notReported(`Schedule L line ${line} is not present in the published return data.`);

  const pick = (...keys) => {
    for (const key of keys) {
      const v = entry[key];
      if (v !== undefined && v !== null && v !== '') return round2(num(v));
    }
    return null;
  };
  const beginning = pick('beginningValue', 'beginning_value', 'beginning');
  const ending = pick('endingValue', 'ending_value', 'ending');
  if (beginning == null && ending == null) {
    return notReported(`Schedule L line ${line} is blank on the return (both columns).`);
  }
  return { reported: true, beginning, ending, reason: null };
}

/** Row order the client's template uses. */
export const CASH_ACCRUAL_ROWS = Object.freeze(['Accounts Receivable', 'A/R Retentions', 'Accounts Payable']);

/**
 * Flatten a balance-sheet statement tree (keyReportReportService.bsStatementToRows)
 * into leaf accounts carrying their section.
 */
export function flattenBsTree(rows) {
  const leaves = [];
  const walk = (list, sectionPath) => {
    for (const row of list || []) {
      if (!row) continue;
      const name = String(row.name ?? row.label ?? '').trim();
      if (!name) continue;
      const children = Array.isArray(row.children) ? row.children : [];
      if (children.length) {
        walk(children, [...sectionPath, name]);
        continue;
      }
      // A `total` row is a rollup of leaves already walked — including it would
      // double the section.
      if (String(row.type || '').toLowerCase() === 'total') continue;
      leaves.push({ name, sectionPath, amount: num(row.amount) });
    }
  };
  walk(rows, []);
  return leaves;
}

function bsSectionOf(sectionPath = []) {
  for (const name of sectionPath) {
    const n = String(name || '').toLowerCase();
    if (/^assets?$/.test(n) || /current assets|fixed assets|other assets/.test(n)) return 'assets';
    if (/^liabilit/.test(n) || /current liabilit|long.?term liabilit/.test(n)) return 'liabilities';
    if (/^equity$/.test(n)) return 'equity';
  }
  return null;
}

/** Sum the balance-sheet accounts belonging to one cash/accrual template row. */
export function bsAmountFor(bsRows, templateLabel) {
  const entry = CASH_ACCRUAL_MAP.find((e) => e.label === templateLabel);
  if (!entry) return { amount: 0, accounts: [] };
  const leaves = flattenBsTree(bsRows);
  const accounts = [];
  let amount = 0;
  for (const leaf of leaves) {
    const section = bsSectionOf(leaf.sectionPath);
    if (entry.section && section && section !== entry.section) continue;
    if (!entry.rx.test(normalizeLabel(leaf.name))) continue;
    // The retentions row is more specific than the receivables row; an account
    // matching retentions must not also be counted as plain A/R.
    if (templateLabel === 'Accounts Receivable'
      && CASH_ACCRUAL_MAP[0].rx.test(normalizeLabel(leaf.name))) continue;
    amount = round2(amount + leaf.amount);
    accounts.push({ account: leaf.name, amount: leaf.amount, section });
  }
  return { amount, accounts };
}

/**
 * Pick the Balance Sheet period that closes a fiscal year (Part 7 / Part 8).
 *
 * `periods` is the union of the monthly and yearly balance-sheet periods a
 * version actually holds — `[{ asOfDate, rows|statement }]`. The closing period
 * for FY N is the LATEST period dated within calendar year N whose month is the
 * fiscal year-end month.
 *
 * The month is matched EXACTLY. When the required period is absent the function
 * returns `{ found: false, requiredPeriod }` so the caller can flag the missing
 * source document — it never falls back to another month, which is the specific
 * behaviour Part 7 and Part 8 prohibit.
 */
export function resolveBsPeriod(periods, fiscalYear, { fiscalYearEndMonth = 12 } = {}) {
  const year = Number(fiscalYear);
  const month = Number(fiscalYearEndMonth);
  const required = `${year}-${String(month).padStart(2, '0')}`;
  const candidates = (periods || [])
    .filter((p) => String(p?.asOfDate || '').slice(0, 7) === required)
    .sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
  if (!candidates.length) {
    return {
      found: false,
      requiredPeriod: required,
      fiscalYear: year,
      reason: `The ${MONTH_NAMES[month - 1]} ${year} Balance Sheet is not available.`,
    };
  }
  const chosen = candidates[candidates.length - 1];
  return {
    found: true,
    requiredPeriod: required,
    fiscalYear: year,
    asOfDate: chosen.asOfDate,
    rows: chosen.rows || chosen.hierarchicalRows || [],
    source: chosen.source || null,
  };
}

export const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

/**
 * Build Section 5 (Cash/Accrual Adjustments) for one fiscal year.
 *
 *   Beginning Balance = prior fiscal period Balance Sheet
 *   Ending Balance    = current fiscal period Balance Sheet
 *   Change            = Ending − Beginning
 *
 * @param {object} args
 * @param {Array} args.periods every balance-sheet period available
 * @param {number} args.fiscalYear
 * @param {number} [args.fiscalYearEndMonth]
 * @param {'Cash'|'Accrual'} [args.returnBasis] the basis the RETURN was filed
 *   on. A return filed on the same basis as the books needs no conversion, and
 *   that is stated rather than silently producing zeros.
 */
export function buildCashAccrualAdjustments({
  periods,
  fiscalYear,
  fiscalYearEndMonth = 12,
  returnBasis = 'Cash',
  bookBasis = 'Accrual',
  taxReturn = null,
  overrides = {},
}) {
  const ending = resolveBsPeriod(periods, fiscalYear, { fiscalYearEndMonth });
  const beginning = resolveBsPeriod(periods, Number(fiscalYear) - 1, { fiscalYearEndMonth });

  const missing = [];
  if (!beginning.found) missing.push(beginning);
  if (!ending.found) missing.push(ending);

  const basisConversionRequired = String(returnBasis).toLowerCase() !== String(bookBasis).toLowerCase();

  const items = CASH_ACCRUAL_ROWS.map((label) => {
    const entry = CASH_ACCRUAL_MAP.find((e) => e.label === label);
    const beg = beginning.found ? bsAmountFor(beginning.rows, label) : null;
    const end = ending.found ? bsAmountFor(ending.rows, label) : null;
    const override = overrides?.[label];
    const hasBoth = Boolean(beg && end);
    const change = hasBoth ? round2(end.amount - beg.amount) : null;
    const rawAdjustment = hasBoth && basisConversionRequired ? round2(entry.sign * change) : (hasBoth ? 0 : null);
    const overrideValue = overrideAmount(override);
    const adjustment = overrideValue != null ? overrideValue : rawAdjustment;

    // The return's own position on this line — Schedule L only, never the book
    // Balance Sheet and never 0 for a blank line. See readScheduleLLine.
    const onReturn = readScheduleLLine(
      taxReturn?.available ? taxReturn.scheduleL : null,
      entry.scheduleLLine,
    );

    return {
      label,
      fiscalYear: Number(fiscalYear),
      // ── Extracted tax-return values (kept separate from everything computed) ──
      scheduleLLine: entry.scheduleLLine,
      scheduleLCaption: entry.scheduleLCaption,
      taxReturnReported: onReturn.reported,
      taxReturnBeginning: onReturn.beginning,
      taxReturnEnding: onReturn.ending,
      taxReturnReason: taxReturn?.available === false
        ? (taxReturn.reason || onReturn.reason)
        : onReturn.reason,
      beginningPeriod: beginning.requiredPeriod,
      endingPeriod: ending.requiredPeriod,
      beginningAsOfDate: beginning.found ? beginning.asOfDate : null,
      endingAsOfDate: ending.found ? ending.asOfDate : null,
      beginningBalance: beg ? beg.amount : null,
      endingBalance: end ? end.amount : null,
      change,
      sign: entry.sign,
      adjustment,
      available: hasBoth,
      isOverride: Boolean(override && !override.deleted),
      accounts: { beginning: beg?.accounts || [], ending: end?.accounts || [] },
      reason: hasBoth
        ? (basisConversionRequired
          ? `${label} change of ${change} converts ${bookBasis.toLowerCase()} books to a ${returnBasis.toLowerCase()}-basis return.`
          : `The return is filed on the same basis as the books (${returnBasis}); no conversion applies.`)
        : [beginning.reason, ending.reason].filter(Boolean).join(' '),
    };
  });

  const contributing = items.filter((i) => i.available && i.adjustment != null);
  const total = round2(contributing.reduce((s, i) => s + i.adjustment, 0));

  return {
    available: missing.length === 0,
    basisConversionRequired,
    returnBasis,
    bookBasis,
    beginning,
    ending,
    missingPeriods: missing.map((m) => ({ period: m.requiredPeriod, reason: m.reason })),
    items,
    total,
    // A partially-resolved section reports the total it COULD compute plus what
    // is missing. It never presents an incomplete total as complete.
    complete: missing.length === 0 && contributing.length === items.length,
    reason: missing.length
      ? `Cash/accrual adjustments are incomplete: ${missing.map((m) => m.reason).join(' ')}`
      : null,
  };
}

// ── Other adjustments (Part 9) ─────────────────────────────────────────────

/**
 * Build Section 6 (Other Adjustments) for one fiscal year.
 *
 * The client's template rows are Other Depreciation Variance, Other Interest
 * Variance and Other.
 *
 * ── WHY THE TWO VARIANCE ROWS CARRY NO INCOME EFFECT BY DEFAULT ─────────────
 * They used to be computed INTO the chain as
 *     adjustment = book expense − the return's page-1 expense
 * and that produced a guaranteed unreconciled difference on any return whose
 * presentation of an expense differs from the books'. Traced on a real 2023
 * 1120-S: the P&L carries no separate interest line (interest sits inside its
 * operating expenses, so `interestExpense` = 0) while page 1 line 13 states
 * 240,911. The row therefore contributed −240,911 to the chain, and Section 7's
 * Unreconciled Difference came out at exactly −240,911 — the whole of an expense
 * the books HAD already deducted, counted a second time.
 *
 * Two independent reasons this row can never be an income adjustment here:
 *
 *  1. It is a CLASSIFICATION difference, not a book-to-tax difference. The same
 *     240,911 is inside book Net Income (within All Other Expenses) and inside
 *     the return's deductions. Book income and tax income are both already net of
 *     it, so nothing has to move. Section 1 shows the presentation difference as
 *     that line's TR Variance, which is where it belongs.
 *  2. Where a book-vs-tax expense difference IS real (tax depreciation ≠ book
 *     depreciation), the return states it on Schedule M-1 — lines 3a and 6a are
 *     literally captioned "Depreciation" — and Schedule M-1 is this chain's
 *     anchor and feeds Section 2. Recomputing it here would relieve the same
 *     amount twice.
 *
 * So both rows are DISPLAY rows: each shows the book figure, the figure the
 * return actually states at its own page-1 line, and the resulting `variance` —
 * and contributes 0 to the reconciliation unless a user explicitly overrides it
 * (an override is a human assertion, and it is honoured and marked as one).
 *
 * `variance` remains `book − tax` in the adjustment convention documented at the
 * top of this file, so an override typed to match it moves book income the way
 * the reviewer expects.
 *
 * "Other" holds ONLY items that survived the whole Part 9 cascade. It is never
 * written as a plug: `plugged` is always false, and `unmappedItems` names every
 * amount inside it.
 */
export function buildOtherAdjustments({ plValues = {}, taxReturn, m1, overrides = {} }) {
  const depreciation = readTaxReturnLine(taxReturn, 'Depreciation Expense');
  const interest = readTaxReturnLine(taxReturn, 'Total Interest Expense');
  const bookDepreciation = round2(num(plValues.depreciation));
  const bookInterest = round2(num(plValues.interestExpense));

  const varianceRow = (label, book, onReturn, whatItIs) => {
    const variance = onReturn.reported ? round2(book - onReturn.value) : null;
    return {
      label,
      // `available` describes the COMPARISON, which needs the return's figure.
      available: onReturn.reported,
      pl: book,
      // Extracted, never derived: null means the return does not state the line.
      taxReturn: onReturn.value,
      taxReturnReported: onReturn.reported,
      variance,
      // Display-only in the chain. See the header above.
      adjustment: 0,
      hasIncomeEffect: false,
      isDisplayOnly: true,
      reason: !onReturn.reported
        ? `${onReturn.reason} No variance can be shown, and nothing is assumed in its place.`
        : `Book ${whatItIs} ${book} vs the return's page-1 ${whatItIs} ${onReturn.value} — a `
          + `presentation difference of ${variance}. It is shown, not added: book income and tax `
          + `income are both already net of this expense, and any genuine book-to-tax difference is `
          + `stated on Schedule M-1 and adjusted in Section 2. Enter a value to override.`,
    };
  };

  const items = [
    varianceRow('Other Depreciation Variance', bookDepreciation, depreciation, 'depreciation'),
    varianceRow('Other Interest Variance', bookInterest, interest, 'interest expense'),
  ].map((item) => {
    const overrideValue = overrideAmount(overrides?.[item.label]);
    if (overrideValue != null) {
      return {
        ...item,
        adjustment: overrideValue,
        hasIncomeEffect: overrideValue !== 0,
        isDisplayOnly: false,
        isOverride: true,
        available: true,
        reason: `Manually overridden to ${overrideValue}. ${item.reason}`,
      };
    }
    return { ...item, isOverride: false };
  });

  // "Other": user-entered residuals only. Nothing is ever computed into it.
  const otherOverrideValue = overrideAmount(overrides?.Other);
  const unmappedItems = (m1?.informationalItems || []).filter((i) => i.mapping === 'other');
  items.push({
    label: 'Other',
    available: true,
    pl: null,
    taxReturn: null,
    adjustment: otherOverrideValue != null ? otherOverrideValue : 0,
    hasIncomeEffect: otherOverrideValue != null && otherOverrideValue !== 0,
    isOverride: otherOverrideValue != null,
    unmappedItems,
    reason: unmappedItems.length
      ? `${unmappedItems.length} tax-return line(s) reached Other with no mapping and no stated income ` +
        `effect: ${unmappedItems.map((i) => i.category).join(', ')}. They are listed, not added.`
      : 'Manual residual only. No value is ever computed into Other to make the report balance.',
  });

  const total = round2(items.reduce((s, i) => s + (i.adjustment == null ? 0 : i.adjustment), 0));
  return {
    items,
    total,
    plugged: false,
    // A row whose comparison could not be shown (the return does not state that
    // page-1 line) is reported as incomplete — it no longer withholds an
    // adjustment, because it never contributes one, but the reviewer is still
    // told the comparison is missing rather than shown a zero.
    complete: items.every((i) => i.available),
  };
}

// ── SDE (Part 11) ──────────────────────────────────────────────────────────

/**
 * Seller's Discretionary Earnings from the line items this page already
 * displays. This is the same add-back set the app's own EBITDA/SDE engine uses
 * (src/services/ebitdaService.js — officer compensation, depreciation,
 * amortization and interest are all add-backs, interest income is removed), so
 * the denominator here agrees with the SDE shown elsewhere in the product.
 *
 *   SDE = Net Income + Officer Wages + Depreciation + Amortization
 *         + Interest Expense − Interest Income
 */
export function computeSde(values) {
  const netIncome = num(values?.netIncome);
  return round2(
    netIncome
    + num(values?.officerWages)
    + num(values?.depreciation)
    + num(values?.amortization)
    + num(values?.interestExpense)
    - num(values?.interestIncome),
  );
}

/**
 * Unreconciled difference as a percentage of SDE (Part 11).
 *
 * Every degenerate denominator returns an explicit status and a null percent —
 * the function can never emit Infinity or NaN, and a negative SDE is reported as
 * such rather than yielding a meaningless negative ratio.
 */
export function unreconciledPctOfSde(unreconciledDifference, sde, { sdeAvailable = true } = {}) {
  const diff = num(unreconciledDifference);
  if (!sdeAvailable || sde == null) {
    return { status: 'sde_unavailable', percent: null, display: 'n/a', reason: 'SDE is not available for this year.' };
  }
  const denominator = num(sde);
  if (Math.abs(denominator) <= FOOTING_TOLERANCE) {
    return {
      status: 'sde_zero',
      percent: null,
      display: 'n/a',
      reason: 'SDE is zero, so a percentage of SDE is undefined. The unreconciled amount itself is shown above.',
    };
  }
  const percent = round2((Math.abs(diff) / Math.abs(denominator)) * 100);
  if (denominator < 0) {
    return {
      status: 'sde_negative',
      percent,
      display: `${percent.toFixed(1)}%`,
      reason: `SDE is negative (${round2(denominator)}); the percentage uses its absolute value.`,
    };
  }
  return { status: 'ok', percent, display: `${percent.toFixed(1)}%`, reason: null };
}

// ── The reconciliation (Part 10 / Part 16) ─────────────────────────────────

/**
 * Assemble the whole reconciliation for ONE fiscal year and return every
 * section plus every footing check.
 *
 * The chain is the one documented at the top of this file. `unreconciled` is the
 * real signed residual: no branch in this function assigns it zero, rounds it
 * away, or moves it into another section.
 */
export function buildYearReconciliation({
  fiscalYear,
  plRows,
  plYearKey = null,
  taxYears,
  bsPeriods = [],
  fiscalYearEndMonth = 12,
  accountingMethod = 'Cash',
  overrides = {},
}) {
  const financial = buildFinancialStatement(plRows, { yearKey: plYearKey });
  const taxReturn = resolveTaxReturnForYear(taxYears, fiscalYear);

  // Section 1 — the financial statement block with a TR Variance per row.
  //
  // `taxReturnReported` carries the publisher's own statement of whether the line
  // was READ off the form. A page-1 line the return leaves blank (cost of goods
  // sold and depreciation on the traced 2023 return) is published as a display 0;
  // the flag and `taxReturnSource` are what let the page say so instead of
  // presenting that 0 as a figure printed on the form.
  const statementRows = financial.lineItems.map((item) => {
    const taxRow = taxReturn.available ? taxReturn.byLabel.get(normalizeLabel(item.label)) : null;
    const taxValue = taxRow ? round2(num(taxRow.taxReturn)) : null;
    return {
      key: item.key,
      label: item.label,
      subtotal: Boolean(item.subtotal),
      pl: item.value,
      taxReturn: taxValue,
      taxReturnReported: taxRow ? taxRow.source?.reported !== false : false,
      taxReturnSource: taxRow?.source || null,
      variance: taxValue == null ? null : trVariance(taxValue, item.value),
    };
  });

  const m1 = buildM1Adjustments({
    taxReturn,
    plValues: financial.values,
    overrides: overrides.m1 || {},
  });

  const cashAccrual = buildCashAccrualAdjustments({
    periods: bsPeriods,
    fiscalYear,
    fiscalYearEndMonth,
    returnBasis: accountingMethod,
    // Only so each row can state what the RETURN reports for it (Schedule L).
    // The adjustment itself is computed from the Balance Sheet, as it must be.
    taxReturn,
    overrides: overrides.cashAccrual || {},
  });

  const other = buildOtherAdjustments({
    plValues: financial.values,
    taxReturn,
    m1,
    overrides: overrides.other || {},
  });

  const bookNetIncome = financial.lineItems.find((i) => i.key === 'netIncome')?.value ?? 0;

  // Section 3 — Reported M1 Book Net Income (Schedule M-1 line 1).
  const reportedM1BookNetIncome = taxReturn.available && taxReturn.scheduleM1?.netIncomePerBooks != null
    ? round2(num(taxReturn.scheduleM1.netIncomePerBooks))
    : null;

  // Section 4 — M1 Variance Check: the book-basis gap the cash/accrual and other
  // adjustments have to explain.
  const m1VarianceCheck = reportedM1BookNetIncome == null
    ? {
      available: false,
      reason: taxReturn.available
        ? 'The return\'s Schedule M-1 line 1 "Net income (loss) per books" was not found, so the reported book income cannot be checked.'
        : taxReturn.reason,
      variance: null,
      explained: null,
      residual: null,
    }
    : (() => {
      const variance = round2(bookNetIncome - reportedM1BookNetIncome);
      const explained = round2(cashAccrual.total + other.total);
      return {
        available: true,
        reason: null,
        bookNetIncome,
        reportedM1BookNetIncome,
        variance,
        explained,
        // Book + explanations should land on the reported book figure.
        residual: round2(bookNetIncome + explained - reportedM1BookNetIncome),
      };
    })();

  // Section 7 — Tax to Book Reconciliation Check.
  const calculatedReconciledIncome = round2(bookNetIncome + m1.total + cashAccrual.total + other.total);

  // The expected figure: the return's own reconciled income when Schedule M-1
  // states it, otherwise composed from the reported book income plus the same
  // M1 adjustments. Never a nearest-year or substituted figure.
  const statedReconciled = taxReturn.available && taxReturn.scheduleM1?.reconciledIncome != null
    ? round2(num(taxReturn.scheduleM1.reconciledIncome))
    : null;
  const expectedReconciledIncome = statedReconciled != null
    ? statedReconciled
    : (reportedM1BookNetIncome != null ? round2(reportedM1BookNetIncome + m1.total) : null);

  const unreconciled = expectedReconciledIncome == null
    ? null
    : round2(calculatedReconciledIncome - expectedReconciledIncome);

  const sde = computeSde({ ...financial.values, netIncome: bookNetIncome });
  const sdePct = unreconciledPctOfSde(unreconciled ?? 0, sde, {
    sdeAvailable: unreconciled != null,
  });

  // Section 9 — Schedule K, canonicalised but retaining source and tax year.
  const scheduleK = buildScheduleKSection({ taxReturn, overrides: overrides.scheduleK || {} });

  const footing = [
    ...financial.footing,
    ...statementRows
      .filter((r) => r.taxReturn != null)
      .map((r) => foots(`TR Variance (${r.label}) = Tax Return − P&L`, r.variance,
        trVariance(r.taxReturn, r.pl))),
    foots('M1 Adjustments total = sum of items', m1.total,
      round2((m1.items || []).reduce((s, i) => s + i.adjustment, 0))),
    foots('Cash/Accrual total = sum of available items', cashAccrual.total,
      round2((cashAccrual.items || []).filter((i) => i.available && i.adjustment != null)
        .reduce((s, i) => s + i.adjustment, 0))),
    foots('Other Adjustments total = sum of items', other.total,
      round2((other.items || []).reduce((s, i) => s + (i.adjustment == null ? 0 : i.adjustment), 0))),
    foots('Calculated Reconciled Income = Book NI + M1 + Cash/Accrual + Other',
      calculatedReconciledIncome,
      round2(bookNetIncome + m1.total + cashAccrual.total + other.total)),
  ];
  if (unreconciled != null) {
    footing.push(foots('Unreconciled = Calculated − Expected', unreconciled,
      round2(calculatedReconciledIncome - expectedReconciledIncome)));
  }

  return {
    fiscalYear: Number(fiscalYear),
    financial,
    taxReturn,
    statementRows,
    m1,
    reportedM1BookNetIncome,
    m1VarianceCheck,
    cashAccrual,
    other,
    scheduleK,
    bookNetIncome,
    calculatedReconciledIncome,
    expectedReconciledIncome,
    unreconciled,
    reconciled: unreconciled != null && Math.abs(unreconciled) <= FOOTING_TOLERANCE,
    sde,
    sdePct,
    footing,
    // Everything a reviewer needs to see WHY the year does not foot, in one place.
    blockers: [
      ...(taxReturn.available ? [] : [taxReturn.reason]),
      ...(cashAccrual.reason ? [cashAccrual.reason] : []),
      ...(m1VarianceCheck.available ? [] : [m1VarianceCheck.reason]),
      ...(financial.unclassified.length
        ? [`${financial.unclassified.length} P&L account(s) are unclassified and excluded from every total: `
          + financial.unclassified.map((r) => r.name).join(', ')]
        : []),
    ].filter(Boolean),
  };
}

/**
 * Section 9 — Schedule K items, label-normalised while preserving source
 * identity and tax year (Part 12). A user-added item is flagged `userAdded` and
 * is never replaced by regenerated source data (Part 18) — the caller merges
 * overrides on top, and `buildScheduleKSection` keeps the user's value.
 *
 * ── THE TAX RETURN IS THE ONLY SOURCE, AND A BLANK IS NOT A ZERO ────────────
 * Three defects, all observed on one real 2023 1120-S export, all of the same
 * kind — a figure the return states was published here as 0:
 *
 *  1. Nondeductible expenses. Schedule K line 16c prints 912. The row read 0,
 *     while the SAME 912 came through correctly on Schedule M-1 line 3 (it is one
 *     figure reported at two addresses — the M1 mapping table already says so).
 *  2. Ordinary business income (loss). Schedule K line 1 prints −391,087 — the
 *     line is captioned "(page 1, line 22)" on the form, i.e. it IS the page-1
 *     bottom line the publisher already carries. The row read 0.
 *  3. Every other line the extraction could not read published a 0 that was
 *     indistinguishable from a preparer's nil assertion.
 *
 * The rules applied here, in order, are therefore:
 *   • a line the extraction did not read is `taxReturn: null` / `reported: false`
 *     and renders as "Not Reported" — never 0, and never a book figure;
 *   • a value is taken only from an address that PRINTS it, and the address used
 *     is recorded on the item as `sourceAddress`;
 *   • Schedule M-1 supplies a line that Schedule K left unread only where the two
 *     schedules state the same figure by definition (M-1's own itemised lines);
 *   • the total covers reported, distributive-share items only — the bottom-line
 *     row is a reference figure, not a reconciling item, so it is excluded.
 */
export function buildScheduleKSection({ taxReturn, overrides = {} }) {
  const byCategory = new Map();

  /**
   * Record / merge one reading, keeping "not reported" distinct from 0.
   *
   * `fillOnly` marks a reading from a schedule that RESTATES a figure rather than
   * adding to it (Schedule M-1's itemised lines against Schedule K's). It fills a
   * category that has no printed figure yet and is otherwise ignored, so one
   * amount reported at two addresses can never be summed into double.
   */
  const record = (category, reading, { fillOnly = false } = {}) => {
    const existing = byCategory.get(category);
    if (!existing) {
      byCategory.set(category, { label: category, ...reading });
      return;
    }
    if (!reading.reported) {
      if (!existing.sourceLabels.includes(reading.sourceLabels[0])) {
        existing.sourceLabels.push(reading.sourceLabels[0]);
      }
      return;
    }
    if (!existing.reported) {
      // The category existed only as an unread line; adopt the address that
      // actually prints a figure rather than leaving the 0/blank in place.
      byCategory.set(category, {
        ...reading,
        label: category,
        sourceLabels: [...new Set([...existing.sourceLabels, ...reading.sourceLabels])],
      });
      return;
    }
    if (fillOnly) {
      if (!existing.sourceLabels.includes(reading.sourceLabels[0])) {
        existing.sourceLabels.push(reading.sourceLabels[0]);
      }
      return;
    }
    // Two different source lines in one category (1065 13a cash + 13b noncash).
    if (!existing.sourceLabels.includes(reading.sourceLabels[0])) {
      existing.taxReturn = round2(existing.taxReturn + reading.taxReturn);
      existing.sourceLabels.push(reading.sourceLabels[0]);
    }
  };

  if (taxReturn?.available) {
    const address = (source, fallback) => {
      if (!source) return fallback;
      const parts = [source.form, source.line ? `line ${source.line}` : null].filter(Boolean);
      return parts.length ? parts.join(' ') : fallback;
    };

    for (const row of taxReturn.data) {
      if (!row?.isReconcilingItem) continue;
      const mapped = mapToM1(row.label);
      const reported = row.source?.reported !== false && row.taxReturn != null && row.taxReturn !== '';
      record(canonicalScheduleKLabel(row.label), {
        sourceLabels: [row.label],
        sourceDocument: taxReturn.fileName || null,
        sourceAddress: address(row.source, 'Schedule K'),
        taxYear: taxReturn.fiscalYear,
        taxReturn: reported ? round2(num(row.taxReturn)) : null,
        reported,
        effect: mapped?.effect || null,
        note: mapped?.note
          || (reported ? null : 'This line was not read on the return, so no figure is reported for it.'),
        userAdded: false,
        isOverride: false,
      });
    }

    // Schedule M-1's own itemised lines. They fill a Schedule K line only when
    // Schedule K's reading is missing (see `record`), because the two schedules
    // report ONE figure — the M1 mapping table treats them as one for exactly
    // this reason. Nothing is summed across the two.
    for (const line of taxReturn.scheduleM1?.lines || []) {
      if (line?.amount == null) continue;
      const mapped = mapToM1(line.label);
      record(canonicalScheduleKLabel(line.label), {
        sourceLabels: [line.label],
        sourceDocument: taxReturn.fileName || null,
        // `m1Line` already reads "M-1 line 3", so this renders "Schedule M-1 line 3".
        sourceAddress: mapped?.m1Line ? `Schedule ${mapped.m1Line}` : 'Schedule M-1',
        taxYear: taxReturn.fiscalYear,
        taxReturn: round2(num(line.amount)),
        reported: true,
        effect: mapped?.effect || null,
        note: mapped?.note || null,
        userAdded: false,
        isOverride: false,
      }, { fillOnly: true });
    }

    // Ordinary business income (loss) — Schedule K line 1, which the form itself
    // captions "(page 1, line 22)". The publisher carries that page-1 line as
    // "Net Income"; it is read from there, at its printed address, and marked as
    // the return's bottom line rather than a reconciling item so it can never be
    // added into an adjustment total.
    // A page-1 bottom line of exactly 0 is not shown, for the same reason a
    // printed 0 is left out of the Schedule K rows above: this is a reference
    // row, and a zero one tells a reviewer nothing.
    const ordinary = readTaxReturnLine(taxReturn, 'Net Income');
    if (ordinary.reported && ordinary.value !== 0) {
      record('Ordinary Business Income (Loss)', {
        sourceLabels: ['Ordinary business income (loss)'],
        sourceDocument: taxReturn.fileName || null,
        sourceAddress: 'Schedule K line 1',
        // The page-1 line it is read from, kept for the tooltip/audit trail.
        sourceDetail: address(ordinary.source, 'page 1'),
        taxYear: taxReturn.fiscalYear,
        taxReturn: ordinary.value,
        reported: true,
        effect: M1_EFFECTS.INFO,
        isBottomLine: true,
        note: 'Schedule K line 1 restates page 1 line 22. Shown for reference and excluded '
          + 'from the Schedule K total — it is the figure the reconciliation targets, not an '
          + 'adjustment to it.',
        userAdded: false,
        isOverride: false,
      }, { fillOnly: true });
    }
  }

  // Overrides last: a user's typed value wins over the extracted one, and a
  // user-added row exists even when the return has no such line.
  for (const [label, override] of Object.entries(overrides || {})) {
    if (!override || override.deleted) {
      byCategory.delete(label);
      byCategory.delete(canonicalScheduleKLabel(label));
      continue;
    }
    const category = override.userAdded ? label : canonicalScheduleKLabel(label);
    const existing = byCategory.get(category);

    // A saved 0 on a line the return prints does not replace the printed figure.
    // The override is left in storage untouched — only its effect on this row is
    // suspended, and the row states that. See isPlaceholderZeroOverride.
    if (existing?.reported && isPlaceholderZeroOverride(override, existing.taxReturn)) {
      existing.ignoredOverride = true;
      existing.note = `${existing.note ? `${existing.note} ` : ''}A saved value of 0 for this line is `
        + 'ignored in favour of the figure the return prints; delete the row if it should not appear.';
      continue;
    }

    byCategory.set(category, {
      label: category,
      sourceLabels: existing?.sourceLabels || [label],
      sourceDocument: existing?.sourceDocument || null,
      sourceAddress: existing?.sourceAddress || null,
      taxYear: taxReturn?.fiscalYear ?? null,
      taxReturn: round2(num(override.taxReturn)),
      // A typed value is a reading the user is asserting, so it IS reported —
      // marked `isOverride` so the provenance stays visible.
      reported: true,
      effect: existing?.effect || mapToM1(category)?.effect || null,
      note: existing?.note || null,
      isBottomLine: Boolean(existing?.isBottomLine),
      userAdded: Boolean(override.userAdded),
      isOverride: true,
    });
  }

  const items = [...byCategory.values()].sort((a, b) => a.label.localeCompare(b.label));
  return {
    available: Boolean(taxReturn?.available) || items.length > 0,
    reason: taxReturn?.available ? null : taxReturn?.reason || null,
    items,
    // Reported, distributive-share items only: an unread line contributes
    // nothing (it is not a zero) and the bottom-line reference row is excluded.
    total: round2(items.reduce(
      (s, i) => s + (i.reported && !i.isBottomLine ? num(i.taxReturn) : 0), 0,
    )),
    notReported: items.filter((i) => !i.reported).map((i) => i.label),
  };
}

/**
 * Build the reconciliation for every fiscal year, each using ONLY that year's
 * own P&L, tax return, Balance Sheet, Schedule K and M-1 data (Part 15).
 *
 * @param {object} args
 * @param {number[]} args.fiscalYears
 * @param {Record<number, Array>} args.plRowsByYear
 * @param {object} args.taxYears
 * @param {Array} args.bsPeriods every balance-sheet period, all years
 */
export function buildReconciliation({
  fiscalYears,
  plRowsByYear = {},
  taxYears = {},
  bsPeriods = [],
  fiscalYearEndMonth = 12,
  accountingMethod = 'Cash',
  overridesByYear = {},
}) {
  const years = [...new Set((fiscalYears || []).map(Number).filter(Boolean))].sort((a, b) => a - b);
  const byYear = {};
  for (const year of years) {
    byYear[year] = buildYearReconciliation({
      fiscalYear: year,
      plRows: plRowsByYear[year] || plRowsByYear[String(year)] || [],
      taxYears,
      bsPeriods,
      fiscalYearEndMonth,
      accountingMethod,
      overrides: overridesByYear[year] || overridesByYear[String(year)] || {},
    });
  }
  return { years, byYear };
}

/** All footing checks that FAILED, across every year — for the validation banner. */
export function collectFootingFailures(reconciliation) {
  const failures = [];
  for (const year of reconciliation?.years || []) {
    for (const check of reconciliation.byYear[year]?.footing || []) {
      if (!check.ok) failures.push({ fiscalYear: year, ...check });
    }
  }
  return failures;
}
