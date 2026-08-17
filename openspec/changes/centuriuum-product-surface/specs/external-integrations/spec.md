## Purpose

Third-party data brought into the platform: payroll provider connections (`DR - 0007`) and the market
and transaction data provider layer (`DR - 0008`). Both sit in the Data Room module in the source list
but are really shared inputs — payroll substantiates QoE add-backs, market data feeds the comps half of
the valuation module. Grouped here so the provider abstraction is specified once rather than negotiated
separately inside each consuming feature, which is exactly what `DR - 0008` asks for.

**Fidelity: sketch.** Gated on an unmade commercial decision: the market data provider is the largest
recurring cost in the platform — see `design.md` Register B §6.

## ADDED Requirements

### Requirement: Payroll provider connections

The system SHALL connect to payroll providers — Gusto, ADP (Run and Workforce Now), Paychex, Paylocity,
Rippling, QuickBooks Payroll — and SHALL provide a mapped file import for providers outside that set.
(`DR - 0007`)

#### Scenario: Provider connected and pulled
- **WHEN** a user connects a supported payroll provider for a company
- **THEN** compensation data for the requested periods is retrieved into the platform

#### Scenario: Unsupported provider falls back to mapped import
- **WHEN** a company's provider is not directly supported
- **THEN** the user can import a file and map its columns to the same internal structure

### Requirement: Employee-level compensation detail

Payroll retrieval SHALL capture, by period: base wages, bonus, commission, owner draws and distributions
where processed through payroll, employer payroll taxes, benefits and retirement contributions, headcount
by period and department, and hire and termination dates. (`DR - 0007`)

#### Scenario: Owner compensation is separable
- **WHEN** payroll data is retrieved
- **THEN** owner and family-member compensation is identifiable at the level needed to substantiate an
  add-back, rather than aggregated into total wages

### Requirement: Payroll data serves add-backs, projections, and diligence

Retrieved payroll data SHALL be available to substantiate officer compensation, family payroll, and
personal benefit add-backs in `QE - 0004` with source-level support; to support headcount and labor cost
assumptions in `PJ - 0002`; to identify related-party and non-arm's-length compensation; and to produce
the employee census a buyer requests in diligence. (`DR - 0007`)

#### Scenario: Add-back cites payroll source
- **WHEN** an add-back is supported by payroll detail
- **THEN** the QoE artifact references the underlying payroll record rather than management assertion

### Requirement: Payroll data is restricted and never buyer-facing at name level

Payroll data SHALL be permission-restricted to the QoE and valuation team under the role model in
`SE - 0001`, SHALL NOT be exposed at individual-name level in the data room or CIM, and SHALL be
aggregated or anonymized in any buyer-facing output. (`DR - 0007`)

#### Scenario: Buyer-facing output is aggregated
- **WHEN** payroll-derived figures appear in a buyer-facing document
- **THEN** they are aggregated or anonymized, with no individual names or individual compensation

#### Scenario: Access is restricted by role
- **WHEN** a user outside the QoE and valuation team requests payroll detail
- **THEN** the request is denied

### Requirement: Market and transaction data as one integration serving many features

The system SHALL provide a single market and transaction data integration serving public comparables
(`VL - 0003`), precedent transactions (`VL - 0004`), and deal sourcing (`BR - 0005`, `BY - 0005`),
rather than a provider integration built separately inside each. (`DR - 0008`)

#### Scenario: One integration, multiple consumers
- **WHEN** any of those features requests external data
- **THEN** it goes through the same integration and the same internal record model

### Requirement: Provider schemas normalize to internal records

Each provider's schema SHALL be normalized into a single internal comparable record and transaction
record, so downstream valuation logic is provider-agnostic and a provider can be swapped without
rebuilding `VL - 0003` and `VL - 0004`. (`DR - 0008`)

#### Scenario: Provider swapped without valuation changes
- **WHEN** the configured provider changes
- **THEN** comparables and precedent transactions continue to resolve against the same internal records
  and the valuation logic is unchanged

### Requirement: Every pulled record is cached and timestamped with provenance

The system SHALL cache each pulled record with the provider name and as-of date, to support the
valuation version snapshot and to respect redistribution limits. (`DR - 0008`)

#### Scenario: Record carries provenance
- **WHEN** a comparable is used in a valuation
- **THEN** the provider and as-of date are recorded with it and reproduce with the snapshot

### Requirement: Provider licensing terms are enforced on redistribution

The system SHALL record and enforce each provider's redistribution terms — some data may be used in an
internal analysis but not reproduced in a client-delivered document — and the report generator SHALL be
aware of that restriction. (`DR - 0008`)

#### Scenario: Restricted data is withheld from a client deliverable
- **WHEN** a report is generated containing data whose license forbids redistribution
- **THEN** that data is withheld or suppressed in the delivered output, with the restriction surfaced to
  the author

### Requirement: Provider usage is metered

External data usage SHALL be metered per user and per engagement through the metering service, since
several providers price per query or per seat. (`DR - 0008`, uses `SY - 0001`)

#### Scenario: Query attributed to an engagement
- **WHEN** a provider query runs
- **THEN** it is recorded against the requesting user and the engagement
