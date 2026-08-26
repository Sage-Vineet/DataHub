## 1. Decide the bootstrap source

- [x] 1.1 **Decided, partially, by `demo-platform-hardening`.** Drizzle migrations are the
      source of truth for everything `packages/db` owns, applied by a runner with a recorded
      history and a checksum guard. The LEGACY half still has no authoritative source: it is a
      tolerant load of `backend/sql/schema.sql`, which ends with 14 statements indexing tables it
      never creates. Replacing that needs a production snapshot and belongs to Phase C
- [x] 1.2 Recorded here rather than in a `design.md`, since the decision arrived through another
      change rather than from this one

## 2. Implement

- [x] 2.1 `devenv.nix`'s `load-schema` rewritten: tolerant legacy load → legacy 049/050 → the
      migration runner. The ordering is the one real constraint, since `0002_qoe_bridge` ALTERs
      tables 049/050 create. Adds `db-status` alongside it
- [x] 2.2 Verified from empty against Postgres 16 — the same sequence `tools/demo/up.sh` runs,
      proven by dropping and rebuilding the demo database: 14 skipped legacy statements, then all
      five migrations applied in order
- [x] 2.3 The runner carries 17 tests including a check that the committed migration set is
      discoverable, ordered, and has a `.down.sql` for every file — so a new migration that breaks
      the path fails in CI rather than on someone's first day
- [ ] 2.4 **Still open:** an authoritative source for the legacy half. Until then `load-schema`
      tolerates a drifted file, and the count of skipped statements is asserted in `up.sh` so a
      change to it is noticed rather than absorbed
