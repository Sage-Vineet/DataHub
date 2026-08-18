CENTURIUUM
Feature Specification

| Feature ID | DB - 0003 |
|---|---|
| Feature Name | Chart of Accounts (COA) |
| Module | DB - Database |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
The Chart of Accounts (COA) table is the structural backbone every downstream financial view in Centuriuum depends on — the Profit & Loss and Balance Sheet reports (RP-0001, RP-0002), the SDE/EBITDA tab (QE-0004), the projection model, and the eventual tax-return bridge all filter and drill down through this table's hierarchy rather than through raw GL account names. Every company organizes its books differently, so a generic "filter to Net Income" or "filter to Gross Profit" operation across dozens of companies with dozens of different charts of accounts requires a fixed, predictable hierarchy spine layered on top of each company's own account structure.
This spec defines the table structure only — the fields each account record carries, the fixed vs. company-configurable hierarchy levels, and the placeholders needed for a future tax-return bridge. It covers the full chart of accounts (both Profit & Loss and Balance Sheet accounts), generated from the GL data already loaded per company/deal. It does not define the drag-and-drop editing UI (DB-0006), the reclassification suggestion engine (DB-0007), or the actual tax-return mapping logic (QE-0001, QE-0002, DB-0008) — those are separate specs that read from or write to this table.
# 2. User Stories
- As an Accountant (QoE preparer), I want the system to automatically build a chart of accounts from the loaded GL data, so that I don't have to manually re-enter every account before I can start building reports for a deal.
- As an Accountant, I want each account tagged with a fixed hierarchy position (e.g., Net Income, Gross Profit, Total Revenue), so that P&L and EBITDA reports filter consistently across every deal regardless of how a given company organized its own books.
- As a Broker, I want to view the resulting chart of accounts hierarchy for a deal, so that I can understand how the financials roll up without needing to interpret a raw GL export myself.
# 3. Functional Requirements
- The system shall create one COA record per unique external GL account code per company/deal, sourced from GL Data (DB-0002).
- The system shall include an account for every GL account that has at least one recorded transaction; accounts with zero activity are not required to appear until a transaction posts.
- Each COA record shall store, at minimum: internal Account ID, Company/Deal ID, External Account Code, Account Name, Account Type (Asset, Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense), Normal Balance (Debit/Credit), Statement Type (Balance Sheet or Profit & Loss), and Active/Inactive flag.
- Each COA record shall include 15 discrete Hierarchy Level fields (Level 1 through Level 15), representing that account's roll-up path from the top-level summary line down to itself.
- For Profit & Loss accounts, Hierarchy Levels 1 through 5 shall be a fixed, system-assigned, non-editable rollup spine in this order: Level 1 = Net Income, Level 2 = Pretax Income, Level 3 = Operating Income, Level 4 = Gross Profit, Level 5 = Total Revenue. Every P&L account shall resolve up through this spine regardless of company.
- Hierarchy Levels 6 through 15 (and any P&L sub-levels below the fixed spine) shall be open, company-specific subtotal and account levels, editable only through the configuration UI in DB-0006.
- The system shall provide an "Estimated Tax Return Line" field on each account for a user-entered estimate of which tax return line the account is expected to map to. This is a placeholder/estimate field only — the confirmed mapping logic and tax return table live in DB-0008 and QE-0002.
- Edits to an account's hierarchy assignment (via DB-0006) or an accepted reclassification suggestion (via DB-0007) shall update the COA record in place. Each such edit shall write a corresponding entry to the Activity & Audit Log (SY-0003) capturing the prior value, new value, editing user, and timestamp.
- When a re-pull of GL data introduces an account not previously present in the COA table, the system shall add it without a hierarchy assignment below the fixed spine and shall flag it for reclassification rather than defaulting it silently into an existing rollup.
- No COA record, field, or lookup shall span more than one company/deal.
# 4. Data Requirements

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Account ID (internal PK) | Write | DB - 0003 (this table) |
| Company / Deal ID | Read | SY - 0002 Company Access Setup |
| External Account Code | Read | DB - 0002 GL Data |
| Account Name | Read | DB - 0002 GL Data |
| Account Type / Normal Balance / Statement Type | Read / Write | DB - 0002 GL Data (initial); DB - 0006 (override) |
| Active / Inactive Flag | Read | DB - 0002 GL Data |
| Hierarchy Level 1 - 5 (fixed P&L spine) | Write | DB - 0003 (system-assigned) |
| Hierarchy Level 6 - 15 (configurable) | Write | DB - 0006 Configurable COA |
| Estimated Tax Return Line | Write | User input; consumed by QE - 0001 / QE - 0002 |
| Confirmed Tax Return Line (future) | Read | DB - 0008 Tax Return Table |
| Last Modified By / Timestamp | Write | SY - 0003 Activity & Audit Log |

# 5. Access & Security
- Roles with access: Accountant / QoE preparer (edits hierarchy assignment via DB - 0006, which operates on this table); Broker (view only).
- Roles explicitly excluded: Bank, Buyer — the chart of accounts is an internal financial workpaper structure, not a deal-facing document, and is not exposed to these roles at any deal stage.
- Company (seller) view access to be confirmed — see Open Questions.
- Deal isolation confirmed: this feature is scoped to a single company/deal only. No cross-deal or cross-company visibility of data, documents, or search results.
# 6. UI / UX Notes
- Platform: Web only.
- Wireframe reference: N/A — this spec defines table structure only; the editing UI is covered by DB - 0006.
No direct end-user interface is introduced by this spec. Reports and modules that consume this table (RP - 0001, RP - 0002, QE - 0004, and the projection model) will read Hierarchy Levels 1-15 to build filters and drill-downs; the hierarchy editing/drag-and-drop experience itself is specified separately in DB - 0006.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| DB - 0002 (GL Data) | Depends on | Source of accounts and transaction activity that generates COA records |
| DB - 0004 (Trial Balance) | Related | Balance Sheet detail may be sourced from TB rather than GL directly |
| DB - 0006 (Configurable COA) | Blocks | Editing UI for hierarchy levels 6-15 operates on this table |
| DB - 0007 (Suggestions on COA) | Blocks | Reclassification suggestion engine writes hierarchy changes to this table |
| DB - 0008 (Tax Return Table) | Depends on (future) | Confirmed tax return line mapping, once specced |
| QE - 0001 (Tax Reconciliation) | Related | Consumes Estimated / Confirmed tax line mapping for the bridge |
| QE - 0002 (Full Tax Return Mapping) | Related | Full account-to-tax-line mapping logic |
| RP - 0001 (Profit & Loss) | Blocks | P&L report filters and drills using hierarchy levels |
| QE - 0004 (SDE/EBITDA Tab) | Blocks | Filters on the fixed Net Income / rollup spine |
| SY - 0003 (Activity & Audit Log) | Depends on | Records all in-place edits to hierarchy assignment |

# 8. Out of Scope / Deferred
- Drag-and-drop hierarchy editing UI — belongs to DB - 0006.
- Automated reclassification suggestion logic — belongs to DB - 0007.
- Confirmed/final tax return line mapping logic and the tax return table structure itself — belongs to QE - 0001, QE - 0002, and DB - 0008.
- Balance Sheet fixed hierarchy spine (the BS equivalent of the P&L Net Income → Total Revenue chain) — not yet defined; see Open Questions.
- Cross-validation of GL totals against COA rollups — belongs to DB - 0005 Validations.
# 9. Open Questions
- What is the fixed hierarchy spine for Balance Sheet accounts (the BS equivalent of the P&L Net Income → Total Revenue chain)? This needs definition (e.g., Total Assets, Current Assets, Total Liabilities, Total Equity) before DB - 0006 and BS reports can rely on a fixed filter the way the P&L side does.
- Should Cost of Goods Sold and Operating Expenses have their own reserved fixed hierarchy tags alongside Gross Profit and Operating Income (e.g., a "Total COGS" tag at Level 4, a "Total Operating Expenses" tag at Level 3), or are those left fully configurable like other sub-accounts?
- Where does "Other Income/Expense" sit in the fixed P&L spine, if at all?
- Should the Estimated Tax Return Line field vary by entity/return type (1065, 1120, 1120-S, Schedule C), matching the variation expected in DB - 0008? Assumed yes, but not yet confirmed.
- Does the Company (seller) role need any view access to the COA/hierarchy, or is this purely an internal Accountant/Broker workpaper?
- Is a 15-level maximum sufficient for the deepest real-world chart of accounts Centuriuum will encounter, or should this be validated against actual client files before the schema is locked?
# 10. Acceptance Criteria
- A COA record is created automatically for every account with GL activity, scoped to a single company/deal.
- Every Profit & Loss account carries values for Hierarchy Levels 1-5 matching the fixed spine: Net Income, Pretax Income, Operating Income, Gross Profit, Total Revenue.
- No two accounts within the same company/deal share the same External Account Code.
- Editing an account's hierarchy assignment updates the record in place and creates a matching Activity & Audit Log entry.
- A newly introduced account from a GL re-pull appears in the COA table without a hierarchy assignment below the fixed spine and is flagged for reclassification.
- No user can view or query COA records belonging to a different company/deal than the one they are authorized on.
