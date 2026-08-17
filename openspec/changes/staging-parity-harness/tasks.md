## 1. Staging environment
- [ ] 1.1 Decide where staging runs and who owns it (`design.md` Open Question 1) — outside-the-repo action
- [ ] 1.2 Snapshot restore script: production snapshot → staging database, repeatable and documented
- [ ] 1.3 Seed-time anonymization: rewrite every email to a routable sink address encoding the row id;
      replace phone numbers; leave financial data unmodified
- [ ] 1.4 Write the `staging_marker` row as part of the seed
- [ ] 1.5 Point staging's emailer at the sink; confirm the Graph path cannot reach a customer domain
- [ ] 1.6 Vitest: anonymization pass leaves no production-shaped address or phone; financial rows
      byte-match the snapshot; marker present

## 2. Schema reconciliation
- [ ] 2.1 `pnpm --filter @datahub/db db:pull` against the snapshot; diff against `packages/db/src/schema.ts`
- [ ] 2.2 Commit the dated drift baseline artifact under `packages/db/`
- [ ] 2.3 Reconciliation script reports new drift separately from baseline drift
- [ ] 2.4 Decide `backend/sql/schema.sql`: fix (incl. the `bank_transactions(client_id)` index at line 278)
      or retire in favour of the Drizzle baseline — decision recorded in the change
- [ ] 2.5 Vitest: the retained schema path applies to a clean database, or the file is gone and the
      Drizzle baseline is the only declared schema
- [ ] 2.6 `pnpm --filter @datahub/db typecheck` + a smoke query against the seeded staging database

## 3. Request-set derivation (shared with the route-contract guard)
- [ ] 3.1 Extract the legacy-surface and module-surface derivation from `apps/api/src/route-contract.test.ts`
      into a shared module both the guard and the harness import
- [ ] 3.2 Emit, per domain, the intersection (compare), the module-only paths (additive), and the
      legacy-only paths (backlog)
- [ ] 3.3 Vitest: `route-contract.test.ts` still passes against the extracted module (no behavior change);
      a route added to a module appears in the intersection with no harness edit

## 4. Comparator
- [ ] 4.1 Status comparison (exact)
- [ ] 4.2 Shape comparison: recursive key/type equality after normalizing ids and timestamps to placeholders
- [ ] 4.3 Per-endpoint semantic invariant hook, supplied by the domain, optional
- [ ] 4.4 Latency recorded, never a gate
- [ ] 4.5 Vitest: differing ids/timestamps pass; a missing key fails naming the field path; a type change
      fails; a status divergence fails reporting both codes

## 5. Harness runner
- [ ] 5.1 Refuse to start against a production `DATABASE_URL` (configured production host)
- [ ] 5.2 Refuse to start unless the target reports the `staging_marker`
- [ ] 5.3 Read-only by default; `PARITY_ALLOW_MUTATION=true` enables mutating verbs
- [ ] 5.4 Session acquisition for auth-gated endpoints (a seeded staging user), or skip-with-reason
- [ ] 5.5 `parity` script in `apps/api/package.json`
- [ ] 5.6 Vitest: each refusal blocks before any request is issued (assert zero outbound requests);
      default run issues no mutating verb

## 6. Report
- [ ] 6.1 Per-endpoint verdicts with the diff on failure
- [ ] 6.2 Coverage section: compared count against domain total, plus every skipped endpoint with its reason
- [ ] 6.3 Machine-readable output (JSON) alongside the human summary, so a cutover change can attach it
- [ ] 6.4 Vitest: a partial run's report states compared-vs-total; skipped endpoints each carry a reason

## 7. CI + first real run
- [ ] 7.1 Run the harness in CI against the compose stack (proves the harness itself, not parity in prod)
- [ ] 7.2 First staging run against a cut-over-candidate domain; attach the report
- [ ] 7.3 Rollback drill: enable a domain in staging, exercise it, flip the flag off, confirm legacy
      serves the route-group again; record the drill
- [ ] 7.4 Supertest: gateway fall-through still intact with the harness present (no request-path change)

## 8. Hand-off
- [ ] 8.1 `auth-production-cutover` tasks 1.x and 4.3 rewired to consume the harness instead of a
      hand-run checklist — without restating its parity cases here
- [ ] 8.2 Document the flip criteria: verdicts green **and** coverage stated **and** rollback drilled
- [ ] 8.3 Note explicitly that a green report authorizes a flip, not a deletion; deletion follows the soak

## 9. Wrap up
- [ ] 9.1 `openspec validate staging-parity-harness --strict` passes
- [ ] 9.2 typecheck + lint + test green
- [ ] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`
- [ ] 9.4 Carry the four open questions in `design.md`; Q3 (un-anonymized financial data in staging)
      needs the CTO's explicit affirmation before the first snapshot is taken
