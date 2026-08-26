## Purpose

Authentication for DataHub: how users prove identity, obtain and present session tokens, recover access, and how the system enforces per-tenant boundaries. This spec captures the behavior the rebuilt `auth` module must honor — parity with the hardened legacy flow, plus login rate-limiting — independent of implementation.

## ADDED Requirements

### Requirement: Credential login

The system SHALL authenticate a user by email and password using a per-user bcrypt hash, and SHALL issue a signed session token on success. There SHALL be no shared or static password path for any user population.

#### Scenario: Valid credentials
- **WHEN** a user submits a correct email/password pair
- **THEN** the system responds 200 with a signed JWT and the user's identity (id, role)

#### Scenario: Invalid credentials
- **WHEN** a user submits a wrong password (or unknown email)
- **THEN** the system responds 401 with a generic message that does not reveal whether the email exists

#### Scenario: Former shared password is rejected
- **WHEN** a client/buyer account attempts to log in with the retired shared password (e.g. "123456")
- **THEN** authentication fails with 401 (the static-password bypass no longer exists)

### Requirement: Login rate limiting

The system SHALL limit repeated failed login attempts per identifier/IP within a time window to bound brute-force attacks (audit H1).

#### Scenario: Threshold exceeded
- **WHEN** the number of failed login attempts from the same source exceeds the configured threshold within the window
- **THEN** further attempts receive 429 Too Many Requests until the window resets

#### Scenario: Successful login is not blocked under the threshold
- **WHEN** a legitimate user logs in within the allowed attempt count
- **THEN** the request succeeds normally

### Requirement: Session token issuance and verification

The system SHALL sign session tokens with a mandatory secret and SHALL reject any token not validly signed by that secret. The service SHALL refuse to start if the secret is missing or an insecure default (fail closed).

#### Scenario: Valid token is accepted
- **WHEN** a request presents a token signed with the configured secret and not expired
- **THEN** the request is authenticated as that user

#### Scenario: Forged or tampered token is rejected
- **WHEN** a request presents a token signed with a different/guessed secret or with altered claims
- **THEN** the request is rejected with 401

#### Scenario: Missing secret fails closed
- **WHEN** the service starts without a configured signing secret (or with an insecure default)
- **THEN** it refuses to start rather than signing with a public constant

### Requirement: Enumeration-safe password reset

The system SHALL provide password reset that does not disclose whether an email is registered, and SHALL require a valid one-time code plus a strong new password to change credentials.

#### Scenario: Forgot-password does not reveal account existence
- **WHEN** a forgot-password request is submitted for any email (registered or not)
- **THEN** the system responds with the same generic 200 and (only for registered emails) dispatches a reset code

#### Scenario: Reset requires a valid code and strong password
- **WHEN** a reset is submitted with a valid, unexpired OTP and a password meeting the strength policy
- **THEN** the password is updated and subsequent login uses the new password

#### Scenario: Reset with an invalid or expired code fails
- **WHEN** a reset is submitted with a wrong or expired OTP
- **THEN** the password is not changed and an error is returned

### Requirement: OTP verification

The system SHALL issue time-limited one-time codes and enforce expiry and attempt/resend limits.

#### Scenario: Valid OTP within limits
- **WHEN** a correct OTP is submitted before expiry and within the attempt limit
- **THEN** verification succeeds

#### Scenario: Expired or over-limit OTP
- **WHEN** an OTP is submitted after expiry, or after exceeding the maximum attempts/resends
- **THEN** verification fails and a new code must be requested

### Requirement: Current session lookup

The system SHALL expose the authenticated user's identity for a valid session token.

#### Scenario: Authenticated identity
- **WHEN** a request to the current-session endpoint presents a valid token
- **THEN** the system returns the user's id, role, and tenant associations

#### Scenario: Unauthenticated request
- **WHEN** the current-session endpoint is called without a valid token
- **THEN** the system responds 401

### Requirement: Multi-tenant access parity

The system SHALL confine each authenticated user to the companies they are authorized for, preserving the legacy `canAccessCompany` boundary.

#### Scenario: Authorized company access
- **WHEN** an authenticated user acts on a company they are associated with
- **THEN** the action is permitted

#### Scenario: Cross-tenant access denied
- **WHEN** an authenticated user attempts to act on a company they are not associated with
- **THEN** the system denies the request (403/404) without leaking the other tenant's data

### Requirement: Post-login provisioning for client users

The system SHALL preserve the legacy post-authentication side effects for client/buyer users so their workspace is usable immediately after first login.

#### Scenario: First client login provisions workspace
- **WHEN** a client user authenticates successfully
- **THEN** their company association is synced and their default folders exist afterward (parity with legacy `ensureDefaultFolders`)
