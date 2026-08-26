## Context

See `proposal.md` — Why. The Phase 0 gateway forwards 100% to legacy today; this change stands up the first in-process TypeScript module behind it and the two foundational packages (`contracts`, `db`) it depends on. The legacy auth logic (already hardened for C1/C2/H3 in commit `17c7e08`) is the behavior source of truth; this is a typed re-implementation at parity plus H1. Constraint: the SPA must see an unchanged `/api/auth` HTTP contract, and legacy pass-through for every other route must stay byte-identical.

## Goals / Non-Goals

**Goals:**
- Establish the reusable module shape (`router + service + repository + contract + tests`) other domains will copy.
- Cut `/api/auth` over to the new module with an instant, env-level rollback.
- Zero-downtime cutover: tokens issued by legacy and the new module are mutually valid during the flip.

**Non-Goals (design-level):**
- No shared/distributed rate-limit store (single-instance in-memory for now; revisit for horizontal scale).
- No JWT refresh/revocation (M1); token model stays at parity.
- Helmet/pino are scoped to the module, not applied to proxied legacy responses.

## Decisions

### D1 — Auth runs in-process in `apps/api`, mounted ahead of the proxy
The module is `app.use("/api/auth", authRouter)` mounted **before** the Phase 0 catch-all proxy. `/api/auth` is served in-process; everything else still falls through to the legacy proxy. This realizes the modular monolith ([ADR-0004](../../../docs/adr/0004-modular-monolith.md)) without a second deployable. *Alternative:* run auth as a separate service behind `API_ORIGIN` and route via `GATEWAY_ROUTES` — deferred; unnecessary infra for one module, and the mount-ahead approach keeps the gateway's proxy contract untouched.

### D2 — Cutover + rollback via an env flag, not a code deploy
An env flag (`AUTH_MODULE_ENABLED`) gates the mount. Enabled → in-process auth; disabled → `/api/auth` falls through to legacy. Rollback is flipping the flag and restarting — no revert, consistent with the Phase 0 reversibility principle ([ADR-0003](../../../docs/adr/0003-parallel-rewrite-behind-gateway.md)). (The Phase 0 routing table remains for future *separate-service* cutovers; in-process modules use this mount flag.)

### D3 — Token parity for zero-downtime
The new module signs/verifies with the **same `JWT_SECRET` and the same claim shape** as legacy. So a token minted by legacy verifies in the new module and vice-versa — users mid-session are unaffected when the flag flips or rolls back. The fail-closed secret loader from `backend/src/config/secrets.js` is reimplemented as a typed `packages/config` (or module) env loader.

### D4 — `packages/db` (Drizzle), auth slice only
`drizzle-kit pull` introspects the live Postgres into a typed schema, but we commit only the **auth-relevant tables** now (users, OTP/email-verification, company + user-company links). Drizzle owns migrations going forward; the legacy 76-file set is frozen ([ADR-0002](../../../docs/adr/0002-drizzle-data-layer.md)). The repository is the only place raw SQL/queries live. *Assumption:* a reachable `DATABASE_URL` (staging/dev) exists at apply time; if not, the auth-slice schema is hand-authored from `backend/sql/schema.sql` and reconciled with introspection later.

### D5 — `packages/contracts` (zod) as the single request/response contract
Auth zod schemas live here; the router validates input with them and the inferred types flow into the service. The SPA can later import the same types, killing hand-typed shapes in `api.js`. Validation failures return 400 before any business logic.

### D6 — Middleware scoped to the module
`express-rate-limit` (H1) is applied to the login route, keyed by IP + submitted email. `helmet` and `pino-http` are applied to the auth router — **not** globally — so proxied legacy responses stay byte-identical (the gateway spec's pass-through guarantee). *Trade-off:* other domains re-apply these as they migrate; acceptable and explicit.

### D7 — Behavior parity is test-enforced
The service ports legacy semantics exactly: bcrypt-only verification, enumeration-safe reset, OTP limits, and the post-login client company-sync + `ensureDefaultFolders` side effects. Parity is locked by tests that assert the same observable outcomes as legacy.

## Risks / Trade-offs

- **Token incompatibility during cutover** → keep the same secret + claim shape (D3); test cross-validation both directions.
- **Helmet/pino altering legacy responses** → scope to the module router, never the proxy path (D6); assert legacy pass-through is unchanged.
- **In-memory rate-limit store is per-instance** → correct for single-instance deploys; note a shared store (Redis) is required before horizontal scaling. Logged, not silently assumed.
- **Introspection needs DB access** → fallback to hand-authored auth-slice schema (D4); reconcile later.
- **Parity drift (missing a legacy side effect)** → port `authService`/`otpService`/`companyService` post-login paths deliberately; parity tests + a manual diff against legacy responses before retiring legacy auth.

## Migration Plan

1. Land `packages/contracts` + `packages/db` (auth slice) — no runtime change.
2. Build `apps/api/src/modules/auth` (+ helmet/pino/rate-limit) behind `AUTH_MODULE_ENABLED=false`.
3. Enable the flag in a canary/preview; verify parity (login, reset, OTP, `/me`, tenant boundary, 429) and that all other routes still proxy unchanged.
4. Flip on; monitor. **Rollback:** set `AUTH_MODULE_ENABLED=false`, restart.
5. After a green soak, delete the legacy `/api/auth` handlers.

## Open Questions

- Which `DATABASE_URL` to introspect at apply time (staging vs. dev snapshot) — does not change the design or specs; resolved when implementation starts.
- Rate-limit thresholds/window (e.g. 5/15 min) — tune during implementation; parity of *behavior* (429 past a threshold) is what the spec fixes.
