## Context

See `proposal.md`. The module runs in-process in `apps/api` behind `AUTH_MODULE_ENABLED` (phase-1-auth design D1/D2); tokens use the same secret + `{sub}` claim as legacy (D3). Two real-world gaps remain before it can serve prod: (1) the schema was hand-authored offline, and (2) the emailer is a stub. This change closes both, then flips the flag safely.

## Goals / Non-Goals

**Goals:** serve `/api/auth` from the TS module in prod with no user-visible change (except 429s under abuse); instant rollback; delete legacy auth once proven.

**Non-Goals:** other domains; token-model changes; a distributed rate-limit store unless multi-instance.

## Decisions

### D1 — Reconcile the schema before enabling
Run `pnpm --filter @datahub/db db:pull` against a **staging** DB (or a prod snapshot) and diff against `packages/db/src/schema.ts`. Fix any drift in the auth-slice tables (users, companies, user_companies, email_verifications, folders) before the flag goes on. The local dev DB already proved `db:pull` works.

### D2 — Real emailer via Microsoft Graph
Implement `GraphEmailer implements Emailer` (mirrors legacy `emailService.js`) and inject it in `createAuthModule({ repo, emailer })` when `AUTH_MODULE_ENABLED`. Keep `ConsoleEmailer` for dev. Forgot/reset must actually send in prod; the enumeration-safe behavior (generic 200) is unchanged.

### D3 — Same JWT secret as legacy (zero-downtime)
Prod `JWT_SECRET` **must equal** the legacy secret so tokens minted by either side validate on both during the flip and any rollback. Verify with a cross-validation check in staging before enabling.

### D4 — Staged flip, not big-bang
Order: staging (flag on) → parity checklist + monitor → production (flag on) → soak → delete legacy. Because the mount is per-instance all-or-nothing, "canary" = a staging environment first (and, if infra allows, a single prod instance) rather than a traffic %.

### D5 — Rollback is an env flag
`AUTH_MODULE_ENABLED=false` + restart returns `/api/auth` to legacy instantly. Keep legacy handlers in place until the soak is green.

### D6 — Rate-limit store
`express-rate-limit` uses an in-memory store — correct for a single instance. If `apps/api` runs multiple instances behind a load balancer, either enable sticky sessions or add a shared store (Redis) so the limit is global. Decide based on the deploy topology (task 8).

## Risks / Trade-offs

- **Prod schema drift** → reconcile via `db:pull` first (D1); block the flip on a clean diff.
- **Reset emails silently fail** → the Graph adapter is a hard prerequisite (D2); test delivery in staging before prod.
- **Secret mismatch breaks sessions** → verify token cross-validation in staging (D3).
- **Multi-instance rate-limit is per-node** → decide shared-store vs sticky before prod (D6).
- **Legacy removed too early** → delete only after an agreed green soak; it stays as the rollback target until then.

## Migration Plan

1. Reconcile schema (staging `db:pull`); implement + test the Graph emailer.
2. Deploy `apps/api` to staging with prod-like secrets; confirm non-auth routes still proxy to legacy unchanged.
3. Enable `AUTH_MODULE_ENABLED` in staging; run the parity checklist (login, `/me`, wrong-password, forgot/reset **with real email**, 429, tenant boundary) + token cross-validation.
4. Enable in production; monitor login-success rate, 401/429/5xx, error logs (pino).
5. Soak (agreed window, e.g. 1 week green). **Rollback:** flag off + restart.
6. Delete legacy `/api/auth` handlers (routes/controllers/services) in a separate, reversible commit.

## Open Questions

- Deploy topology of `apps/api` (single vs multi-instance) — drives the D6 rate-limit decision. Resolve with ops before prod.
- Soak window length — agree with the team (default: one green week).
