## 1. Staging environment
- [~] 1.1 Decide where staging runs and who owns it (`design.md` Q1) — deferred: outside-the-repo (ops)
- [~] 1.2 Snapshot restore (pg_restore) → staging — deferred: needs a real snapshot and a host (ops).
      The seed that runs *after* the restore is built and tested (1.3/1.4)
- [x] 1.3 Seed-time anonymization: rewrite every email to a routable sink address encoding the row id;
      replace phone numbers; leave financial data unmodified
- [x] 1.4 Write the `staging_marker` row as part of the seed
- [~] 1.5 Point staging's emailer at the sink — deferred: needs the environment (ops). The DB-side
      half (addresses rewritten so no customer address survives) is built and tested
- [x] 1.6 Vitest: anonymization pass leaves no production-shaped address or phone; financial rows
      byte-match the snapshot; marker present

## 2. Schema reconciliation
- [~] 2.1 `db:pull` against the snapshot — deferred: needs the snapshot (ops). The diff/reconcile
      logic it feeds is built and tested (`packages/db/src/drift.ts`)
- [~] 2.2 Commit the dated drift baseline — deferred: gated on 2.1; `baselineFrom()` produces it
- [x] 2.3 Reconciliation script reports new drift separately from baseline drift
- [x] 2.4 Decide `backend/sql/schema.sql`: fix (incl. the `bank_transactions(client_id)` index at line 278)
      or retire in favour of the Drizzle baseline — decision recorded in the change
- [x] 2.5 Vitest: the retained schema path applies to a clean database, or the file is gone and the
      Drizzle baseline is the only declared schema
- [~] 2.6 Smoke query against seeded staging — deferred: needs the environment (ops)

## 3. Request-set derivation (shared with the route-contract guard)
- [x] 3.1 Extract the legacy-surface and module-surface derivation from `apps/api/src/route-contract.test.ts`
      into a shared module both the guard and the harness import
- [x] 3.2 Emit, per domain, the intersection (compare), the module-only paths (additive), and the
      legacy-only paths (backlog)
- [x] 3.3 Vitest: `route-contract.test.ts` still passes against the extracted module (no behavior change);
      a route added to a module appears in the intersection with no harness edit

## 4. Comparator
- [x] 4.1 Status comparison (exact)
- [x] 4.2 Shape comparison: recursive key/type equality after normalizing ids and timestamps to placeholders
- [x] 4.3 Per-endpoint semantic invariant hook, supplied by the domain, optional
- [x] 4.4 Latency recorded, never a gate
- [x] 4.5 Vitest: differing ids/timestamps pass; a missing key fails naming the field path; a type change
      fails; a status divergence fails reporting both codes

## 5. Harness runner
- [x] 5.1 Refuse to start against a production `DATABASE_URL` (configured production host)
- [x] 5.2 Refuse to start unless the target reports the `staging_marker`
- [x] 5.3 Read-only by default; `PARITY_ALLOW_MUTATION=true` enables mutating verbs
- [x] 5.4 Session acquisition for auth-gated endpoints (a seeded staging user), or skip-with-reason
- [x] 5.5 `parity` script in `apps/api/package.json`
- [x] 5.6 Vitest: each refusal blocks before any request is issued (assert zero outbound requests);
      default run issues no mutating verb

## 6. Report
- [x] 6.1 Per-endpoint verdicts with the diff on failure
- [x] 6.2 Coverage section: compared count against domain total, plus every skipped endpoint with its reason
- [x] 6.3 Machine-readable output (JSON) alongside the human summary, so a cutover change can attach it
- [x] 6.4 Vitest: a partial run's report states compared-vs-total; skipped endpoints each carry a reason

## 7. CI + first real run
- [x] 7.1 The harness's own logic runs in CI via `pnpm run test` (comparator, refusals, coverage
      reporting, seed, schema-file guard).
- [~] 7.1b Run it against a live compose stack in CI — deferred: needs DB services + a seeded target (ops)
- [~] 7.2 First staging run + attach the report — deferred: needs the environment (ops)
- [~] 7.3 Rollback drill — deferred: needs the environment (ops). Criteria written up in
      `docs/CUTOVER_FLIP_CRITERIA.md`
- [x] 7.4 Supertest: gateway fall-through still intact with the harness present (no request-path change)

## 8. Hand-off
- [x] 8.1 `auth-production-cutover` tasks 1.x and 4.3 rewired to consume the harness instead of a
      hand-run checklist — without restating its parity cases here
- [x] 8.2 Flip *and* delete criteria written up in `docs/CUTOVER_FLIP_CRITERIA.md`
- [x] 8.3 Note explicitly that a green report authorizes a flip, not a deletion; deletion follows the soak

## 9. Wrap up
- [~] 9.1 `openspec validate staging-parity-harness --strict` — the CLI is not installed in this
      worktree; artifact structure checked by hand
- [x] 9.2 typecheck + lint + test green (api 179 → 289 tests; db 26 → 40)
- [x] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`
- [~] 9.4 Four open questions carried in `design.md`. **Q3 (un-anonymized financial data in staging)
      needs the CTO's explicit affirmation before the first snapshot is taken** — this is the one
      blocking decision, and it is a decision, not a task

## 10. Found while building this (not in the original scope)

- [x] 10.1 `backend/sql/schema.sql` had a **second** defect beyond the known index bug: it references
      `dataset_versions(id)` but never creates that table, so it fails on an empty database outright
- [x] 10.2 `dataset_versions` is created **twice in the migrations with conflicting definitions**
      (001 vs 019) — so production's actual shape is not recoverable from this repository, which is
      itself the argument for snapshot-based reconciliation
- [x] 10.3 `bank_transactions.client_id` resolved from the running code (`bankVsBooks.js:483` filters
      on it) rather than guessed; declaration fixed
- [x] 10.4 File marked NOT AUTHORITATIVE with the evidence; `schema-file.test.ts` pins all of it
- [ ] 10.5 **Follow-up:** `devenv.nix`'s `load-schema` script runs this file and therefore cannot work
      on an empty database. Left alone here — changing the dev environment is outside this change
