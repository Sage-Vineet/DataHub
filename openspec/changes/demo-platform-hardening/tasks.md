## 1. Migration runner

- [x] 1.1 `tools/db/migrate.mjs` — read `packages/db/migrations/*.sql` sorted by `NNNN`, excluding
      `*.down.sql`; create `schema_migrations(version text PRIMARY KEY, checksum text,
      applied_at timestamptz DEFAULT now())`
- [x] 1.2 Apply each unapplied file in its own transaction; record version + sha256 on success
- [x] 1.3 Checksum mismatch on an already-applied file exits non-zero and names the file; `--force`
      re-records without re-applying
- [x] 1.4 `--to NNNN` / `--down NNNN` drive the `.down.sql` siblings in descending order and delete
      the rolled-back rows
- [x] 1.5 Lives at `packages/db/scripts/migrate.mjs`, not `tools/db/` — the package that owns the
      migrations already depends on `pg`, so the runner needs no new dependency and no new workspace
- [x] 1.6 `packages/db/package.json` gains `"db:migrate"`; root `justfile` gains `db-migrate`
- [x] 1.7 Vitest against PGlite: fresh apply, idempotent re-run, mid-migration failure rolls back
      and is not recorded, edited-file detection, force path, down path

## 2. Demo bootstrap rewiring

- [x] 2.1 `tools/demo/up.sh` steps 2, 3 and the `0002` line of step 5 collapse into one
      `db:migrate` call, preserving the order: legacy `schema.sql` (tolerant) → legacy `049` →
      legacy `050` → `db:migrate` → `seed.sql` → backfill → `seed-qoe`
- [ ] 2.2 Cold `docker compose -f docker-compose.demo.yml down -v && ./tools/demo/up.sh` goes green,
      including every existing curl assertion
- [ ] 2.3 `openspec/changes/devenv-schema-bootstrap` reconciled — either closed by this runner or its
      remaining gap restated

## 3. Feature declaration on the gateway

- [x] 3.1 Add `DATAROOM_MODULE_ENABLED`, `DATAROOM_VERSIONS_ENABLED`, `DATAROOM_COMMENTS_ENABLED`,
      `DATAROOM_CHUNKED_UPLOAD_ENABLED`, `QA_MODULE_ENABLED`, `QA_PRESENTATION_ENABLED`,
      `QA_NOMINATIONS_ENABLED`, `CIM_MODULE_ENABLED` to `MODULE_FLAGS` in `apps/api/src/env.ts`
- [x] 3.2 `apps/api/src/gateway.ts` `/healthz` returns `{status, service, features:{...}}` — on the
      gateway app, NOT a module router, so `route-contract.test.ts` never sees it
- [x] 3.3 All eight flags into `docker-compose.demo.yml` beside lines 92-99, defaulting `true`;
      added to the `LEGACY_MODE=1` off-switch block in `tools/demo/up.sh`
- [x] 3.4 Vitest/supertest: `/healthz` reports each flag; a flag set false is reported false;
      `apps/api/src/env.test.ts` still passes unmodified (it iterates `MODULE_FLAGS`)

## 4. Client feature degradation

- [ ] 4.1 `apps/web/src/context/FeatureContext.jsx` — fetch `/healthz` once at boot, expose
      `useFeature(name)`; **every flag false while pending and false on error**
- [ ] 4.2 Provider mounted above the router in `apps/web/src/App.jsx`
- [ ] 4.3 Navigation entries for disabled features are **not rendered** — not disabled, not greyed
- [ ] 4.4 Route elements for disabled features render a plain "coming soon" card, gated **above** any
      data fetch, so no request reaches the gateway and falls through to legacy
- [ ] 4.5 Vitest + @testing-library/react: pending renders nothing; error renders nothing; enabled
      renders the entry. (First tests in `apps/web` — establishes the pattern.)

## 5. Per-user client persistence

- [ ] 5.1 `apps/web/src/store/fileExplorerStore.js:586-595` — `persist` `name` keyed by signed-in
      user id instead of the global `leo-file-explorer`
- [ ] 5.2 Persisted state cleared on sign-out in `AuthContext`
- [ ] 5.3 Vitest: two user ids write to two keys; sign-out clears; no `folderAccess` survives a
      user switch

## 6. Seed data and reset

- [ ] 6.1 `tools/demo/seed-dataroom.sql` — a populated folder tree per demo company with real PDF,
      xlsx and docx bytes; one document carrying three versions; one internal comment thread; one
      pre-loaded ~80 MB file so the large-file story needs no live upload
- [ ] 6.2 `tools/demo/seed-qa.sql` — 8 items across 4 categories, 2 with live threads, 1 with a
      published presentable version, nominations set on both sides
- [ ] 6.3 `tools/demo/seed-cim.mjs` — a 14-slide deck roughly 60% populated, plus one already
      published version with its PDF resolvable in the data room
- [ ] 6.4 **Three demo companies each fully seeded**, so three booth devices never contend on the
      same rows
- [ ] 6.5 `tools/demo/reset.sh` — `TRUNCATE ... RESTART IDENTITY CASCADE` over demo-owned tables then
      re-seed; under 30s; no container restart; safe with the SPA already open
- [ ] 6.6 Wire the new seeds into `up.sh`
- [ ] 6.7 Extend the `up.sh` curl assertion block for the seeded state, **each check flag-guarded**
      so it skips rather than fails when a feature is off

## 7. Freeze checklist

- [ ] 7.1 `docs/DEMO_FREEZE_CHECKLIST.md` — the ordered T-48h procedure: pick the kill list, flip
      flags only, cold rebuild, verify `up.sh` green in the frozen flag state, eyeball the SPA on
      the iPad with the console open as a blocking gate, run `reset.sh`, two concurrent sessions,
      record and freeze the passing flag set
- [ ] 7.2 Rehearse it once end to end and correct whatever the rehearsal disproves
