# Activity log — what is captured, and what is not

> Status: current as of the `activity-log-capture` change · Spec: `SE - 0004`
> Design: `openspec/changes/activity-log-capture/design.md`

An audit log is trusted in proportion to how well its limits are known. A log whose
gaps are undocumented gets asked questions it cannot answer, and the answer that
comes back — silence — reads as "it did not happen". This page is the standing
statement of what the log does and does not see.

## Captured now

**Tier 1 — request envelope, every request, both engines.** Written at the gateway,
so a request served by the legacy backend is captured as fully as one served by a
module. Records: timestamp, method, raw and normalized path, status, actor, IP,
user agent, duration, correlation id, and which engine served it.

**Tier 2 — semantic events**, emitted by migrated modules and joined to their
envelope by correlation id:

| Event | Emitted from | Notes |
|---|---|---|
| `auth.login.succeeded` / `.failed` | `modules/auth/router.better.ts` | Failure is logged although the response stays enumeration-safe |
| `auth.password.changed` | `modules/auth/router.better.ts` | On completed reset |
| `auth.session.terminated` | `modules/auth/router.better.ts` | On logout |
| `access.granted` / `.modified` / `.revoked` | `modules/folders/router.ts` | Folder access, with the granting user |
| `access.granted` / `.revoked` | `modules/users/router.ts` | Company membership, with the granting user |
| `document.opened` | `modules/uploads/router.ts` | Folder document listing |
| `document.downloaded` | `modules/uploads/router.ts` | Upload content served |

Semantic events are emitted **after** the authorization guard, never before, so the
log never records an access that was actually denied. Denied attempts still appear
— as envelopes, with their status.

## Not captured, and what each waits on

| Not captured | Waits on | Consequence today |
|---|---|---|
| Document view **duration** | `DR - 0006` secure viewer | `BR - 0010` engagement analytics can rank by opens and downloads, not by time spent |
| **Print** events | `DR - 0006` secure viewer | Printing is invisible; download is the closest proxy |
| QoE add-back and adjustment changes | QoE module | Not built |
| Valuation assumption changes | Valuations module | Not built |
| Signature execution | `SY - 0004` e-signature | Not built |
| Deal stage changes, offer receipt | `deal-marketing` / `deal-execution` | Not built |
| Integration connect/disconnect | Event type declared; no integration module has a seam yet | Declared so the first integration emits rather than invents |
| Semantic attribution for **legacy-served** requests | Cutover progress | Legacy traffic has envelopes but no domain events — the largest current gap, and it shrinks with every domain flipped |

## Known limits of what *is* captured

- **Tier-1 attribution is what the credential asserts, not a validated session.**
  The gateway verifies a JWT signature and reads `sub`; it does no database lookup,
  because tier 1 runs on every request and a session lookup would put the audit log
  on the product's latency path. Better Auth bearer tokens are opaque session
  tokens, so they do not verify at tier 1 and those requests are recorded as
  anonymous — attributed instead by the tier-2 event the module emits with its
  validated identity.
- **Bodies are never captured**, by design and by test. Reading a body at the
  gateway would consume the stream and forward a body-less request to legacy.
- **The hash chain is consistency evidence, not cryptographic proof against a
  privileged attacker.** It detects alteration and removal by anyone who cannot
  rewrite the whole chain. Defending against someone who can needs external
  anchoring, which is deliberately deferred (design D5, open question 4).
- **Load shedding is possible and visible.** If the writer's buffer overflows or a
  write fails, a gap marker records the interval, count, and reason. A quiet period
  with no gap marker means nothing happened; a quiet period with one means capture
  was shedding.
- **Retention period is undecided** (design open question 1). Partitioning is in
  place, so any answer is implementable without a migration.

## Not in this change at all

The **read** surface — search, filtering, export, anomaly alerting, and the log's
own access control and self-logging. All of it can be built over history at any
time; history cannot. Nothing currently exposes the log through an API, so there is
no read path to restrict yet — but that access control must land with the read
surface, not after it.
