## Why

The audit's **C3** finding: a live Gmail app password sits in `backend/.env.example`, a `.env` was committed in the first commit (`86450de`) and is still recoverable from history, and database files were committed. Anything that ever touched git must be treated as **compromised**. Two actions close this: (1) **rotate** the leaked credentials now, and (2) **purge** the secrets and committed data from git history. This is destructive (history rewrite + force-push) and outward-facing (rotating a live credential), so it is explicitly an **owner/CTO decision** requiring a coordinated freeze — it is not something to do silently.

**Track:** security remediation (C3). No product behavior change → `skip_specs`.

## What Changes

- **Rotate & audit (the real fix).** Revoke the leaked Gmail app password, issue a new one, move it into a proper secret store (never committed), and audit that account for unauthorized use. Rotate any other secret that ever appeared in git.
- **Purge history (hygiene).** Remove the leaked secret strings and committed artifacts (`backend/.env`, `dev-database*.db`, any `.env`) from **all** git history with `git filter-repo`.
- **Force-push & re-clone.** Rewrite all branches/tags and force-push; everyone re-clones; open PRs are recreated.
- **Verify clean.** Run a secret scanner (`gitleaks`) over the rewritten history.
- **Prevent recurrence.** Add a `gitleaks` pre-commit hook + a CI secret-scan step; confirm `.gitignore` blocks `.env`/`.db` (already largely done).

## Impact

- **Rewrites shared history**, including `main` — this is the one deliberate exception to "main is frozen," and the whole point of the change. Every clone, fork, open PR, and CI cache is affected.
- **All commit SHAs change** after the rewrite — hashes referenced in `docs/REARCH_LOG.md` become approximate (acceptable).
- **No application code changes.**
- **Coordination required:** a short freeze window while everyone syncs, the rewrite happens, and everyone re-clones.

## Non-goals

- Any application/behavior change.
- The C1/C2/H3/H1 code fixes (already done on `ba/rearch`).
- Guaranteeing removal from third-party forks/caches — **rotation** is the guarantee; purge is best-effort hygiene (see design).

## ⚠️ Prerequisite

Do **not** start without explicit owner sign-off and a scheduled freeze window. Step 1 (rotation) is the actual security fix and should happen **first and independently** — even if the history purge is deferred, the rotated credential is already dead.
