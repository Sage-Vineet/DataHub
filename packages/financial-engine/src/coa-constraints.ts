/**
 * Chart of accounts — accounting constraints. The veto that makes a classifier
 * a fallback rather than an override.
 *
 * Ported from `backend/src/services/keyReports/coaAccountingConstraints.js` on
 * the `data_room` branch. This is the single place that answers "is this
 * classification ALLOWED, given everything stronger than whatever produced
 * it?", and it is applied to the classifier's output before that output is
 * accepted — so the model can only ever choose WITHIN what the evidence
 * permits.
 *
 * Every constraint here derives from double-entry accounting itself, never from
 * account names. There is no list of account names in this file and there must
 * never be one: the same rules have to hold for QuickBooks, Sage, Xero, MYOB,
 * NetSuite, Dynamics and hand-built ledgers, in any language, for any industry.
 *
 * ## The constraints
 *
 * **C1 — statement/type agreement.** An account's statement side is a pure
 * function of its type: asset/liability/equity are balance sheet;
 * income/cogs/expense are profit and loss. There is no such thing as an equity
 * account on the P&L.
 *
 * The root cause this closes, confirmed in the source before the original fix:
 * `statementType` used to be assignable independently of `accountType`, so
 * `accountType: "equity"` with `statementType: "profit_loss"` was reachable.
 * The prefix resolver then matched on `statementType === "profit_loss"`, found
 * "equity" among none of cogs/expense/income, and fell through to the P&L
 * anchor — filing an equity account under profit and loss. That is the reported
 * "Equity → P&L" symptom, and it needed no AI mistake at all to happen.
 *
 * **C2 — permanence.** An account the ledger proves carried a balance across a
 * fiscal-year boundary is a balance-sheet account. Temporal accounts are closed
 * to zero at year end; that is what makes them temporal. See `coa-evidence.ts`
 * for why only "permanent" is ever asserted, and why normal-balance and
 * continuity signals are deliberately not enforced.
 *
 * **C3 — document section.** If the uploaded balance sheet or P&L places the
 * account in a section, that section's implied type wins outright. The document
 * is the client's own statement of fact.
 *
 * ## Honest limits
 *
 * These constraints narrow; they do not fully determine. C2 cannot separate
 * asset from liability from equity — all three are permanent — and it says
 * nothing at all about an account with no opening-balance history. Those
 * accounts still reach the classifier, but they reach it with the narrowing
 * applied and its answer checked on the way back, which is the whole point.
 */

import {
  BALANCE_SHEET_TYPES,
  allowedAccountTypesFor,
  describeGlEvidence,
  type GlEvidence,
} from "./coa-evidence.js";

/**
 * The three temporal types — the accounts closed to zero at year end.
 *
 * Their permanent counterparts live in `coa-evidence.ts` as
 * `BALANCE_SHEET_TYPES`, and are imported rather than restated. The two source
 * modules this was ported from each declared their own copy of that list; CJS
 * let them get away with it, but two lists that must agree forever is one more
 * than there should be.
 *
 * `AccountType` in `types.ts` now carries `cogs` too, so this list and that
 * union finally agree. They did not for a long while, and two real defects
 * hid in the gap: the trial balance posted cost of sales to the credit column,
 * and `loadEngagement` folded it into `expense` on the way out of the
 * database — which silently discarded a QoE reclassification to `cogs` and
 * left gross profit underivable.
 */
export const PROFIT_LOSS_TYPES = ["income", "cogs", "expense"] as const;

const BALANCE_SHEET_SET: ReadonlySet<string> = new Set(BALANCE_SHEET_TYPES);
const PROFIT_LOSS_SET: ReadonlySet<string> = new Set(PROFIT_LOSS_TYPES);

export type StatementSide = "balance_sheet" | "profit_loss";

export interface ConstraintResult {
  /** `null` means unconstrained. */
  allowed: string[] | null;
  /** Which constraints contributed, in the order they applied. */
  basis: string[];
}

export interface Violation {
  violation:
    | "unknown_account_type"
    | "statement_type_mismatch"
    | "contradicts_document"
    | "contradicts_gl_permanence";
  detail: string;
}

/**
 * C1 — the statement an account type belongs to.
 *
 * A pure function, and there is no other legitimate source for `statementType`
 * anywhere in the pipeline.
 */
export function statementForAccountType(accountType: unknown): StatementSide | null {
  const type = String(accountType ?? "").toLowerCase().trim();
  if (BALANCE_SHEET_SET.has(type)) return "balance_sheet";
  if (PROFIT_LOSS_SET.has(type)) return "profit_loss";
  return null;
}

export interface AllowedAccountTypesInput {
  glEvidence?: GlEvidence | null;
  /**
   * The type implied by the account's own position in an uploaded document.
   * Already the strongest signal — when present it collapses the set to exactly
   * that type.
   */
  documentAccountType?: string | null;
  /** Types implied by resolved siblings. A narrowing hint, not a lock. */
  hierarchyAccountTypes?: readonly string[] | null;
}

/**
 * The account types still permitted for one account, after every evidence
 * source stronger than the classifier has had its say.
 *
 * Intersection semantics: each source can only narrow, never widen.
 */
export function allowedAccountTypes({
  glEvidence = null,
  documentAccountType = null,
  hierarchyAccountTypes = null,
}: AllowedAccountTypesInput = {}): ConstraintResult {
  const basis: string[] = [];
  let allowed: string[] | null = null;

  const narrow = (candidates: readonly string[] | null, why: string): void => {
    if (!candidates || !candidates.length) return;
    basis.push(why);
    allowed = allowed === null ? [...candidates] : allowed.filter((t) => candidates.includes(t));
  };

  // C3 — the document is the client's own statement of fact, so it collapses
  // the set to a single type rather than merely narrowing it.
  if (documentAccountType) {
    narrow([documentAccountType], `document section says ${documentAccountType}`);
  }

  // C2 — proven permanence.
  const glAllowed = allowedAccountTypesFor(glEvidence);
  if (glAllowed) {
    narrow(
      glAllowed,
      "General Ledger proves a balance carried across a fiscal year (permanent account)",
    );
  }

  // Hierarchy consensus narrows, but is never allowed to empty the set on its
  // own — a sibling group is evidence, not proof.
  if (hierarchyAccountTypes && hierarchyAccountTypes.length) {
    const before = allowed;
    narrow(
      hierarchyAccountTypes,
      `resolved sibling accounts are ${[...new Set(hierarchyAccountTypes)].join("/")}`,
    );
    if (allowed && !(allowed as string[]).length) {
      allowed = before; // contradicts harder evidence — drop the hint, keep the proof
      basis.pop();
    }
  }

  return { allowed, basis };
}

export interface ClassificationCheckInput {
  accountType?: string | null;
  statementType?: string | null;
  glEvidence?: GlEvidence | null;
  documentAccountType?: string | null;
}

/**
 * Does a proposed classification violate the constraints?
 *
 * Returns `null` when acceptable. This is the veto that makes the classifier a
 * fallback rather than an override.
 */
export function checkClassification({
  accountType,
  statementType,
  glEvidence = null,
  documentAccountType = null,
}: ClassificationCheckInput): Violation | null {
  const type = String(accountType ?? "").toLowerCase().trim();
  // Nothing claimed. Handled as needs-review upstream, not as a violation.
  if (!type) return null;

  // C1
  const expectedStatement = statementForAccountType(type);
  if (!expectedStatement) {
    return {
      violation: "unknown_account_type",
      detail: `"${accountType}" is not one of the six account types`,
    };
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
