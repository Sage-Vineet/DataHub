## Why

`deal-qa-module` shipped the requirement that an answer's evidence be "discoverable from
either place" (`QA - 0003`) — and built only one half of it. The server half is complete
and tested: `POST /qa/items/:id/attachments` enforces the cross-deal guard, the null-adapter
path degrades cleanly when the data room is off, and `qa_attachments` records the link.

The client half was zero. `attachQaDocumentRequest` sat in `apps/web/src/lib/api.js` **called
from nowhere**; `apps/web/src/pages/client/CompanyQA.jsx` had no file control, so a seller
could not produce evidence at all; and `QAItemDrawer.jsx` rendered the attachments it did
receive as **dead `<li>` pills**. The demo seed attaches "Lease Agreement.txt" to `QA-003`,
so the one place the product's central claim was on screen, it was inert.

The claim being made — three surfaces that work together — had **not one clickable link
between any two of them**, while the data to build every direction already existed
(`qa_attachments`, `cim_block_provenance`, `qa_items.external_ref`).

A defect sat underneath it. `tools/demo/seed.sql` archived the **Legal** folder to
demonstrate the `includeArchived` filter, and `seed-dataroom.sql` filed the only seeded
evidence inside it. `FileExplorer.jsx` excludes archived items from the normal view, so the
showcase link pointed somewhere a visitor could not navigate back to by clicking.

**Cutover-order domain:** none. This is greenfield capability on two greenfield modules
(`qa`, `dataroom`), both behind kill-switch flags. **No legacy impact:** no legacy route,
handler or table is read or written, `moduleSurfaces()` is untouched, and the parity route
surface is byte-identical. **No main-branch impact:** `main` stays frozen.

## What Changes

- **The forward link.** An attachment on an answer becomes a link into the data room that
  opens the document in the **preview** — the claim is "here is the lease that says that",
  and the detail drawer shows metadata *about* a file rather than the file. Gated on
  `useFeature('dataroom')` and on a resolvable client id; where either is missing it renders
  today's non-link pill, because a link to a *coming soon* page is worse than no link.
- **The data room consumes a document reference**, navigating by the document's real ancestor
  chain rather than the folder in the link, so the link survives the file being moved.
- **The seller attaches evidence.** A file control and a destination picker on the client's
  Q&A sheet, progressively disclosed, driven by the chunked upload route.
- **An attachment binds to an answer even when the caller does not name one.**
  `repository.drizzle.ts` skips rows with no `response_id`, so an unbound attachment was
  stored and **never returned** — optional in the contract, mandatory in practice. The
  service now resolves the current answer.
- **The seed defect is fixed**: Legal is unarchived and a dedicated empty folder carries the
  archive demonstration instead.

## Non-goals

- **The reverse link — "what is this file evidence for?" — is deferred.** It was designed
  (`GET /qa/documents/:documentId/evidence`, owned by `qa` rather than `dataroom` so one
  visibility rule keeps one home) and deliberately not built: nobody at a booth is asking it
  yet, because they have not accumulated enough documents for it to be a problem. Reliability
  over completeness for the 24 Aug demo.
- **`WorkspaceQA` consuming `?item=`.** The reverse direction still shows the reference as
  text.
- **Fixing `replaceQaAssigneesRequest`**, which is wired into `qaStore.reassign()` while no
  component calls it, even though `NominatePanel.jsx` tells the user reassignment is possible.
  A real defect — the UI promises something it cannot do — but a separate one.
- **No contract, migration or route changes.** Every endpoint this uses already shipped.
