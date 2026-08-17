## Purpose

The question-and-answer surface that carries the company's commentary through the engagement: per-user
request tracking (`QA - 0001`) and linkage into the other modules (`QA - 0002`). Small in the source
list, load-bearing in practice — the seller's explanation of a number is what turns an anomaly into an
add-back, and the QoE generator (`QE - 0015`) writes into this surface.

**Fidelity: sketch.** The source list also references a `QA - 0003` (a confirmatory diligence request
list, referenced by `BR - 0015`) that has no row — see `design.md` Register A.

## ADDED Requirements

### Requirement: Questions carry a requestor and a requestee

The system SHALL let a question be assigned to the user who raised it and the user responsible for
answering it, and SHALL track each item to resolution. (`QA - 0001`)

#### Scenario: Assignment and resolution
- **WHEN** a question is raised and assigned
- **THEN** it appears on the requestee's outstanding items until answered and resolved

#### Scenario: Outstanding items are visible per user
- **WHEN** a user opens their items
- **THEN** the questions they owe and the questions they are awaiting are both listed

### Requirement: Questions link to the objects they concern

The system SHALL link questions and answers to the reporting, QoE, and data room objects they concern.
The linkage need not be a hard reference, but the association SHALL be retained so commentary is
reachable from the data it explains. (`QA - 0002`)

#### Scenario: Answer reachable from the account
- **WHEN** a user views an account that has an associated question
- **THEN** the question and any answer are reachable from that account

#### Scenario: Supporting document attached to an answer
- **WHEN** an answer is provided with a document
- **THEN** the document is stored in the data room and linked to the answer

### Requirement: Q&A visibility follows the deal permission model

Question and answer visibility SHALL be governed by the per-company permission model, so that a party
sees only the Q&A their access permits — this is explicitly critical, since Q&A carries seller
commentary that is not appropriate for every counterparty. (`QA - 0002`, gated by `SE - 0002`)

#### Scenario: Restricted party does not see restricted Q&A
- **WHEN** a user without permission on a Q&A thread views the deal
- **THEN** that thread does not appear in their listings or search results

### Requirement: Commentary is reusable across deliverables

Answers SHALL be available for reuse in the deliverables that need them — working capital commentary,
the risk and opportunity register, and the CIM — without re-entry. (`QA - 0002`, consumed by
`QE - 0006`, `QE - 0007`, `cim`)

#### Scenario: Answer reused in a deliverable
- **WHEN** a deliverable needs commentary that exists as an answer
- **THEN** the answer is available to insert, retaining its link to the original question
