## Context

See `proposal.md`. The relevant facts about the stack as it stands:

- The SPA now calls the **gateway**, not legacy directly (commit `24780ac`), so the gateway is the one
  place every request passes through regardless of which engine serves it.
- The gateway runs **no body parser** before the proxy — bodies stream through untouched
  (`gateway.ts`), and `withCommonMiddleware` exists precisely because `router.use()` consumed request
  streams and broke unmigrated neighbours. Any capture that reads a body would reintroduce that bug.
- Modules already receive a validated session via `requireSession`; the gateway does not.
- Nine domains exist in the new stack; most traffic is still legacy.

## Goals / Non-Goals

**Goals:** capture that covers legacy and module traffic from day one; storage whose immutability is
demonstrable, not asserted; honest behavior under load, including visible gaps; no change to request
latency, semantics, or streaming.

**Non-Goals:** read surface, search, export, alerting, analytics, view duration, retrofitting history.

## Decisions

### D1 — Two tiers: gateway envelope for coverage, module events for meaning

The gateway sees **everything** and understands **nothing** — it knows a POST hit `/companies/42` and
returned 200, not that a permission was granted. A module understands its own semantics but only sees
its own traffic, which today is a small minority.

Neither tier alone is sufficient, so both are built:

- **Tier 1 — envelope (gateway).** Every request: timestamp, method, normalized path, status, actor,
  IP, user agent, duration, correlation id, and which engine served it.
- **Tier 2 — semantic events (modules).** Typed events with domain meaning, carrying the same
  correlation id: `auth.login.succeeded`, `access.granted`, `document.downloaded`.

As domains cut over, tier 2 coverage grows and tier 1 stays constant. The correlation id means an
event and its envelope are joinable, so a semantic event never needs to duplicate transport detail.

**Consequence, stated plainly:** for a legacy-served request we get the envelope only. That is a real
limitation and it is still far better than nothing — "this user opened this document at this time from
this IP" is most of what a confidentiality dispute turns on, and it is available for every route from
day one without touching a legacy file.

### D2 — Envelope-only: capture never reads a body

Tier 1 records the request line and headers it needs, never body content. This is not a privacy
preference — reading the body would consume the stream and break the proxying that `shared/router.ts`
was written to fix. Capture attaches to the response-finished event, where the status and duration are
known and the body has already streamed past.

Path is normalized (`/companies/42` → `/companies/:id`) so the log is aggregatable, with the raw path
retained.

### D3 — Actor attribution at the gateway via cheap token decode

The gateway has no session guard, so attribution needs the actor without a database round trip on every
request. The bearer token is decoded — signature verified, no lookup — and the subject claim recorded;
requests with no or invalid token are recorded as anonymous, which is itself a signal worth having
(`SE - 0004` requires failed and denied attempts, and an unauthenticated probe is one).

**Trade-off:** the decoded subject is what the token asserts, not what a session lookup would confirm.
For a *log* that is the correct bar — we are recording what was presented. Where certainty matters, the
tier-2 event carries the module's validated session identity, and the two being joinable means a
mismatch is detectable rather than hidden.

### D4 — Append-only enforced twice: no write path, and no grant

Immutability by convention is not immutability. Two independent mechanisms:

1. **No update or delete path exists in code.** The repository exposes `append` and reads. There is no
   administrative override, because an override is exactly what an attacker or a panicking insider
   would use.
2. **The database role the application uses holds INSERT and SELECT on the table, not UPDATE or
   DELETE.** So a code defect cannot mutate history either.

Retention deletion runs as a separate, privileged, audited path — not through the application role.

### D5 — Tamper evidence by hash chain

Each record carries the hash of its own canonical content plus the previous record's hash. Removing or
altering a record breaks the chain from that point, and the break is detectable by a verification pass
without an external service.

This is deliberately modest: a hash chain proves *internal* consistency and detects casual tampering.
It does not defend against an attacker who can rewrite the whole chain, which needs external anchoring
or append-only storage at the infrastructure layer. That is a later hardening step, and claiming more
now would be the kind of security theatre that makes people trust a control further than it deserves.

### D6 — Load shedding is recorded, never silent

The write path is asynchronous with a bounded buffer, so capture never adds latency to a request and a
capture failure never fails a request. But a bounded buffer can overflow, and the naive behavior —
drop the record — produces a log that is wrong in the most dangerous way: it looks complete.

Instead: on overflow, a **gap marker** is written recording the interval, the count dropped, and the
reason. A reader can then see "between 14:02 and 14:03, 1,840 events were not captured" and treat that
window accordingly.

**Trade-off:** requests still succeed while capture degrades. The alternative — failing requests to
guarantee the log — is wrong for this product; an audit log that can take the platform down is a
liability. The gap marker is what makes the degradation honest rather than invisible.

### D7 — Partition by month from the start

`SE - 0004` requires retention that outlives the engagement, and tier 1 writes on every request, so this
table becomes the largest in the system. Monthly partitioning from day one costs almost nothing now and
is expensive to introduce once the table is large. Retention policy then operates on partitions.

### D8 — Ship capture for events we can actually see; name the ones we cannot

Landing now: authentication events, permission grant/modify/revoke, document open and download,
integration connect/disconnect, and the envelope for everything else.

**Not landing, because the feature that produces them does not exist:** view *duration* and print
events (need `DR - 0006`'s secure viewer), QoE add-back changes and valuation assumption changes (need
those modules), signature execution (needs `e-signature`). Each is a capture point to be added with its
feature. Recording that list here is the point — it is the difference between a known backlog and a
silent hole discovered when someone asks the log a question it cannot answer.

## Risks / Trade-offs

- **Write volume on every request.** Tier 1 doubles the write path's row count against production
  traffic. Mitigated by async writes, batching, and D7 partitioning — but it should be measured against
  the snapshot's real volumes in staging before production enablement, not estimated.
- **The gateway becomes load-bearing for an audit control.** A capture defect there affects all traffic.
  Mitigated by D6 (never blocks, never fails a request) and by capture being attached after the
  response, where it cannot alter the response.
- **Tier 1 records IPs and identities — the log is itself sensitive.** Its read surface is out of scope
  here, so nothing exposes it yet; that surface must land with access control and self-logging, and this
  change should not be read as having provided them.
- **Hash chain over-promises if described loosely** (D5). It should be documented as consistency
  evidence, not as cryptographic proof against a privileged attacker.
- **Partial semantic coverage during Phase C** (D1). Real, and the alternative — waiting for cutover to
  finish before capturing anything — is strictly worse.

## Migration Plan

1. `packages/db`: `activity_events`, monthly partitioning, hash-chain columns; INSERT/SELECT-only
   application grant.
2. Append-only repository + hash chain + verification pass.
3. Async writer with bounded buffer, batching, and gap markers (D6).
4. Tier-1 gateway middleware: response-finished hook, envelope, path normalization, token decode (D3).
5. Tier-2 emission in auth, companies, users, folders, uploads.
6. Enable behind `ACTIVITY_LOG_ENABLED`; measure write volume in staging against snapshot data; enable
   in production.
- **Rollback:** flag off → capture stops, request path unchanged. Records already written stay (they are
  append-only), and the gap is visible per D6.

## Open Questions

1. **Retention period.** `SE - 0004` says it must outlive engagement closure; the actual number is a
   legal/commercial decision, not an engineering one. Partitioning (D7) makes any answer implementable,
   so this does not block the build.
2. **Does tier 1 log query strings?** They can carry identifiers useful to an investigation and
   occasionally secrets in badly-formed legacy links. Recommendation: capture with a redaction list, but
   confirm.
3. **Is the token-decode attribution (D3) acceptable for evidentiary use**, or does a disputed record
   need session-validated identity? Affects whether tier-2 coverage becomes a prerequisite for relying
   on the log in a dispute.
4. **External anchoring for the hash chain** (D5) — needed at all, and if so, when? Deferring is
   reasonable; deciding it is not urgent, but it should be an explicit deferral rather than an omission.
