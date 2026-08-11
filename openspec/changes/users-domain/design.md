## Context

See `proposal.md` and the domain map. Legacy `userService.js` is ~1,097 lines with 20+ functions: role/sub-role gating, `effective_role` computation, `attachAssignedCompanies` (incl. a 5-query historical-company inference), delete-with-reassignment, Supabase→`pg` fallback with a circuit breaker, and migration shims for columns added in migrations 039/041. We keep the behavior, drop the shims and dual path.

## Goals / Non-Goals

**Goals:** parity for `/api/users`; one typed path; effective-role + visibility rules in one tested place; delete invariant preserved.

**Non-Goals:** migrating companies/folders; changing the JWT/session model; removing the historical-inference shim (parity now, simplify later).

## Decisions

### D1 — Blueprint + shared access
`modules/users/` follows the `auth` blueprint and imports the shared `canAccessCompany` (promoted in `companies-domain`). If companies hasn't landed yet, promote the shared guard here.

### D2 — Effective-role + visibility as pure, tested functions
Port `effective_role` and the visibility filter into pure functions in the service (input: viewer + target rows) so they're unit-tested exhaustively across role/sub-role combinations. This is the highest-value correctness surface.

### D3 — Cross-domain writes via ports
- `EmailerPort` + `NotificationPort` — welcome email + in-app notification on create (best-effort; failures never fail the request).
- `AuthCachePort` — invalidate the auth module's session cache on update (call the auth service's `invalidateUserCache`).
- `RecordReassignmentPort` — reassign `created_by`/`uploaded_by` across folders/requests/documents/activity/reminders on delete. Backed by a transactional query now; becomes those modules' services later. This keeps the "no reaching into other domains' tables" rule explicit.

### D4 — Delete is transactional and invariant-guarded
`resolveReplacementUserId` runs first; if none, reject (400) with no writes. Otherwise reassign (via the port) and delete the user in one transaction.

### D5 — Historical-company inference is an isolated read
Port `attachAssignedCompanies`' 5-query fan-out into a single repository read method, clearly named as a legacy-compat shim. It runs only when `user_companies` is empty for a broker. Flag it for removal once `user_companies` is authoritative.

### D6 — Passwords reuse the auth hashing
bcrypt hashing/verification matches the `auth` module (same cost, same `$2[aby]$` acceptance). Self-service password change requires and verifies `current_password`.

## Risks / Trade-offs

- **Effective-role drift** → exhaustive table-driven tests against the legacy matrix (D2).
- **Reassignment touches other domains' tables** → `RecordReassignmentPort` keeps the boundary explicit; transactional to avoid partial reassignment (D3/D4).
- **Historical inference is N+1-ish** → isolated, only-when-needed, and marked for removal (D5).
- **Column/migration shims** → not ported; ensure `db:pull` reflects the real prod columns first.

## Migration Plan

1. Contracts + fuller `packages/db` users schema + `broker_team_invites` (reconcile via `db:pull`).
2. Ports (email, notification, auth-cache, reassignment) with adapters.
3. Repository (Drizzle + in-memory) incl. transactional delete/reassignment + the inference read; service with visibility/gating/effective-role/create/update/delete/membership/team.
4. Tests to ≥90%, table-driven for effective-role and visibility; delete-invariant tests.
5. Mount `/api/users` behind `USERS_MODULE_ENABLED`; soak; delete legacy handlers.
- **Rollback:** flag off → legacy serves `/api/users`.

## Open Questions

- Whether to keep or drop the historical-inference shim at cutover — default keep (parity); revisit after `user_companies` is confirmed authoritative in prod.
