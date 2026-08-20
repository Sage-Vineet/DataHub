## 1. The demo seed defect

- [x] 1.1 `tools/demo/seed.sql` — stop archiving **Legal**, which held the only seeded Q&A
      evidence. `FileExplorer.jsx` excludes archived items from the normal view, so the one
      link the demo is built around pointed into a folder a visitor could not click back to
- [x] 1.2 Add a dedicated empty **Superseded** folder and archive that instead, so the archive
      view and the `includeArchived` parity check still have something to find
- [x] 1.3 `tools/demo/up.sh` — repoint the two archive-parity assertions from `Legal` to
      `Superseded`, with the reason recorded beside them

## 2. Binding an attachment to an answer

- [x] 2.1 `apps/api/src/modules/qa/service.ts` — `attach()` resolves the item's current answer
      when no `response_id` is supplied. `repository.drizzle.ts` skips rows with no
      `responseId`, so an unbound attachment was stored and never returned: optional in the
      contract, mandatory in practice
- [x] 2.2 `service.test.ts` — an attachment created without a `response_id` comes back on the
      current answer; one created against a superseded answer stays on that answer
- [x] 2.3 `qa.integration.test.ts` — the same over real HTTP, and attaching the same document
      twice records one row (the idempotency the client's retry depends on)

## 3. The forward link

- [x] 3.1 `apps/web/src/components/qa/QAItemDrawer.jsx` — attachments render as links into the
      data room instead of dead `<li>` pills. Both ids are already on the item-detail payload,
      so no extra lookup
- [x] 3.2 Gate on `useFeature('dataroom')` and a resolvable client id; fall back to today's
      non-link pill where either is missing, because a link to a *coming soon* page is worse
      than no link
- [x] 3.3 `apps/web/src/components/fileExplorer/FileExplorer.jsx` — consume the reference:
      navigate, select, and open the **preview** rather than the detail drawer, which shows
      metadata *about* a file rather than the file
- [x] 3.4 Resolve the folder from the document's real ancestor chain, using the folder in the
      reference only as a fallback, so a moved document is still found
- [x] 3.5 Wait for the server tree before acting — the store persists `tree` to localStorage,
      so a stale one from last session is present first — latch per reference so the detail
      drawer's `onChanged` refresh cannot reopen the preview, and strip the parameters so a
      reload or back-navigation does not replay it
- [x] 3.6 An unresolvable reference reports "not in this data room" without disclosing the
      filename or distinguishing absence from lack of permission

## 4. The seller attaches

- [x] 4.1 `apps/web/src/store/qaStore.js` — `answer()` returns the created response, which it
      previously discarded; attaching to the answer just posted needs its id
- [x] 4.2 `apps/web/src/store/qaStore.test.js` — the response is returned, and the detail and
      list refreshes still run
- [x] 4.3 `apps/web/src/pages/client/CompanyQA.jsx` — a paperclip label wrapping a hidden file
      input, revealing the destination picker only once a file is chosen. A native `<select>`,
      flat and indented as `MoveFolderModal` does it: a custom tree inside a bottom sheet is
      the wrong control on a phone
- [x] 4.4 `apps/web/src/pages/client/qaFolders.js` — the pure half (flatten, category default,
      size formatting) in its own module, so the page stays a component-only module and the
      logic is testable without a DOM
- [x] 4.5 `qaFolders.test.js` against the payload the server really sends. `listFolderTree`
      resolves to an **array** of roots whose nodes carry **no `type` field**; the first
      implementation read `node.children` and filtered on `type === 'folder'`, which would
      have emptied the picker on stage — and an empty picker means no `folder_id`, which means
      the attach is skipped silently rather than reported
- [x] 4.6 Default the destination from the item's category, never to blank
- [x] 4.7 Upload through the chunked route, which returns the `document_id` directly and so
      avoids a second create call that would have to get `status` right against an enum the
      deployed database and the model disagree on (`dataroom-versions-comments` design D4a)
- [x] 4.8 Answer, then upload, then link — so a failed upload cannot cost the answer — and on
      a failed link keep the document, retry once, then offer a retry against the document
      already uploaded
- [x] 4.9 Keep the sheet open on success; the attach route returns 204 and the previous
      `submit()` closed immediately, so the respondent never saw their own attachment land
- [x] 4.10 Gate the whole control on `useFeature('dataroomChunkedUpload')`

## 5. Demo verification

- [x] 5.1 `tools/demo/up.sh` — the seeded answer carries its evidence, and the evidence's
      folder is reachable in the normal folder listing (a direct guard on task 1.1)
- [x] 5.2 `up.sh` — the seller's path over HTTP exactly as the tablet drives it: answer, open
      a session, PUT a chunk, complete, attach, re-read the item and find the file on the
      answer. Guarded on `DATAROOM_CHUNKED_UPLOAD_ENABLED`
- [x] 5.3 Guard that block on a resolved evidence folder too: under `set -u` an unresolved one
      would abort the whole bringup rather than report a failed check, and a check that cannot
      run must be skipped and said so
- [x] 5.4 Verified green against the live stack
- [ ] 5.5 Two-browser run-through on the actual iPad: broker asks, seller attaches, broker
      clicks through to the document
