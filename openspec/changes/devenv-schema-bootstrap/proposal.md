## Why

`devenv.nix`'s `load-schema` script runs `packages/db/schema.sql`, which
`staging-parity-harness` established is **not authoritative** — it is a partial,
drifted snapshot (duplicate migration numbers 001 vs 019), pinned as such by
`schema-file.test.ts`. Running it against an empty database does not produce a
usable dev database, so `load-schema` cannot do the job its name claims.

This was raised and deliberately deferred by `staging-parity-harness` §10.5 as out
of scope for that change: fixing it means changing the dev environment, not the
parity harness. It is recorded here so the finding is not lost in that change's
archive.

## Cutover-order domain

`config/contracts/db` — the foundation layer of the cutover order in
`docs/MODERNIZATION_PLAN.md` §5. Nothing above it gets a trustworthy local database
until this is resolved.

## What changes

Give the dev environment a bootstrap path that produces a working database without
depending on a non-authoritative schema file. The shape is undecided — candidates
are Drizzle migrations as the source of truth, or a sanitized snapshot restore, and
that choice belongs with whoever owns the introspected Drizzle schema.

## Non-goals

- Making `packages/db/schema.sql` authoritative. It is pinned as non-authoritative
  on purpose and this change does not relitigate that.
- Any change to `tools/parity` or the parity harness itself.

## Status

**Not started — unscoped.** Filed to preserve a real finding with a known cause, not
to commit to an approach. Needs a decision on the bootstrap source before tasks are
meaningful.
