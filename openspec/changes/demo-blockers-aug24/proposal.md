## Why

A full front-end audit of the running demo stack on 21 Aug 2026 (broker + client, 31 screens,
`ba/rearch` @ `36d87da`) found eight defects that a prospect can hit by walking one step off the
happy path. The conference booth demo is **Mon 24 Aug 2026** — three days out.

The pattern underneath them is the one the modernization plan predicted: **every screen that fails
is still on the un-migrated legacy path.** `report-sources`, `key-reports/chart-of-accounts` and
`key-reports/popup-preference` all call Supabase first on every read, get no credentials in the
demo, retry three times and return 500 after 7–24 seconds. The TypeScript modules already cut over
— dataroom, requests, Q&A, CIM — are the parts that work. This change does **not** cut those
domains over; it makes their failure legible and removes the demo-visible symptoms.

Two of the eight are not legacy at all and are cheap: a seed-data naming collision that reads
exactly like a cross-tenant leak, and a build note shipped as user-facing copy.

**Cutover-order domain:** spans `messages` (a regression in an already-cut-over module) and
`reports` (not yet started — this change only adds error surfacing, not the cutover). The remainder
is `apps/web` copy and seed data. It is deliberately **remediation, not cutover** — sequenced by a
fixed external date rather than by the domain order.

## What Changes

- **Restore the dropped `direct-messages/contacts` route.** `backend/src/routes/messages.js:19`
  declares the literal `/contacts` path *before* the `:recipientId` param route. The TypeScript
  rewrite (`apps/api/src/modules/messages/router.ts:56`) defines only the param route, so
  `contacts` is captured as a recipient ID and the conversation query fails. Seven 500s fire on
  every page load that touches Messages, for both roles.
- **Give the legacy financial screens a real error state.** A 500 currently renders as an
  indefinite "Loading…" (Chart of Accounts) or a silent revert to the empty prompt (Generate
  Reports). Neither is distinguishable from a slow network. Add failure and timeout states that
  say what failed and offer a retry.
- **Suppress the QuickBooks banner when nothing was ever connected.** `QBDisconnectedBanner.jsx`
  renders "QuickBooks disconnected. Showing last synced data." on Reports, Analytics and Invoices
  in a demo where no QuickBooks account has ever existed and the figures come from an uploaded GL.
  Never-connected and disconnected are different states; only the second warrants a warning.
- **Rename the seeded QoE engagement.** The only key report in Acme Manufacturing's workspace is
  labelled `Cascade Family Entertainment, LLC — QoE`, and it appears in the version selector on
  four financial screens alongside a matching GL filename. Verified against the database: the row
  genuinely belongs to Acme (`key_report_versions.company_id = a0000000-…-0001`), so this is seed
  naming and **not** a tenancy defect — but it is indistinguishable from one on a projector.
- **Delete the developer copy on Invoices.** `WorkspaceInvoices.jsx:1038` ships "…laid out like the
  spreadsheet view from your reference, with live numbers from `GET /invoices`" as the page
  subtitle.
- **Unroute `/broker/requests`.** It renders a blank page. Not a data failure: `Requests.jsx`
  contains only two modals, both closed on mount, and a comment at line 50 reading
  "Currently no UI for listing requests". It is a stub that was wired into the router. Its two
  siblings — `/broker/documents` (a file explorer with no nav and no company label) and
  `/broker/reminders` (never finishes loading) — are unreachable from the UI as well.
- **Cut the client dashboard's blocking fan-out.** `/client/dashboard` takes ~20s and fires 178
  requests, including a contacts lookup per company and broker-only `key-reports` and
  `report-sources` calls the client portal never renders.

## Capabilities

### Modified Capabilities
- `messages`: the contacts listing is restored as an explicit route rather than a param collision.
- `reports`: report generation and chart-of-accounts retrieval surface failure to the user instead
  of presenting it as an unresolved load.

## Impact

- **Changed (backend):** `apps/api/src/modules/messages/router.ts`, its service and repository
  (a `listDirectContacts` path that does not exist in the TS module today).
- **Changed (frontend):** `WorkspaceReports.jsx`, `WorkspaceKeyReports.jsx`,
  `components/common/QBDisconnectedBanner.jsx`, `WorkspaceInvoices.jsx`, `App.jsx` (three routes),
  `pages/client/Dashboard.jsx`.
- **Changed (demo):** `tools/demo/seed-qoe.mjs` and the seeded GL filename.
- **Data:** none. No migration, no schema change.
- **Legacy impact:** none — `backend/` is not modified. The legacy `/contacts` handler already
  behaves correctly and stays as the reference the TS route is tested against.
- **Main-branch impact:** none. `main` is frozen at `e56ff1b`; all work lands on `ba/rearch`.

## Non-goals

- **The `reports` domain cutover.** Decomposing the 9,088-line `manualGlMultiYearService.js` and
  moving `report-sources` and `chart-of-accounts` off the Supabase path is the Phase-2 `reports`
  work and is far larger than three days. This change makes the failure honest; it does not fix
  the cause. Tracked in `broker-surface-remediation` §7 as the follow-on decision point.
- **Wiring QuickBooks.** The banner is suppressed for the never-connected state only. Connection
  health, OAuth and sync remain untouched.
- **Building the cross-deal request list.** `/broker/requests` is unrouted, not implemented. What
  a broker needs across deals is a product question, answered in `broker-surface-remediation`.
- **Any of the P1–P3 audit findings.** Request-count reconciliation, folder grants, the client Q&A
  entry point, the CIM decision and the craft pass are all deliberately out of scope here and live
  in `broker-surface-remediation`. Mixing them into a three-day window is how a demo gets broken
  rather than fixed.
- **Redesign.** No visual rework beyond deleting wrong copy and adding missing error states.
  `frontend-ui-adoption` owns component migration and is explicitly behavior-preserving; nothing
  here should pre-empt it.
