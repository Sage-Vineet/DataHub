## 1. Rotate & audit — OWNER ACTION, and the part that actually closes C3

These touch a live third-party account, so they cannot be done from inside the
repository. Nothing below them depends on them; they are first because they are
the security fix.

- [ ] 1.1 Revoke the leaked Gmail app password; issue a new one; store it in the deploy/secret manager (never in git)
- [ ] 1.2 Rotate any other secret that ever appeared in git (QuickBooks, Graph, JWT if it was ever committed)
- [ ] 1.3 Audit the Gmail/Graph account for unauthorized use since the first commit that carried the password (`28fd6c6`); note findings
- [ ] 1.4 Confirm the running app reads the new secret from env, not from any committed value

## 2. Sanitize the tracked tree

- [x] 2.1 Replace the real mailbox and both app-password values in `backend/.env.example` with placeholders, and record in the file why it matters
- [x] 2.2 Confirm `gitleaks detect --no-git` over the working tree reports no leaks
- [x] 2.3 Confirm `.gitignore` blocks `.env*`, `*.db` and caches (already done in `00b8fa8`; `.env.example` is deliberately tracked, which is exactly why it must hold placeholders only)

## 3. Prevent recurrence

- [x] 3.1 Add `.gitleaks.toml` with the default rule set plus rules for the credential shapes this repo actually handles: Gmail app password, QuickBooks OAuth secret, Supabase service-role JWT
- [x] 3.2 Allowlist the values that are public on purpose — the demo and devenv signing secrets, the seeded bcrypt digest, local connection strings — so the scan is quiet enough to keep
- [x] 3.3 Add `.githooks/pre-commit` scanning the staged diff; warn-and-continue when `gitleaks` is absent so it cannot block a commit made outside the dev shell
- [x] 3.4 Provision `gitleaks` in `devenv.nix`, and set `core.hooksPath` from `enterShell` (idempotent, per-clone)
- [x] 3.5 Add a hard CI secret-scan gate with `fetch-depth: 0`, placed before install so a leak fails in seconds
- [x] 3.6 Document the hook and the bypass in `CONTRIBUTING.md`

## 4. Verify the tooling actually works

Asserted rather than assumed: a scanner nobody has watched catch something is a
scanner nobody knows the configuration of.

- [x] 4.1 Plant a Gmail-app-password-shaped value and confirm `gitleaks` flags it under rule `gmail-app-password` (the default rules do **not** catch this shape)
- [x] 4.2 Confirm the pre-commit hook blocks a staged secret (exit 1) and allows a clean staged change (exit 0)
- [x] 4.3 Confirm the hook degrades to a warning and exit 0 when `gitleaks` is not on PATH
- [x] 4.4 Confirm a full working-tree scan is clean, so the first real finding is a real one

## 5. Wrap up

- [ ] 5.1 `openspec validate secrets-rotation --strict` passes
- [ ] 5.2 Update `docs/REARCH_LOG.md` — C3 rotation closed; note that history purge remains open
- [ ] 5.3 Update the security-remediation memory item

## Notes

- Rotation is the guarantee. The history purge
  (`openspec/changes/secrets-history-purge/`) is hygiene, and deferring it does
  not keep the credential alive — only skipping 1.1 does.
- A secret that reached a commit must be rotated even if the commit is later
  amended or purged: it existed on disk in a reachable object, and clones,
  forks, CI caches and GitHub's own cached views may retain it.
