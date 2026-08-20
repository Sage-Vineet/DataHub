## 1. Contracts

- [x] 1.1 `packages/contracts/src/cim.ts` — `cimDeck`, `cimVersion`, `cimSection`, `cimSlide`,
      `cimBlock`, `cimBlockBulkUpsert`, `cimGap`, `cimGenerateRequest`, `cimReviewItem`,
      `cimAcceptAnswer` (`{qa_item_id, mode: replace|append|skip, text?}`), `cimPublication`
- [x] 1.2 Re-export from `packages/contracts/src/index.ts` as `export * as cim` plus flat types
- [x] 1.3 `cim.test.ts` — `content_class` defaults to deal content; `mode` defaults to skip;
      a published version has no mutation schema

## 2. Data layer

- [x] 2.1 `packages/db/migrations/0004_cim.sql` — `cim_deck`, `cim_version`, `cim_section`,
      `cim_slide`, `cim_block`, `cim_question_library`, `cim_block_provenance`, `cim_publication`
- [x] 2.2 `cim_block` carries `block_key` (the SPA field id verbatim), `content jsonb`,
      `content_class`, `content_class_locked`, `populated_by`; UNIQUE `(version_id, block_key)`
- [x] 2.3 Partial unique index enforcing at most one draft or in-review version per deck
- [x] 2.4 **Guarded forward-only blob migration** from `workspace_page_state` using the
      `to_regclass(...) IS NULL → RETURN` pattern from `0002_qoe_bridge.sql` — an unguarded
      `INSERT..SELECT` fails to *parse* on a `packages/db`-only database (`design.md` D2).
      Blob rows are **read, not deleted**
- [x] 2.5 `0004_cim.down.sql`
- [x] 2.6 `packages/db/src/cim-schema.ts` following `qoe-schema.ts`; re-export from `schema.all.ts`
- [x] 2.7 `schema.test.ts` assertions

## 3. Module scaffold

- [x] 3.1 `apps/api/src/modules/cim/{ports,service,repository.drizzle,repository.memory,router,index}.ts`
      per `CONTRIBUTING.md` §4
- [x] 3.2 Mount at `"/"` in `server.ts` under `CIM_MODULE_ENABLED`, routes written as `/cim/...`.
      **`/cim-questionnaire` is a legacy path and must not be claimed**
- [x] 3.3 **Do NOT add `cim` to `moduleSurfaces()`** (`apps/api/src/parity/routes.ts`); comment
      recording why (`design.md` D7)
- [x] 3.4 `withCommonMiddleware(router, [helmet(), pinoHttp(), express.json({limit:'25mb'}), requireAuth])`
      — per route, never `router.use()`
- [x] 3.5 `canAccessCompany` on every route
- [x] 3.6 Vitest: `route-contract.test.ts` green; `route-surface.json` unchanged; cross-tenant deck
      access refused

## 4. Deck read and write

- [x] 4.1 `GET /cim/decks?company_id=`, `POST /cim/decks` (creates v1 + default outline + slides +
      blocks), `GET /cim/decks/:id/versions`
- [x] 4.2 `GET /cim/versions/:id` — version, sections, slides and blocks in **one** payload
- [x] 4.3 `PUT /cim/versions/:id/blocks` (bulk upsert — the editor's save), `PATCH /cim/blocks/:id`
- [x] 4.4 **Version write-lock:** any mutation on a published version returns 409
- [x] 4.5 `POST /cim/decks/:id/versions` — editing a published deck clones blocks into a new draft
- [x] 4.6 `content_class_locked` blocks reclassification to firm boilerplate by any route
- [x] 4.7 Vitest: write-lock rejects on published; fork produces a new draft leaving the published
      version and its publication untouched; a locked block cannot be reclassified
- [x] 4.8 `cim.integration.test.ts` (PGlite, hand-written DDL per
      `uploads.integration.test.ts:12-43`): create → edit → publish → edit again → two versions

## 5. Question library

- [x] 5.1 One-shot extraction script (authoring-time, **not** a build step) over
      `FIELD_LABEL_OVERRIDES` (~line 246, 373 labels) and `SECTION_QUESTION_BANK` (line 108) →
      `tools/demo/seed-cim-questions.sql`, ~400 rows (`design.md` D3)
- [x] 5.2 `GET /cim/question-library?section_key=` — scope-filtered to system, own firm, own
- [x] 5.3 Vitest: scope filtering returns nothing belonging to another firm or user

## 6. Guided Q&A loop

- [x] 6.1 `GET /cim/versions/:id/gaps` — unpopulated blocks joined to their mapped library question;
      blocks with no mapped question returned flagged as unmapped, never omitted
- [x] 6.2 `POST /cim/versions/:id/questions/generate` — calls `QaPort.createRequest` with
      `externalRef = cim_block.id`; broker edits to wording/order do not mutate the library
- [ ] 6.3 `QaPort` with **two adapters selected by `CIM_QA_ADAPTER=qa|local`, defaulting to `local`**
      (`design.md` D4). The `local` adapter is a legitimate shipping path, not a stub
- [x] 6.4 `GET /cim/versions/:id/review-queue` — submitted answers joined back through `externalRef`
- [x] 6.5 `POST /cim/blocks/:id/accept-answer` — `mode` **defaults to skip** when the block has
      content; writes content, sets `populated_by='answer'`, locks `content_class` to deal content,
      inserts provenance including the answer **as originally submitted**
- [x] 6.6 Discard writes provenance and leaves the block untouched; the answer is retained
- [x] 6.7 Vitest: generation skips populated blocks; unmapped gaps surface; accept onto a filled
      block with no mode leaves it unchanged; broker-edited acceptance preserves the original
      submission in provenance; accepted blocks cannot be reclassified

## 7. PDF export and publish

- [ ] 7.1 `apps/web/src/features/cim/cimPdfExport.js` — offscreen `SlideCanvas` + `html2canvas` +
      `jsPDF`; cover, table of contents, page numbers, footer and confidentiality legend drawn as
      **text primitives, not rasterised**; draft watermark when not published
- [ ] 7.2 Watchdog with a readable failure toast rather than an endless spinner; determinate
      progress with slide thumbnails
- [ ] 7.3 Pin the font stack in `SlideCanvas` so screen and PDF agree (`design.md` D5)
- [x] 7.4 `POST /cim/versions/:id/publish` — raw bytes following the existing `POST /uploads`
      convention (`apps/web/src/lib/api.js:517-545`); sha256, store via `StoragePort`, create the
      data room document via `DataRoomPort`, write `cim_publication`, mark published
- [x] 7.5 `DataRoomPort` adapter following the `createFolderProvisioningPort` precedent
      (`server.ts:98-107`)
- [ ] 7.6 Leave the existing `.pptx` button working and untested — not on the critical path
- [x] 7.7 Vitest: publish records a hash and a document id; a second publish of the same version is
      refused; the published document resolves in the data room

## 8. Audit

- [x] 8.1 Emit deck created, request generated, answer accepted, export generated and version
      published through `emitActivity`
- [x] 8.2 Vitest: the full path produces five audit entries with actor and timestamp

## 9. Frontend

- [ ] 9.1 Extract `apps/web/src/features/cim/SlideCanvas.jsx` from `WorkspaceCimPrep.jsx`
      lines 2745-~3050 **verbatim**, zero behaviour change
- [ ] 9.2 Extract `apps/web/src/features/cim/layout.js` — `extractTemplateFields`,
      `applyFieldValues`, `getElementDisplayText`, `buildChartSvg`, `getElementStyle`,
      `parseTableText`, `SECTION_SLIDES`, `BASIC_DETAIL_FIELD_DEFINITIONS`
- [ ] 9.3 `apps/web/src/features/cim/cimApi.js` — the `/cim` client plus the block↔`fieldValues`
      adapter
- [ ] 9.4 Re-point `WorkspaceCimPrep.jsx` persistence. **Blocked, and not by effort**: the SPA's
      field ids are derived from the 38 layout JSONs (`makeFieldId`, line 1158), so a deck created
      through `/cim` has no keys it can render. Needs 9.4a first — see `design.md` D1a
- [ ] 9.4a Extract the block-key set from `apps/web/public/cim-template/layouts/*.json` into a
      manifest the API can seed an outline from, so a new deck and a migrated one speak the same
      vocabulary
- [ ] 9.5 Re-point `apps/web/src/pages/client/CimQuestionnaire.jsx`'s two API calls at the Q&A
      adapter; keep the page otherwise as-is — it is already the right seller surface
- [x] 9.6 Review queue surface with accept / edit-and-accept / discard
- [x] 9.7 Three-pane layout (slide navigator with per-slide completion indicator, canvas, context
      panel); deck health panel listing what blocks publication
- [x] 9.8 Route element gated on `useFeature('cim')` **above any data fetch**, so a disabled module
      issues no request that could fall through the proxy to legacy
- [x] 9.9 iPad: below 1024px one pane behind a segmented control; **tapping a field opens a bottom
      sheet with a plain textarea, never inline canvas editing** (`design.md` D6); 44px targets;
      `touch-action: manipulation`; no hover-only affordances; no drag-and-drop
- [x] 9.10 Remove destructive actions (delete deck, delete slide, clear-all) from the demo build

## 10. Demo verification

- [x] 10.1 `tools/demo/seed-cim.mjs` — a **14-slide** deck roughly 60% populated per demo company,
      plus one already-published version whose PDF resolves in the data room
- [ ] 10.2 Extend the `up.sh` curl block: deck seeded; gaps present; published version resolves in
      the data room; a write to a published version returns 409; cross-tenant deck access returns
      403. Each check flag-guarded so it skips when the feature is off
- [x] 10.3 Rehearse publish twice on the actual booth iPad, not on the dev laptop
