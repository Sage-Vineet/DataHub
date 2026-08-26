## Why

The other half of audit finding **C3**. A `.env` was committed in the first
commit (`86450de`), database files were committed, and a Gmail app password
appears in history from `28fd6c6` onward. Rotation kills the credential; this
change removes the values and the committed artifacts from git history so they
stop leaking further from the repository.

Split out of `secrets-rotation-history-purge` on 22 Aug 2026. Bundling the two
is why neither moved: this half needs owner sign-off and a coordinated freeze,
and it held the non-destructive half — the rotation that actually closes the
finding — hostage for weeks. Rotation now lives in
`openspec/changes/secrets-rotation/` and does not depend on this.

**Track:** security remediation (C3). No product behavior change → `skip_specs`.

## What Changes

- **Purge history.** Remove the leaked secret strings and committed artifacts
  (`backend/.env`, any `.env`, `dev-database*.db`, `qb-state*.json`, committed
  `.pyc`) from **all** history with `git filter-repo`.
- **Force-push & re-clone.** Rewrite every branch and tag, force-push, everyone
  re-clones, open PRs are recreated.
- **Verify clean.** `gitleaks detect` over the rewritten history.

## Impact

- **Rewrites shared history, including `main`** — the one deliberate exception
  to "main is frozen", and the whole point of the change. Every clone, fork,
  open PR and CI cache is affected.
- **All commit SHAs change.** Hashes referenced in `docs/REARCH_LOG.md` and in
  the OpenSpec archive become approximate. That is accepted, not accidental.
- **No application code changes.**
- **Coordination required:** a freeze window while everyone syncs, the rewrite
  runs, and everyone re-clones.

## Non-goals

- Rotation — `openspec/changes/secrets-rotation/`. Do that first; it is the real
  fix and it does not need this.
- Guaranteeing removal from forks or third-party caches. Best-effort by nature.

## ⚠️ Prerequisite

Do **not** start without explicit owner sign-off and a scheduled freeze window.
Rotation (`secrets-rotation` §1) should already be done — once the credential is
dead, this change is hygiene and can be scheduled calmly rather than urgently.

## Status

**Not started — deliberately gated, not forgotten (22 Aug 2026).**

Note for whoever runs it: the inventory must include `backend/.env.example`.
It is a *tracked* file, so it is easy to think of as an example rather than a
leak, and it carried a real mailbox and two live app-password values until they
were replaced on 22 Aug 2026. The values are still in history behind that path.
