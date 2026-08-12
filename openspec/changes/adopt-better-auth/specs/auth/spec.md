## MODIFIED Requirements

### Requirement: Session token issuance and verification

The system SHALL establish an authenticated session on successful login and SHALL reject
any session credential it did not issue or that has expired. Session state SHALL be
**server-side (database-backed)** and presented to the browser as an **httpOnly, Secure,
SameSite cookie** — not a bearer token held in browser-accessible storage (audit M2/M3).
The service SHALL fail closed if its signing secret is missing or an insecure default.

#### Scenario: Valid session is accepted
- **WHEN** a request presents a valid, unexpired session cookie the system issued
- **THEN** the request is authenticated as that user

#### Scenario: Forged or tampered session is rejected
- **WHEN** a request presents a session cookie with an invalid or tampered signature
- **THEN** the request is rejected as unauthenticated (401)

#### Scenario: Session is delivered as an httpOnly cookie
- **WHEN** a user logs in successfully
- **THEN** the session is set as an httpOnly, Secure cookie and is **not** exposed to
  client-side JavaScript or persisted in `localStorage`

#### Scenario: Missing secret fails closed
- **WHEN** the service starts without a valid signing secret (unset or an insecure default)
- **THEN** it refuses to start

## ADDED Requirements

### Requirement: Session revocation

The system SHALL be able to invalidate an active session server-side so that a revoked
session credential is no longer accepted (audit M1). This includes single-session logout
and revoking all of a user's sessions.

#### Scenario: Revoked session is rejected
- **WHEN** an active session is revoked (logout, or an administrative force-logout)
- **THEN** the next request presenting that session credential is rejected as
  unauthenticated (401), even before any token would have naturally expired

#### Scenario: Revoke all sessions
- **WHEN** all of a user's sessions are revoked (e.g. after a password change or account compromise)
- **THEN** every previously issued session for that user is rejected on its next use

### Requirement: Credential migration parity

The system SHALL authenticate pre-existing users whose credentials are stored as legacy
bcrypt hashes, without requiring a password reset, so the engine change is invisible to users.

#### Scenario: Existing bcrypt credential logs in unchanged
- **WHEN** a user whose stored credential is a legacy bcrypt hash submits their correct password
- **THEN** authentication succeeds (200) with no forced reset, and a session is established
