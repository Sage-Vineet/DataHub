CENTURIUUM
Feature Specification

| Feature ID | DB - 0007 |
|---|---|
| Feature Name | Suggestions on COA |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | Depends on DB - 0003 (COA), DB - 0006 (Configurable COA) |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Every company's chart of accounts is named and organized differently — one company's "gain on sale of fixed assets" is another's "proceeds from sales" or "gain/loss on sale of fixed assets." This makes fixed, rule-based reclassification impractical. This feature uses AI to read the chart of accounts generated in DB - 0003 and intelligently suggest GAAP-aligned reclassifications and parent groupings — for example, moving interest income out from under Sales and into a Total Interest Income roll-up under Other Income, or grouping a long list of Meals & Entertainment sub-accounts under a single parent when doing so would be material and useful. Suggestions are advisory only: the system never reclassifies automatically. The user reviews each suggested change and approves or denies it individually inside the DB - 0006 Configurable COA UI, keeping final judgment with the person who has full context on the company. This reduces the manual cleanup burden on brokers, QoE providers, and company users who may not know standard GAAP financial-statement hierarchy, without removing their control over the final structure.
# 2. User Stories
- As a QoE provider, I want the system to suggest GAAP-aligned reclassifications of a company's chart of accounts, so that I don't have to manually identify every misplaced account myself.
- As a broker, I want to see a short, plain-language summary of each suggested reclass, so that I can quickly approve or deny it without deep GAAP expertise.
- As a company user, I want to understand why an account is being suggested to move, so that I can learn how my books compare to standard financial reporting.
- As any COA user, I want to individually approve or deny each suggestion, so that the final chart of accounts reflects my judgment and context, not a fully automated result.
# 3. Functional Requirements
- The system shall run the COA suggestion process automatically once, at the point the chart of accounts is first generated from GL data (DB - 0003 initial setup), and shall not require the user to manually trigger it.
- The system shall not re-run the suggestion process automatically on subsequent GL data reloads or version updates; re-running it shall only be available as an explicit, user-initiated action (see Open Questions).
- The system shall use an AI/LLM-based classification approach (not a fixed lookup table) to interpret account names and context and determine the standard GAAP financial-statement placement each account should likely sit under, given that account naming conventions vary widely across companies and cannot be exhaustively enumerated.
- The system shall generate, for each account it flags, a suggested reclassification consisting of: the current placement (parent/sub-parent), the suggested placement, and a short plain-language rationale (e.g., "Interest income is typically reported under Other Income, not Sales, because it is not part of core operating revenue.").
- The system shall be able to suggest creation of a new parent/sub-parent grouping (not just moving an account under an existing parent) when multiple related accounts would be more useful grouped together — for example, consolidating multiple Meals & Entertainment sub-accounts under one parent, or grouping a Merchant Fees account and a Bank Fees account together under a shared subtotal.
- The system shall target a general presentation guideline of roughly 5–12 sub-parent groupings under each major roll-up (e.g., Total SG&A, Total COGS) when generating grouping suggestions, while allowing exceptions where accounts do not logically relate to one another.
- The system shall present suggestions to the user inside the DB - 0006 Configurable COA UI as a reviewable, summarized list (e.g., "Move [Account] from [Current Parent] to [Suggested Parent]") rather than as a separate standalone wizard.
- The system shall allow the user to approve or deny each suggestion individually, on a per-account basis; there is no bulk-only accept/deny and no partial/grouped approval requirement.
- The system shall apply only approved suggestions to the live chart of accounts structure; denied suggestions shall not alter the COA and shall not be reissued or re-surfaced automatically.
- The system shall not persist or learn from a user's individual approve/deny decisions across deals or companies; each company's COA suggestion run is independent, since account context varies deal to deal.
- The system shall leave dollar amounts/transaction-level GL detail unaffected by any reclassification suggestion; suggestions only change where an account sits in the reporting hierarchy, never the underlying transaction data.
- The system shall clearly label all suggested changes as suggestions pending user action, and shall make no reclassification automatically without explicit user approval.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Chart of Accounts (account list, current hierarchy placement) | Read | DB - 0003 (COA) |
| Configurable COA hierarchy / parent-child structure | Read / Write | DB - 0006 (Configurable COA) |
| GL account-level transaction data (context only, not modified) | Read | DB - 0002 (GL Data) |
| Suggested reclassification records (current placement, suggested placement, rationale text, status: pending/approved/denied) | Write | New table — COA Suggestions (proposed as part of DB - 0007; not yet an existing DB block) |
| Approved suggestion outcome | Write | DB - 0006 Configurable COA hierarchy |

Note: this feature introduces a new suggestions/status table not yet formally defined among DB - 0001 through DB - 0010. Recommend adding it as a sub-block of DB - 0007 rather than overloading DB - 0006's structure table.
# 5. Access & Security
- Roles with access: Broker, Accountant, Company, QoE provider — same roles permitted to use DB - 0006 Configurable COA.
- Roles explicitly excluded: Bank (consistent with COA/financial structure editing generally being excluded pre-underwriting, per existing deal-stage access rules).
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results. AI suggestions are generated using only that deal's own GL/COA data — no suggestion logic references or aggregates data from other companies or deals.
# 6. UI / UX Notes
- Platform: Web only (consistent with DB - 0006 Configurable COA, a full data-structure editing workflow not appropriate for the mobile light experience).
- Wireframe reference: N/A — to be designed alongside DB - 0006's drag-and-drop canvas.
Suggestions should appear as inline indicators/badges on affected accounts within the existing DB - 0006 hierarchy view (e.g., a small "Suggested reclass" tag), rather than a separate modal wizard flow. Selecting a badge should expand a short summary: current placement → suggested placement, plus the one-line rationale. Approve/Deny actions should be available directly from that summary. Where a new parent grouping is suggested (rather than a simple move), the summary should show which accounts would roll under the new parent and why (e.g., materiality / thematic grouping).
Overall goal: give the user a fast, scannable review pass — not a heavy multi-step wizard — since the user is expected to review and resolve all suggestions in one sitting after initial COA setup.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0003 (COA) | Depends on | Suggestions run against the COA generated from GL/P&L/BS structure in DB - 0003. |
| DB - 0006 (Configurable COA) | Depends on | Suggestions surface inside the DB - 0006 UI; this feature has no standalone interface of its own. |
| DB - 0002 (GL Data) | Depends on | Account context (names, activity) used as input to the AI classification step. |

# 8. Out of Scope / Deferred
- Automatic application of reclassifications without user approval — explicitly out of scope; this is a suggestion-and-review feature only.
- Manual drag-and-drop editing of the COA hierarchy — belongs to DB - 0006 (Configurable COA), not this feature.
- Any memory/learning of a user's past approve/deny decisions across companies or deals — explicitly excluded per house decision; every company's suggestions are generated independently.
- Automatic re-running of suggestions on every GL reload/version update — deferred; only the initial COA setup triggers suggestions automatically (see Open Questions for re-run behavior).
- Suggestions for Balance Sheet hierarchy placement are not explicitly scoped here beyond what is included in general COA structure from DB - 0003; if BS-specific suggestion logic (e.g., current vs. long-term classification) is needed, it should be scoped as a follow-on rather than assumed included.
# 9. Open Questions
- Should the user be able to manually re-trigger the suggestion process later (e.g., after a significant GL reload or restatement), even though it is not automatic on every reload? If yes, does re-running reissue suggestions for accounts already reviewed (approved or denied) in a prior run, or only for newly appeared accounts?
- What underlying AI/LLM service will power the classification step, and does the account-level data sent to it need any masking/anonymization given sensitive financial data? (Ties to general AI-usage/data-handling policy, not yet defined for the platform.)
- Is there a defined reference taxonomy of "standard GAAP financial statement hierarchy" the AI should be grounded against (e.g., a standardized P&L/BS structure), or is this left entirely to model judgment? A lightweight internal reference structure may improve consistency across companies.
- Should there be any visual indication of the AI's confidence in a suggestion (e.g., high/medium confidence), or is every suggestion presented uniformly regardless of confidence?
- Does this feature need an audit trail entry when a user approves/denies a suggestion? Per the Audit Trail / Activity Log cross-cutting gap, logging of who approved/denied what should be referenced there rather than built locally.
# 10. Acceptance Criteria
- Upon initial COA generation (DB - 0003), the system automatically produces a set of suggested reclassifications without requiring a manual trigger.
- Each suggestion clearly shows current placement, suggested placement, and a plain-language rationale.
- Suggestions include both simple account moves and, where applicable, new parent-grouping proposals (e.g., consolidating similar sub-accounts).
- The user can approve or deny each suggestion individually from within the DB - 0006 Configurable COA UI.
- Approving a suggestion updates the live COA hierarchy; denying a suggestion leaves the COA unchanged and does not resurface that suggestion automatically.
- No suggestion is applied to the COA without explicit user approval.
- No suggestion logic references data from any company/deal other than the one currently being worked.
