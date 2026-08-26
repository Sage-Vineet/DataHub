## Why

The CIM is the primary document a broker puts in front of buyers, and the pitch being taken to
market is that it takes **weeks by hand and should take minutes**. There is already a substantial
CIM surface in this repository — `WorkspaceCimPrep.jsx` (5,055 lines), 38 extracted real slide
layouts, a hand-rolled OOXML `.pptx` writer, a seller questionnaire page — and **all of it persists
into a single JSON blob**: one `workspace_page_state` row keyed `(company_id, page_key)`
(`backend/sql/migrations/048_workspace_page_state.sql`), served by legacy
`backend/src/routes/workspacePageState.js`. There is no backend CIM module and no relational schema.

That blob is the blocker for everything `CM - 0001` actually asks for. A row with one `payload jsonb`
has **no version axis**, so "editing a published CIM creates a new draft and prior published versions
remain retrievable" is not expressible. It has **no per-block identity**, so an answer cannot be
pointed at the block it populates, and `CM - 0004`'s review-and-accept flow has nothing to write to.
And because it is served by legacy, the CIM would be the one demo surface with no module flag — so
the promised kill switch would have nothing to switch.

Meanwhile `CM - 0004`'s question library is **90% built and unnoticed**: 373 authored `label:` strings
in `FIELD_LABEL_OVERRIDES`, most already phrased as questions, each already bound to a
`{slide, order, tokenIndex}` triple — that is, already bound to a block — plus `SECTION_QUESTION_BANK`
at line 108. Rebuilding a question library from scratch would be rebuilding something that exists.

**Cutover-order domain:** none — **greenfield capability**, following the `activity-log` and `qoe`
precedent. Legacy serves `/cim-questionnaire` and `/workspace-page-state/:pageKey`; this change adds
`/cim/*`, which legacy does not serve, and leaves the legacy routes reachable as the rollback target.

## What Changes

- **New `cim` module** at `apps/api/src/modules/cim/`, serving `/cim/*`, mounted at `"/"` with routes
  prefixed inside the router and **deliberately absent from `moduleSurfaces()`**
  (`apps/api/src/parity/routes.ts:111-124`) — that absence, not the prefix, is how `qoe` escapes
  `route-contract.test.ts`.
- **Relational spine, `jsonb` leaves.** Real tables for everything needing a version axis or an
  identity — deck, version, section, slide, block, publication. `cim_block.content` stays `jsonb`
  holding exactly the value shape the existing renderer already understands.
- **The god-file is re-pointed, not refactored.** The field key
  (`"<slide>:<aid>[:token:<i>:<key>]"`, produced by `extractTemplateFields` at line 1204) is stable,
  so the change to `WorkspaceCimPrep.jsx` is swapping two call sites — `getWorkspacePageStateRequest`
  (4347) and `saveWorkspacePageStateRequest` (4780) — for `/cim` calls behind an adapter that
  flattens blocks to the flat `fieldValues` map on load and back on save.
- **A forward-only blob migration** so existing CIM work is carried across rather than stranded.
- **The question library seeded from what already exists** — `FIELD_LABEL_OVERRIDES` and
  `SECTION_QUESTION_BANK`, extracted once by a script.
- **Guided Q&A through the Q&A module**, not privately: generation creates items in `deal-qa`
  carrying an opaque reference back to the block, and accepted answers populate blocks with
  provenance.
- **PDF export and publish** — the deck renders to PDF client-side, the server hashes and stores it,
  writes it into the data room as a tracked document, and freezes the version.
- **`content_class`** (deal content vs firm boilerplate) ships now. `CM - 0002` states that
  `CM - 0001` must carry it, and retrofitting a classification onto content already authored is the
  expensive kind of migration.

## Capabilities

### New Capabilities
- `cim`: a versioned, block-structured CIM deck built from platform data and guided Q&A, exported to
  PDF and published into the data room as an immutable tracked document.

### Modified Capabilities
- `data-room`: published CIM PDFs land as tracked documents, inheriting its access control and
  versioning.
- `deal-qa`: gains guided CIM Q&A as a source of origin for generated items.

## Impact

- **New code:** `apps/api/src/modules/cim/*`, `packages/contracts/src/cim.ts`,
  `packages/db/src/cim-schema.ts` (following `qoe-schema.ts`),
  `apps/web/src/features/cim/{SlideCanvas.jsx,layout.js,cimApi.js,cimPdfExport.js}`.
- **Changed:** `apps/web/src/pages/broker/workspace/WorkspaceCimPrep.jsx` — **two persistence call
  sites and an import**, roughly 60 lines in a 5,055-line file; `apps/web/src/pages/client/CimQuestionnaire.jsx`
  — two API calls repointed; `apps/api/src/server.ts`; `packages/db/src/schema.all.ts`.
- **Data:** new `cim_*` tables and a forward-only migration of existing `workspace_page_state` CIM
  rows. The blob rows are **read, not deleted**, so the legacy path stays a working rollback.
- **Legacy impact:** `/cim-questionnaire` and `/workspace-page-state/:pageKey` stay live and
  untouched behind the gateway. Rollback is `CIM_MODULE_ENABLED=false`.
- **Depends on:** `demo-platform-hardening` (migration runner, feature degradation);
  `dataroom-versions-comments` for publish; `deal-qa-module` for guided Q&A — the last of which is
  behind a port with a local fallback, see Non-goals.

## Non-goals

- **Data-bound financial exhibits.** `CM - 0001` specifies three exhibit groups (Core Earnings,
  Revenue Analytics, Balance Sheet & Cash) bound to QoE-adjusted figures. **None ships here.** The
  `slide_class` column distinguishes qualitative from exhibit slides so they can be added without a
  migration, but v1 is the narrative deck only. This is the single largest deferral in this change
  and it is deliberate: the qualitative half is what stalls a CIM, and the financial half depends on
  a QoE surface still in flight.
- **`.pptx` export as a requirement.** The existing hand-rolled writer
  (`apps/web/src/lib/cimPptxExport.js`) keeps working and its button stays. It is not on the
  critical path, gets no broker-only gate, and is not covered by this change's tests.
- **`CM - 0002` templates.** No template gallery, clone, promote, save-as-template, or firm default.
  Only the `content_class` attribute that `CM - 0002` requires `CM - 0001` to carry ships now.
- **`CM - 0003` the `.pptx` loader** — upload, attestation, extraction, mapping proposals, review.
  Entirely deferred.
- **`CM - 0005` the teaser / blind profile**, and **anonymisation** beyond an optional name-and-
  descriptor swap. The customer-name relabel map is not built.
- **Seller approval as a publish gate.** `CM - 0001` requires that a CIM not be publishable until a
  seller approves that version. The approval fields ship and are recorded and displayed; **publish is
  not blocked on them.** Stated plainly because it is a real weakening of a specified control, and it
  should be closed before the feature reaches a paying broker.
- **Concurrent edit locking.** `CM - 0001` requires an edit lock. Deferred; the demo instead seeds a
  separate deck per company so devices do not contend.
- **Server-side PDF rendering.** Rendering is client-side. Immutability is delivered by the version
  write-lock plus a content hash over the stored artifact, not by where the pixels were rasterised.
  Moving rendering server-side is a later change with no schema impact.
