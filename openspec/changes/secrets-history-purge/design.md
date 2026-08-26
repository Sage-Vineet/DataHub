## Context

See `proposal.md`. Git history is immutable by design, so removing a committed secret requires rewriting history and force-pushing — disruptive and irreversible for collaborators. The credential is already exposed, so **rotation** (not purge) is the real mitigation; purge is hygiene to stop the secret leaking further from the repo.

## Goals / Non-Goals

**Goals:** the leaked credential is dead; secrets + committed data are gone from the rewritten history; recurrence is blocked by tooling.

**Non-Goals:** application changes; guaranteeing removal from forks/third-party caches (rotation covers that).

## Decisions

### D1 — Rotate first, independently
Revoke the leaked Gmail app password and any other ever-committed secret **before** touching history. This is the security fix and must not wait on the (riskier) purge. New secrets live only in the secret store / deploy env, never in git.

### D2 — `git filter-repo` for the rewrite
Use `git filter-repo` (modern, fast, the maintainers' recommendation over `filter-branch`/BFG). Remove the committed paths (`backend/.env`, any `.env`, `dev-database*.db`) across all history and `--replace-text` the known secret strings so any stray copies are redacted too.

### D3 — Work on a mirror, keep a backup
Run the rewrite on a fresh `git clone --mirror`. Keep the original mirror as a backup until the new history is verified and adopted. Only then force-push.

### D4 — Coordinated freeze
Announce a short freeze: everyone pushes/merges outstanding work first. After the rewrite + force-push, everyone **re-clones** (rebasing an old clone onto rewritten history is error-prone). Open PRs are recreated from the new base.

### D5 — Rotation is the guarantee; purge is best-effort
Forks, GitHub's commit cache, and CI artifacts may still hold old blobs. That's acceptable because the credential is already rotated. Optionally ask GitHub Support to purge cached commit views after the force-push.

### D6 — Prevent recurrence
Add a `gitleaks` pre-commit hook and a CI secret-scan step. `.gitignore` already blocks `.env`/`.db`/caches (done in `00b8fa8`).

## Risks / Trade-offs

- **Force-push disrupts all clones/PRs** → freeze window + clear re-clone instructions (D4).
- **All commit SHAs change** → hashes cited in `docs/REARCH_LOG.md` become approximate; add a note there rather than chase them.
- **This rewrites `main`** (the one deliberate exception to "main frozen") → intended; it's the point of the change.
- **Incomplete purge in forks/caches** → covered by rotation (D1/D5).

## Migration Plan

1. Rotate the credential; audit the account; store the new secret out of git.
2. Inventory paths + secret strings to remove; scan current history with `gitleaks` to enumerate hits.
3. Freeze; ensure everything is merged; take a `--mirror` backup.
4. `git filter-repo` to strip paths + replace secret strings across all refs.
5. Verify: `gitleaks detect` on the rewritten history is clean; `git log --all -- backend/.env` is empty.
6. Force-push all branches + tags; team re-clones; recreate open PRs.
7. Add the `gitleaks` pre-commit hook + CI secret-scan; note the SHA change in `REARCH_LOG.md`.

## Open Questions

- Freeze window timing — schedule with the whole team (low-activity slot).
- Whether to engage GitHub Support to purge cached commit views post-rewrite (optional).
