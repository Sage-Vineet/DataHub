## Purpose

The two outward-facing data integrations that serve several capabilities each and must therefore be
specified once rather than negotiated separately inside every consumer: `DR - 0007` (Payroll System
Integrations) and `DR - 0008` (Market & Transaction Data Provider Integration). Both are pulled out of
the Data Room module because their consumers are elsewhere — QoE, valuations, projections, and deal
sourcing.

**Fidelity: mixed.** `DR - 0007` is at specified fidelity, drawn from its feature specification (Josh
Tonnesen, 14 Aug 2026). `DR - 0008` has no feature specification document and remains at sketch fidelity
from the product-list summary; it is also the platform's largest recurring-cost decision and is
unresolved — see `design.md` Register B.

## ADDED Requirements

### Requirement: Payroll connections are initiated from the Data Retrieve Wizard

The system SHALL allow a user to initiate a payroll connection through the Data Retrieve Wizard
(`DR - 0003`), with payroll providers presented as a connection type alongside financial data sources,
reusing the same wizard framework and connection UI. (`DR - 0007`)

#### Scenario: Payroll appears as a wizard connection type
- **WHEN** a user opens the Data Retrieve Wizard
- **THEN** payroll providers are offered alongside financial data sources

### Requirement: Six OAuth payroll providers plus a mapped import path

The system SHALL support OAuth-based connection to Gusto, ADP (Run and Workforce Now), Paychex,
Paylocity, Rippling, and QuickBooks Payroll using each provider's official API — never browser
automation and never stored credentials — and SHALL support a mapped file import path for providers
outside that set, allowing manual upload of an exported report mapped to a standard template.
(`DR - 0007`)

#### Scenario: Supported provider connects by OAuth
- **WHEN** a user selects one of the six supported providers
- **THEN** the connection is established through that provider's official OAuth flow

#### Scenario: Unsupported provider uses mapped import
- **WHEN** a user's payroll provider is outside the supported set
- **THEN** they can upload an exported report and map it to the standard template

### Requirement: Payroll retrieval is static, versioned, and filed by template

The system SHALL retrieve standard payroll reports — payroll summary, payroll detail, tax liability
report — for a user-specified date range and SHALL save them as static files in the data room folder
defined for payroll documentation per `DR - 0002`, subject to standard folder-level permissions.
Retrieved reports SHALL NOT maintain a live or refreshing connection to the payroll source. Re-running a
pull for the same connection SHALL create a new version of the retrieved report set rather than
overwriting the prior pull. (`DR - 0007`)

#### Scenario: Reports land in the payroll folder
- **WHEN** a retrieval completes for a selected date range
- **THEN** the reports are saved as static files in the correct data room folder

#### Scenario: Re-pull versions rather than overwrites
- **WHEN** a retrieval is re-run for the same connection
- **THEN** a new version is created and the prior pull is retained

#### Scenario: Folder permissions govern payroll documents
- **WHEN** a user without access to the payroll folder attempts to view the documents
- **THEN** access is refused, while users with folder access can view them

### Requirement: Retrieval metadata and error reporting

The system SHALL record which payroll provider, connection account, date range, and user initiated each
retrieval, and SHALL make that metadata viewable. The system SHALL notify the initiating user of
retrieval success or failure with a clear, actionable message, including authentication errors and
provider-side rate limits or outages. (`DR - 0007`)

#### Scenario: Provenance is visible
- **WHEN** a payroll retrieval completes
- **THEN** provider, account, date range, initiating user, and timestamp are recorded and viewable

#### Scenario: Failures are actionable
- **WHEN** authentication fails or the provider is rate-limited or down
- **THEN** the initiating user receives a clear, actionable message

### Requirement: Payroll parsing is explicitly out of scope

The system SHALL NOT parse retrieved payroll reports into structured, employee-level data fields as part
of this capability. Extracting employee-level compensation detail is a separate, not-yet-specified
feature that consumes this one's output. (`DR - 0007`)

#### Scenario: Retrieval only
- **WHEN** payroll reports are retrieved
- **THEN** they are stored as files and no employee-level structured extraction occurs

### Requirement: One market and transaction data layer serving several features

The system SHALL provide a single external market and transaction data integration serving the public
comparables set in `VL - 0003`, the precedent transaction set in `VL - 0004`, and the off-market deal
sourcing ambition in `BR - 0005` and `BY - 0005` — specified as one integration rather than negotiated
separately inside each consumer. Candidate providers span institutional sources (Capital IQ, PitchBook,
FactSet, Refinitiv), private-transaction specialists suited to lower middle market work (DealStats and
the BVR data sets, Pratt's Stats, IBA Market Data, BIZCOMPS), industry benchmark sources (RMA Annual
Statement Studies, IBISWorld), and lower-cost market data APIs for public company pricing and
fundamentals. (`DR - 0008`)

**Fidelity: sketch** — no feature specification document exists for `DR - 0008`.

#### Scenario: Consumers read one integration
- **WHEN** `VL - 0003`, `VL - 0004`, `BR - 0005`, or `BY - 0005` needs external market or transaction data
- **THEN** it reads through this integration rather than its own provider connection

### Requirement: Provider schemas normalize to one internal record

The system SHALL normalize each provider's schema into a single internal comparable record and
transaction record, so downstream valuation logic is provider-agnostic and a provider can be swapped
without rebuilding `VL - 0003` and `VL - 0004`. (`DR - 0008`)

#### Scenario: Provider swap does not reach the consumers
- **WHEN** the underlying data provider is changed
- **THEN** `VL - 0003` and `VL - 0004` continue to operate against the same internal record shapes

### Requirement: Every pulled record is cached and timestamped with provenance

The system SHALL cache and timestamp every pulled record with the provider name and as-of date, both to
satisfy the version snapshot required by `VL - 0010` and to respect provider redistribution limits.
(`DR - 0008`)

#### Scenario: A valuation snapshot can be reconstructed
- **WHEN** a valuation version is locked under `VL - 0010`
- **THEN** the provider name and as-of date of every underlying record are available

### Requirement: Provider usage is metered through the shared metering layer

The system SHALL meter market and transaction data usage per user and per engagement through the shared
metering layer in `SY - 0004` rather than building its own, since several candidate providers price per
query or per seat. (`DR - 0008`, depends on `SY - 0004`)

#### Scenario: Provider queries produce usage events
- **WHEN** a metered provider query executes
- **THEN** a Usage Event is recorded through `SY - 0004` with user, engagement, provider, and cost

### Requirement: Licensing terms on redistribution are enforced

The system SHALL enforce each provider's licensing terms on redistribution. Where data may be used in an
internal analysis but not reproduced in a client-delivered document, the report generator SHALL be aware
of that restriction and honour it. (`DR - 0008`)

#### Scenario: Restricted data does not reach a client deliverable
- **WHEN** a report is generated for external delivery containing data whose licence forbids
  redistribution
- **THEN** the generator withholds or suppresses that data rather than reproducing it
