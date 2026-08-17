## Why

`SE - 0004` (Activity & Audit Log) is the only capability in the product surface whose value **expires**.
Every other feature can be built later at the same cost. An audit log cannot: it is a capture problem,
and activity that was not recorded when it happened is gone. The product list says so directly —
"build early rather than retrofitted" — and the dependency graph agrees, placing it at L1 with document
control (`DR - 0006`), buyer engagement analytics (`BR - 0010`), the seller status report
(`BR - 0011`), and e-signature audit certificates (`SY - 0004`) all downstream of it.

`BR - 0010` is the sharpest case. It is described in the product list as a key demo feature, and it is
built **entirely** from history: which documents a buyer opened, for how long, how often they returned.
On the day that feature is scheduled, its quality is decided by how long capture has been running. Any
month spent without capture is a month that feature can never show.

There is a second reason to do this now rather than with the rest of the capability: `activity-log` has
**no legacy equivalent**. There is nothing to cut over, no parity to prove, no handler to delete. It
can be built greenfield in the new stack while the cutover work proceeds independently — one of only
two foundation capabilities with that property.

**Cutover-order domain:** none — new capability, no legacy predecessor. It attaches at the gateway
seam (`docs/MODERNIZATION_PLAN.md` §5's route-group mechanics) and is workstream C4 in
`docs/PHASE_C_PLAN.md`.

## What Changes

- **Two-tier capture.** The gateway records a request envelope for **all** traffic, including traffic
  still served by legacy; modules emit typed semantic events as they cut over. A correlation id joins
  the two. This is the crux: a log that only sees the new stack would miss almost everything for the
  duration of Phase C — exactly the gap the capability exists to close.
- **Envelope-only at the gateway.** The gateway deliberately parses no bodies so uploads and downloads
  stream through (`gateway.ts`); capture SHALL NOT change that. Method, path, actor, status, IP, user
  agent, timing — never body content.
- **Append-only storage with a per-record hash chain**, so tamper evidence is a property of the data
  rather than a promise about access control. No update or delete path exists, for anyone, including
  administrators.
- **Explicit gap markers.** If the write path sheds load, it records **that it did** rather than losing
  records invisibly. A log with a visible gap is evidence; a log with an invisible one is misleading.
- **Semantic events for the domains already built** — authentication, permission changes, and document
  access — emitted from the modules that own them.
- **Retention and partitioning** sized for a log that must outlive the engagements it describes.

## Capabilities

### New Capabilities
- `activity-log`: capture — the request envelope for all traffic, typed semantic events from migrated
  modules, append-only tamper-evident storage, and visible gap markers.

## Impact

- **New code:** `apps/api/src/activity/*` (capture middleware, writer, hash chain, event types),
  `packages/db` (`activity_events` + partitioning), emission call sites in the auth, companies, users,
  folders, and uploads modules.
- **Data:** one new append-only table. No change to existing tables.
- **Runtime behavior:** every request gains an envelope write on a non-blocking path. Request latency
  and semantics are unchanged; a capture failure never fails a request (see `design.md` D5 for the
  bound on that trade).
- **Legacy impact:** none to legacy code — capture happens at the gateway, in front of it. Legacy
  traffic is covered without modifying a single legacy file, which is the whole reason for the gateway
  tier.
- **Branch:** `ba/product-surface-specs` off `ba/rearch`; `main` frozen.

## Non-goals

- **Search, filtering, and export.** Specified in the `activity-log` surface sketch and deliberately
  deferred — they can be built over history at any time. Capture cannot.
- **Anomaly alerting** (mass download, unexpected geography, off-hours). Same reason; it needs a
  history to be calibrated against anyway.
- **Buyer engagement analytics** (`BR - 0010`). This change makes it possible later; it does not build
  it.
- **Document view *duration*.** Requires the secure viewer of `DR - 0006`, which does not exist. Open
  and download are captured now; duration is recorded as a gap in what we can currently see.
- **Log access control and self-logging.** The read surface is out of scope, so there is nothing yet
  to restrict; both land with the read surface.
- **Retrofitting history.** Nothing before this change ships can be recovered. That is the cost being
  incurred by every week it is not built, and it is not recoverable afterwards.
