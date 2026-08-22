## Why

Audit finding **C3**: a live Gmail app password reached version control. It is
recoverable from history, and until 22 Aug 2026 it was also sitting in the
**current working tree** on `ba/rearch` — `backend/.env.example` carried a real
service mailbox address and two app-password-shaped values, one of them assigned
to `EMAIL_PASS`. Anything that ever touched git must be treated as compromised.

This change is the half of C3 that is **safe to do immediately**: kill the
exposed credential, and stop the next one arriving. It was previously bundled
with the git-history rewrite in `secrets-rotation-history-purge`, and that
bundling is why it sat at 0/23 for weeks — the destructive half needs a
coordinated freeze and owner sign-off, and it held the non-destructive half
hostage. The purge now lives separately in
`openspec/changes/secrets-history-purge/`.

Rotation is the actual mitigation. Once the credential is dead, whether the
purge ever runs is a hygiene question rather than a security one.

**Track:** security remediation (C3). No product behavior change → `skip_specs`.

## What Changes

- **Rotate & audit.** Revoke the leaked Gmail app password, issue a new one into
  the deploy secret manager, and audit that mailbox for unauthorized use. Rotate
  anything else that ever appeared in git.
- **Sanitize the tracked tree.** `backend/.env.example` now carries placeholders
  only, and says why. *(done — 22 Aug 2026)*
- **Prevent recurrence.** `gitleaks` pre-commit hook, a hard CI secret-scan gate,
  and a rule set that catches the specific credential shape that leaked — the
  default rules do not, because a Gmail app password has no prefix and
  unremarkable entropy. *(done — 22 Aug 2026)*

## Impact

- **No application code changes.** The scanning work touches `.gitleaks.toml`,
  `.githooks/pre-commit`, `devenv.nix`, `.github/workflows/ci.yml` and
  `CONTRIBUTING.md` only.
- **CI gains a hard gate.** Unlike the dependency audit, the secret scan is not
  `continue-on-error`: there is no known-unfixable backlog to work around.
- **Developers gain a pre-commit hook** that degrades to a warning when
  `gitleaks` is absent, so it cannot block a commit made outside the dev shell.
  CI is the enforcement point; the hook is the fast path.

## Non-goals

- The history rewrite and force-push — `openspec/changes/secrets-history-purge/`.
- Guaranteeing removal from forks or third-party caches. Rotation is what covers
  that; no rewrite can.

## ⚠️ Owner action required

Tasks 1.1–1.4 are outward-facing: they touch a live third-party account and
cannot be done from inside this repository. They are the CTO's to run, and they
are the ones that actually close C3. Everything else here is already done.

## Status

**Prevention complete, rotation outstanding (22 Aug 2026).** The scanning
tooling is in place and verified — it found the live credential in
`backend/.env.example` on its first run against the working tree, which is the
clearest possible argument for having it. The credential itself is still live
until someone revokes it.
