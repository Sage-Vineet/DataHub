## 0. Preconditions

- [ ] 0.1 `demo-blockers-aug24` shipped and archived. It owns the P0 set and has a fixed date; this
      change must not compete with it for the same files
- [ ] 0.2 `deal-qa-module` (49/1) and `dataroom-versions-comments` (45/1) synced and archived, so
      `openspec/specs/deal-qa` and the dataroom grant baseline exist. §4 and §5 write against them
- [ ] 0.3 Re-run the audit walk on a cold stack and confirm the P1–P3 findings still reproduce.
      Some may have moved under `demo-blockers-aug24`; do not fix what is already fixed
- [ ] 0.4 Agree the sequencing with whoever owns `frontend-ui-adoption`. Both touch
      `FileExplorer.jsx`, `Users.jsx` and the workspace pages. That change is behavior-preserving
      and `skip_specs`; this one changes behaviour. Same screen, one rewrite

## 1. Requests and Q&A: one derivation, one truth (F‑10, F‑11)

- [x] 1.1 Add a single counts-and-status derivation to the requests service. Every surface reads
      the same payload; a surface wanting a different grouping asks for it **by name**, so the
      label and the number come from one place (`design.md` D3)
- [x] 1.2 Fix the Deal Tracker "Recent Requests" panel, which badges every row `Pending` while the
      requests table shows Overdue / In Review / Blocked / Completed / Pending. Note the direction
      of this defect — the *client's* dashboard already renders the true statuses
- [x] 1.3 Re-point the Deal Tracker KPI strip, the company card and the card's detail modal at the
      shared derivation. Today they report 4 open / 3 pending / 6 total for the same six requests
- [x] 1.4 Rename the "DataRoom Analytics" panel. It reports request statuses, uploads, messages and
      users added — none of which is dataroom analytics — or fold it into the KPI strip, which it
      already half-duplicates
- [x] 1.5 Delete the "Company Overview" panel on Deal Tracker: six cells repeating the page header
      (name, industry) and the KPI strip directly above it (open, completed, reminders)
- [x] 1.6 Remove the Company Details interstitial modal between the dashboard card and the
      workspace. It shows the card's own fields plus `Phone —` and `Client Since N/A` before
      offering Open Workspace — a click that adds nothing
- [ ] 1.7 **Vitest/supertest:** the derivation returns counts that sum to the item count; a request
      in each status is counted once and only once; `open` and `pending` are either the same set or
      separately named in the payload
- [ ] 1.8 **Vitest (web):** the Deal Tracker panel renders each of the five statuses distinctly

## 2. Overdue and reminders (F‑12, F‑16)

- [x] 2.1 Fix the date rendering that shows the broker `2026-08-19` and the client `18 Aug 2026`
      for the same request. A UTC boundary is being crossed on render; the seller is working to a
      deadline a day earlier than the one that was set
- [x] 2.2 Audit every date the two roles both see for the same off-by-one and fix at the formatter,
      not per call site
- [ ] 2.3 **Vitest:** a due date renders identically for both roles across a timezone boundary
      (pin the test clock; this bug is invisible in the middle of a day)
- [x] 2.4 Make overdue visible where a broker triages. The requests table has no due-date column
      and badges the overdue item the same as the pending ones — the status chip is the only signal
- [ ] 2.5 Add `Send Reminder` to the request row. It exists on the detail, one level down, which is
      not where chasing happens
- [x] 2.6 Fix the Reminders page, which sits on "Loading reminders…" indefinitely behind four
      filter dropdowns and a search box, against 0 reminders and a critical overdue request
- [ ] 2.7 Do not render four filters and a search box above an empty set. Filters appear when there
      is something to filter
- [ ] 2.8 **Vitest/supertest:** a reminder raised from the list attaches to the right request and
      appears on the Reminders page
- [x] 2.9 Delivery stays in-app. No mailer — the notifications hub is still absent and building a
      bespoke one is what `deal-qa-module` explicitly forbade

## 3. Requests ↔ documents (F‑14)

- [x] 3.1 Attach a dataroom document to a request from the request detail. `Linked Documents (0)`
      is a bare heading with no affordance today
- [ ] 3.2 Add a narrative response composer. `Narrative Response — no narrative has been added yet`
      has no way to add one, on a request whose response type is `Both`
- [ ] 3.3 Show the link from the other side: a document displays the request it satisfies
- [x] 3.4 Populate the Documents column in the requests table. It reads 0 for all six requests
      including the one marked **Completed** — a completed diligence request with nothing attached
      has not been completed
- [ ] 3.5 Gate completion on the response type being satisfied: a request expecting a document
      cannot be completed with none attached. Decide whether this is a hard block or a warning and
      record which in `design.md`
- [x] 3.6 Label the response type in words. `Type: Both` with no legend means "expects a document
      and a written answer", which the detail view only reveals indirectly
- [ ] 3.7 **Vitest/supertest:** attach and detach; a request cannot link a document from another
      company; completion respects the rule chosen in 3.5
- [ ] 3.8 Wire `Request missing info (17)` from CIM Builder into the same linkage, so a CIM gap
      becomes a request that can be satisfied by a document. This is the seam the rest of the
      product is missing and CIM Builder already has it

## 4. The client's Q&A entry point (F‑09)

- [x] 4.1 Add Q&A to the client's navigation. The page at `/client/qa` is already built and is one
      of the best screens in the product — "Questions for you · 1 still to answer", a clear Answer
      button, an "Already answered" list — and is reachable only by typing the URL
- [x] 4.2 Add a tile to the client dashboard counting questions awaiting them, next to the existing
      "Next due request" prompt
- [ ] 4.3 Add a requestee-scoped listing to the qa module if one does not exist, so the client
      surface does not filter the whole company's items client-side
- [ ] 4.4 **Vitest/supertest:** the listing returns only items assigned to the caller; a client
      cannot read items for a company they cannot access
- [x] 4.5 **Walk the loop end to end as two users:** broker asks → nomination assigns Dana →
      Dana finds it from her own navigation → answers → broker sees it. This is the acceptance
      test for the whole pillar, and it currently fails at step three
- [ ] 4.6 Warn when a Q&A category has no nominee. "Who answers what" nominates for Finance and
      Legal; Compliance, HR, Tax, M&A and Other are unassigned with no indication of where those
      questions go

## 5. Dataroom access grants (F‑13, F‑17)

- [x] 5.1 Grant panel **on the folder, in the tree** (`design.md` D4). Folders have no context menu
      today; grants exist and are enforced but cannot be set anywhere in the interface
- [ ] 5.2 Extract it as its own component. `FileExplorer.jsx` is 2,832 lines and is already on the
      known-debt god-file list — do not grow it
- [x] 5.3 Read/write endpoints for folder grants in the folders module, if the write path is not
      already exposed
- [x] 5.4 A read-only *who can see this* affordance on the document row, resolving the inherited
      grant, so "why can this bidder see that file" is answerable in one click
- [ ] 5.5 Introduce a `contribute` grant level: upload into granted folders, no structural edits,
      no delete. Express the client's narrowed scope as a grant level, not a role check, so it
      composes with 5.1 rather than forking a second authorization path (`design.md` D5)
- [ ] 5.6 Apply it to the client's file explorer, which today offers Upload, New Folder,
      multi-select, archive and delete across all 7 files including the broker's Financials folder
- [ ] 5.7 **Vitest/supertest:** a grant opens exactly the intended folder and nothing above it;
      revoking removes access to children; a `contribute` user can upload and cannot delete;
      no grant crosses a company boundary
- [ ] 5.8 **Acceptance:** stage a two-phase disclosure — phase-one folders to all bidders,
      phase two to the shortlist — entirely through the interface. This is the thing the product
      cannot currently do
- [x] 5.9 Reconcile the count the client sees. Their dashboard says "2 documents shared"; their
      file explorer shows the same 7 files the broker sees. One of the two is wrong
- [x] 5.10 (F‑18) Remove the free-text `Password Reset` field from `Edit User`, where a broker can
      type a new password for their client between the Role and Status fields of a routine edit
      form. Replace with an emailed invite or reset link whose result the broker never sees
- [ ] 5.11 **Vitest/supertest:** the credential-reset endpoint no longer accepts a caller-supplied
      password for another user; a reset issues a single-use, expiring token instead
- [x] 5.12 Check whether any other surface sets another user's credential directly —
      `grep -rn "password" apps/web/src apps/api/src --include=*.jsx --include=*.ts` over the
      user-management paths

## 6. Financial surfaces: honesty before capability (F‑15, F‑22)

- [x] 6.1 Make the EBITDA classification ratio a banner, not a footnote. The bridge renders
      confident four-year figures ending in Adjusted EBITDA of $478,632 above a grey line reading
      "3 accounts classified into EBIT lines · 36 left out". A broker will screenshot that number
      into a teaser
- [x] 6.2 Fix the footing. The displayed columns do not sum in two of four years — FY2023 is $1 out
      and FY2025 $10 out, consistent with rounding each component before summing. FY2022 and FY2024
      foot correctly. In a QoE deliverable a bridge that does not foot is a credibility problem
- [x] 6.3 **Vitest:** the bridge foots for every period; assert on the rendered figures, since this
      is a display-rounding defect and a test on the raw values would pass
- [ ] 6.4 Surface the balance validation more widely. Financial Statements states "Balances — assets
      equal liabilities plus equity in all 48 periods" on screen. It is exactly the detail that wins
      a finance buyer and almost nobody will find it two levels under Quality of Earnings
- [x] 6.5 Keep the version selector consistent with the workspace it is in. It reads
      `Cascade Family Entertainment, LLC — QoE` on four screens; `demo-blockers-aug24` §4 renames
      the seed, but the selector should also show the deal it belongs to
- [x] 6.6 Do **not** attempt the reports cutover here. Leave `TODO(reports-cutover)` markers and
      record the decision point in §9

## 7. Navigation and information architecture (F‑20 – F‑25)

- [ ] 7.1 (F‑21) Implement the five-destination sidebar from `design.md` D1: Overview · Dataroom ·
      Requests & Q&A · CIM · Financials · People. Nothing is deleted — Key Reports, Bank Rec and
      Tax Rec move under Financials
- [ ] 7.2 Move Invoices out of the deal workspace to a firm-level area. It is how the brokerage
      bills its client, it has nothing to do with a transaction, and it is already duplicated as a
      Recent Invoices panel on the Analytics page
- [ ] 7.3 Merge Analytics into Overview, keeping the panels worth keeping. Its page title is
      *Dashboard* — the third thing in the product called a dashboard
- [ ] 7.4 Move Connections to workspace settings
- [x] 7.5 (F‑24) One name per destination. `Deal Team` opens a page titled *Users* at `/dataroom/users`;
      `Reports` opens *Financial Reports*; `Analytics` opens *Dashboard*. Align nav label, page
      title and route
- [ ] 7.6 Fix the route nesting: Key Reports and Connections live under `/dataroom/` in the URL
      while appearing as top-level items in the sidebar
- [ ] 7.7 Remove the duplicated period controls on Analytics — two independent pickers with two
      Apply buttons, one nested inside the other
- [ ] 7.8 Present one CIM destination (`design.md` D2). CIM Builder is the surface; CIM Prep is
      reachable from it as the PowerPoint export path. Do **not** delete CIM Prep — `cim-builder/design.md:49`
      records that it "is untouched and stays" — and do not pre-empt `cim-builder` task 9.4
- [ ] 7.9 Give CIM Prep a way back. It takes over the entire screen with no nav, no company
      switcher and no route out except its own back arrow
- [ ] 7.10 Make the two CIM tools agree on the deal's name — CIM Builder calls it Project Atlas,
      CIM Prep's Project Name field reads "Acme Manufacturing"
- [ ] 7.11 Add a section outline to CIM Builder. 29 questions across ~10 sections in one
      unstructured scroll, no jump-to, no collapse, and a wide empty right rail that could hold it
- [ ] 7.12 Show save state in CIM Builder. No save button, no dirty indicator, no "Saved" — for a
      document a client fills in over days, that is a data-loss worry whether or not it autosaves
- [ ] 7.13 Make the 17 gaps navigable. The header counts them; the fields say "Not written yet" in
      placeholder grey, indistinguishable at a glance
- [ ] 7.14 Replace the raw-blob PPT preview, which opens a new browser tab titled with a UUID

## 8. Deep links and craft (F‑23, F‑26 – F‑33)

- [ ] 8.1 Put panel state in the route for requests, Q&A threads and team members, so they can be
      linked and so browser Back closes the panel instead of leaving the workspace (`design.md` D6)
- [ ] 8.2 **Vitest (web):** a deep link opens the right panel on a cold load
- [ ] 8.3 One primary action colour. Green, navy, orange and blue are all used as primary today;
      Deal Team puts three filled buttons of three different colours on one small screen, none of
      which is the main action. Land this in `packages/ui` tokens, not per screen
- [ ] 8.4 (F‑31) One destructive treatment, and stop giving it the most weight on the page. Request detail
      has a filled red `Block Request` and an outlined red `Delete Request` dominating the rail
      while `Save Request Details` is a modest green button; Edit User puts Delete beside Cancel
- [x] 8.5 (F‑27) Fix `Joined Invalid Date` on the team member card and `1 items` on folder rows
- [x] 8.6 (F‑28) Sort the Q&A list and show dates. It runs QA‑005, 001, 003, 002, 004 with no sort control
      and no dates — in a module whose job is "how long has this been open". The dates exist; the
      detail shows Aug 12, Aug 15, Aug 16
- [x] 8.7 Label the Q&A list's unlabelled right-hand column. It reads "Dana Client" on a thread the
      detail says was asked by Blake Broker, so it is the answerer
- [ ] 8.8 Split the Q&A filter row, which mixes scope (Raised by me, Assigned to me) with topic
      (Finance, Legal, Tax…) as one axis, five of which have no data
- [ ] 8.9 Fix the Q&A status that reads `Answered` on a thread whose last message is an unanswered
      broker follow-up, while the Follow-up counter reads 0
- [ ] 8.10 (F‑29) Fix the document preview contradiction: "Preview not available for this file type" on a
      CSV, beside a panel saying spreadsheets render, on a file the same panel types as
      *Spreadsheet*
- [x] 8.11 Populate `Uploaded by`. It reads `Unknown` on every document, in a product whose value
      proposition is provenance
- [ ] 8.12 (F‑30) Add the columns a dataroom is judged on: uploaded by, version, visibility, linked
      request, seen/unseen. Today: name, modified, size, actions
- [ ] 8.13 Surface row actions without hover, and lift versions and comments out of a hover-only
      kebab two levels down. Both features exist and work
- [ ] 8.14 Default the file list to list view, not grid tiles, and reconcile the folder counts —
      a tile reads "3 items" where the tree reads "5 files" for the same folder
- [x] 8.15 (F‑19) Add a deal-level activity roll-up. Three activity feeds render "No recent activity yet"
      against 34 requests, five Q&A threads and a published CIM. Per-document Viewers/Downloaders
      instrumentation already exists — this is the roll-up, not new capture
- [x] 8.16 Fix the 100%-complete category rendering its progress bar in warning orange
- [x] 8.17 Reconcile the role label: `Administrator` in the top bar, `Broker` in the sidebar footer
- [ ] 8.18 Reconsider the sign-out confirmation dialog. Signing out is not destructive and is
      trivially reversible

## 9. Open questions to close before or during

- [ ] 9.1 **Does the ~620-field CIM Prep form survive?** Not an audit call. §7.8 presents one CIM
      destination without answering it. Needs a product owner
- [ ] 9.2 **When does the `reports` cutover start?** Until it does there is no working P&L anywhere
      in the product, the EBITDA bridge computes from 3 of 39 accounts, and four financial screens
      500 after 7–24 seconds. The navigation cut is designed so Financials can be re-promoted once
      it works
- [ ] 9.3 **Hard block or warning on 3.5?** Whether a request expecting a document can be completed
      without one
- [ ] 9.4 **What do brokers need across deals?** `/broker/requests`, `/broker/documents` and
      `/broker/reminders` were unrouted as stubs. Deserves its own proposal, not a revival
- [ ] 9.5 **Is the client's write scope a grant level or a role?** §5.5 assumes a grant level;
      confirm against how buyers will be modelled, since Buyers already exists on the People page
      with 0 rows and no NDA/access/stage columns

## 10. Verify and wrap up

- [ ] 10.1 `pnpm build`, `pnpm test`, `pnpm typecheck` green; web lint error count trending down
- [ ] 10.2 Re-walk the full audit as both roles on a cold stack and check each P1–P3 finding off by
      number. A finding that cannot be reproduced is closed; a finding that is reproduced and not
      fixed is carried forward explicitly, not dropped
- [ ] 10.3 Confirm the acceptance tests specifically: the Q&A loop (4.5) and the two-phase
      disclosure (5.8). These two are the change
- [ ] 10.4 Commit on `ba/rearch`, Conventional Commits; update `docs/REARCH_LOG.md`
- [ ] 10.5 Sync deltas into `openspec/specs/` and archive at 100%

## Notes

- **Do the acceptance tests first.** 4.5 and 5.8 are one-line-to-state, hard-to-fake proofs that
  the two broken pillars work. Writing them early keeps §4 and §5 honest.
- **Order.** §1–§4 restore the deal loop and are the highest value per hour. §5 is the largest
  single piece and the one that changes what the product *is*. §7 is cheap and changes the first
  impression more than anything else here. §8 is a long tail — take it in slices with whatever
  screen is already open.
- **What is still broken afterwards** is recorded in `design.md` D8: no P&L, an EBITDA bridge on
  3 of 39 accounts, in-app-only reminders, read-only activity roll-ups. Say so when reporting this
  change as done.
