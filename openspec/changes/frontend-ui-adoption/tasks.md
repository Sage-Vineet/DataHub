## 1. Enable incremental TypeScript in apps/web

- [ ] 1.1 Add `apps/web/tsconfig.json` (extends `@datahub/config` where sensible) with `allowJs: true`, `jsx: react-jsx`, `checkJs: false`
- [ ] 1.2 Add `typescript` + `@types/react`/`@types/react-dom` dev deps; add a `typecheck` script (non-blocking at first)
- [ ] 1.3 Convert 1–2 leaf modules (`lib/*`, `services/*`, no JSX) to `.ts` as the reference

## 2. Modal sweep → @datahub/ui Dialog

- [ ] 2.1 Migrate remaining `Users.jsx` modals: `UserFormModal`, `ExistingUserConfirmModal`, `InviteBrokerModal` (DeleteModal already done)
- [ ] 2.2 Sweep other pages' hand-rolled `fixed inset-0` modals to Dialog (preview modals, confirm dialogs)
- [ ] 2.3 Verify each: same behavior, now with focus-trap + Escape; look unchanged

## 3. Primitive adoption (as screens are touched)

- [ ] 3.1 Replace ad-hoc buttons/inputs/selects/badges with `@datahub/ui` equivalents on each touched screen
- [ ] 3.2 Use the `@datahub/ui` Table on the next screen that has a real tabular list
- [ ] 3.3 Keep a simple adoption checklist (screen → migrated?) in the PR description or a tracking doc

## 4. Shared types

- [ ] 4.1 Import `packages/contracts` types at the API boundary; delete the corresponding hand-typed shapes in `api.js`
- [ ] 4.2 Type the auth calls first (contracts already exist), then extend as more domain contracts land

## 5. God-component decomposition (in slices)

- [ ] 5.1 Extract one section of `WorkspaceCimPrep.jsx` (5,055) into its own component/file; verify parity
- [ ] 5.2 Do the same opportunistically for `WorkspaceReconciliation.jsx` (3,788) and `FileExplorer.jsx` (2,832) when touched
- [ ] 5.3 Rule: extract → verify → ship; never rewrite a whole page in one PR

## 6. (Optional) data fetching

- [ ] 6.1 Introduce `@tanstack/react-query` on one feature; move that feature's calls off `api.js`
- [ ] 6.2 Decide with the team whether to continue rolling it out or defer

## 7. Verify & wrap up (per PR, ongoing)

- [ ] 7.1 `pnpm build` green; side-by-side visual parity for each migrated screen
- [ ] 7.2 Web lint error count trends down as legacy patterns are replaced
- [ ] 7.3 Commit on `ba/rearch` (Conventional Commits); update `docs/REARCH_LOG.md` periodically

## Notes

- This is a **standing track**, not a one-shot change — expect many small PRs. Consider re-proposing/splitting if a single area (e.g. a full god-component decomposition) becomes large enough to warrant its own change.
- Best sequenced against the Phase 2 backend domains (users/companies/folders) so the same screens are touched once.
