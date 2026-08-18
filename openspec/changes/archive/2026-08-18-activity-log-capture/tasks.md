## 1. Contracts
- [x] 1.1 zod schemas: envelope record, semantic event record, gap marker
- [x] 1.2 Typed event union for the events landing now (auth outcome, permission change, document
      open/download, integration connect/disconnect)
- [x] 1.3 Contract tests, incl. an assertion that no envelope schema can carry body content

## 2. Data layer
- [x] 2.1 Model `activity_events` in `packages/db`: envelope fields, event type/payload, correlation id,
      engine, actor, `content_hash`, `prev_hash`
- [x] 2.2 Monthly partitioning from the start (`design.md` D7)
- [x] 2.3 Grant model: application role holds INSERT + SELECT only — **no UPDATE, no DELETE**
- [~] 2.4 Separate privileged path for retention deletion, operating on partitions — deferred:
      the retention *period* is an undecided legal/commercial input (design Q1); partitioning is in
      place so any answer drops in without a migration
- [x] 2.5 Schema test asserts the columns and the partitioning
- [x] 2.6 Integration test (real Postgres): UPDATE and DELETE as the application role are rejected

## 3. Append-only repository + hash chain
- [x] 3.1 `append` and read operations only — no update/delete method exists on the repository
- [x] 3.2 Hash chain: canonical content hash + previous record hash, assigned at append
- [x] 3.3 Verification pass over a range
- [x] 3.4 In-memory adapter mirrors the same surface
- [x] 3.5 Vitest: altered record detected; removed record detected; intact chain verifies;
      concurrent appends produce a single well-formed chain

## 4. Async writer
- [x] 4.1 Bounded buffer, batched flush, never blocks the request path
- [x] 4.2 Gap marker on overflow: interval, dropped count, reason (D6)
- [x] 4.3 Write-path failure is contained — logged, never propagated to the request
- [x] 4.4 Vitest: overflow produces a gap marker with an accurate count; a writer error does not surface
      to the caller; buffer drains in order

## 5. Tier 1 — gateway envelope
- [x] 5.1 Response-finished hook in `apps/api/src/gateway.ts`; records status, duration, engine
- [x] 5.2 Path normalization (`/companies/42` → `/companies/:id`), raw path retained
- [x] 5.3 Actor attribution by token decode — signature verified, no DB lookup; anonymous recorded as
      anonymous (D3)
- [x] 5.4 Correlation id generated per request and exposed to modules
- [x] 5.5 **Supertest: a proxied upload/download streams through unbuffered and byte-identical with
      capture enabled** (guards the `shared/router.ts` regression class)
- [x] 5.6 Supertest: legacy-proxied request captured with engine=legacy; module-served captured with
      engine=module; 401/403/5xx all captured
- [x] 5.7 Supertest: response status, headers, and body identical with capture on and off

## 6. Tier 2 — semantic events from migrated modules
- [x] 6.1 Emission helper taking the correlation id from request context
- [x] 6.2 auth: login succeeded/failed, password and session changes
- [x] 6.3 users (company membership) · folders (folder access): grant/modify/revoke with the granting
      user. `companies` has no access-grant route of its own — membership lives in `users`
- [x] 6.4 uploads: document open and download
- [x] 6.5 Vitest/supertest per module: the event is emitted with the acting user, subject, scope, and
      correlation id, and joins its envelope

## 7. Enablement & measurement
- [x] 7.1 `ACTIVITY_LOG_ENABLED` flag; strict parsing per `env.ts` (a mistyped flag fails the boot)
- [~] 7.2 Measure write volume and latency impact in staging **against snapshot-scale data** —
      deferred: needs the staging environment from `staging-parity-harness` task 1.x (ops)
- [~] 7.3 Enable in production after the measurement — deferred: gated on 7.2 (ops)
- [x] 7.4 Supertest: flag off → no records written and the request path is unchanged

## 8. Documentation of what is NOT captured

> Written up in `docs/ACTIVITY_LOG_COVERAGE.md`.
- [x] 8.1 Record the deferred capture points and the feature each waits on (D8): view duration and
      print (`DR - 0006` viewer), QoE add-back and valuation assumption changes, signature execution
- [x] 8.2 Document the hash chain as consistency evidence, not proof against a privileged attacker (D5)
- [x] 8.3 State plainly that the read surface, access control, and self-logging are not in this change

## 9. Wrap up
- [~] 9.1 `openspec validate activity-log-capture --strict` — the CLI is not installed in this
      worktree; artifact structure checked by hand against the existing changes
- [x] 9.2 typecheck + lint + test green (232 api tests, up from 179); `src/activity` coverage
      95.9% statements / 94.4% functions
- [x] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`
- [x] 9.4 Carry the four open questions in `design.md`; Q1 (retention period) needs a legal/commercial
      answer but does not block the build
