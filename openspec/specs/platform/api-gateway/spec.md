# platform/api-gateway Specification

## Purpose
The API gateway is the single HTTP entry point that fronts all DataHub backend traffic, forwarding each request to either the legacy backend or a new module based on an environment-driven routing table. It is the seam that makes the re-architecture reversible: domains are cut over — and rolled back — one route-group at a time without touching callers.
## Requirements
### Requirement: Default pass-through to legacy

The gateway SHALL forward every incoming request to the legacy backend by default, so that with no route-group cut over, externally observable behavior is identical to calling the legacy backend directly.

#### Scenario: Unmapped path forwards to legacy
- **WHEN** a request arrives for a path with no explicit routing-table entry
- **THEN** the gateway forwards it to the configured legacy backend origin and returns the legacy response unchanged

#### Scenario: Method, query, and body are preserved
- **WHEN** a request with any HTTP method, query string, and request body is forwarded
- **THEN** the method, path, query string, and body are transmitted to the upstream byte-for-byte and the upstream status code, response headers, and response body are returned to the client unchanged

### Requirement: Environment-driven routing table

The gateway SHALL resolve each request to an upstream target using a routing table supplied by environment configuration, and changing that table SHALL NOT require code changes to callers.

#### Scenario: Route-group flipped to a new module
- **WHEN** the routing table maps a route-group (e.g. a path prefix) to a new-module target
- **THEN** requests matching that route-group are forwarded to the new-module upstream and all other requests continue to the legacy backend

#### Scenario: Rollback by reverting the table entry
- **WHEN** a previously flipped route-group's entry is removed or repointed to legacy
- **THEN** matching requests are forwarded to the legacy backend again with no other behavior change

#### Scenario: Invalid or missing routing configuration
- **WHEN** the gateway starts with a malformed or absent routing table
- **THEN** it fails to start with a descriptive error rather than starting with undefined routing behavior

### Requirement: Header and client-context integrity

The gateway SHALL preserve request headers required for authentication and client identification, and SHALL annotate forwarded requests with standard proxy headers.

#### Scenario: Authorization header is preserved
- **WHEN** a request carrying an `Authorization` (bearer) header is forwarded
- **THEN** the upstream receives the identical `Authorization` header

#### Scenario: Forwarding metadata is added
- **WHEN** a request is forwarded to any upstream
- **THEN** the gateway sets standard forwarding headers (e.g. `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`) without dropping existing client headers

### Requirement: Streaming and large payload pass-through

The gateway SHALL stream request and response bodies so that uploads and downloads (financial documents, report exports) pass through without full buffering or truncation.

#### Scenario: Large upload passes through
- **WHEN** a client streams a large multipart upload through the gateway
- **THEN** the body is streamed to the upstream without buffering the entire payload in memory and without altering the content

#### Scenario: Streamed download passes through
- **WHEN** an upstream returns a streamed or chunked response
- **THEN** the gateway relays the stream to the client preserving content and transfer semantics

### Requirement: Health check

The gateway SHALL expose an unauthenticated health endpoint that reports gateway liveness independently of upstream availability.

#### Scenario: Health endpoint responds
- **WHEN** a client requests `GET /healthz`
- **THEN** the gateway responds `200` with a small body indicating the gateway is up, without proxying to any upstream

### Requirement: Upstream failure handling

The gateway SHALL surface upstream connectivity failures as explicit gateway errors rather than hanging or silently swallowing them.

#### Scenario: Upstream unreachable
- **WHEN** the resolved upstream cannot be reached or times out
- **THEN** the gateway returns a `502`/`504` status with an error body and logs the failure (no silently discarded error)

