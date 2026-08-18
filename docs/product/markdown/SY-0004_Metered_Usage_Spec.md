CENTURIUUM
Feature Specification

| Feature ID | SY - 0004 |
|---|---|
| Feature Name | AI & Compute Usage Metering |
| Module | SY - System |
| Status | Draft |
| Related / Recycled IDs | None |
| Author | Josh Tonnesen |
| Date | August 14, 2026 |

# 1. Purpose & Business Context
Centuriuum's AI capabilities (document extraction, OCR, guided Q&A generation, CIM/teaser drafting assistance, and similar features) and select third-party data provider calls (e.g., market and transaction comparables under DR - 0008) carry real, variable per-use cost to Centuriuum. Without usage-level tracking, the business has no way to see which users, companies/deals, or feature areas are driving that cost, no way to identify abuse of free or unmetered access, and no factual basis for future decisions on caps, tiered access, or rebilling. This feature establishes the underlying metering data layer — capturing every AI and heavy-compute usage event by user and by company/deal — so Centuriuum can analyze cost drivers, project spend, and later layer in caps or a pricing/rebilling model. This spec covers data capture and internal visibility only; it does not implement caps, limits, or a customer-facing pricing model.
# 2. User Stories
- As an internal admin (Centuriuum ops), I want to see AI and compute usage broken down by user and by company/deal, so that I can identify which accounts or deals are driving disproportionate cost.
- As an internal admin, I want usage data aggregated over time, so that I can project future AI/compute spend as usage grows.
- As an internal admin, I want to see usage by event type (e.g., OCR extraction, AI drafting, data provider query), so that I can identify which specific features are the most expensive to run and prioritize efficiency work.
- As a product owner, I want usage data captured now even though pricing and caps are undecided, so that when we do define a monetization or cap approach, we have real historical data to base it on rather than guessing.
# 3. Functional Requirements
- The system shall record a Usage Event each time a metered action occurs, including at minimum: AI/LLM invocations (e.g., guided Q&A generation, drafting assistance, extraction from uploaded documents), OCR processing of uploaded/scanned documents, and outbound calls to metered third-party data providers (e.g., market/transaction data queries under DR - 0008).
- The system shall capture, at minimum, the following fields on every Usage Event: event type, timestamp, initiating user ID, associated company/deal ID (where applicable), the specific provider/model/engine invoked, a unit quantity appropriate to the event (e.g., tokens, pages processed, API calls), and the computed raw cost to Centuriuum for that event.
- The system shall associate every Usage Event with exactly one user and, where the action occurs within the context of a company/deal, exactly one company/deal, so usage can be rolled up either way.
- The system shall maintain a Rate Reference table mapping each metered provider/model/engine to its current per-unit cost, allowing raw cost to be computed at the time of the event or recalculated retroactively if rates change.
- The system shall provide an internal-facing usage dashboard (not visible to Broker, Bank, Buyer, Company, or Accountant roles) allowing an admin to filter and aggregate usage by user, by company/deal, by event type, and by date range.
- The system shall support projected-spend views that extrapolate recent usage trends forward, at minimum by user and by company/deal.
- The system shall NOT block, throttle, or otherwise restrict any user's usage based on volume in this phase; this feature is data capture and visibility only.
- The system shall record Usage Events using the same event-capture conventions (user, company/deal, timestamp) as the Activity & Audit Log (SE - 0003) to allow future correlation, without writing usage events into the audit log itself or surfacing them in the audit log UI.
- The system shall retain full Usage Event history indefinitely unless a data retention policy is later defined under the Legal / Compliance cross-cutting gap.
# 4. Data Requirements
What tables/fields does this feature read from or write to? Reference the relevant Database module table blocks (DB - 0001 through DB - 0010) wherever applicable so every feature traces back to the reconciled data structure.

| Data Element | Read/Write | Source / Destination |
|---|---|---|
| Usage Event record (event type, timestamp, user, company/deal, unit quantity, provider/model, computed raw cost) | Write | New Usage Event table (see Open Questions re: DB module placement / DB - 0010 table-block architecture) |
| User ID | Read | SY - 0001 Role Based Access Setup (user/role record) |
| Company/Deal ID | Read | SY - 0002 Company Access Setup (company/deal record) |
| Aggregated usage rollups (by user, by company, by event type, by period) | Read/Write | Derived from Usage Event table; consumed by admin usage dashboard |
| Provider rate/cost table (per-unit cost by AI model, OCR engine, or data provider) | Read | New Rate Reference table, maintained by internal admin (Admin/Internal Ops console — see Dependencies) |
| Market/transaction data provider query counts | Write | DR - 0008 Market & Transaction Data Provider Integration |

Note: the Usage Event table is a new, system-level table and does not map cleanly to an existing DB - 0001 through DB - 0010 block, since those cover financial/GL data rather than platform telemetry. See Open Questions regarding where this table is architecturally housed relative to DB - 0010 (Table Blocks).
# 5. Access & Security
- Roles with access: Centuriuum internal admin/ops only, via the internal usage dashboard.
- Roles explicitly excluded: Broker, Bank, Buyer, Company, Accountant — no user-facing role sees usage or cost data in this phase. Usage metering is an internal cost-management tool, not a customer-facing feature, in this version.
- Deal isolation confirmed: usage data may reference a company/deal ID for aggregation purposes, but the internal admin dashboard is a cross-deal, cross-company reporting surface by design (that is its purpose — identifying company/deal-level cost outliers across the platform). This is an intentional exception to standard deal isolation and is limited strictly to internal admin roles; it must never be exposed to any deal-participant role (Broker, Bank, Buyer, Company, Accountant), each of whom continues to see only their own deal's data with no visibility into usage or cost.
# 6. UI / UX Notes
- Platform: Web only. This is an internal admin tool; no mobile requirement.
- Wireframe reference: N/A
Usage dashboard should support tabular and simple chart views (usage/cost over time, by user, by company/deal, by event type). No specific visual design is prescribed here — functional filtering and export (e.g., CSV) are the priority for this phase over polish.
# 7. Dependencies

| Related Feature | Relationship | Notes |
|---|---|---|
| SY - 0003 | Runs in tandem with | Usage Event table is a sibling data stream to the Activity & Audit Log, not a subsection of it. Usage events are not surfaced in the audit log UI, but both should share the same underlying event-capture pattern (user, company/deal, timestamp, IP where applicable) so the two can be correlated later if needed. |
| SY - 0001 / SY - 0002 | Depends on | Usage must be attributable to a specific user and a specific company/deal, which requires role and company-access records to already exist. |
| DR - 0008 | Depends on / Informs | Market & Transaction Data Provider Integration already calls for per-user, per-engagement metering of paid data provider queries. This feature is the shared metering layer DR - 0008 should plug into rather than building its own. |
| Admin / Internal Ops console (cross-cutting gap) | Blocks (partial) | The internal-facing usage dashboard and rate-table maintenance described in this spec assume an internal admin console exists. No feature ID yet — see Open Questions. |
| Referral / commission tracking (cross-cutting gap) | Related, not blocking | Any future rebilling of metered costs to end users/brokerages will likely route through the same commercial layer as referral/commission tracking. Not required for this phase since rebilling is deferred. |

# 8. Out of Scope / Deferred
- Any hard usage cap, throttling, or blocking of users based on volume — deferred to a future spec once cost drivers are understood.
- Customer-facing pricing model (fixed allotment vs. meter-plus-margin vs. subscription) — deferred to a future spec. This feature only builds the data layer that a future pricing decision would depend on.
- Rebilling or invoicing of metered costs to brokerages/users — deferred; would likely depend on the Referral / Commission Tracking cross-cutting gap and/or a billing system not yet specced.
- Any changes to the Activity & Audit Log (SE - 0003) itself — usage events are a separate, non-visible data stream, not an addition to the audit log UI or schema.
- Per-provider licensing/redistribution compliance logic for market data providers — owned by DR - 0008, not duplicated here.
# 9. Open Questions
- Where should the Usage Event table live architecturally relative to the Database module's table-block structure (DB - 0010)? It doesn't fit the GL/financial table blocks — confirm whether it's a standalone system-level table outside the DB - 0001–0010 numbering, or whether it should get its own DB block.
- This feature assumes an internal Admin / Internal Ops console exists (or will exist) to host the usage dashboard and maintain the Rate Reference table. That console is currently an unspecced cross-cutting gap — should a lightweight version of it be specced alongside this feature, or does this spec simply block on it?
- Should Usage Events capture cost at time-of-event (locking in the rate that applied then) or always resolve against the current Rate Reference table? This matters for historical trend accuracy if provider rates change over time — recommend locking rate at time-of-event, but flagging for confirmation.
- Is there a target retention period for Usage Event data, or should it be retained indefinitely pending the future Legal / Compliance spec?
# 10. Acceptance Criteria
- Every AI/LLM invocation, OCR job, and metered third-party data provider call in the system generates a Usage Event with user, company/deal (where applicable), event type, provider/model, unit quantity, and computed cost.
- An internal admin can filter and view usage/cost totals by user, by company/deal, by event type, and by date range through a web-based dashboard not visible to any customer-facing role.
- Usage Event capture does not appear in, or alter, the Activity & Audit Log (SE - 0003) UI.
- No user-facing cap, block, or throttle exists anywhere in the system as a result of this feature — confirmed via QA pass that heavy usage by a test account is tracked but never restricted.
- Rate Reference table can be updated by an internal admin, and newly computed Usage Event costs reflect the updated rate going forward.
