// ============================================================================
// Chart of Accounts — PRIORITY 4: accounting constraints.
//
// The single place that answers "is this classification ALLOWED, given
// everything stronger than the thing that produced it?". Applied to Gemini's
// output before it is accepted, so the AI can only ever choose WITHIN what the
// evidence permits — it can never override it.
//
// Every constraint here is derived from double-entry accounting itself, not
// from account names. There is no list of account names in this file and there
// must never be one: the same rules have to hold for QuickBooks, Sage, Xero,
// MYOB, NetSuite, Dynamics and hand-built ledgers, in any language, for any
// industry.
//
// ── THE CONSTRAINTS ─────────────────────────────────────────────────────────
//
// C1  STATEMENT / TYPE AGREEMENT.  An account's statement side is a pure
//     function of its type: asset/liability/equity are Balance Sheet,
//     income/cogs/expense are Profit & Loss. There is no such thing as an
//     equity account on the P&L.
//
//     CONFIRMED ROOT CAUSE this closes: statementType used to be assignable
//     independently of accountType (buildCoaModel took a coarse GL-boundary
//     bucket in preference to the account's own type), so accountType:"equity"
//     with statementType:"profit_loss" was reachable. getFinalCoaPrefix then
//     matched on statementType==="profit_loss", found "equity" among none of
//     cogs/expense/income, and fell through to the P&L anchor — filing an
//     equity account under Profit & Loss. That is exactly the reported
//     "Equity → P&L" symptom, and it needed no AI mistake at all to happen.
//
// C2  PERMANENCE.  An account the General Ledger proves carried a balance
//     across a fiscal-year boundary is a Balance Sheet account. Temporal
//     (P&L) accounts are closed to zero at year end — that is what makes them
//     temporal. See coaGlEvidence for why only "permanent" is ever asserted
//     and why normal-balance and continuity signals are deliberately not
//     enforced.
//
//     This is what stops "Retained Earnings → expense", "Owner Draw → asset"
//     (asset is permanent, so that one is NOT blocked here — see the honest
//     limits note below), "Liability → expense" and "Equity → P&L" for every
//     account whose ledger actually carries an opening balance.
//
// C3  DOCUMENT SECTION.  If the uploaded Balance Sheet or P&L places the
//     account in a section, that section's implied type wins outright. The
//     document is the client's own statement of fact.
//
// ── HONEST LIMITS ───────────────────────────────────────────────────────────
// These constraints narrow; they do not fully determine. C2 cannot separate
// asset from liability from equity (all three are permanent), and it says
// nothing at all about an account with no opening-balance history. Those
// accounts still reach Gemini — but they reach it with the narrowing applied
// and its answer checked on the way back, which is the whole point.
// ============================================================================

const { allowedAccountTypesFor, describeGlEvidence } = require("./coaGlEvidence");

const BALANCE_SHEET_TYPES = new Set(["asset", "liability", "equity"]);
const PROFIT_LOSS_TYPES = new Set(["income", "cogs", "expense"]);

/**
 * C1 — the statement an account type belongs to. A pure function; there is no
 * other legitimate source for statementType anywhere in the pipeline.
 */
function statementForAccountType(accountType) {
  const t = String(accountType || "").toLowerCase().trim();
  if (BALANCE_SHEET_TYPES.has(t)) return "balance_sheet";
  if (PROFIT_LOSS_TYPES.has(t)) return "profit_loss";
  return null;
}

/**
 * The set of account types still permitted for one account, after every
 * evidence source stronger than AI has had its say. Intersection semantics:
 * each source can only narrow, never widen.
 *
 * @param {object} params
 * @param {object|null} params.glEvidence       coaGlEvidence entry for this account
 * @param {string|null} params.documentAccountType type implied by the account's own
 *   position/section in an uploaded document (already the strongest signal —
 *   when present it collapses the set to exactly that type)
 * @param {string[]|null} params.hierarchyAccountTypes types implied by resolved
 *   siblings/parent (coaHierarchyEvidence) — a narrowing hint, not a lock
 * @returns {{allowed: string[]|null, basis: string[]}} allowed=null means
 *   "unconstrained"; basis explains which constraints contributed.
 */
function allowedAccountTypes({ glEvidence = null, documentAccountType = null, hierarchyAccountTypes = null } = {}) {
  const basis = [];
  let allowed = null;

  const narrow = (candidates, why) => {
    if (!candidates || !candidates.length) return;
    basis.push(why);
    allowed = allowed === null
      ? candidates.slice()
      : allowed.filter((t) => candidates.includes(t));
  };

  // C3 — the document is the client's own statement of fact; it collapses the
  // set to a single type rather than merely narrowing it.
  if (documentAccountType) narrow([documentAccountType], `document section says ${documentAccountType}`);

  // C2 — proven permanence.
  const glAllowed = allowedAccountTypesFor(glEvidence);
  if (glAllowed) narrow(glAllowed, "General Ledger proves a balance carried across a fiscal year (permanent account)");

  // Hierarchy consensus narrows, but is never allowed to empty the set on its
  // own — a sibling group is evidence, not proof.
  if (hierarchyAccountTypes && hierarchyAccountTypes.length) {
    const before = allowed;
    narrow(hierarchyAccountTypes, `resolved sibling accounts are ${[...new Set(hierarchyAccountTypes)].join("/")}`);
    if (allowed && !allowed.length) {
      allowed = before; // contradicts harder evidence — drop the hint, keep the proof
      basis.pop();
    }
  }

  return { allowed, basis };
}

/**
 * Does a proposed classification violate the constraints? This is the veto that
 * makes AI a fallback rather than an override.
 *
 * @returns {{violation: string, detail: string}|null} null when acceptable
 */
function checkClassification({ accountType, statementType, glEvidence = null, documentAccountType = null }) {
  const type = String(accountType || "").toLowerCase().trim();
  if (!type) return null; // nothing claimed — handled as needsReview elsewhere, not a violation

  // C1
  const expectedStatement = statementForAccountType(type);
  if (!expectedStatement) {
    return { violation: "unknown_account_type", detail: `"${accountType}" is not one of the six account types` };
  }
  if (statementType && statementType !== expectedStatement) {
    return {
      violation: "statement_type_mismatch",
      detail: `accountType "${type}" belongs on the ${expectedStatement}, but statementType says ${statementType}`,
    };
  }

  // C3 — document evidence outranks everything downstream of it.
  if (documentAccountType && documentAccountType !== type) {
    return {
      violation: "contradicts_document",
      detail: `the uploaded document places this account in a ${documentAccountType} section, not ${type}`,
    };
  }

  // C2 — proven permanence.
  const glAllowed = allowedAccountTypesFor(glEvidence);
  if (glAllowed && !glAllowed.includes(type)) {
    return {
      violation: "contradicts_gl_permanence",
      detail: `${describeGlEvidence(glEvidence)} — a permanent account cannot be "${type}"`,
    };
  }

  return null;
}

module.exports = {
  statementForAccountType,
  allowedAccountTypes,
  checkClassification,
  BALANCE_SHEET_TYPES,
  PROFIT_LOSS_TYPES,
};
