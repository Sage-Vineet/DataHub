## 1. Rotate & audit (do this first, independently)

- [ ] 1.1 Revoke the leaked Gmail app password; issue a new one; store it in the deploy/secret manager (never in git)
- [ ] 1.2 Rotate any other secret that ever appeared in git (QuickBooks, Graph, JWT if it was ever committed)
- [ ] 1.3 Audit the Gmail/Graph account for unauthorized use; note findings
- [ ] 1.4 Confirm the running app uses the new secret from env, not any committed value

## 2. Inventory

- [ ] 2.1 List paths to purge: `backend/.env`, any `.env`, `dev-database*.db`, `qb-state*.json`, committed `.pyc`
- [ ] 2.2 List exact secret strings to redact (the Gmail app password, any tokens)
- [ ] 2.3 Run `gitleaks detect` over current history to enumerate every hit (baseline)

## 3. Freeze & backup

- [ ] 3.1 Announce a freeze window; ensure all branches/PRs are pushed/merged
- [ ] 3.2 Take a backup: `git clone --mirror` to a safe location (rollback source)

## 4. Purge history

- [ ] 4.1 On a fresh `--mirror` clone, run `git filter-repo --invert-paths --path backend/.env --path dev-database.db ...` (all target paths)
- [ ] 4.2 `git filter-repo --replace-text secrets.txt` to redact the known secret strings across all history
- [ ] 4.3 Confirm refs rewritten (all branches + tags)

## 5. Verify

- [ ] 5.1 `git log --all -- backend/.env` and `-- 'dev-database*.db'` return nothing
- [ ] 5.2 `gitleaks detect` on the rewritten history is clean
- [ ] 5.3 Spot-check a couple of historical commits — secret strings redacted

## 6. Force-push & coordinate

- [ ] 6.1 `git push --force --all` and `--force --tags` from the rewritten mirror
- [ ] 6.2 Everyone re-clones fresh (do NOT rebase old clones); recreate any open PRs from the new base
- [ ] 6.3 Add a note in `docs/REARCH_LOG.md` that SHAs changed on <date>; (optional) ask GitHub Support to purge cached commit views

## 7. Prevent recurrence

- [ ] 7.1 Add a `gitleaks` pre-commit hook (documented in CONTRIBUTING)
- [ ] 7.2 Add a CI secret-scan step (`gitleaks`) to `.github/workflows/ci.yml`
- [ ] 7.3 Confirm `.gitignore` blocks `.env*`, `*.db`, caches (already done in 00b8fa8)

## 8. Wrap up

- [ ] 8.1 `openspec validate secrets-rotation-history-purge --strict` passes
- [ ] 8.2 Update `docs/REARCH_LOG.md` (C3 closed); mark the security-remediation memory item done

## Notes — DANGER

- **Requires owner sign-off + a scheduled freeze.** Step 1 (rotation) is the real fix; do it first even if the purge is deferred.
- Force-push rewrites `main` and every branch — the single deliberate exception to "main is frozen."
- Rotation is the guarantee; history purge is best-effort (forks/caches may retain old blobs).
