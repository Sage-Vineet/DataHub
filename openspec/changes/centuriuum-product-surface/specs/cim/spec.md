## Purpose

The marketing deliverables a sell-side process runs on: the CIM builder (`CM - 0001`), firm templates
(`CM - 0002`), the CIM loader that prepopulates from an existing document (`CM - 0003`), guided Q&A to
collect what the CIM needs (`CM - 0004`), and the anonymous teaser or blind profile (`CM - 0005`). The
teaser is the document that is actually mass-distributed, has fundamentally different confidentiality
rules from the CIM, and precedes it in the process.

**Fidelity: sketch.** Financial content comes from `qoe` and `reports` — the product intent is
explicitly that the financial slides are the strongest part and are populated from platform data rather
than authored. Shares its generator with `QE - 0014`.

## ADDED Requirements

### Requirement: CIM builder with slide-level editing and PDF export

The system SHALL provide a slide-deck builder inside the platform for producing a CIM, with
configurability over layout and content, exporting to PDF. (`CM - 0001`)

#### Scenario: Deck built and exported
- **WHEN** a user builds a CIM in the platform
- **THEN** it exports to PDF with the layout as presented

### Requirement: Financial content is populated from platform data

The CIM's financial sections SHALL be populated directly from the platform's financial analysis and
data rather than re-entered, so the CIM cannot contradict the reports and QoE output it is drawn from.
(`CM - 0001`)

#### Scenario: Financial slides read from the platform
- **WHEN** a financial slide is generated
- **THEN** its figures resolve from the reports and QoE data for that deal

#### Scenario: Underlying change is reflected
- **WHEN** the underlying adjusted earnings change before release
- **THEN** the CIM's financial content reflects the change rather than retaining stale figures

### Requirement: Qualitative content is collected from the parties

The system SHALL collect the qualitative content the CIM needs — the material that cannot come from the
financial data — as inputs from the broker and the seller. (`CM - 0001`)

#### Scenario: Qualitative inputs requested
- **WHEN** a CIM section requires qualitative content
- **THEN** it is presented as an input to be supplied rather than generated

### Requirement: Firm templates, including preloaded brokerage defaults

The system SHALL support per-user and per-firm CIM templates, with templates preloaded for the larger
brokerages by default. (`CM - 0002`)

#### Scenario: Firm template applied
- **WHEN** a user belonging to a firm with a template creates a CIM
- **THEN** that firm's template is applied by default

### Requirement: CIM loader prepopulates from an uploaded document

The system SHALL let a user upload an existing CIM to prepopulate the template they are using, so they
are editing rather than starting from an empty deck. (`CM - 0003`)

#### Scenario: Uploaded CIM populates the template
- **WHEN** a user uploads an existing CIM
- **THEN** the extractable content is mapped into the selected template for review

#### Scenario: Extraction is reviewable
- **WHEN** content is extracted from an uploaded document
- **THEN** the user reviews and corrects it before it is treated as CIM content

### Requirement: Guided Q&A to populate the CIM

The system SHALL generate standard or custom questions with a single action, requesting from the company
the items needed to populate the CIM. Using it SHALL be optional — a broker who already knows the answers
may enter them directly or handle them on a call. (`CM - 0004`)

#### Scenario: Question set generated and sent
- **WHEN** a broker generates the CIM question set
- **THEN** the questions are raised to the company through the Q&A surface

#### Scenario: Direct entry instead
- **WHEN** a broker enters the answers directly
- **THEN** the CIM populates without the questions being sent

### Requirement: Teaser generated with identifying information suppressed by design

The system SHALL auto-generate a one-to-two-page anonymous teaser from the CIM data and the financial
data, suppressing identifying information by design: no company name, no location beyond region or
metro, no customer names, no website, no photographs of identifiable premises or signage, and an
industry description generic enough that the business cannot be reverse-identified. (`CM - 0005`)

#### Scenario: Teaser generated without identifiers
- **WHEN** a teaser is generated
- **THEN** none of the suppressed categories appear in the output

### Requirement: Teaser content set

The teaser SHALL cover: business description and value proposition, industry and end markets, region,
years in operation, employee count in bands, revenue and adjusted EBITDA or SDE for the trailing period
and one or two prior years pulled live from `QE - 0004`, customer mix and concentration described
qualitatively, growth drivers and investment highlights, reason for sale, real estate status, and
asking price or a note that price is market-determined. (`CM - 0005`)

#### Scenario: Financials pulled live
- **WHEN** the teaser presents earnings
- **THEN** they resolve from the QoE bridge, so the teaser cannot contradict the CIM

### Requirement: Confidentiality scan before release

The system SHALL run an automated confidentiality scan before a teaser is released, flagging any
retained identifying term — the company's own name appearing in a copied narrative block being the most
common leak — and SHALL let the broker preview the teaser exactly as an outside recipient would see it.
(`CM - 0005`)

#### Scenario: Retained identifier is flagged
- **WHEN** the teaser contains the company name or another identifying term
- **THEN** the scan flags it before release

#### Scenario: Recipient preview
- **WHEN** the broker previews as a recipient
- **THEN** they see what an outside party would see, with no internal-only content

### Requirement: Teaser is versioned and distributed through the tracked channel

The teaser SHALL export to PDF, be version controlled, and be distributed and tracked through the
teaser distribution feature rather than by ad-hoc attachment. (`CM - 0005`, distributed by `BR - 0008`)

#### Scenario: Distribution records the version
- **WHEN** a teaser is distributed
- **THEN** the distribution log records which version each recipient received
