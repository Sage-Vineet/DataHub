## 1. Contracts

- [x] 1.1 `packages/contracts/src/qa.ts` — `qaCategory`, `qaNomination`, `qaItemCreate`,
      `qaItemUpdate`, `qaItemListQuery` (category, status, `mine=requestor|requestee`),
      `qaItemResponse`, `qaResponseCreate` (with optional `supersedes_id`), `qaPresentationCreate`,
      `qaAttachmentCreate`, `qaVisibilityRule`
- [x] 1.2 Re-export from `packages/contracts/src/index.ts` as `export * as qa` plus flat types
- [x] 1.3 Add Q&A event types to the **closed** `activityEventType` enum at
      `packages/contracts/src/activity.ts:36-48` — `qa.item.created`, `qa.response.posted`,
      `qa.assignment.changed`, `qa.presentation.published`. An undeclared type throws at runtime
- [x] 1.4 `qa.test.ts` — snake_case wire shape; status and origin enums reject unknown values; a
      response schema has **no** update variant (immutability expressed in the contract, not only
      in the service)

## 2. Data layer

- [x] 2.1 `packages/db/migrations/0003_dataroom_qa.sql` (shared with `dataroom-versions-comments`):
      `qa_categories`, `qa_nominations`, `qa_items`, `qa_assignees`, `qa_assignment_events`,
      `qa_responses`, `qa_presentations`, `qa_attachments`, `qa_item_visibility`
- [x] 2.2 `qa_responses` carries `citation_ref` UNIQUE, `supersedes_id`, `answer_root_id`,
      `answer_version`, `is_current`; partial unique index enforcing one current version per answer
      root
- [x] 2.3 `qa_item_visibility` uses the exclusive-subject CHECK idiom already at
      `packages/db/src/schema.ts:157-175` (`(user_id IS NOT NULL) <> (role_key IS NOT NULL)`)
- [x] 2.4 Backfill `qa_categories` for existing companies from the `request_category`
      vocabulary (see `design.md` D2)
- [x] 4.0 **Provision a company's categories on first use**, idempotently, the way folders are
      provisioned. The migration backfill only covers companies that predate the feature; a
      company created afterwards would otherwise have none. Found by bringing up a cold demo
      stack, where the backfill correctly did nothing because the seed had not run yet
- [x] 2.5 `.down.sql`; Drizzle declarations; `schema.test.ts` assertions
- [x] 2.6 `text` + `CHECK` rather than `pgEnum` for the new status columns — deviation recorded in
      `design.md` D6

## 3. Module scaffold

- [x] 3.1 `apps/api/src/modules/qa/{ports,service,repository.drizzle,repository.memory,router,index}.ts`
      per `CONTRIBUTING.md` §4
- [x] 3.2 Mount at `"/"` in `server.ts` under `QA_MODULE_ENABLED`, routes written as `/qa/...`
- [x] 3.3 **Do NOT add `qa` to `moduleSurfaces()`** (`apps/api/src/parity/routes.ts`); comment there
      recording why (`design.md` D8)
- [x] 3.4 `withCommonMiddleware` per route, never `router.use()`
- [x] 3.5 Vitest: `route-contract.test.ts` green; `tools/parity/route-surface.json` unchanged

## 4. Categories and nomination

- [x] 4.1 `GET /qa/companies/:companyId/categories` — categories with their nominees inline
- [x] 4.2 `PUT /qa/companies/:companyId/categories/:categoryId/nominees`
- [x] 4.3 Item creation resolves nominees for the chosen category into requestees automatically
- [x] 4.4 Vitest: a nominee is assigned without the asker naming them; a nominated item can still be
      reassigned (the nomination is a default, not a lock); a non-member cannot be nominated

## 5. Items and assignment

- [x] 5.1 `GET /qa/companies/:companyId/items` with category, status and `mine` filters
- [x] 5.2 `POST /qa/companies/:companyId/items`, `GET /qa/items/:id` (item + thread + assignees +
      history + presentations in one payload), `PATCH /qa/items/:id`
- [x] 5.3 `POST /qa/items/:id/assignees` — any deal member may reassign; writes `qa_assignment_events`
- [x] 5.4 `DealMemberPort` over `user_companies` + `users.company_id`; off-deal assignment refused
- [x] 5.5 Server-side module/section/account tagging, defaulting to unclassified rather than null
- [x] 5.6 Vitest: off-deal assignment refused; history records actor, timestamp, prior and new
      assignees; `mine=requestor` and `mine=requestee` return disjoint correct sets

## 6. Responses, versioning, presentable versions

- [x] 6.1 `POST /qa/items/:id/responses` — insert-only; assigns `citation_ref`; sets `answered_at` on
      the first answer only
- [x] 6.2 **No update or delete route for a response exists at all** — immutability enforced by the
      absence of the route, not by a guard inside one
- [x] 6.3 Supersede path: `supersedes_id` sets `answer_root_id`, increments `answer_version`, flips
      the prior row's `is_current`; the prior body is never touched
- [x] 6.4 `POST /qa/items/:id/presentation` and `.../presentation/:id/publish` — separate table,
      own version counter, broker role only
- [x] 6.5 Vitest: an edit attempt has no route to reach; superseding preserves the earlier version
      at its own citation ref; exactly one current version after two supersedes; a presentable
      version does not mutate its source response; only published presentations are offered onward

## 7. Attachments and visibility

- [x] 7.1 `POST /qa/items/:id/attachments` — requires a destination folder; links the document to
      both the data room and the item
- [x] 7.2 `DataRoomAttachmentPort` injected from the dataroom module; **null adapter when
      `DATAROOM_MODULE_ENABLED=false`**, so attachment routes report unavailable and every other Q&A
      route still works (`design.md` D7)
- [x] 7.3 Per-item visibility overrides applied **in the repository query**, so a hidden item is
      absent from the response rather than hidden in the UI (`design.md` D5)
- [x] 7.4 Vitest: attachment without a folder is rejected; the null adapter path returns unavailable
      rather than throwing; a hidden item is absent from the API response for the excluded user

## 8. Audit

- [x] 8.1 Emit the four Q&A event types through `emitActivity` (`apps/api/src/activity/capture.ts`)
- [ ] 8.2 `GET /qa/items/:id/audit` — assignment events and activity entries for the item
- [ ] 8.3 Vitest: create → answer → reassign → publish produces four audit entries with actor and
      timestamp

## 9. Integration tests

- [x] 9.1 `qa.integration.test.ts` (PGlite, hand-written DDL per
      `uploads.integration.test.ts:12-43`): nominate → create → auto-assign → answer → supersede →
      reword → publish, asserting every prior version still readable
- [x] 9.2 Cross-tenant: no route returns an item from a company the session cannot access

## 10. Frontend

- [ ] 10.1 `apps/web/src/store/qaStore.js` — zustand, shaped like `fileExplorerStore.js`.
      **No `persist`** (see `demo-platform-hardening` task 5). No react-query — it is not installed
      and this is not the week to introduce it
- [ ] 10.2 `apps/web/src/lib/api.js` — Q&A wrappers appended in the existing style
- [ ] 10.3 `WorkspaceQA.jsx` — list with category tabs and "raised by me" / "assigned to me" /
      status filter chips. Steal the layout of `WorkspaceRequests.jsx`, not its code
- [ ] 10.4 `QAItemDrawer.jsx` — thread, answer composer, delegate control, answer-version
      disclosure, and the broker presentable panel **side by side with the seller's immutable
      words**, plus an audit tab
- [ ] 10.5 Nominee picker screen for the seller — a headline demo moment, not a settings page
- [ ] 10.6 Routes in `apps/web/src/App.jsx`: `dataroom/qa` in the broker workspace block and the
      equivalent in the client block so the seller persona has it
- [ ] 10.7 Route element gated on `useFeature('qa')` **above any data fetch**, so a disabled module
      issues no request that could fall through the proxy to legacy (`design.md` D9)
- [ ] 10.8 iPad: 44px tap targets, no hover-only affordances, drawer full-screen below `lg`

## 11. Demo verification

- [ ] 11.1 Extend the `tools/demo/up.sh` curl block: seeded items list; a nominated answerer is
      auto-assigned; a superseded answer keeps both versions readable; a published presentable
      version is returned. Each check flag-guarded so it skips when the feature is off
- [ ] 11.2 Two-browser run-through (broker on laptop, seller on iPad) through the full round trip
