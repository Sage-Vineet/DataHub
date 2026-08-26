# Design notes — deal Q&A

## D1 — Why not extend `requests`

`requests` looks close: it has a category enum, priority, status, due date, an `assigned_to` FK, and
narrative and document children. It is nonetheless the wrong object.

- It models a **broker→client ask for a deliverable** with an **approval gate**
  (`approval_status`, `approved_by`, `approved_at`) and a submission source. A Q&A item is a
  question with an answer, and it has no approval step.
- It has a **single nullable assignee** and no requestor/requestee distinction, no assignment
  history, no threading. Adding those to a table already cut over and parity-tested (11 routes,
  `requests-domain` archived) means changing shipped behaviour to serve a new object.
- Its `request_category` is a `pgEnum`. Nomination is per category *per company*, so the category
  must be a row.

Bending it would produce a worse demo and a worse schema, and would put a flagged, parity-tested
module at risk during the one week it must not break. Greenfield is cheaper here, and the
`activity-log` precedent (`docs/REARCH_LOG.md` §20) shows the shape.

## D2 — Categories are rows, seeded from the requests vocabulary

`qa_categories` is per-company. The reason is nomination: a seller nominates answerers *for a
category on their deal*, and an enum cannot carry that. Seeded from the existing `request_category`
values — Finance, Legal, Compliance, HR, Tax, M&A, Other — so a visitor who clicks between the Q&A
surface and the requests surface sees one vocabulary rather than two.

## D3 — How the three departures reconcile rather than override

The confirmed asks contradict the written specs on their face. Each is resolved so that the spec's
guarantee still holds literally:

| Ask | Spec it appears to contradict | Resolution |
|---|---|---|
| Seller nominates answerers | `QA - 0001`: the broker assigns requestees | `qa_nominations` supplies the **default** requestee at creation. `QA - 0001`'s "any member may reassign, and it is logged" is untouched. Additive. |
| Broker rewords an answer | `QA - 0002`: a posted response is permanently immutable | `qa_responses.body` is **never UPDATEd**. The reword is a row in `qa_presentations` pointing at the immutable response. Immutability holds literally. |
| Answers are versioned | `QA - 0002`: correction happens only via a new follow-up | A correction **is** a new response row, with `supersedes_id` and an incremented `answer_version`. The only mutation is flipping the prior row's `is_current`. Every version keeps its own citation reference, so a narrative citing v1 still resolves. |

The third one is worth stating plainly: this is not a workaround. `QA - 0002`'s guarantee is that a
follow-up cannot invalidate an existing narrative, and an append-only supersede chain delivers that
*by construction* rather than by policy.

## D4 — Citation references are permanent and per-response

`qa_responses.citation_ref` is unique across the system and assigned at post time — `QA - 0002`
requires that a *specific response*, not just a thread, be citable. The item carries its own
human-readable `reference` (`QA-014`); a response extends it (`QA-014.R3`). A superseding version
gets a **new** reference rather than inheriting the old one, which is what keeps an old citation
resolving to what it originally meant.

## D5 — Enforcement lives in the repository, not the component

Per-item visibility overrides and role-based filtering are applied in the query, so a hidden item is
**absent from the response**, not hidden in the UI.

This is worth saying explicitly because the codebase already contains the opposite mistake once:
`folder_access` grants are stored server-side and honored only by the browser
(`apps/web/src/components/fileExplorer/FileExplorer.jsx:2477-2509`), with `canAccessCompany` the
sole server check. That hole is accepted for the demo and recorded in the data room change's
Non-goals. New code does not repeat it.

## D6 — `text` + `CHECK` instead of `pgEnum` for the new status columns

A deviation from repo style, which uses `pgEnum` throughout `packages/db/src/schema.ts`. Justified
because PGlite integration tests hand-write their DDL per file, enum `ALTER` is awkward across that
boundary, and the zod contract in `packages/contracts/src/qa.ts` is the real validation boundary in
this architecture. Recorded here so it reads as a decision rather than an oversight.

## D7 — Cross-module ports, and what happens when a dependency is off

- **QA → data room:** `DataRoomAttachmentPort { attach(documentId, folderId); describe(documentId) }`,
  implemented by the dataroom service and injected in `server.ts`, following the
  `FolderProvisioningPort` precedent (`apps/api/src/modules/companies/ports.ts:74-79`, injected at
  `server.ts:98-107`). When `DATAROOM_MODULE_ENABLED=false` a **null adapter** is injected: the
  attachment routes report the capability unavailable and every other Q&A route works. A kill switch
  that takes out a neighbouring feature entirely is not a kill switch.
- **QA → users:** `DealMemberPort { listMembers(companyId); isMember(companyId, userId) }` over
  `user_companies` and `users.company_id`. This is what enforces `QA - 0001`'s "no cross-deal
  assignment".
- **QA → activity log:** the existing `emitActivity` (`apps/api/src/activity/capture.ts`). Note that
  `activityEventType` (`packages/contracts/src/activity.ts:36-48`) is a **closed zod enum** — an
  undeclared event type throws at runtime, so adding the Q&A values is required, not optional.

## D8 — The route-contract guard

`route-contract.test.ts` iterates `moduleSurfaces()` (`apps/api/src/parity/routes.ts:111-124`), which
lists seven modules. **`qoe` is not among them** — that absence, not its prefix, is why it passes.

So `qa` mounts at `"/"`, writes every route as `/qa/...`, and stays out of that list. A comment in
`routes.ts` records why, because the instinct on reading the list is to add what is missing, and
doing so turns every `/qa` route into an orphan failure and forces regeneration of the committed
`tools/parity/route-surface.json`.

## D9 — The trap that makes client flag-awareness mandatory

An unmatched `/qa/...` path does **not** 404. It falls through the catch-all proxy in
`apps/api/src/gateway.ts` to the legacy backend and returns something unexpected. So with
`QA_MODULE_ENABLED=false` and no client awareness, the nav entry stays, the fetch resolves to
nonsense, and the store never settles into either a result or an error state.

This is why `demo-platform-hardening` is a hard prerequisite rather than a convenience, and why the
Q&A route element must be gated **above** any data fetch.
