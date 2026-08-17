## 1. Contracts
- [ ] 1.1 zod schemas: envelope record, semantic event record, gap marker
- [ ] 1.2 Typed event union for the events landing now (auth outcome, permission change, document
      open/download, integration connect/disconnect)
- [ ] 1.3 Contract tests, incl. an assertion that no envelope schema can carry body content

## 2. Data layer
- [ ] 2.1 Model `activity_events` in `packages/db`: envelope fields, event type/payload, correlation id,
      engine, actor, `content_hash`, `prev_hash`
- [ ] 2.2 Monthly partitioning from the start (`design.md` D7)
- [ ] 2.3 Grant model: application role holds INSERT + SELECT only — **no UPDATE, no DELETE**
- [ ] 2.4 Separate privileged path for retention deletion, operating on partitions
- [ ] 2.5 Schema test asserts the columns and the partitioning
- [ ] 2.6 Integration test (real Postgres): UPDATE and DELETE as the application role are rejected

## 3. Append-only repository + hash chain
- [ ] 3.1 `append` and read operations only — no update/delete method exists on the repository
- [ ] 3.2 Hash chain: canonical content hash + previous record hash, assigned at append
- [ ] 3.3 Verification pass over a range
- [ ] 3.4 In-memory adapter mirrors the same surface
- [ ] 3.5 Vitest: altered record detected; removed record detected; intact chain verifies;
      concurrent appends produce a single well-formed chain

## 4. Async writer
- [ ] 4.1 Bounded buffer, batched flush, never blocks the request path
- [ ] 4.2 Gap marker on overflow: interval, dropped count, reason (D6)
- [ ] 4.3 Write-path failure is contained — logged, never propagated to the request
- [ ] 4.4 Vitest: overflow produces a gap marker with an accurate count; a writer error does not surface
      to the caller; buffer drains in order

## 5. Tier 1 — gateway envelope
- [ ] 5.1 Response-finished hook in `apps/api/src/gateway.ts`; records status, duration, engine
- [ ] 5.2 Path normalization (`/companies/42` → `/companies/:id`), raw path retained
- [ ] 5.3 Actor attribution by token decode — signature verified, no DB lookup; anonymous recorded as
      anonymous (D3)
- [ ] 5.4 Correlation id generated per request and exposed to modules
- [ ] 5.5 **Supertest: a proxied upload/download streams through unbuffered and byte-identical with
      capture enabled** (guards the `shared/router.ts` regression class)
- [ ] 5.6 Supertest: legacy-proxied request captured with engine=legacy; module-served captured with
      engine=module; 401/403/5xx all captured
- [ ] 5.7 Supertest: response status, headers, and body identical with capture on and off

## 6. Tier 2 — semantic events from migrated modules
- [ ] 6.1 Emission helper taking the correlation id from request context
- [ ] 6.2 auth: login succeeded/failed, password and session changes
- [ ] 6.3 companies · users · folders: permission grant/modify/revoke with the granting user
- [ ] 6.4 uploads: document open and download
- [ ] 6.5 Vitest/supertest per module: the event is emitted with the acting user, subject, scope, and
      correlation id, and joins its envelope

## 7. Enablement & measurement
- [ ] 7.1 `ACTIVITY_LOG_ENABLED` flag; strict parsing per `env.ts` (a mistyped flag fails the boot)
- [ ] 7.2 Measure write volume and latency impact in staging **against snapshot-scale data**, not
      estimated (depends on `staging-parity-harness` task 1.x)
- [ ] 7.3 Enable in production after the measurement
- [ ] 7.4 Supertest: flag off → no records written and the request path is unchanged

## 8. Documentation of what is NOT captured
- [ ] 8.1 Record the deferred capture points and the feature each waits on (D8): view duration and
      print (`DR - 0006` viewer), QoE add-back and valuation assumption changes, signature execution
- [ ] 8.2 Document the hash chain as consistency evidence, not proof against a privileged attacker (D5)
- [ ] 8.3 State plainly that the read surface, access control, and self-logging are not in this change

## 9. Wrap up
- [ ] 9.1 `openspec validate activity-log-capture --strict` passes
- [ ] 9.2 typecheck + lint + test green; module coverage ≥90%
- [ ] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`
- [ ] 9.4 Carry the four open questions in `design.md`; Q1 (retention period) needs a legal/commercial
      answer but does not block the build
