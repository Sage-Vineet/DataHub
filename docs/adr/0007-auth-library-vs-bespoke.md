# ADR-0007 — Adopt an off-the-shelf auth library (Better Auth) vs. the bespoke module

- **Status:** Accepted (2026-08-11) — CTO chose Better Auth after the spike came back green (8/8)
- **Deciders:** CTO / platform
- **Implemented by:** change `adopt-better-auth` (in progress); evidence in `spikes/better-auth/SPIKE.md`

## Context

Phase 1 built a **bespoke** TypeScript auth module (`apps/api/src/modules/auth`). It is
tested and locally soaked, and it correctly closes the *critical* audit findings:
bcrypt-only credential check that rejects non-bcrypt hashes (C1), a fail-closed
`JWT_SECRET` that refuses insecure defaults (C2), enumeration-safe forgot-password,
hashed OTPs with attempt/resend/expiry limits, and login rate-limiting.

It is built on sound **primitives** — `bcryptjs` for hashing, `jsonwebtoken`
(HS256) for tokens, `node:crypto` for OTP/id generation. Using those libraries is
*not* "rolling your own crypto." **But the identity/session layer around them is
hand-rolled** — login, token issuance, `/me`, middleware, and the OTP reset flow
are all code we now own and must maintain.

Three known gaps were **deliberately deferred** in the cutover proposal
(`openspec/changes/auth-production-cutover`) as "Non-goals":

- **M1 — no token revocation / refresh / rotation.** Tokens are stateless 7-day
  HS256 (`config.ts:32`, `service.ts:158`). A stolen token cannot be invalidated,
  a user cannot be force-logged-out, and "kill all sessions" is impossible until
  expiry. This is the most serious gap for a documents/finance product.
- **M2 / M3 — token storage + CORS hardening deferred.** The SPA stores the JWT in
  `localStorage` and sends it as a `Bearer` header (`apps/web/src/context/AuthContext.jsx`,
  `apps/web/src/lib/api.js`). Any XSS ⇒ token theft, and with no revocation that is
  a 7-day window.

Auth is also the **reference domain**: `companies` / `users` / `folders` are about
to copy this pattern (ADR-0003). Deciding whether to keep building auth ourselves is
therefore far cheaper **now**, while auth is the only domain, than after four domains
inherit the hand-rolled approach.

The trigger for this ADR was a direct CTO question: *are we using an off-the-shelf,
bulletproof auth solution, or building it ourselves?* — and specifically, *what about
Better Auth or Supabase?*

## Decision

**Accepted:** adopt **Better Auth** (self-hosted, MIT, TypeScript-native) as the auth
engine, mounted behind the existing gateway seam, keeping identity data in our own
Postgres. The gating spike (`spikes/better-auth/`) came back **green (8/8)**, proving
(a) existing bcrypt-hashed users log in unchanged (parity), (b) database-backed,
revocable sessions via httpOnly cookies, and (c) a clean Drizzle-adapter path onto
`packages/db` — so the CTO confirmed the direction. Implementation is tracked by change
`adopt-better-auth`. Fallback if implementation hits a blocker: *keep the bespoke module
and schedule M1/M2/M3 as explicit hardening changes* (see Alternatives).

This ADR does **not** stop the in-flight cutover from being *possible* — the bespoke
module remains the rollback target — but it pauses *retiring legacy auth* until the
engine decision is settled, so we don't cement a pattern we may replace.

## Reasons

- **Closes M1 + M2 + M3 in one move, not three future changes.** Better Auth uses
  **database-backed sessions with httpOnly, secure cookies by default** → revocation /
  force-logout / kill-all-sessions is built in (M1), and the SPA stops holding a JWT in
  `localStorage` (M2/M3).
- **Best fit for this exact stack.** First-class **Drizzle adapter** over our own
  Postgres (leverages ADR-0002 directly), native **Express** integration that drops
  into the `apps/api` gateway the same way the current module mounts (ADR-0003), and a
  **React client SDK** that covers the "client-side needs" — session state and refresh —
  so we stop hand-maintaining `AuthContext`'s token plumbing.
- **Growth path as config, not code.** Plugins for **2FA/TOTP**, an **organizations**
  plugin (maps onto our company / `company_ids` multi-tenant model), and **SSO / SAML /
  OIDC** if enterprise customers ask — none of which we'd want to hand-build.
- **We stop owning the security-critical maintenance surface** of a bespoke identity
  layer while **keeping data ownership** (no vendor lock, unlike a managed provider).

## Alternatives considered

- **Keep the bespoke module; schedule M1/M2/M3 as hardening.** Viable and lowest
  immediate churn — the module works and is tested. Rejected as the *default* because it
  means building and forever maintaining revocation, refresh, secure-cookie sessions,
  and (later) MFA/SSO ourselves — reinventing what Better Auth ships. Retained as the
  **fallback** if the spike fails.
- **Supabase Auth (GoTrue).** We already depend on `@supabase/supabase-js`, and its
  client SDK has the richest out-of-the-box client-side story (auto refresh, social,
  MFA). **Rejected as the direction** because we use Supabase today *only as a
  Postgres/PostgREST data client* (service-role key, `persistSession:false`,
  `backend/src/lib/supabaseClient.js`), and adopting GoTrue would move identity into
  Supabase's `auth.users` and deepen platform coupling — the *opposite* of the
  modernization plan's goal of dropping the "Supabase-vs-`pg` dual path"
  (`openspec/changes/companies-domain`). Enterprise SSO is also paywalled.
- **Managed provider (Auth0 / Clerk / WorkOS / Cognito).** Least maintenance, fastest
  to enterprise SSO. Deferred: per-MAU cost and re-introducing an external identity
  dependency we just spent Phase 1 removing; revisit only if enterprise SSO/SCIM becomes
  a near-term sales requirement.
- **Passport.js.** Mature, but it is a middleware collection, not a batteries-included
  identity system — sessions, revocation, MFA, and org modeling would still be ours to
  assemble. Weaker fit than Better Auth for the "off-the-shelf, handles everything" bar.

## Consequences

- **Migration is a model mapping + backfill, not table reuse.** Our `users` table stores
  the bcrypt hash inline (`packages/db/src/schema.ts`); Better Auth manages its own
  `user` / `session` / `account` / `verification` tables (credentials live in `account`).
  Cutover requires mapping/backfilling existing users into that model, with a custom
  password verifier so current bcrypt hashes authenticate without a forced reset. The
  spike de-risks exactly this.
- **The SPA changes auth transport.** Moving from `Bearer`-token-in-`localStorage` to
  cookie sessions touches `apps/web/src/lib/api.js` and `AuthContext.jsx` (real but
  bounded frontend work) and requires CORS `credentials` + CSRF consideration.
- **The gateway seam is unchanged.** Better Auth mounts at `/api/auth` behind the same
  `AUTH_MODULE_ENABLED`-style flag, so cutover/rollback stays a config change (ADR-0003).
- **If adopted, this supersedes the bespoke module** as the reference pattern for Phase 2
  domains; if rejected, the bespoke module stands and M1/M2/M3 become tracked changes.

## References

- Spike: `spikes/better-auth/` (`SPIKE.md` for findings + effort estimate)
- Bespoke module: `apps/api/src/modules/auth/{service,config,middleware,ports}.ts`
- Cutover change: `openspec/changes/auth-production-cutover/`
- Gateway seam: ADR-0003; data layer: ADR-0002
- SPA auth: `apps/web/src/context/AuthContext.jsx`, `apps/web/src/lib/api.js`
