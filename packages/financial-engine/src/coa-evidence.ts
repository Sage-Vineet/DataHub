/**
 * Chart of accounts — structural evidence read from the general ledger itself,
 * before any classifier is consulted.
 *
 * Ported from `backend/src/services/keyReports/coaGlEvidence.js` on the
 * `data_room` branch, where it was written against live UAT data. The reasoning
 * below is that branch's and is preserved deliberately: the measurements are
 * the reason the module is shaped the way it is, and they are not re-derivable
 * from the code.
 *
 * ## Why this exists
 *
 * An account present in the general ledger but in neither the uploaded balance
 * sheet nor the uploaded P&L used to go straight to the AI classifier — and the
 * prompt for exactly that population carries no section evidence at all, by
 * construction. The model was therefore classifying from the account NAME and
 * nothing else, which is how "Retained Earnings → expense" and "Owner Draw →
 * asset" reached the chart of accounts.
 *
 * The ledger already contains a hard, name-free, ERP-agnostic fact about many
 * of those accounts, and nothing was reading it.
 *
 * ## The signal: permanence
 *
 * A real (permanent) account — asset, liability, equity — carries its balance
 * across a fiscal-year boundary. A temporal account — income, cogs, expense —
 * is closed to zero at year end and starts the next year from nothing. That is
 * the *definition* of the two groups, not a heuristic about them, and it holds
 * in every double-entry system regardless of ERP, language, industry or naming.
 *
 * An ERP states it explicitly by emitting an opening `BEGINNING_BALANCE` row
 * carrying the amount brought forward. A non-zero opening balance therefore
 * PROVES the account is permanent — a balance-sheet account.
 *
 * ## What this deliberately does not claim
 *
 * 1. **It never asserts "temporal."** Absence of an opening row is not proof of
 *    anything: a genuinely permanent account can lack one (first period ever,
 *    an ERP that omits zero-balance openers, a partial export). Asserting
 *    "temporal" from absence would veto correct answers.
 *
 * 2. **It never derives a normal balance (debit vs credit).** Measured against
 *    live data before the original was written: only 10 of 10,470 ledger rows
 *    carried a non-zero debit/credit column, and the signed `amount` uses the
 *    NATURAL-BALANCE convention — an income account's increases are stored
 *    positive, the same sign as an expense's. Sign carries no debit/credit
 *    information at all, so a normal-balance rule built on it would have been
 *    confidently wrong on every revenue account.
 *
 * 3. **Year-over-year continuity is computed but never enforced.** Measured on
 *    the same data: 92% accurate (34/37) — and all three errors predicted
 *    "permanent" for an operating expense, i.e. they would have vetoed the
 *    correct classification. A signal that mis-vetoes does not get to veto. It
 *    is exposed as context for the classifier prompt and nothing more.
 *
 * The result is a constraint that is small in coverage but exact where it
 * applies, which is the only kind that is safe to enforce.
 */

/** The three permanent account types, in the order the original emitted them. */
export const BALANCE_SHEET_TYPES = ["asset", "liability", "equity"] as const;

/**
 * A raw `general_ledger_entries` row.
 *
 * Deliberately NOT `GlEntry` from `types.ts`. That type is the engine's clean
 * per-period amount and carries neither `row_type` nor `running_balance` — the
 * two fields this entire module reads. Narrowing to `GlEntry` before this runs
 * would discard the evidence.
 */
export interface LedgerRow {
  account_name?: string | null;
  account_section?: string | null;
  row_type?: string | null;
  running_balance?: number | string | null;
  transaction_date?: string | null;
}

export interface GlEvidence {
  /** Only ever `"permanent"` or `null` — see the header. */
  permanence: "permanent" | null;
  /** Fiscal years the account carried a non-zero balance into. */
  openingBalanceYears: number[];
  yearsPresent: number[];
  /** CONTEXT ONLY. Never a constraint — it mis-vetoes. */
  carriesAcrossYears: boolean | null;
  transactionCount: number;
}

/**
 * The key every stage of the COA pipeline agrees on.
 *
 * Kept local rather than imported so this module has no dependency on the
 * 6,800-line legacy service that consumes it — which is what made it portable
 * at all.
 */
export function normKey(accountName: unknown): string {
  return String(accountName ?? "").trim().toLowerCase();
}

function ledgerRowName(row: LedgerRow): string {
  return String(row?.account_name ?? row?.account_section ?? "").trim();
}

function ledgerRowYear(row: LedgerRow): number | null {
  const year = Number(String(row?.transaction_date ?? "").slice(0, 4));
  return Number.isInteger(year) && year > 1900 ? year : null;
}

/**
 * Treat a missing `row_type` as a transaction: pre-migration rows carry null and
 * were only ever real postings, which is the same assumption the trial balance
 * makes.
 */
function isTransactionRow(row: LedgerRow): boolean {
  const type = row?.row_type;
  return !type || type === "TRANSACTION";
}

interface YearAccumulator {
  opening: number | null;
  firstRunning: number | null;
  lastRunning: number | null;
}

/** Per-account structural evidence, keyed by `normKey(accountName)`. */
export function buildGlEvidence(ledgerRows: readonly LedgerRow[] | null | undefined): Map<string, GlEvidence> {
  const byAccount = new Map<string, { years: Map<number | "unknown", YearAccumulator>; transactionCount: number }>();

  for (const row of ledgerRows ?? []) {
    const name = ledgerRowName(row);
    if (!name) continue;
    const key = normKey(name);
    if (!key) continue;

    let account = byAccount.get(key);
    if (!account) {
      account = { years: new Map(), transactionCount: 0 };
      byAccount.set(key, account);
    }

    const yearKey = ledgerRowYear(row) ?? "unknown";
    let year = account.years.get(yearKey);
    if (!year) {
      year = { opening: null, firstRunning: null, lastRunning: null };
      account.years.set(yearKey, year);
    }

    if (row.row_type === "BEGINNING_BALANCE") {
      // The ERP's own statement of what this account brought forward.
      year.opening = Number(row.running_balance) || 0;
      continue;
    }
    // TOTAL_ROW / ACCOUNT_HEADER carry no evidence.
    if (!isTransactionRow(row)) continue;

    account.transactionCount += 1;
    const running = row.running_balance == null ? null : Number(row.running_balance);
    if (running != null && Number.isFinite(running)) {
      if (year.firstRunning == null) year.firstRunning = running;
      year.lastRunning = running;
    }
  }

  const out = new Map<string, GlEvidence>();
  for (const [key, account] of byAccount) {
    const yearKeys = [...account.years.keys()]
      .filter((y): y is number => y !== "unknown")
      .sort((a, b) => a - b);

    // The hard signal: a non-zero opening balance is proof the account carried
    // a balance across a period boundary, which only a permanent account does.
    const openingBalanceYears = yearKeys.filter((y) => {
      const opening = account.years.get(y)?.opening;
      return opening != null && Math.abs(opening) >= 0.005;
    });

    // The soft signal — prompt context only, never enforced. Does each year open
    // roughly where the previous one closed?
    let carriesAcrossYears: boolean | null = null;
    for (let i = 1; i < yearKeys.length; i += 1) {
      const prev = account.years.get(yearKeys[i - 1]!);
      const cur = account.years.get(yearKeys[i]!);
      if (prev?.lastRunning == null || cur?.firstRunning == null) continue;
      // Tolerance scales with the balance carried: the first posting of the new
      // year moves the running balance away from the carried figure, so an exact
      // match is not expected — only the same order of magnitude.
      const carried =
        Math.abs(cur.firstRunning - prev.lastRunning) < Math.abs(prev.lastRunning) * 0.5 + 1;
      carriesAcrossYears = carriesAcrossYears === null ? carried : carriesAcrossYears && carried;
    }

    out.set(key, {
      permanence: openingBalanceYears.length ? "permanent" : null,
      openingBalanceYears,
      yearsPresent: yearKeys,
      carriesAcrossYears,
      transactionCount: account.transactionCount,
    });
  }
  return out;
}

/**
 * The account types this evidence permits, or `null` when it constrains nothing
 * — the overwhelmingly common case, and the correct answer whenever the ledger
 * simply does not say.
 */
export function allowedAccountTypesFor(evidence: GlEvidence | null | undefined): string[] | null {
  if (evidence?.permanence === "permanent") return [...BALANCE_SHEET_TYPES];
  return null;
}

/**
 * One-line rendering of the evidence for a classifier prompt or a rejection log.
 * Empty string when there is nothing worth saying.
 */
export function describeGlEvidence(evidence: GlEvidence | null | undefined): string {
  if (!evidence) return "";
  const parts: string[] = [];
  if (evidence.permanence === "permanent") {
    parts.push(
      `carried a non-zero opening balance into ${evidence.openingBalanceYears.join(", ")} ` +
        "(proves a permanent/Balance Sheet account)",
    );
  } else if (evidence.carriesAcrossYears === true) {
    parts.push("balance appears to carry across fiscal years (weak hint: possibly permanent)");
  } else if (evidence.carriesAcrossYears === false) {
    parts.push("balance appears to reset each fiscal year (weak hint: possibly temporal/P&L)");
  }
  if (evidence.transactionCount) parts.push(`${evidence.transactionCount} GL transactions`);
  return parts.join("; ");
}
