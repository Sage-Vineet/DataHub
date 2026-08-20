# Design notes — CIM builder

## D1 — Relational spine, `jsonb` leaves. The god-file is re-pointed, not refactored.

`WorkspaceCimPrep.jsx` is not a block editor. It is a **token-fill engine over 38 extracted real
slide layouts**:

- `SlideCanvas` (line 2745) is a self-contained responsive renderer that scales any
  `apps/web/public/cim-template/layouts/source-slide-NN.layout.json` to its container width, and
  already handles tables, charts, insets, vertical anchoring and logo-placeholder suppression.
- `extractTemplateFields` (line 1204) walks a layout and yields fields keyed
  `"<slide>:<aid>[:token:<i>:<key>]"`.
- Persistence (line 4767) is one flat map, `fieldValues[fieldId] = string`, plus `assetValues`,
  `chartValues` and `globalDetails`.

**That key is stable, and it is the fact the whole approach rests on.** So `cim_block.content` holds
exactly the shape `fieldValues[fieldId]` holds today, and the SPA change is an adapter that flattens
blocks to the flat map on load and back on save — two call sites,
`getWorkspacePageStateRequest` (4347) and `saveWorkspacePageStateRequest` (4780). Roughly 60 lines
touched in a 5,055-line file, and the in-memory shape after migration is byte-identical to before.

Three options were considered:

| Option | Verdict |
|---|---|
| Build a clean CIM surface beside the god-file | **No.** What makes a broker say "I want that" is the deck *looking like a real CIM*, and that look is 38 professional layouts plus a renderer that already works. A canvas built from scratch in three days would look like a wireframe standing next to it, and it doubles the surface that can break. |
| Keep the JSON blob for now, schema later | **No.** A `(company_id, page_key)` UNIQUE row has no version axis and no per-block identity, so publish-a-frozen-version and answers-land-on-blocks are not expressible. It also leaves CIM as the only demo surface served by legacy, so the promised kill switch would have nothing to switch. |
| **Relational spine, `jsonb` leaves, re-point the god-file** | **Chosen.** Buys the version axis and block identity that `CM - 0001` and `CM - 0004` need, at the cost of an adapter rather than a refactor. |

### D1a — Correction: re-pointing the god-file needs more than two call sites

D1 above says the SPA change is "swapping two call sites … roughly 60 lines".
That is right about the *mechanism* and wrong about a prerequisite, found while
building the editor.

The SPA's field ids are not a convention the server can reproduce. They come from
`makeFieldId(slideNumber, element)` (`WorkspaceCimPrep.jsx:1158`), which reads
element ids out of the 38 `source-slide-NN.layout.json` files. The blob migration
preserves those keys because they already exist in the blob — but a deck created
fresh through `/cim` has no such keys unless the API also knows the layouts.

So re-pointing works for migrated decks and produces an unrenderable deck for new
ones. Closing that gap means the API emitting layout-derived block keys for all 38
slides, which is a real piece of work rather than a rewiring.

**What ships instead.** The CIM builder surface (`WorkspaceCimBuilder.jsx`) covers
the half that carries the pitch and needs no layout rendering: which blocks are
empty, one action that asks the company about exactly those, the review queue, and
the published PDF in the data room. `WorkspaceCimPrep.jsx` is untouched and stays
on its legacy blob path as the visual deck editor.

Two surfaces is worse than one, and this is a deferral rather than a design
preference. The work to close it: extract the block-key set from the layout files
into a manifest the API can seed an outline from, then re-point the god-file's two
call sites as D1 describes. That is tracked as its own task rather than left as a
comment.

## D2 — The blob migration is forward-only and guarded

Inside the CIM migration, using the same `DO $$ ... to_regclass(...) IS NULL → RETURN` guard that
`0002_qoe_bridge.sql` uses for `ebitda_adjustments` — a database built from `packages/db` alone has
no `workspace_page_state`, so an unguarded `INSERT..SELECT` would fail to **parse**, not merely to
run.

For each row where the page key is the CIM key: one deck, one draft version, `globalDetails` → the
version's cover, and `jsonb_each_text(payload->'fieldValues')` → one block per key, with `block_key`
the existing field id **verbatim**. `assetValues` and `chartValues` become image and chart blocks
under the same keys.

The blob rows are read, not deleted. The legacy path stays a working rollback target, which is what
makes `CIM_MODULE_ENABLED=false` a real fallback rather than a nominal one.

## D3 — The question library already exists

373 `label:` strings in `FIELD_LABEL_OVERRIDES` (around line 246), most already phrased as questions
— "What is the company's current market share (%)?" — and each already bound to a
`{slide, order, tokenIndex}` triple, which *is* a block binding. Plus `SECTION_QUESTION_BANK` at
line 108: 11 sections, 55 questions.

`CM - 0004`'s "question library mapped to a target content block" is therefore mostly authored
already. A one-shot extraction script (run once at authoring time, emitting a seed file — **not** a
build step) turns these into roughly 400 library rows. The demo's questions look authored because
they are, and nobody spends a day writing questions an accountant already wrote.

## D4 — Guided Q&A goes through the Q&A module, behind a port

`CM - 0004` could be built privately inside CIM. It must not be: the CIM questionnaire already
exists as a private JSON blob, and it is the third disconnected "ask someone for information" system
in this codebase. `openspec/product/design.md` §D7 puts `deal-qa` upstream of `cim` for exactly this
reason.

So the CIM owns the **two ends** — gap analysis and generation, then review and acceptance — and
delegates the **middle** to `deal-qa`. `QaPort`:

```ts
export interface QaPort {
  createRequest(input: {
    companyId: string; title: string; createdBy: string;
    items: Array<{ externalRef: string; sectionKey: string; text: string; assigneeUserId?: string }>;
  }): Promise<{ requestId: string; items: Array<{ itemId: string; externalRef: string }> }>;
  listSubmittedAnswers(requestId: string): Promise<Array<{
    itemId: string; externalRef: string; text: string;
    attachmentDocumentId?: string | null; respondentId: string; submittedAt: string;
  }>>;
}
```

`externalRef` carries `cim_block.id` and is **opaque to the Q&A module** — it never learns what a
CIM is. That single column is the entire integration contract between the two changes, and it
should be agreed before either starts.

**Two adapters, selected by `CIM_QA_ADAPTER=qa|local`, defaulting to `local`.** This is not a hedge,
it is the build order: develop and test against a local adapter with no cross-change dependency, and
flip to the real one once `deal-qa` is green. The flip is reversible by environment variable, which
matters in a week where either change could slip.

## D5 — PDF: render in the browser, freeze on the server

The two concerns `CM - 0001` conflates get split.

**Render = browser.** Each slide mounts into an offscreen fixed-width `SlideCanvas`, `html2canvas`
rasterises it, `jsPDF` places one page per slide. Cover, table of contents, page numbers, footer,
confidentiality legend and the draft watermark are drawn with **jsPDF text primitives on top**, not
rasterised — so they stay crisp and selectable. New file
`apps/web/src/features/cim/cimPdfExport.js`, sibling to the existing `cimPptxExport.js`.

**Freeze = server.** The SPA posts the bytes; the service hashes them, stores them through the
uploads `StoragePort`, creates the data room document, records the publication and marks the version
published. **Immutability is delivered by the version write-lock plus the content hash, not by where
the pixels were rasterised.** Every mutating route checks status first, and the artifact is
content-addressed, so "did this change" is a one-line comparison.

Server-side rendering was rejected for this change, not on principle: `apps/api` has no document
generation of any kind today, every export in this repository is browser-side, and standing up
headless Chromium means a Docker image change, a font-installation problem and a memory-limit
problem — the debugging profile that produces exactly the buggy demo the schedule cannot absorb.
It is a later change with no schema impact.

**Known risk:** `html2canvas` is roughly 300-500ms per slide, and unreliable on iPad Safari.
Mitigations are in the demo shape rather than the code — seed a 14-slide deck rather than 38, ship
it already published so the data room end state exists without a live render, show determinate
progress so a slow render reads as working rather than hung, apply a watchdog with a readable
failure rather than an endless spinner, and keep publish a broker-on-a-laptop action.

Also pin the font stack (`Calibri, 'Segoe UI', system-ui, sans-serif`) in `SlideCanvas`, so screen
and PDF agree on machines without Calibri. They already disagree today; nobody has noticed.

## D6 — Frontend extraction, and touch

One mechanical move, the only god-file surgery in this change, and it pays for itself the same day
because both the editor and the PDF exporter need `SlideCanvas`:

- `apps/web/src/features/cim/SlideCanvas.jsx` ← lines 2745-~3050 **verbatim**, zero behaviour change.
- `apps/web/src/features/cim/layout.js` ← the pure helpers: `extractTemplateFields`,
  `applyFieldValues`, `getElementDisplayText`, `buildChartSvg`, `getElementStyle`, `parseTableText`,
  plus the `SECTION_SLIDES` and `BASIC_DETAIL_FIELD_DEFINITIONS` constants.
- `apps/web/src/features/cim/cimApi.js` ← the `/cim` client and the block↔`fieldValues` adapter.

`WorkspaceCimPrep.jsx` then imports them and shrinks by ~350 lines for free.

**On touch: no inline canvas editing.** Tapping a field opens a bottom sheet with a plain
`<textarea>`. An iOS keyboard over an absolutely-positioned, CSS-scaled `contentEditable` is caret
hell and it will fail in front of a stranger. Below 1024px the three-pane layout collapses to one
pane behind a segmented control; no hover-reveal, no drag-and-drop, and reorder (if it ships at all)
uses buttons. `SlideCanvas` already scales to container width via `useElementWidth` — that code is
not touched.

## D7 — The route-contract guard

`route-contract.test.ts` iterates `moduleSurfaces()` (`apps/api/src/parity/routes.ts:111-124`), which
lists seven modules. **`qoe` is not among them** — that absence, not its prefix, is why it passes.

`cim` mounts at `"/"`, writes every route as `/cim/...`, and stays out of that list. Note that
`/cim-questionnaire` is a **legacy** path and must not be claimed; `/cim/...` does not collide with
it under Express matching. If the build goes red on `route-contract.test.ts`, someone has added
`cim` to `moduleSurfaces()` — that is the first thing to check.

Adding `CIM_MODULE_ENABLED` to `MODULE_FLAGS` needs no test edit: `apps/api/src/env.test.ts:30`
iterates the list rather than asserting a literal.

## D8 — What ships now that looks deferrable, and why

**`content_class` on every block.** `CM - 0002` states that `CM - 0001` must carry a deal-content vs
firm-boilerplate attribute, and that answer-derived and imported content must be permanently locked
to deal content so it can never launder into a firm template. The columns cost nothing today.
Retrofitting a classification onto content that has already been authored is the expensive kind of
migration, and getting it wrong is a confidentiality incident rather than a bug.

**`slide_class`.** Distinguishes qualitative from financial-exhibit slides. No exhibit ships, but
declaring the axis now means exhibits arrive without a migration.

**Seller approval fields, recorded but not gating.** `CM - 0001` requires that publication be blocked
until a seller approves the version. This change records and displays approval but does **not** gate
publish. That is a real weakening of a specified control, it is called out in the proposal's
Non-goals, and it should close before the feature reaches a paying broker.
