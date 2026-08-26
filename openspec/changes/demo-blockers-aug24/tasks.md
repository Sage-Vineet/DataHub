## 0. Before anything else

- [ ] 0.1 Branch from `ba/rearch`. `main` is frozen at `e56ff1b` — never commit to it
- [x] 0.2 Bring up a **cold** stack (`docker compose -f docker-compose.demo.yml down -v && ./tools/demo/up.sh`)
      and confirm each of the eight defects reproduces before touching it. Several are only visible
      on a cold seed, and F‑02 fires seven times per page load — easy to mistake for one failure
- [x] 0.3 Record the current failing-call inventory as the regression baseline:
      `/report-sources` 500, `/key-reports/popup-preference` 500,
      `/key-reports/versions/:id/chart-of-accounts` 500, `/companies/:id/direct-messages/contacts`
      500 × 7, plus `localhost:4000/health` and `/api/auth/status` 503 (the SPA calling legacy
      directly, bypassing the gateway — see 7.3)

## 1. F‑02 — restore the direct-messages contacts route

- [x] 1.1 Read `backend/src/routes/messages.js:19-21` as the reference. The literal `/contacts`
      route is declared **before** `/:recipientId`; the TS module at
      `apps/api/src/modules/messages/router.ts:56` has only the param route
- [x] 1.2 Add `GET /companies/:companyId/direct-messages/contacts` to the TS router **above** the
      existing `:recipientId` route. Ordering is the fix — a route added below it is still shadowed
- [x] 1.3 Add `listDirectContacts` to the messages service and both repositories
      (`repository.drizzle.ts`, `repository.memory.ts`) per `CONTRIBUTING.md` §4. Match the legacy
      handler's payload shape — the SPA's `api.js:382` already consumes it
- [x] 1.4 Add the contacts response to `packages/contracts/src/messages.ts` and re-export
- [x] 1.5 **Vitest/supertest:** `contacts` returns the deal's members and does not 500; a company
      the caller cannot access is refused; a real recipient ID still resolves to a conversation
      (proves the param route was not broken by the insertion)
- [x] 1.6 **Vitest:** a regression test asserting `contacts` is never parsed as a recipient ID —
      this is the specific failure, and route ordering is easy to undo in a later refactor
- [x] 1.7 Confirm `tools/parity/route-surface.json` and `route-contract.test.ts` account for the
      new route; update the surface file if the parity harness requires it
- [x] 1.8 Verify in the browser: Messages loads for **both** roles, and the seven 500s per page
      load are gone from the network panel

## 2. F‑03 / F‑04 — make legacy financial failures legible

- [x] 2.1 `WorkspaceKeyReports.jsx`: replace the indefinite `Loading…` on the Chart of Accounts
      panel with three distinct states — loading, failed (with the reason and a Retry), and empty
      ("no accounts classified yet"). Today a 500 after 24s is indistinguishable from a slow network
- [x] 2.2 Add a client-side timeout to the chart-of-accounts and report-sources calls, shorter than
      the legacy Supabase retry budget (observed: 24.5s for three attempts). A user should be told
      it failed well before the server gives up
- [x] 2.3 `WorkspaceReports.jsx`: `Generate Reports` currently spins, then reverts to the empty
      prompt with no message. Surface the failure — the console already logs
      `[WorkspaceReports] Failed to load uploaded files`, so the error is in hand and being
      discarded. Keep the Balance Sheet / P&L / Cash Flow tabs disabled but say **why**
- [ ] 2.4 Do the same for the `Connections` page, which currently stacks "Failed to fetch",
      "Connection Error" and "Unable to check connection" for one failure while a spinner above
      still claims to be refreshing. One failure, one message
- [x] 2.5 **Vitest (web):** the reports panel renders the failed state when the fetch rejects, and
      the empty state when it resolves empty — the two must not collapse into one
- [x] 2.6 Do **not** attempt to fix the 500s themselves. That is the `reports` cutover (see
      `proposal.md` Non-goals). Leave a `TODO(reports-cutover)` at each call site naming the
      Supabase dependency so the follow-on change finds them

## 3. F‑06 — the QuickBooks banner

- [x] 3.1 `components/common/QBDisconnectedBanner.jsx`: distinguish **never connected** from
      **was connected, now disconnected**. Render nothing in the first case
- [x] 3.2 Source the distinction from the connection record (all four sources currently read
      `Last sync: Never` / `Not Connected` on the Connections page), not from a fetch failure —
      a failed health check must not be reported to the user as "disconnected"
- [x] 3.3 Verify the banner is gone from Reports, Analytics and Invoices on a fresh demo, and
      still appears if a connection is established and then dropped
- [ ] 3.4 **Vitest (web):** never-connected renders nothing; previously-connected renders the
      warning; health-check failure renders neither (it is not a disconnection)

## 4. F‑01 — seed data that reads like a tenancy leak

- [x] 4.1 Confirm the finding first, so the fix is not mistaken for a security patch:
      `SELECT k.company_id, c.name, k.version_name FROM key_report_versions k JOIN companies c ON
      c.id = k.company_id;` returns Acme Manufacturing owning a row named "Cascade Family
      Entertainment, LLC — QoE". The ownership is correct; only the label is wrong
- [x] 4.2 Rename the seeded engagement in `tools/demo/seed-qoe.mjs` to the demo company
- [x] 4.3 Rename the seeded GL file (`Cascade Family Entertainment, LLC — General Ledger
      2022-2025.xlsx`) in the dataroom seed to match
- [x] 4.4 Sweep the rest of the seed for the same anonymization residue —
      `grep -ri "cascade" tools/demo/` — and check `Project Atlas` is consistent: CIM Builder calls
      the deal Project Atlas while CIM Prep's Project Name field reads "Acme Manufacturing"
- [x] 4.5 Re-seed cold and walk all four screens that show the version selector — Key Reports,
      Reports, EBITDA Calculation, Financial Statements
- [x] 4.6 Zero-byte file: `Cascade …xlsx` lists at `0 B` with no failed-upload indicator. Either
      seed real bytes or drop it — a 0 B document in a dataroom demo invites the question

## 5. F‑05 — developer copy in the product

- [x] 5.1 `WorkspaceInvoices.jsx:1038` — replace "Monthly invoice performance laid out like the
      spreadsheet view from your reference, with live numbers from `GET /invoices`" with copy
      written for a user. Nothing user-facing names an endpoint
- [x] 5.2 Sweep for siblings: `grep -rnE "GET /|POST /|from your reference|placeholder|TODO" apps/web/src --include=*.jsx`
      over rendered strings. The audit also found "ask your broker to add users" shown **to the
      broker** on the Messages empty state — fix that here, it is one line
- [ ] 5.3 (F‑32) Check the remaining unexplained user-facing labels flagged in the audit and either define
      or remove them: a `Visibility` column whose every value is "Yes", a `Type` column reading
      "Both"/"Narrative" with no legend, and Invoices' `Total EV / $ per EV / Total PA / $ per PA`

## 6. F‑08 — the routed stub

- [x] 6.1 Confirm the cause: `pages/broker/Requests.jsx` renders only `NewRequestModal` and a
      details `Modal`, both closed on mount (`showCreate=false`, `selected=null`), with the comment
      at line 50 — "Currently no UI for listing requests, so just close the modal". It is a stub,
      not a failed fetch
- [x] 6.2 Remove the `/broker/requests` route from `App.jsx:292`. Do not leave a route pointing at
      a component that cannot render content
- [x] 6.3 `/broker/documents` renders `FileExplorer` with no nav rail, no page title and no
      indication of which company's files are shown — for a broker with seven deals this is worse
      than nothing. Unroute it too
- [x] 6.4 `/broker/reminders` never resolves its loading state. Unroute
- [x] 6.5 Confirm nothing in the UI links to any of the three (they were reachable only by typed
      URL). Add a redirect to `/broker/dashboard` rather than a 404, so an old bookmark lands
      somewhere sensible
- [x] 6.6 Record in `broker-surface-remediation` that the cross-deal views are wanted but
      unbuilt — unrouting is deferral, not a decision that brokers do not need them

## 7. F‑07 — the client dashboard's twenty seconds

- [x] 7.1 Profile `/client/dashboard` cold and confirm the baseline: ~20s, 178 requests
- [x] 7.2 Stop the client portal calling broker-only endpoints. It currently fetches
      `/key-reports/versions`, `/key-reports/popup-preference`, `/key-reports/versions/:id/chart-of-accounts`
      and `/report-sources` — none of which it renders, three of which 500 slowly. Most of the wait
      is these
- [ ] 7.3 Stop the SPA calling `http://localhost:4000` directly (`/health`, `/api/auth/status`,
      both 503). Legacy is internal to the compose network and is only reachable through the
      gateway; a hardcoded legacy origin in the frontend fails in every environment
- [x] 7.4 The contacts lookup fans out one request per company (seven for this account). After
      §1 it will succeed rather than 500, but it should not be on the dashboard's critical path
      at all — defer it to the Messages screen
- [x] 7.5 Render the dashboard progressively: the KPI strip and Next-due prompt should not wait on
      the slowest panel. A partial dashboard beats a spinner
- [x] 7.6 Re-measure. Target under 3s to first meaningful paint on the demo stack; record the
      actual number in `docs/REARCH_LOG.md` whether or not it is hit

## 8. Rehearsal and verification

- [ ] 8.1 `pnpm build` green; `pnpm test` green; web lint error count not increased
- [ ] 8.2 Cold `down -v` → `up.sh` → walk the **full booth path** end to end as broker:
      dashboard → workspace → Dataroom → Requests → Q&A → CIM Builder → EBITDA Calculation →
      Financial Statements. Every screen on that path works today and must still work
- [ ] 8.3 Walk it again as `client@demo.test`. Confirm the dashboard time, and note that the client
      Q&A page still has no nav entry — that is F‑09, deliberately **not** fixed here; decide
      explicitly whether the demo shows the client side at all
- [ ] 8.4 With the network panel open, confirm zero 500s on the booth path. Any remaining 500
      is either unfixed or newly introduced; both need to be known before Monday
- [ ] 8.5 Have someone who did not do the work drive the demo cold, without narration. Anything
      they hesitate over is a finding
- [ ] 8.6 Agree the fallback: if a screen fails live, which one is dropped and what is said. The
      kill switches exist (`*_MODULE_ENABLED`) — know in advance which flags produce a clean
      degraded demo rather than discovering it at the booth
- [ ] 8.7 Commit on `ba/rearch` with Conventional Commits; update `docs/REARCH_LOG.md`; sync and
      archive this change once at 100% (leaving completed changes unarchived is what stranded 44
      requirements in Aug 2026)

## Notes

- **Ordering.** §1 and §4 and §5 are the cheapest and highest-visibility — do them first. §7 is
  the largest and can be cut to §7.2 alone (dropping the broker-only calls) if time runs short;
  that one task removes most of the twenty seconds.
- **What this change does not buy you.** After all eight are fixed, the financial pillar still has
  no working P&L and the Q&A loop is still unreachable for the seller. Both are P1 and both are in
  `broker-surface-remediation`. Do not let a green demo path read as a healthy product.
- **Relationship to `frontend-ui-adoption`.** That change is a behavior-preserving component
  migration (`skip_specs`, "no redesign"). This one changes behaviour and copy. They touch some of
  the same files; sequence so the same screen is not rewritten twice.
