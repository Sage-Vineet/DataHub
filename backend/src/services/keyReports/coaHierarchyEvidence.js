// ============================================================================
// Chart of Accounts — PRIORITY 3: hierarchy / sibling evidence.
//
// Runs after document matching (P1) and GL structural evidence (P2), before
// Gemini (P5). Answers: "do this account's already-RESOLVED neighbours agree on
// what it must be?"
//
// ── THE ONE SIGNAL THIS USES, AND WHY ONLY ONE ──────────────────────────────
// Account-number blocks. Every numbered chart of accounts groups related
// accounts into a contiguous numeric range, and which range means what is the
// client's own convention, not ours. So this never interprets a number — it
// only asks whether the accounts already resolved in the SAME block agree.
// That is structural, language-independent, industry-independent, and cannot
// be fooled by wording.
//
// Two other candidate signals were considered and deliberately REJECTED:
//
//   • Shared name tokens (the "30010 TH Equity" ⇒ "TH Distribution" idea).
//     A shared leading word is not evidence of a shared type: "Bank Fees"
//     (expense) and "Bank Account" (asset), or "Insurance Expense" and
//     "Prepaid Insurance", share their most distinctive token and sit on
//     opposite statements. Inheriting a type across that would manufacture
//     precisely the confident-but-wrong classification this redesign exists to
//     prevent, and it is name matching — which this pipeline must not contain.
//
//   • split_account co-occurrence. Real, but far too noisy to act on: a bank
//     or A/P control account posts against nearly every other account in the
//     ledger, so co-occurrence implies no shared type.
//
// The deliberate consequence: for a client whose COA carries no account numbers
// this module contributes nothing, and those accounts fall through to Gemini
// WITH the P2 constraints still applied and its answer still vetoed on the way
// back. That is the correct outcome — silence is better than a guess.
// ============================================================================

// The shortest numeric prefix that can meaningfully identify a block. One digit
// is too coarse to be evidence of anything.
const MIN_BLOCK_PREFIX = 2;

function accountNumberDigits(accountNumber) {
  const digits = String(accountNumber ?? "").replace(/\D/g, "");
  return digits.length >= MIN_BLOCK_PREFIX ? digits : null;
}

/**
 * Infer an account's type from already-resolved accounts in the same
 * account-number block.
 *
 * Requires UNANIMITY among the block's resolved accounts: a block whose members
 * disagree is not evidence, it is noise. Uses the longest prefix that still has
 * at least `minPeers` resolved neighbours, so a tight block (3011x) is
 * preferred over a loose one (3xxxx) when both exist.
 *
 * @param {object} account            { accountNumber }
 * @param {Array}  resolvedAccounts   [{ accountNumber, accountType }] — accounts
 *   already resolved by P1/P2, i.e. genuinely known, never AI-guessed
 * @param {object} [opts]
 * @param {string[]|null} [opts.allowed] account types still permitted by P2/P4;
 *   a block consensus outside this set is discarded rather than applied
 * @param {number} [opts.minPeers=2]
 * @returns {{accountType: string, basis: string}|null}
 */
function inferTypeFromAccountNumberBlock(account, resolvedAccounts, opts = {}) {
  const { allowed = null, minPeers = 2 } = opts;
  const digits = accountNumberDigits(account?.accountNumber);
  if (!digits) return null;

  const peers = (resolvedAccounts || [])
    .map((a) => ({ digits: accountNumberDigits(a.accountNumber), accountType: a.accountType }))
    .filter((a) => a.digits && a.accountType && a.digits !== digits);
  if (peers.length < minPeers) return null;

  // Longest prefix first — the tightest block that still has enough peers wins.
  for (let len = digits.length - 1; len >= MIN_BLOCK_PREFIX; len -= 1) {
    const prefix = digits.slice(0, len);
    const inBlock = peers.filter((p) => p.digits.startsWith(prefix));
    if (inBlock.length < minPeers) continue;
    const types = new Set(inBlock.map((p) => p.accountType));
    if (types.size !== 1) continue; // block disagrees — not evidence
    const consensus = [...types][0];
    if (allowed && !allowed.includes(consensus)) continue; // contradicts harder evidence
    return {
      accountType: consensus,
      basis: `${inBlock.length} resolved account(s) in number block ${prefix}* are all ${consensus}`,
    };
  }
  return null;
}

/**
 * The hierarchy stage's answer for one account, or null when it has nothing to
 * say — which, by design, is most of the time.
 */
function inferHierarchyType(account, resolvedAccounts, opts = {}) {
  return inferTypeFromAccountNumberBlock(account, resolvedAccounts, opts);
}

module.exports = {
  inferHierarchyType,
  inferTypeFromAccountNumberBlock,
};
