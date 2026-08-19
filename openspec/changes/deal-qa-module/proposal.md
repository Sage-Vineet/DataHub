## Why

`QA - 0001/0002/0003` (Josh Tonnesen, 14 Aug 2026) specify the system of record for formal, trackable
questions and answers on a deal — who asked what of whom, what was answered, and what evidence backs
it. **None of it exists.** There is no `qa_items` table, no module, no legacy route; `grep` for
questions, answers, checklists or tasks returns nothing across `backend/`, `apps/` and `packages/`.

Today the same need is served by three unrelated, non-interoperating systems: `requests` (a
broker→client document/narrative ask with an approval gate), `messages` (chat), and a **CIM
questionnaire stored as a JSON blob** in `workspace_page_state`. The first two are the wrong object
and the third has no per-question identity, so nothing downstream can cite an answer.

That matters beyond Q&A itself. `openspec/product/design.md` §D7 puts `deal-qa` upstream of both
`qoe` and `cim`: the working capital notes (`QE - 0006`), risk and opportunity items (`QE - 0007`),
the reconciling-item generator (`QE - 0015`) and CIM population (`CM - 0004`) all depend on this
being the single place formal Q&A lands. Building the CIM's questionnaire privately again would be
the fourth such system.

**Cutover-order domain:** none — this is **greenfield capability**, following the `activity-log`
precedent (`docs/REARCH_LOG.md` §20). There is no legacy handler to shadow and nothing to cut over,
so the flag is a kill switch rather than a rollback.

## What Changes

- **New `qa` module** at `apps/api/src/modules/qa/`, serving `/qa/*`, mounted at `"/"` with routes
  prefixed inside the router and **deliberately absent from `moduleSurfaces()`**
  (`apps/api/src/parity/routes.ts:111-124`) — that absence, not the prefix, is how `qoe` escapes
  `route-contract.test.ts`.
- **Per-company categories with nominated answerers.** Categories are rows, not a `pgEnum`, because
  the seller nominates people *per category per deal* and an enum cannot carry a nomination. Seeded
  from the existing `request_category` vocabulary so it matches the requests surface a visitor may
  also click into.
- **One requestor, many requestees**, with reassignment by any deal member and a full assignment
  history.
- **Insert-only responses with a supersede chain**, each carrying a permanent citation reference.
- **A broker-authored presentable version** of an answer, in its own table, versioned on its own
  counter.
- **Answers file attachments into the data room** at a folder the respondent picks.
- **Per-item visibility overrides** and Q&A event types on the existing hash-chained activity log.

### Three deliberate departures from the written specs

Each was confirmed, and each is reconciled rather than overridden. Stated here so a later reader
does not treat them as drift:

1. **The seller nominates answerers.** `QA - 0001` has the broker assigning requestees. Nomination is
   built as *delegation*: a nomination supplies the **default** requestee at item creation, and
   `QA - 0001`'s "any user with access may reassign, and it is logged" is preserved intact. Additive,
   not a replacement.
2. **The broker rewords an answer.** `QA - 0002` makes a posted response permanently immutable. So
   the response body is **never updated**; the reword lives in a separate table, attributed to the
   broker, pointing at the exact immutable response it derives from. Immutability holds literally,
   and the seller's words remain visible beside the presentable version.
3. **Answers are versioned.** `QA - 0002` says corrections happen only via a new follow-up. A
   correction here is a **new response row** with a supersede pointer and an incremented version;
   the only mutation is flipping the prior row's current flag. Every version keeps its own citation
   reference and timestamp, so a narrative citing v1 still resolves — which is exactly
   `QA - 0002`'s "a follow-up does not invalidate a narrative", achieved by construction.

## Capabilities

### New Capabilities
- `deal-qa`: per-company Q&A items with categories, nominated and reassignable answerers, threaded
  insert-only responses, answer versioning, broker presentable versions, data room attachments,
  per-item visibility, and an audit trail.

### Modified Capabilities
- `activity-log`: the event-type enum gains Q&A events. It is a **closed zod enum**
  (`packages/contracts/src/activity.ts:36-48`) — an undeclared type throws, so this is required, not
  optional.

## Impact

- **New code:** `apps/api/src/modules/qa/*`, `packages/contracts/src/qa.ts`,
  `apps/web/src/store/qaStore.js`, `apps/web/src/pages/broker/workspace/WorkspaceQA.jsx`,
  `QAItemDrawer.jsx`, a nominee picker.
- **Changed:** `packages/contracts/src/activity.ts` (enum values), `apps/api/src/server.ts`,
  `apps/web/src/App.jsx` (routes), `apps/web/src/lib/api.js`.
- **Data:** nine new `qa_*` tables. No existing table is altered.
- **Legacy impact:** none. Nothing legacy serves `/qa`, and no existing route changes behaviour.
- **Depends on:** `demo-platform-hardening` (migration runner, feature degradation);
  `dataroom-versions-comments` for attachment filing — but see Non-goals, that dependency is
  optional at runtime.

## Non-goals

- **A notifications hub.** `QA - 0001` requires notification events to route through a platform hub
  "rather than a standalone email mechanism built specifically for Q&A". No hub exists — it is one
  of the four open cross-cutting gaps in `openspec/product/design.md` Register B. This change emits
  the events to the activity log and **builds no mailer**. Building a bespoke Q&A mailer is
  explicitly what the spec forbids.
- **The `QA - 0002` retrieval service, auto-tagging and narrative citation rendering.** The module,
  section and account tag columns ship and default to "Unclassified / General" so no item is dropped
  from the pipeline, but the tag-narrowed retrieval service and inline citation rendering are
  deferred to whichever narrative-drafting feature first needs them.
- **`QE - 0015` (the Q&A generator).** Materiality-threshold scanning of the P&L and balance sheet to
  generate questions is a separate feature. This change only accepts `qe_generator` as a source of
  origin so generated items have somewhere to land.
- **Bulk reassignment**, self-unassignment, and due-date reminder delivery. The first two are
  deferred by `QA - 0001` §8 itself; the third needs the absent hub and there is no scheduled worker
  anywhere in this repository.
- **Answer attachments when the data room capability is disabled.** The attachment port is injected
  as a null adapter and the attachment routes return a clear unavailable response; every other Q&A
  route works. That is the kill switch behaving correctly, not a degraded build.
