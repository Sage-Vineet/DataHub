/**
 * Chart of accounts — hierarchy evidence, from account-number blocks.
 *
 * Ported from `backend/src/services/keyReports/coaHierarchyEvidence.js` on the
 * `data_room` branch. Runs after document matching and ledger evidence, before
 * the AI classifier, and answers one question: do this account's already-
 * RESOLVED neighbours agree on what it must be?
 *
 * ## The one signal this uses, and why only one
 *
 * Account-number blocks. Every numbered chart of accounts groups related
 * accounts into a contiguous numeric range, and which range means what is the
 * client's own convention, not ours. So this never interprets a number — it
 * only asks whether the accounts already resolved in the SAME block agree.
 * That is structural, language-independent, industry-independent, and cannot be
 * fooled by wording.
 *
 * Two other candidate signals were considered and deliberately rejected:
 *
 * - **Shared name tokens.** A shared leading word is not evidence of a shared
 *   type: "Bank Fees" (expense) and "Bank Account" (asset), or "Insurance
 *   Expense" and "Prepaid Insurance", share their most distinctive token and
 *   sit on opposite statements. Inheriting a type across that would manufacture
 *   exactly the confident-but-wrong classification this pipeline exists to
 *   prevent — and it is name matching, which this stage must not contain.
 *
 * - **Split-account co-occurrence.** Real, but far too noisy to act on: a bank
 *   or A/P control account posts against nearly every other account in the
 *   ledger, so co-occurrence implies no shared type.
 *
 * The deliberate consequence: for a client whose chart carries no account
 * numbers this module contributes nothing, and those accounts fall through to
 * the classifier with the ledger constraints still applied and its answer still
 * vetoed on the way back. That is the correct outcome — silence beats a guess.
 */

/** One digit is too coarse to be evidence of anything. */
const MIN_BLOCK_PREFIX = 2;

export interface ResolvedAccount {
  accountNumber?: string | number | null;
  /** Genuinely known — resolved by document or ledger evidence, never AI-guessed. */
  accountType?: string | null;
}

export interface HierarchyInference {
  accountType: string;
  basis: string;
}

export interface HierarchyOptions {
  /**
   * Account types still permitted by stronger evidence. A block consensus
   * outside this set is discarded rather than applied.
   */
  allowed?: readonly string[] | null;
  minPeers?: number;
}

function accountNumberDigits(accountNumber: unknown): string | null {
  const digits = String(accountNumber ?? "").replace(/\D/g, "");
  return digits.length >= MIN_BLOCK_PREFIX ? digits : null;
}

/**
 * Infer an account's type from already-resolved accounts in the same
 * account-number block.
 *
 * Requires UNANIMITY among the block's resolved members: a block whose members
 * disagree is not evidence, it is noise. Uses the longest prefix that still has
 * at least `minPeers` resolved neighbours, so a tight block (`3011*`) is
 * preferred over a loose one (`3*`) when both exist.
 */
export function inferTypeFromAccountNumberBlock(
  account: ResolvedAccount | null | undefined,
  resolvedAccounts: readonly ResolvedAccount[] | null | undefined,
  opts: HierarchyOptions = {},
): HierarchyInference | null {
  const { allowed = null, minPeers = 2 } = opts;
  const digits = accountNumberDigits(account?.accountNumber);
  if (!digits) return null;

  const peers = (resolvedAccounts ?? [])
    .map((a) => ({ digits: accountNumberDigits(a.accountNumber), accountType: a.accountType }))
    .filter(
      (a): a is { digits: string; accountType: string } =>
        Boolean(a.digits) && Boolean(a.accountType) && a.digits !== digits,
    );
  if (peers.length < minPeers) return null;

  // Longest prefix first — the tightest block that still has enough peers wins.
  for (let len = digits.length - 1; len >= MIN_BLOCK_PREFIX; len -= 1) {
    const prefix = digits.slice(0, len);
    const inBlock = peers.filter((p) => p.digits.startsWith(prefix));
    if (inBlock.length < minPeers) continue;

    const types = new Set(inBlock.map((p) => p.accountType));
    if (types.size !== 1) continue; // the block disagrees — not evidence
    const consensus = [...types][0]!;
    if (allowed && !allowed.includes(consensus)) continue; // contradicts harder evidence

    return {
      accountType: consensus,
      basis: `${inBlock.length} resolved account(s) in number block ${prefix}* are all ${consensus}`,
    };
  }
  return null;
}

/**
 * This stage's answer for one account, or `null` when it has nothing to say —
 * which, by design, is most of the time.
 */
export function inferHierarchyType(
  account: ResolvedAccount | null | undefined,
  resolvedAccounts: readonly ResolvedAccount[] | null | undefined,
  opts: HierarchyOptions = {},
): HierarchyInference | null {
  return inferTypeFromAccountNumberBlock(account, resolvedAccounts, opts);
}
