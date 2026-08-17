## Purpose

The profile each participant type holds on the platform: broker (`US - 0001`), bank representative
(`US - 0002`), business buyer (`US - 0003`), accountant (`US - 0004`), and company/seller
(`US - 0005`). The source rows are deliberately thin — "functionality and standard views will come in
later specs" — so this capability specifies the profile as a *record* and defers the per-role surfaces
to the capabilities that own them (`broker-workspace`, `buyer-workspace`, `bank-portal`,
`company-portal`).

**Fidelity: sketch, intentionally shallow.** The source list defers the detail; this spec does not
invent it.

## ADDED Requirements

### Requirement: A profile exists per participant type

The system SHALL support a distinct profile type for broker, bank representative, business buyer,
accountant, and company/seller, each carrying the fields its type requires, and each linked to exactly
one platform user account. (`US - 0001` … `US - 0005`)

#### Scenario: Profile created on user creation
- **WHEN** a user account is created with a platform role
- **THEN** a profile of the corresponding type is created and linked to that account

#### Scenario: Profile type determines the fields collected
- **WHEN** a broker and a buyer each complete their profile
- **THEN** each is asked for the fields defined for their type, and neither is asked for the other's

### Requirement: Profile completeness is visible but not blocking

The system SHALL show the user which profile fields remain incomplete and SHALL NOT block platform
access on incomplete optional fields, since several profile inputs (notably buyer lending detail under
`BY - 0002`) are explicitly not required. (`US - 0001` … `US - 0005`, `BY - 0002`)

#### Scenario: Incomplete profile still permits use
- **WHEN** a user with an incomplete optional profile uses the platform
- **THEN** access is unaffected and the incomplete fields are surfaced as a prompt, not a gate

### Requirement: Profile data carries into deal artifacts

The system SHALL make profile data available to the features that merge it into generated documents —
broker and brokerage identity into CIM and teaser templates, engagement letters, and outbound email —
so that a document is generated substantially complete rather than filled by hand. (`US - 0001`,
consumed by `cim`, `deal-execution`, `deal-marketing`)

#### Scenario: Broker identity merges into a generated document
- **WHEN** a broker generates a document from a template
- **THEN** their profile and brokerage details populate the corresponding merge fields

### Requirement: A user may hold profiles across deals without cross-deal visibility

A user's profile SHALL be a platform-level record, while their access to any company remains governed
per deal by `access-control`; holding a profile SHALL grant no visibility into any deal.
(`US - 0001` … `US - 0005`, gated by `SE - 0002`)

#### Scenario: Profile grants no deal access
- **WHEN** a user completes a profile
- **THEN** they see no company or deal data until granted access to a specific company
