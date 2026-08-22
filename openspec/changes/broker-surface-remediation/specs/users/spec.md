## Purpose

How a person's credential is reset when they cannot get in. This delta narrows one behaviour: today
a broker can set another user's password by typing it into a text field, in the middle of a routine
profile-edit form.

## MODIFIED Requirements

### Requirement: One user never sets another user's credential

The system SHALL NOT accept a caller-supplied password for a different user. Where a user needs a
new credential, the system SHALL issue a single-use, expiring reset link to that user's own address,
and the initiating user SHALL NOT learn the resulting credential.

Observed today: the `Edit User` dialog carries a `Password Reset` field labelled "Leave blank to
keep existing", positioned between Role and Status alongside name, email and phone. A broker
editing a client's job title is one field away from setting their password, and knows it afterwards.

#### Scenario: A reset is initiated for another user

- **WHEN** a user initiates a credential reset for a different user
- **THEN** a single-use, expiring link is issued to that user
- **AND** the initiating user is not shown a credential

#### Scenario: A password is supplied for another user

- **WHEN** a request carries a password for a user other than the caller
- **THEN** the request is refused

#### Scenario: Editing a profile does not touch credentials

- **WHEN** a user's profile fields are edited
- **THEN** no credential field is offered or accepted in that operation

#### Scenario: A user changes their own password

- **WHEN** a user changes their own password
- **THEN** the change is accepted, subject to the existing authentication rules
