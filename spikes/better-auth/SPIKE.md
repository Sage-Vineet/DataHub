# Spike — Better Auth over Drizzle + Postgres (ADR-0007)

**Time-box:** ~½ day · **Status:** ✅ green (8/8) · **Verdict:** adopt Better Auth is viable; no blocker found.

This spike de-risks the three questions ADR-0007 hinges on, using **real Better Auth
code** (v1.6.27) on the **real Drizzle adapter** against a **real Postgres engine**
(PGlite, embedded — throwaway, no external DB needed).

## Run it

```bash
cd spikes/better-auth
corepack pnpm install --ignore-workspace
node spike.mjs
```

Expected tail:

```
8/8 checks passed
SPIKE RESULT: Better Auth on Drizzle+Postgres closes M1/M2/M3 with bcrypt parity.
```

## What it proves

| # | Claim in ADR-0007 | Check | Result |
|---|---|---|---|
| 1 | Existing **bcrypt** users log in unchanged (no forced reset) | seed an `account.password` with a legacy bcrypt hash; sign in with the original plaintext via a custom `password.verify = bcrypt.compare` | ✅ 200 |
| 2 | Sessions are **httpOnly cookies**, not a `localStorage` JWT (M2/M3) | assert `Set-Cookie: better-auth.session_token=…; HttpOnly` | ✅ |
| 3 | Sessions are **DB-backed** (a row in *our* Postgres) | `SELECT * FROM session` → 1 row after login | ✅ |
| 4 | **Revocation works server-side** (audit **M1**) | `revokeSession` → `getSession` returns `null`, row deleted | ✅ |
| 5 | All of it runs on the **Drizzle adapter** over our own schema | `drizzleAdapter(db, { provider: "pg", schema })` | ✅ |
| — | Wrong password rejected | 401 | ✅ |

M1 (revocation) is the single thing the bespoke module structurally **cannot** do
with stateless HS256 tokens — the spike shows Better Auth gives it to us for free.

## Findings for the migration (feed into ADR-0007 "Consequences")

1. **Data model is separate tables, not our `users` row.** Better Auth owns
   `user` / `session` / `account` / `verification`. Credentials live in `account`
   (`providerId = "credential"`, `password = <hash>`), **not** on `user`. Migration =
   backfill `users → user` + one `account` row per user carrying the existing
   `password_hash`. The spike seeds exactly this shape, so the backfill is
   mechanical.
2. **bcrypt hashes migrate verbatim.** No forced password reset — a custom
   `emailAndPassword.password.verify` delegating to `bcrypt.compare` authenticates
   legacy hashes as-is. (Optional nicety: transparently re-hash to Better Auth's
   default scrypt on next successful login.)
3. **drizzle-orm version.** Better Auth 1.6.27 declares a peer of
   `drizzle-orm@^0.45.2`; the monorepo is on `^0.40.1`. The spike **ran green on
   0.40.1** (peer warning is non-blocking here), but adopting for real should bump
   `packages/db` to the supported range and re-run the type/integration suite.
4. **Schema generation is a one-liner, not hand-authored.** The tables in
   `schema.mjs` were hand-written for the spike; in production use
   `npx @better-auth/cli generate` to emit the Drizzle schema from the auth config
   (keeps it correct across Better Auth upgrades).
5. **SPA transport change is the real frontend work.** Moving from
   `Authorization: Bearer <jwt>` (`apps/web/src/lib/api.js`) to cookie sessions
   needs `credentials: "include"` on fetches, CORS `credentials` on the gateway, and
   CSRF handling. Bounded, but it touches `AuthContext.jsx` and the api client.

## Rough effort to production (estimate, not a commitment)

- Better Auth mounted in `apps/api` behind the gateway flag, Drizzle schema
  generated, config (secret/baseURL/trustedOrigins): **~1 day**
- `users → user/account` backfill migration + bcrypt-verify parity + tests: **~1–2 days**
- SPA cutover to cookie sessions (api client, AuthContext, CORS/CSRF): **~2–3 days**
- Feature parity for OTP-reset flow (email-otp plugin) + email adapter: **~1–2 days**
- **Total: ~1–1.5 weeks**, versus separately building M1 revocation + M2/M3 cookie
  hardening + future MFA/SSO on the bespoke module (more, and ongoing to maintain).

## Not covered (intentionally out of the time-box)

- Multi-tenant mapping via the **organizations** plugin (company / `company_ids`).
- The **email-otp** plugin to replace the current forgot/reset OTP flow.
- Load/perf of DB-backed sessions vs stateless (add `cookieCache` / secondary
  storage if needed — Better Auth supports both).
