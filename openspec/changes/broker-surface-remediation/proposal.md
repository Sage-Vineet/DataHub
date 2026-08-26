## Why

The 21 Aug 2026 front-end audit judged the running product against one question: does a broker
opening a deal see a deal platform, or an accounting product with a dataroom attached? The answer
was the second, and it is visible in the navigation before it is visible in any defect.

**A workspace has eleven top-level destinations. Ten of them are financial tooling** — Key Reports,
Reports, Analytics, Invoices, EBITDA Calculation, Quality of Earnings Report with three children of
its own, and Connections. The four stated pillars — dataroom, requests/Q&A, CIM, basic financial
displays — share what is left with a module that bills the client.

Underneath that, the pillars do not connect to each other:

- **The seller cannot reach the questions asked of them.** `/client/qa` is a well-built page with
  no entry in the client's navigation and no tile on the client dashboard. A broker asks, assigns,
  and the assignee has no path to it. The Q&A loop is closed end to end.
- **Requests and documents never meet.** Every request detail shows `Linked Documents (0)` as a
  bare heading with no way to attach, and the Documents column reads 0 for all six requests
  including the one marked Completed.
- **Four panels report four different counts** for the same six requests, and the broker's own Deal
  Tracker badges all of them "Pending" while the *client's* dashboard shows the true statuses.
- **There is no interface anywhere to grant a person access to a folder.** Grants work at the data
  layer — the client sees "2 documents shared" against 7 files in the room — but a broker cannot
  open phase-one folders to all bidders and hold phase two for the shortlist, which is the central
  act of running a dataroom.

None of this is a rewrite. The capabilities are built; they are unwired, misreported, or unreachable.

**Cutover-order domain:** `folders`/`uploads` (grants), `requests` (linkage and status), and the
greenfield `deal-qa` capability. The navigation and copy work is the frontend incremental track.
This change is **remediation of shipped behaviour**, not a cutover — no domain moves off legacy here.

## What Changes

- **Folder-level access grants get an interface.** A grant panel on the folder, in the tree where
  folders live, showing who has access at what level. The enforcement already exists; the control
  does not.
- **Scope the client's write access to the dataroom.** The seller currently has Upload, New Folder,
  multi-select, archive and delete across every folder including Financials. In a broker-run
  process the seller uploads where they are asked to.
- **One source of truth for request counts and status.** Deal Tracker, the company card, the card's
  detail modal and the Requests table all derive from the same query and agree.
- **Requests link to documents, in both directions.** Attach from the request; see the request from
  the document; a request cannot be completed with nothing attached where its response type expects
  a document.
- **The client gets a way in to Q&A.** A navigation entry and a dashboard tile counting what is
  waiting for them.
- **Reminders connect to what they are reminding about.** A reminder can be raised from the request
  list, not only from the detail, and an overdue request is visibly overdue everywhere it appears.
- **Deep links.** Requests, Q&A threads and team members become addressable, so a broker can send a
  colleague the blocked item.
- **The navigation is cut to the four pillars** (see `design.md` D1). Financial tooling groups under
  one destination; Invoices leaves the deal workspace; the working Balance Sheet stops being two
  levels below a page that cannot produce a statement.
- **A craft pass** over the findings that individually read as small and collectively read as beta:
  four different colours all used as the primary action, `Joined Invalid Date`, `1 items`,
  scrambled Q&A ordering with no dates in the list view, a preview that says spreadsheets render
  and then does not render a CSV, `Uploaded by Unknown`, and destructive actions carrying more
  visual weight than the save.

## Capabilities

### Modified Capabilities

- `folders`: per-folder access grants become manageable and visible, and the client's write scope
  narrows from the whole room to the folders they are asked to fill.
- `requests`: a single derivation for counts and status across every surface; bidirectional linkage
  to dataroom documents; completion gated on the response type actually being satisfied.
- `design-system`: one primary action colour, one destructive treatment, and states for empty,
  failed and loading that are distinguishable from each other.
- `users`: credential reset stops being something one user does to another. Today `Edit User`
  carries a free-text password field between Role and Status, so a broker editing a client's job
  title is one field away from setting their password — and knows it afterwards.

### New Capabilities

- `deal-qa` gains a client-facing surface requirement. **Depends on `deal-qa-module` being synced
  and archived first** — it sits at 49/1 and its baseline spec does not exist under
  `openspec/specs/` yet, so these requirements are written as ADDED against the change rather than
  MODIFIED against a baseline.

## Impact

- **Changed (backend):** `apps/api/src/modules/folders/*` (grant read/write endpoints),
  `apps/api/src/modules/requests/*` (linkage, single count derivation, completion rule),
  `apps/api/src/modules/qa/*` (a requestee-scoped listing for the client),
  `apps/api/src/modules/users/*` (credential reset becomes a link, not a supplied value).
- **Changed (frontend):** `FileExplorer.jsx` (2,832 lines — extract the grant panel rather than
  growing it), `WorkspaceRequests.jsx`, `WorkspaceDealTracker.jsx`, `pages/client/*`, `App.jsx`
  (routes and deep links), the workspace sidebar, `components/common/*` for the craft pass.
- **Data:** a link table between requests and dataroom documents if one does not already exist;
  grants themselves are already modelled.
- **Legacy impact:** none — `backend/` is not modified.
- **Main-branch impact:** none. `main` frozen at `e56ff1b`; work lands on `ba/rearch`.
- **Depends on:** `demo-blockers-aug24` (ships first, on a fixed date); `deal-qa-module` and
  `dataroom-versions-comments` reaching 100% and archiving.

## Non-goals

- **The `reports` domain cutover.** `report-sources` and `chart-of-accounts` stay on the Supabase
  path here. §7 records the decision point and the cost, and the navigation cut is designed so the
  financial group can be re-promoted once it works — but decomposing the 9,088-line
  `manualGlMultiYearService.js` is its own change.
- **Building a working P&L.** There is none anywhere in the product today. Financial Statements
  renders Balance Sheet and Trial Balance only. Producing the P&L is part of the cutover above.
- **Retiring CIM Prep.** `cim-builder/design.md:49` records that `WorkspaceCimPrep.jsx` "is
  untouched and stays" — the coexistence is a decision already taken, not an oversight. What this
  change does is stop presenting two CIM tools as peers in one navigation without saying which is
  the product. See `design.md` D2.
- **A notifications hub.** Still absent, still the blocker on reminder delivery — `deal-qa-module`
  named it as a Non-goal for the same reason. Reminders here are surfaced in-app; nothing is mailed.
- **Cross-deal broker views.** `/broker/requests`, `/broker/documents` and `/broker/reminders` were
  unrouted by `demo-blockers-aug24` as stubs. What a broker needs across seven deals is a real
  product question and deserves its own proposal, not a revival of the stubs.
- **A visual redesign.** The craft pass fixes contradictions and missing states. Component
  migration to `@datahub/ui` belongs to `frontend-ui-adoption`, which is explicitly
  behavior-preserving; sequence so a screen is not rewritten twice.
- **Responsive/mobile.** Not assessed in the audit — the window could not be resized during the
  session, so no claim is made either way. Out of scope until it is measured.
