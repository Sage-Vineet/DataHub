# Design notes — broker surface remediation

## D1 — The navigation cut

Today's workspace sidebar, and what each destination is:

| Today | What it is | Disposition |
|---|---|---|
| Deal Tracker | deal overview | keep, rename `Overview` |
| Deal Team | page titled *Users*, route `/dataroom/users` | keep, one name |
| Dataroom → Requests, Documents, Q&A, CIM Builder, Messages, Reminders | four pillars in a submenu | promote |
| Key Reports | 7-step CoA classification wizard, 500s | group under Financials |
| Reports | *Financial Reports*, cannot generate | group under Financials |
| Analytics | page titled *Dashboard*, holds Recent Invoices | merge into Overview |
| Invoices | broker→client billing | remove from the deal workspace |
| EBITDA Calculation | the add-back bridge — works | group under Financials |
| Quality of Earnings Report → Financial Statements, Bank Rec, Tax Rec | the working Balance Sheet lives here | group under Financials |
| Connections | data-source configuration | move to workspace settings |
| CIM Prep | second CIM tool, full-screen takeover | see D2 |

Proposed:

```
Overview            deal tracker + the analytics panels worth keeping
Dataroom            Documents · Permissions · Activity
Requests & Q&A      Requests · Questions · Reminders
CIM                 one builder, one export path
Financials          Statements · EBITDA bridge · Quality of Earnings
People              broker team · client team · buyers
```

Five destinations, one of them financial. Nothing is deleted — Key Reports, Bank Rec and Tax Rec
all still exist under `Financials`; they stop being peers of the dataroom.

Two placements are deliberate and worth defending:

- **`Requests & Q&A` as one destination.** They are the same job — a broker chasing a seller for
  something — differing only in whether the answer is a file or a sentence. Today they are separate
  siblings and neither links to the other, which is part of why the Q&A loop is unreachable.
- **`Invoices` leaves entirely.** It is how the brokerage bills its client. It has nothing to do
  with a deal, and it is already duplicated as a Recent Invoices panel on the Analytics page. It
  belongs in a firm-level area, not in the workspace for a specific transaction.

## D2 — Two CIM tools, and why this change does not pick one

`cim-builder/design.md:49` records the decision: `WorkspaceCimPrep.jsx` "is untouched and stays".
That is a deliberate coexistence, so retiring it here would be overriding a decision rather than
implementing one.

What the two are:

| | CIM Builder | CIM Prep |
|---|---|---|
| Model | 29 plain-language questions | ~620 fields over 11 sections, 341 in Financial Performance alone |
| Output | publishes into the dataroom | PowerPoint export |
| Chrome | inside the workspace | full-screen takeover, no nav, no way back |
| Deal name | "Project Atlas" | "Acme Manufacturing" |
| Gap handling | *Request missing info (17)* → client requests | *Ask client* per field |

The audit's judgement is that CIM Builder's question model is the better product — asking "Why is
the owner selling now?" is the difference between a CIM that gets written and one that does not —
and that CIM Prep holds the one thing it lacks, the PowerPoint path.

**What this change does:** presents one CIM destination in the navigation, with CIM Builder as the
surface and CIM Prep reachable from it as the export path, sharing the deal's name. It does not
delete CIM Prep, migrate its data, or pre-empt `cim-builder` task 9.4 (re-pointing its persistence),
which is recorded there as blocked for reasons other than effort.

**What it defers:** whether the ~620-field form survives at all. That needs a decision from the
product owner, not from an audit. Recorded as an open question in §9 of `tasks.md`.

## D3 — One derivation for request counts

Four surfaces currently disagree about the same six requests:

| Surface | Reports |
|---|---|
| Deal Tracker KPI strip | 4 open · 1 completed · 1 overdue |
| Deal Tracker "DataRoom Analytics" | 3 pending · 1 in review · 1 completed |
| Deal Tracker "Recent Requests" | 6 rows, **all badged Pending** |
| Company card / detail modal | 3 pending · 1 completed / 6 total |
| Requests table (the truth) | 2 pending · 1 overdue · 1 in review · 1 blocked · 1 completed |

They are not all wrong in the same way. Some are counting different things without labelling them
(`open` vs `pending`), one is genuinely broken (Recent Requests flattens every status to Pending),
and one panel is mislabelled entirely — "DataRoom Analytics" reports request statuses, uploads,
messages and users added, none of which is dataroom analytics.

The fix is not to reconcile five formulas. It is to derive counts **once**, server-side, in the
requests module, and have every surface render the same payload. Where a surface wants a different
grouping it asks for that grouping by name, so the label and the number come from the same place.

Note the direction of the defect: the *client's* dashboard already shows correct statuses. The
broker's home screen is the one that lies, which is the wrong way round for the paying user.

## D4 — Grants belong on the folder

Access is enforced today — the client's dashboard reports "2 documents shared" against 7 files in
the room — but there is no interface anywhere to set it. I checked three places: folders have no
context menu in the tree; the document row offers preview, activity, download, versions, rename and
move but not permissions; and Edit User covers name, email, phone, role, status and password and
says nothing about access.

The control goes **on the folder, in the tree**, because that is where the mental model lives: a
broker thinks "open Financials to the shortlist", not "give Grace access to eleven documents". The
document row gets a read-only *who can see this* affordance that resolves the inherited grant, so
the question "why can this bidder see that file" is answerable in one click.

This is the difference between file storage and a dataroom. Staged disclosure — phase one to all
bidders, phase two to the shortlist — is the reason brokers buy a VDR, and it is the one thing the
current interface cannot express.

`FileExplorer.jsx` is 2,832 lines and already named as a god-component in the config's known-debt
list. The grant panel is extracted as its own component from the start rather than added to it.

## D5 — Why the client's write scope narrows

The seller currently gets the same file explorer as the broker: Upload, New Folder, multi-select,
archive and delete, across all 7 files including the broker's Financials folder.

That is not a permissions bug — it is a missing product decision. In a broker-run process the
seller uploads what they are asked for, into the place they are asked to put it. They do not
reorganise the room, and they certainly do not archive documents a bidder is reading.

The narrowing is expressed as a grant level (`contribute` — upload into folders granted to them,
no structural edits, no delete) rather than a role check, so it composes with D4 instead of forking
a second authorization path.

## D6 — Deep links, and why they are not cosmetic

Opening a request, a Q&A thread or a team member leaves the URL unchanged. Two consequences:

1. A broker cannot send a colleague a link to the blocked request. For a tool whose whole subject
   is a team chasing items, this removes the cheapest coordination mechanism available.
2. The browser back button jumps out of the workspace instead of closing the panel, because there
   is no history entry to pop.

Both are fixed by the same change: the panel state goes in the route. This is small, and it is
listed under structural rather than craft because it changes what the product can be used for.

## D7 — The craft items are not cosmetic either, mostly

Some are genuinely defects wearing small clothes:

- `Joined Invalid Date` and `1 items` are rendering bugs, visible to every user, on the first
  screen a broker opens after adding someone to a deal.
- The Q&A list omits dates and ages **in a module whose entire job is "how long has this been
  open"**. The dates exist — the detail view shows Aug 12, Aug 15, Aug 16 — so this is a list-view
  omission, not missing data. The unlabelled right-hand column reads "Dana Client" on a thread the
  detail says was asked by Blake Broker, so it is the answerer, mislabelled by absence.
- The document preview says "PDFs, spreadsheets, Word documents, and images render inside this
  preview" beside a CSV it types as "Spreadsheet" and refuses to render. `Uploaded by: Unknown` on
  every document, in a product whose value proposition is provenance.

Others are a missing design system rather than bugs: green, navy, orange and blue all used as the
primary action, with Deal Team putting three filled buttons of three different colours on one small
screen, none of which is the main thing to do. That belongs in the `design-system` capability and
is why this change carries a delta there rather than fixing buttons screen by screen.

## D8 — What this change knowingly leaves broken

Stated so a later reader does not mistake it for drift:

- **No P&L.** Financial Statements renders Balance Sheet and Trial Balance. The P&L needs the
  reports cutover.
- **The EBITDA bridge still computes from 3 of 39 accounts.** §6 makes the ratio a banner instead of
  a grey footnote, so nobody screenshots the number into a teaser without seeing the caveat. Getting
  the other 36 classified is the Chart of Accounts flow, which 500s, which is the cutover.
- **Reminders are in-app only.** No hub, no mailer — the same Non-goal `deal-qa-module` declared.
- **Activity roll-ups are read-only.** Per-document Viewers/Downloaders instrumentation already
  exists and is good; this change surfaces it at deal level. It does not add new event capture.
