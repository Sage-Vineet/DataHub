## Purpose

The broker→client ask for a deliverable, and how it is counted, chased and satisfied. The object
itself works; three things around it do not. Counts are derived independently on four surfaces and
disagree. The link to the data room — the reason a request exists — is inert. And a request can be
marked complete with nothing attached to it.

## ADDED Requirements

### Requirement: Request counts derive from one place

The system SHALL derive request counts and statuses once, and every surface that reports them SHALL
render that derivation. Where a surface groups requests differently, it SHALL request that grouping
by name, so that the label and the number it describes originate together.

Observed today across one deal of six requests: the Deal Tracker KPI strip reports 4 open, 1
completed, 1 overdue; the panel below it reports 3 pending, 1 in review, 1 completed; the company
card reports 3 pending, 1 completed; its detail modal reports 6 total; and the requests table — the
correct one — holds 2 pending, 1 overdue, 1 in review, 1 blocked, 1 completed.

#### Scenario: Every surface agrees

- **WHEN** the same deal's requests are shown on more than one surface
- **THEN** each surface reports counts consistent with the others
- **AND** a request is counted once within any single grouping

#### Scenario: A grouping is named

- **WHEN** a surface reports a count under a label such as "open"
- **THEN** that label corresponds to a named grouping in the derivation, not to a locally computed set

### Requirement: A request's status is reported faithfully wherever it appears

The system SHALL render a request's actual status on every surface that shows the request. No
surface SHALL substitute a default status for the real one.

Observed today: the broker's own Deal Tracker badges all six requests `Pending`, including one
Overdue, one In Review, one Blocked and one Completed. The client's dashboard renders the same six
correctly — the broker's home screen is the surface that misreports.

#### Scenario: A non-pending request is listed

- **WHEN** a request whose status is overdue, in review, blocked or completed appears in any list
- **THEN** that status is shown

#### Scenario: An overdue request is distinguishable

- **WHEN** a request is past its due date
- **THEN** it is visually distinguishable from a request that is merely open, in every list where
  it appears

### Requirement: Requests and documents are linked in both directions

The system SHALL allow a document in the data room to be attached to a request, from the request,
and SHALL show on the document which request it satisfies. The number of documents attached to a
request SHALL be reported wherever the request is listed.

#### Scenario: A document is attached

- **WHEN** a user attaches a data room document to a request
- **THEN** the document is listed on the request
- **AND** the request is identified on the document

#### Scenario: Attachment does not cross deals

- **WHEN** a document belonging to another company is attached to a request
- **THEN** the attachment is refused

#### Scenario: The attachment count is reported

- **WHEN** a request with attached documents is listed
- **THEN** the count of attached documents is shown, and reflects reality

### Requirement: A narrative response can be given

The system SHALL allow a written response to be recorded against a request whose response type
expects one, from the request itself.

Observed today: the request detail shows "Narrative Response — no narrative has been added yet"
with no affordance to add one, on a request whose response type is `Both`.

#### Scenario: A narrative is added

- **WHEN** a user records a written response on a request expecting one
- **THEN** the response is stored against the request and shown on it

### Requirement: A request's response type is stated in words

The system SHALL describe what a request expects in language the reader can act on, rather than an
internal type name.

Observed today a column headed `Type` renders `Both` and `Narrative` with no legend anywhere;
`Both` means the request expects a document **and** a written answer.

#### Scenario: The expectation is legible

- **WHEN** a request is listed or opened
- **THEN** what it expects — a document, a written answer, or both — is stated without the reader
  needing to infer it

### Requirement: A reminder that was sent can be seen

The system SHALL show every reminder that was sent against a request, on the page a broker uses to
chase, and SHALL NOT report a send that did not happen.

The reminders board is derived from requests and their send history — there is a `reminders` table
and it is not what this reads. Observed today the read is served by legacy against a dead Supabase
and 500s, so a broker can press Remind, have the row written, and see 0 Due / 0 Scheduled / 0
Resolved: chasing a client leaves no trace they can find. Separately, legacy defaulted the first and
last send timestamps to the request's approval or creation time, so the board reported "Last
Reminder 14 Aug" beside "Sent Count 0".

#### Scenario: A reminder sent from the request list shows on the board

- **WHEN** a broker sends a reminder for a request
- **THEN** the reminders board shows that request with the send counted, dated, and attributed to
  the person who sent it
- **AND** the next automatic reminder moves out by the request's cadence, so the request stops
  asking to be chased again immediately

#### Scenario: Nothing sent is reported as nothing sent

- **WHEN** no reminder has ever been sent for a request
- **THEN** the board says so, rather than reporting the request's creation or approval time as a
  send

#### Scenario: The board is scoped to the deal and the reader

- **WHEN** the board is requested for a company
- **THEN** it carries only that company's requests
- **AND** a reader who is not a broker or admin sees only requests that are approved and visible to
  them, plus any they raised themselves

## MODIFIED Requirements

### Requirement: Completion means the request was satisfied

The system SHALL NOT treat a request as complete where its response type has not been satisfied.
A request expecting a document SHALL NOT complete with no document attached.

Observed today: the Documents column reads 0 for every request in the demo deal, including the one
marked Completed. A completed diligence request with nothing attached has not been completed, and
reporting it as such is what makes the request pillar untrustworthy rather than merely incomplete.

#### Scenario: Completion is attempted with nothing attached

- **WHEN** a request expecting a document is marked complete and no document is attached
- **THEN** the system refuses or warns, per the rule recorded in `design.md`
- **AND** the outcome is the same on every surface that can complete a request

#### Scenario: Completion succeeds when satisfied

- **WHEN** a request expecting a document is marked complete and a document is attached
- **THEN** the request completes
