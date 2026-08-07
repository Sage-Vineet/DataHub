// ============================================================================
// Chart of Accounts — PRIORITY 2: structural evidence read from the General
// Ledger itself, before any AI is consulted.
//
// WHY THIS EXISTS. Accounts that appear in the GL but in neither the uploaded
// Balance Sheet nor the uploaded Profit & Loss used to go straight to Gemini,
// and the prompt for exactly that population carries no section evidence at
// all (bsSection/plSection are null by construction — see the `needsAi` filter
// in chartOfAccountsService). Gemini was therefore classifying from the
// account NAME and nothing else, which is why equity/expense/liability
// inversions ("Retained Earnings → expense", "Owner Draw → asset") were
// reaching the Chart of Accounts.
//
// The General Ledger already contains a hard, name-free, ERP-agnostic fact
// about many of those accounts, and nothing was reading it.
//
// ── THE SIGNAL: PERMANENCE ──────────────────────────────────────────────────
// A real (permanent) account — asset, liability, equity — carries its balance
// ACROSS a fiscal-year boundary. A temporal account — income, cogs, expense —
// is closed to zero at year end and starts the next year from nothing. That is
// the definition of the two groups, not a heuristic about them, and it holds in
// every double-entry system regardless of ERP, language, industry or naming.
//
// An ERP states this explicitly: it emits an opening/BEGINNING_BALANCE row
// carrying the amount brought forward. A non-zero opening balance therefore
// PROVES the account is permanent, i.e. a Balance Sheet account.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT CLAIM ────────────────────────────
// 1. It never asserts "temporal". Absence of an opening-balance row is not
//    proof of anything: a genuinely permanent account can be missing one
//    (first period ever, an ERP that omits zero-balance openers, a partial
//    export). Asserting "temporal" from absence would veto correct answers.
//
// 2. It never derives a normal balance (debit vs credit). MEASURED against
//    live data before writing this: only 10 of 10,470 GL rows carry non-zero
//    debit_amount/credit_amount, and the signed `amount` column uses the
//    NATURAL-BALANCE convention (an income account's increases are stored
//    POSITIVE, same sign as an expense's) — so sign carries no debit/credit
//    information whatsoever. A normal-balance rule built on it would have been
//    confidently wrong on every revenue account.
//
// 3. Year-over-year running-balance continuity is computed and exposed, but
//    ONLY as context for the AI prompt — never as a constraint. MEASURED on
//    live data: 92% accurate (34/37), and all three errors predicted
//    "permanent" for an operating expense, i.e. they would have VETOED the
//    correct classification. Per the design rule that a wrong classification is
//    worse than an unclassified one, a signal that mis-vetoes is not allowed to
//    veto. It is passed to Gemini as a hint and nothing more.
//
// The result is a constraint that is small in coverage but exact where it
// applies, which is the only kind of constraint that is safe to enforce.
// ============================================================================

const BALANCE_SHEET_TYPES = ["asset", "liability", "equity"];

// Mirrors chartOfAccountsService.normName — the key every stage of the COA
// pipeline agrees on. Kept local so this module has no circular dependency on
// the 6800-line service that consumes it.
function normKey(accountName) {
  return String(accountName || "").trim().toLowerCase();
}

// A GL row's account identity, matching how chartOfAccountsService reads it.
function glRowName(row) {
  return String(row?.account_name || row?.account_section || "").trim();
}

function glRowYear(row) {
  const d = String(row?.transaction_date || "");
  const y = Number(d.slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : null;
}

// Treat a missing row_type as a transaction — pre-migration rows carry null and
// were only ever real postings (same assumption generateTrialBalance makes).
function isTransactionRow(row) {
  const t = row?.row_type;
  return !t || t === "TRANSACTION";
}

/**
 * Per-account structural evidence read from the General Ledger.
 *
 * @param {Array} glRows raw general_ledger_entries rows
 * @returns {Map<string, {
 *   permanence: "permanent"|null,   // ONLY ever "permanent" — see the header
 *   openingBalanceYears: number[],  // years that carried a non-zero balance in
 *   yearsPresent: number[],
 *   carriesAcrossYears: boolean|null, // CONTEXT ONLY — never a constraint
 *   transactionCount: number,
 * }>} keyed by normKey(accountName)
 */
function buildGlEvidence(glRows) {
  const byAccount = new Map();

  const ensure = (name) => {
    const key = normKey(name);
    if (!key) return null;
    if (!byAccount.has(key)) {
      byAccount.set(key, { name, years: new Map(), transactionCount: 0 });
    }
    return byAccount.get(key);
  };

  for (const row of glRows || []) {
    const name = glRowName(row);
    if (!name) continue;
    const acct = ensure(name);
    if (!acct) continue;
    const year = glRowYear(row);
    const yearKey = year == null ? "unknown" : year;
    if (!acct.years.has(yearKey)) {
      acct.years.set(yearKey, { opening: null, firstRunning: null, lastRunning: null });
    }
    const y = acct.years.get(yearKey);

    if (row.row_type === "BEGINNING_BALANCE") {
      // The ERP's own statement of what this account brought forward.
      y.opening = Number(row.running_balance) || 0;
      continue;
    }
    if (!isTransactionRow(row)) continue; // TOTAL_ROW / ACCOUNT_HEADER carry no evidence

    acct.transactionCount += 1;
    const running = row.running_balance == null ? null : Number(row.running_balance);
    if (running != null && Number.isFinite(running)) {
      if (y.firstRunning == null) y.firstRunning = running;
      y.lastRunning = running;
    }
  }

  const out = new Map();
  for (const [key, acct] of byAccount) {
    const yearKeys = [...acct.years.keys()].filter((y) => y !== "unknown").sort((a, b) => a - b);

    // ── The hard signal ────────────────────────────────────────────────────
    // A non-zero opening balance is proof the account carried a balance across
    // a period boundary, which only a permanent (Balance Sheet) account does.
    const openingBalanceYears = yearKeys.filter((y) => {
      const opening = acct.years.get(y).opening;
      return opening != null && Math.abs(opening) >= 0.005;
    });
    const permanence = openingBalanceYears.length ? "permanent" : null;

    // ── The soft signal (prompt context only, never enforced) ──────────────
    // Does each year open roughly where the previous year closed?
    let carriesAcrossYears = null;
    for (let i = 1; i < yearKeys.length; i += 1) {
      const prev = acct.years.get(yearKeys[i - 1]);
      const cur = acct.years.get(yearKeys[i]);
      if (prev.lastRunning == null || cur.firstRunning == null) continue;
      // Tolerance scales with the balance being carried: the first posting of
      // the new year moves the running balance away from the carried figure,
      // so an exact match is not expected — only the same order of magnitude.
      const carried = Math.abs(cur.firstRunning - prev.lastRunning)
        < Math.abs(prev.lastRunning) * 0.5 + 1;
      carriesAcrossYears = carriesAcrossYears === null ? carried : (carriesAcrossYears && carried);
    }

    out.set(key, {
      permanence,
      openingBalanceYears,
      yearsPresent: yearKeys,
      carriesAcrossYears,
      transactionCount: acct.transactionCount,
    });
  }
  return out;
}

/**
 * The account types this GL evidence permits. Returns null when the evidence
 * constrains nothing — the overwhelmingly common case, and the correct answer
 * whenever the ledger simply doesn't say.
 *
 * @returns {string[]|null}
 */
function allowedAccountTypesFor(evidence) {
  if (evidence?.permanence === "permanent") return BALANCE_SHEET_TYPES.slice();
  return null;
}

/**
 * One-line, human-readable rendering of the evidence, for the AI prompt and for
 * the rejection log. Returns "" when there is nothing worth saying.
 */
function describeGlEvidence(evidence) {
  if (!evidence) return "";
  const parts = [];
  if (evidence.permanence === "permanent") {
    parts.push(
      `carried a non-zero opening balance into ${evidence.openingBalanceYears.join(", ")} `
      + `(proves a permanent/Balance Sheet account)`,
    );
  } else if (evidence.carriesAcrossYears === true) {
    parts.push("balance appears to carry across fiscal years (weak hint: possibly permanent)");
  } else if (evidence.carriesAcrossYears === false) {
    parts.push("balance appears to reset each fiscal year (weak hint: possibly temporal/P&L)");
  }
  if (evidence.transactionCount) parts.push(`${evidence.transactionCount} GL transactions`);
  return parts.join("; ");
}

module.exports = {
  buildGlEvidence,
  allowedAccountTypesFor,
  describeGlEvidence,
  normKey,
  BALANCE_SHEET_TYPES,
};
