# Deploying to centuriuum.com

The SPA and the gateway deploy separately and must agree about three things:
the origin each one lives at, the origins the other is allowed to talk to, and
which capabilities are switched on. Every failure below has been reached by
getting one of those three wrong.

```
  https://centuriuum.com        Vercel        apps/web    static bundle
  https://api.centuriuum.com    container     apps/api    gateway + Postgres
```

Both on `centuriuum.com`. That is not cosmetic — see **Why the API must be a
subdomain** at the end.

## 1. Vercel project (apps/web)

`vercel.json` at the repo root already carries the build. Set **Root Directory
blank** and **Framework Preset: Other** — a dashboard override beats
`vercel.json`, and the preset for Vite rewrites the output directory to `dist`,
which publishes an empty site.

| Setting | Value |
|---|---|
| Root Directory | *(blank — repo root)* |
| Framework Preset | Other |
| Build Command | *(leave unset — `vercel.json` supplies it)* |
| Output Directory | *(leave unset — `vercel.json` supplies it)* |
| Install Command | *(leave unset — `vercel.json` supplies it)* |
| Production Branch | `data_room` |

One environment variable, and the build **fails without it**:

```
VITE_API_BASE_URL = https://api.centuriuum.com
```

Vite inlines this at build time, not runtime. Unset, every API call in the
shipped bundle would point at `http://localhost:8080` — a site that loads
perfectly and does nothing. `apps/web/vite.config.js` refuses to build when
`VERCEL=1` and the variable is missing, so this fails loudly in the build log
rather than quietly in production.

Set it for **Production** and **Preview** both. A preview build without it fails
the same way.

No rewrite rules are needed. The SPA uses `HashRouter`, so every route lives
after the `#` and the server only ever serves `/`.

## 2. Gateway (apps/api)

Ships as a container — `apps/api/Dockerfile`, with `docker-compose.staging.yml`
as the reference for shape. It needs a Postgres it owns, and HTTPS.

### Required, refuses to start without them

```
DATABASE_URL     postgres://…                       a real Postgres
JWT_SECRET       <strong random>                    rejects known-insecure defaults
NODE_ENV         production                         also what makes the session cookie Secure
```

### Origins — all three, or auth breaks

```
BETTER_AUTH_URL        https://api.centuriuum.com     the gateway's own public URL
AUTH_TRUSTED_ORIGINS   https://centuriuum.com         the SPA origin, exactly
FRONTEND_URL           https://centuriuum.com
```

`AUTH_TRUSTED_ORIGINS` gates credentialed CORS and CSRF. If it does not match
the browser's `Origin` header character for character — scheme included, no
trailing slash — login returns 403 and nothing else works.

### Capability flags — unset means OFF

`parseFlag` treats an unset flag as `false`, and off means the feature is
**absent**, not degraded. A gateway started with none of these set serves an
application with no data room, no Q&A, no CIM and no earnings bridge. Set every
one you intend to ship:

```
BETTER_AUTH_ENABLED=true
ACTIVITY_LOG_ENABLED=true
DATAROOM_MODULE_ENABLED=true
DATAROOM_VERSIONS_ENABLED=true
DATAROOM_COMMENTS_ENABLED=true
DATAROOM_CHUNKED_UPLOAD_ENABLED=true
QA_MODULE_ENABLED=true
QA_PRESENTATION_ENABLED=true
QA_NOMINATIONS_ENABLED=true
CIM_MODULE_ENABLED=true
QOE_MODULE_ENABLED=true
COA_REVIEW_MODULE_ENABLED=true
```

The value must be exactly `true` or `false`. `1`, `TRUE` and `yes` are refused
at boot rather than read as off — a flag that silently means the opposite of
what it says is worse than one that stops.

`/healthz` reports which capabilities are live, and the SPA reads exactly that
to decide what to render. After deploying, `curl https://api.centuriuum.com/healthz`
and check the `features` object matches what you set. If they disagree, the SPA
will show a feature that is not there.

### Optional, but each one silently removes something

```
GEMINI_API_KEY                     COA reasonableness generation. Without it the
                                   module still serves; only generating new
                                   recommendations reports unavailable.

GRAPH_TENANT_ID                    Password reset delivery, via Microsoft Graph.
GRAPH_CLIENT_ID                    Without GRAPH_TENANT_ID the gateway falls back
GRAPH_CLIENT_SECRET                to ConsoleEmailer, which in production sends
GRAPH_SENDER_EMAIL                 nothing and logs nothing. Reset appears to
                                   work — the response is deliberately generic —
                                   and no mail ever arrives. Configure it, or
                                   decide consciously that reset is not live.

QB_CLIENT_ID                       QuickBooks. The redirect URI must match what
QB_CLIENT_SECRET                   is registered in the Intuit app EXACTLY:
QB_REDIRECT_URI                    https://api.centuriuum.com/api/auth/callback
QB_AUTHORIZE_URL                   Intuit redirects a browser there, so it is the
QUICKBOOKS_API_BASE_URL            gateway's origin, never the SPA's.

UPLOAD_MAX_SIZE                    Defaults apply if unset.
```

## 3. Database

```
DATABASE_URL=… pnpm --filter @datahub/db db:migrate
```

On an empty database that is `0000_baseline.sql` alone, which creates all 86
tables. `db:migrate --status` reports what is applied, pending or drifted
without changing anything.

Do **not** run the demo seeds against production. `tools/demo/*` exists to
furnish a local booth demo and creates fictional companies and users whose
passwords are a published constant.

## 3b. Supabase, on a clean database

Supabase is used only as the Postgres host. There is no Supabase SDK and no
dependency on one — the references left in `apps/api` are historical comments
about what the deleted legacy backend did.

Point `DATABASE_URL` at the Supabase connection string and add `sslmode`:

```
DATABASE_URL=postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres?sslmode=require
```

`packages/db/src/client.ts` drives TLS from `sslmode` and deliberately does not
hardcode `rejectUnauthorized:false` (audit H2), so pass a URL you are willing to
have verified. Either port works: the pool holds `max: 5` connections and the
codebase issues **no** prepared statements, so the pgbouncer pooler on `6543` is
safe if you prefer it.

The baseline creates its 86 tables with bare `CREATE TABLE public.x` — no
`IF NOT EXISTS`. **It requires an empty database** and will fail on the first
name it finds already taken. That is the intended behaviour: it refuses to
half-apply over someone else's schema. Verified against an empty Postgres:
86 tables plus `schema_migrations`, and `db:migrate --status` reports
`applied 1, pending 0, drifted 0` — the Drizzle schema and the migrated
database agree.

The one extension it needs is `pgcrypto`, guarded with `IF NOT EXISTS` and
grantable by Supabase's `postgres` role.

## 3c. Creating the first account

On an empty database nobody can sign up. `/auth/broker/signup` requires a
`verification_token`, which is only issued after an emailed OTP is verified —
and with Microsoft Graph unconfigured the fallback emailer sends nothing. The
result is a working deployment that no one can get into.

Either configure Graph before launch, or bootstrap an admin directly. The
bootstrap is two steps and uses the same production function the rollout does:

```sql
-- 1. A user row with a bcrypt hash of the chosen password.
--    Generate it yourself; never reuse a hash from tools/demo, whose
--    password is a published constant.
INSERT INTO users (id, name, email, password_hash, role, status)
VALUES (gen_random_uuid(), 'Ops Admin', 'admin@centuriuum.com', '<bcrypt>', 'admin', 'active');
```

```bash
# 2. Give it a Better Auth identity.
DATABASE_URL=… pnpm --filter @datahub/demo backfill
```

`backfillBetterAuthIdentities` is idempotent and reversible, and carries the
existing bcrypt hash into the `credential` account row rather than forcing a
reset. Verified on a clean database: it produced an `auth_user` with
`email_verified = true` and an `account` row whose password matches the hash
supplied — so the bootstrapped admin logs in without any email being sent.

## 4. Order

1. Postgres up, `db:migrate` run.
2. Gateway deployed with the variables above, `/healthz` returning the expected
   `features` object.
3. Vercel project created with `VITE_API_BASE_URL` set, then deploy.
4. Sign in from `https://centuriuum.com` and confirm a session survives a page
   reload — that is the check that proves the cookie is actually being stored
   and returned.

Step 3 before step 2 produces a site whose every request fails, which is
indistinguishable from a broken build.

## Why the API must be a subdomain

The session cookie is set `sameSite: "lax"`
(`apps/api/src/modules/auth/better-auth.ts`). Lax means the browser sends the
cookie on same-site requests only, and "same site" is decided by the
**registrable domain**:

- `centuriuum.com` → `api.centuriuum.com` — same site. The cookie flows. ✓
- `centuriuum.vercel.app` → `api.centuriuum.com` — cross-site. The browser
  withholds the cookie on every XHR, login appears to succeed, and the next
  request is unauthenticated. ✗

So while the SPA is still on a `*.vercel.app` preview URL, expect authenticated
requests to fail even with everything else correct. Attach the custom domain
before testing auth.

There is a `bearer()` plugin on the auth module and the SPA does read a token
from the login response's `Authorization` header, so a cross-site deployment
*may* work on that path — it has not been verified end to end, and it should not
be relied on. If a cross-site deployment is ever genuinely required, change the
cookie to `SameSite=None; Secure` deliberately and test it, rather than hoping
the bearer fallback carries it.
