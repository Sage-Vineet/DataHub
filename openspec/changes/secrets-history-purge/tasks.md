## 0. Prerequisite

- [ ] 0.1 Rotation (`openspec/changes/secrets-rotation/` §1) is done — the exposed credential is already dead before history is touched
- [ ] 0.2 Explicit owner sign-off, and a freeze window on the calendar

## 1. Inventory

- [ ] 1.1 List paths to purge: `backend/.env`, any `.env`, **`backend/.env.example`**, `dev-database*.db`, `qb-state*.json`, committed `.pyc`
- [ ] 1.2 List exact secret strings to redact: the Gmail app password(s) — note there were **two** app-password-shaped values in `.env.example`, one bare on its own line — the service mailbox address, and any tokens
- [ ] 1.3 Run `gitleaks detect --config .gitleaks.toml` over current history to enumerate every hit (baseline). The config from `secrets-rotation` already carries a rule for the Gmail app-password shape, which the default rules miss

## 2. Freeze & backup

- [ ] 2.1 Announce the freeze; ensure all branches/PRs are pushed or merged
- [ ] 2.2 Take a backup: `git clone --mirror` to a safe location (this is the rollback source, and the only one)

## 3. Purge

- [ ] 3.1 On a fresh `--mirror` clone, `git filter-repo --invert-paths --path ...` for every path in 1.1
- [ ] 3.2 `git filter-repo --replace-text secrets.txt` to redact the strings in 1.2 across all history, catching stray copies the path list misses
- [ ] 3.3 Confirm refs rewritten across all branches **and** tags

## 4. Verify

- [ ] 4.1 `git log --all -- backend/.env`, `-- backend/.env.example` and `-- 'dev-database*.db'` return nothing
- [ ] 4.2 `gitleaks detect --config .gitleaks.toml` over the rewritten history is clean
- [ ] 4.3 Spot-check `28fd6c6` and `13b5860` — the two commits that introduced the app password — and confirm redaction

## 5. Force-push & coordinate

- [ ] 5.1 `git push --force --all` and `--force --tags` from the rewritten mirror
- [ ] 5.2 Everyone re-clones fresh (do NOT rebase an old clone onto rewritten history); recreate open PRs from the new base
- [ ] 5.3 Note in `docs/REARCH_LOG.md` that SHAs changed on <date>; optionally ask GitHub Support to purge cached commit views

## 6. Wrap up

- [ ] 6.1 `openspec validate secrets-history-purge --strict` passes
- [ ] 6.2 Update `docs/REARCH_LOG.md` (C3 fully closed)

## Notes — DANGER

- Force-push rewrites `main` and every branch — the single deliberate exception
  to "main is frozen".
- Rotation is the guarantee; this is best-effort. Forks, CI caches and GitHub's
  cached commit views may retain old blobs regardless.
- Keep the backup mirror until the new history has been verified **and** adopted
  by everyone, not merely pushed.
