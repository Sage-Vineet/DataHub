## Context

See `proposal.md`. The gateway (`apps/api/src/gateway.ts`) already routes per request: in-process
modules mount ahead of a catch-all proxy, and `withCommonMiddleware` (`shared/router.ts`) ensures an
undefined path falls through to legacy untouched. `route-contract.test.ts` already derives the legacy
route surface from `backend/src/app.js` and the module surface from the real routers, and fails the
build when a module claims a path legacy does not serve.

So the seam and the source-derivation both exist. What is missing is a way to compare the two engines'
**answers**, against production-shaped data, and a place to run it.

## Goals / Non-Goals

**Goals:** an environment whose data is production-shaped and safe to point a live system at; drift
between the snapshot and `packages/db` recorded rather than rediscovered; a re-runnable per-endpoint
parity verdict that makes deleting a legacy handler an evidenced decision.

**Non-Goals:** performing flips, restating auth's parity cases, performance testing, automating the
decision.

## Decisions

### D1 — The request set is derived from source, never hand-listed

The harness reuses `route-contract.test.ts`'s derivation: legacy routes from `backend/src/app.js` +
route files, module routes from the real routers. For a given domain it emits the intersection — the
paths both engines claim — and that intersection **is** the request set.

A hand-listed set is the failure mode this exists to prevent: it passes while the module quietly stops
covering a route, because nobody updated the list. Deriving it means adding a route to a module
automatically widens what parity must prove, and the harness reports paths it could not exercise rather
than omitting them silently.

### D2 — Compare on status and normalized shape, not bytes

Byte equality is the wrong bar and would fail on every response: ids, timestamps, and ordering legitimately
differ between engines. The comparator asserts, in order of strictness:

1. **Status code** — exact match, always.
2. **Body shape** — same keys, same types, recursively, after normalizing volatile fields (ids,
   timestamps, `created_at`/`updated_at`) to type placeholders.
3. **Declared invariants** — per-endpoint semantic assertions supplied by the domain (e.g. "the
   returned company list has the same length and the same set of names"). Optional, and where the real
   confidence comes from.

Latency is recorded and reported, never a gate (proposal non-goal).

### D3 — Read-only by default; mutating requests are opt-in and staging-only

Mutating verbs run only with `PARITY_ALLOW_MUTATION=true`, and never against production. Two independent
refusals, because one is a config check and the other is a fact about the target:

- the harness refuses to start if `DATABASE_URL` matches the configured production host, and
- it refuses to start unless the target it is pointed at reports the staging marker seeded in D4.

A parity tool that can write to production is a worse risk than the drift it detects.

### D4 — Email addresses are rewritten at seed time, not masked at read time

The snapshot carries real customer data. The specific hazard is not "PII sits in a lower environment" —
it is that **staging runs a real Graph emailer**, so a password-reset test or a notification loop sends
real mail to real customers from a system nobody is watching. Masking in the application layer does not
prevent that; the address has to be wrong in the database.

At seed: every email address is rewritten to a routable sink address that encodes the original row id,
phone numbers are replaced, and a `staging_marker` row is written (which D3's second refusal reads).
Financial data is **not** anonymized — the whole point of a production snapshot is that the shapes and
volumes are real, and financial rows are what the parity comparison is about.

Staging access stays restricted to the production-access population. Anonymizing contact identifiers
reduces the blast radius of the outbound-mail hazard; it does not make the environment public.

**Trade-off:** rewritten addresses mean email-delivery parity cannot be tested end-to-end in staging.
That is the right trade — `auth-production-cutover` task 4.3's "email received" case moves to the
sink inbox, which is checkable, rather than to a customer's inbox, which is not recoverable.

### D5 — Drift is a committed artifact, not an observation

`db:pull` output is diffed against `packages/db/src/schema.ts` and the result is committed as a dated
baseline. Later runs diff against the baseline, so *new* drift is distinguishable from known,
already-triaged drift. Without that, every reconciliation re-derives the same known differences and the
signal is lost in them.

### D6 — `backend/sql/schema.sql`: fix or retire, decided by evidence

The file indexes a column that does not exist (line 278, `bank_transactions(client_id)`), so it cannot
have applied cleanly to any database in a long time. The reconciliation in D5 establishes what
production actually has; that determines whether the file is repairable or should be retired in favour
of the Drizzle baseline. The decision is not taken up front, because taking it before the snapshot is
guessing. What is not acceptable is carrying it unchanged: it is the audit's "no authoritative schema"
finding in its most concrete form.

### D7 — The harness reports coverage alongside verdicts

Output states: endpoints compared, endpoints skipped and why (no fixture, mutation not permitted,
auth-gated with no session), and per-endpoint verdicts. A report that shows 12 green and says nothing
about the 30 it did not touch reads as "parity proven" when it means "parity sampled" — and that
misreading is what would authorize deleting a handler too early.

## Risks / Trade-offs

- **False confidence from a thin request set.** The most dangerous outcome here — a green report over
  four endpoints looks identical to a green report over forty. Mitigation: D7's coverage reporting is
  mandatory output, and the flip criteria in `tasks.md` reference coverage, not just verdicts.
- **Snapshot data handling.** Mitigated by D4, but the residual is real: financial data stays
  un-anonymized by design. That is a decision for the CTO to affirm explicitly, not for this change to
  assume.
- **Snapshot staleness.** A snapshot ages the moment it is taken; drift found against a month-old
  snapshot may not reflect production. Mitigation: the seed path is a repeatable script, so re-seeding
  is cheap, and the baseline is dated.
- **Harness rot.** A tool nobody runs decays. Mitigation: it runs in CI against the in-memory/compose
  stack (proving the harness itself works), and against staging on demand.
- **Parity passes, production differs.** Staging is not production — different secrets, scale, and
  integrations. Mitigation: the canary step in each domain's cutover change stays, and the rollback
  drill proves the exit.

## Migration Plan

1. Seed tooling: snapshot restore + D4 anonymization + `staging_marker`; documented, repeatable.
2. `db:pull` reconciliation; commit the dated baseline (D5); take the `schema.sql` decision (D6).
3. Comparator (D2) + request-set derivation extracted from `route-contract.test.ts` into a shared
   module both it and the harness import.
4. Harness runner with the D3 refusals and the D7 report.
5. CI wiring against compose; on-demand run against staging.
6. Rollback drill: flip a domain on in staging, exercise it, flip off, confirm legacy resumes.
- **Rollback:** the harness is a tool with no request-path code; removing it changes no behavior.

## Open Questions

1. **Where does staging run, and who pays for it?** Compose exists (`docker-compose.staging.yml`); a
   persistent hosted staging does not. Pending action in `REARCH_LOG.md` already lists Vercel and
   branch-protection items as outside-the-repo work — this joins them.
2. **Snapshot cadence** — one-off for Phase C, or scheduled? Affects whether the seed path needs to be
   idempotent against an existing staging database.
3. **Does the CTO affirm un-anonymized financial data in staging** (D4)? If not, the parity comparison
   weakens substantially and the trade-off needs restating.
4. **Sink address domain** for D4's rewritten emails — needs a real domain that accepts and retains
   mail, so `auth-production-cutover` 4.3 stays checkable.
