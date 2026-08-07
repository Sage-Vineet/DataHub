# Security Architecture

DataHub handles financial records for multiple client companies. This document
describes the controls in place, why each exists, and what it does not cover.

Mapped against **OWASP Top 10 (2021)** and **OWASP ASVS v4.0 Level 2**.

---

## ⚠️ Act on these before deploying

### 1. Rotate the leaked Gmail app password — immediately

`backend/.env.example` contained a live Google app password
(`EMAIL_PASS=ferk kjri uatf oahr`, plus a second credential on line 16). That
file is tracked by git and the value is present in commit history.

The file is now sanitised, **but the credential is still in history and must be
treated as compromised**:

1. Revoke it at <https://myaccount.google.com/apppasswords>.
2. Move transactional mail to a dedicated sender (SendGrid / SES / Postmark).
   An app password grants access to the entire mailbox; a scoped API key does not.
3. Optionally purge it from history (`git filter-repo --path backend/.env.example`),
   then force-push and have every collaborator re-clone. Revocation matters more
   than the purge — assume anyone with repo access has already seen it.

### 2. Run the two migrations

```bash
psql "$DATABASE_URL" -f backend/sql/migrations/089_security_sessions_and_audit.sql
psql "$DATABASE_URL" -f backend/sql/migrations/090_enable_row_level_security.sql
```

Migration 089 creates the session, lockout and audit tables. **Authentication
will not work until it has run** — sessions are stored server-side now.

### 3. Set the new environment variables

`JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY` and `CORS_ALLOWED_ORIGINS` are new
and required. The server refuses to boot in production without them. See
`backend/.env.example`.

### 4. Existing users must reset their passwords

Any account whose stored `password_hash` is not a bcrypt hash can no longer log
in — this is deliberate (see §15). Those accounts previously authenticated by
plaintext string comparison. Direct affected users through
`POST /auth/forgot-password`.

### 5. Client accounts need a password reset

`CLIENT_STATIC_PASSWORD` is gone (see §6). Existing client/buyer accounts still
hold the old shared hash. Force a reset:

```sql
UPDATE users
   SET must_change_password = true,
       token_version = token_version + 1
 WHERE role IN ('buyer', 'client');
```

---

## Verification

```bash
cd backend && npm run test:security     # 165 assertions
bash scripts/security-invariants.sh     # 12 banned patterns
```

| Suite | Assertions | Covers |
|---|---|---|
| `test/security.unit.test.js` | 70 | password policy, tokens, crypto, uploads, RBAC, redaction, validation |
| `test/security.integration.test.js` | 24 | live middleware chain over HTTP — headers, auth, CORS, rate limits, error shape |
| `test/security.regression.test.js` | 71 | **one group per vulnerability found here** — each would have passed before its fix |
| `scripts/security-invariants.sh` | 12 | banned patterns that must never reappear |

All pass. CI runs all four plus CodeQL, gitleaks, and `npm audit`
(`.github/workflows/security.yml`).

The regression suite is the important one: it is named after the bugs, so
reintroducing any of them turns CI red with the original issue's name attached.
It has already earned its keep — it caught two defects in this work that the
other suites missed (see the note under V9 below).

---

## What was found and fixed

Ordered by severity. Everything below was live in the codebase before this work.
Each row has a matching group in `test/security.regression.test.js` (`V1`–`V15`),
so none of them can come back silently.

> **V9 footnote.** Writing that suite surfaced two further defects that the unit
> and integration tests had missed:
> - `DATABASE_SSL_REJECT_UNAUTHORIZED` defaulted to `IS_PRODUCTION`, so any
>   deploy where `NODE_ENV` was unset or misspelled silently accepted
>   unverified TLS to the database — with nothing in the logs looking wrong. It
>   now defaults to `true` unconditionally. Security defaults must never hang
>   off `NODE_ENV`.
> - The log redactor masked bare email addresses only when they sat under an
>   `email` key; one appearing inside an error message went out in the clear. It
>   is now masked wherever it appears.

| # | Issue | Impact | Fixed in |
|---|---|---|---|
| 1 | Live Gmail app password in a tracked file | Mailbox takeover, phishing from your domain | `backend/.env.example` (rotate manually) |
| 2 | `JWT_SECRET \|\| "change_me"` fallback | Total auth bypass if the env var is unset — forge any user's token | `config/env.js`, `security/tokens.js` |
| 3 | Plaintext password comparison | Any non-bcrypt row authenticated on a string match | `services/authService.js` |
| 4 | `CLIENT_STATIC_PASSWORD`, default `"123456"` | One guess authenticated **every** client account | removed; `config/demoUsers.js` |
| 5 | `quickBooksAuth` allowlist bypass | Routes not on a hardcoded list served with **no auth** — `PUT /api/customers/:id` was open | `middleware/quickbooksAuth.js` |
| 6 | CORS allowed any `*.vercel.app` with credentials | Anyone deploys to Vercel free → authenticated cross-origin requests as a logged-in victim | `app.js` |
| 7 | No RLS on any table | Anon key holder reads the entire database via PostgREST, bypassing the API | migration `090` |
| 8 | Tokens accepted from `?token=` and 3 custom headers | Credentials leak to access logs, history, `Referer` | `security/tokens.js` |
| 9 | `rejectUnauthorized: false` ×12 | DB connection open to active MITM | `db/pgPool.js` |
| 10 | Logout was a no-op `204` | Token stayed valid for its full 7 days | `services/sessionService.js` |
| 11 | 7-day JWT, no refresh, no revocation | Stolen token usable for a week | §2 |
| 12 | No rate limiting anywhere | Unlimited credential stuffing | `middleware/rateLimit.js` |
| 13 | No security headers | Clickjacking, MIME sniffing, no HSTS | `middleware/securityHeaders.js` |
| 14 | `console.error(err)` + raw message to client | Stack traces and DB internals disclosed | `middleware/error.js` |
| 15 | No upload validation | Arbitrary file upload including executables | `security/fileUpload.js` |
| 16 | Unauthenticated `POST /uploads/presign` | — | `routes/uploads.js` |
| 17 | Body parsed before auth on uploads (200 MB) | Unauthenticated memory-exhaustion DoS | `routes/uploads.js` |
| 18 | Orphaned uploads downloadable by any user | Cross-tenant document disclosure | `controllers/uploads.js` |
| 19 | `403` echoed the caller's role | Free privilege-mapping oracle | `middleware/auth.js` |
| 20 | `send-verification-otp` returned 409 for existing accounts | User enumeration | `controllers/auth.js` |
| 21 | Password reset auto-issued a session | Reset code alone produced a live login | `controllers/auth.js` |
| 22 | 8-char password minimum, bcrypt cost 10 | Weak against offline cracking | `security/passwordPolicy.js` |
| 23 | 12 dependency vulnerabilities (6 high) | Known CVEs | `npm audit fix`, xlsx aliased |

---

## The 22 controls

### 1. OAuth 2.0

**Why.** QuickBooks holds the financial data this product exists to analyse. Its
OAuth tokens are the highest-value secret in the system.

**Implementation.** `middleware/quickbooksAuth.js`, `routes/quickbooks/token.js`.
Access tokens are refreshed proactively before expiry (`tokenManager`). The
authorisation-code callback is the one endpoint that cannot require a bearer
token — Intuit calls it directly — so it is the sole entry in
`UNAUTHENTICATED_PATHS` and is protected by the signed `state` parameter instead.

Every **other** route on those routers is now authenticated by default.
`guardFinancialRouter` reads each router's own registered layers to decide
whether it owns a request, so a newly added route is covered automatically. The
previous hardcoded prefix list meant any unlisted route was public.

**Prevents.** Authorization-code injection, CSRF on the callback, token theft
through an unauthenticated disconnect endpoint.

---

### 2. JWT security

**Why.** A stateless JWT cannot be revoked. Once signed it is valid until it
expires, no matter what happens — that makes logout, single-device login and
session timeout impossible to enforce.

**Implementation.** `security/tokens.js`, `services/sessionService.js`.

| | Access token | Refresh token |
|---|---|---|
| Lifetime | 15 min | 7 days absolute |
| Transport | `Authorization: Bearer` | HttpOnly cookie, `SameSite=Strict`, `Path=/auth` |
| Storage | memory + localStorage | never readable by JS |
| Revocable | via `token_version` | immediately, row-level |
| Secret | `JWT_SECRET` | `JWT_REFRESH_SECRET` (**different**) |

Hardening on every `verify()`:

- `algorithms: ["HS256"]` pinned — defeats `alg: none` and RS256→HS256 confusion.
- `issuer` and `audience` checked.
- `typ` claim checked, and the two types use different keys — an access token
  can never be replayed as a refresh token.
- `clockTolerance` 5s, down from 30s. Generous skew extends an expired token's life.

**Rotation with theft detection.** Each refresh mints a new `jti` and atomically
overwrites the stored hash, conditional on the presented hash still being
current. A second use of an already-rotated token matches zero rows — that is a
replay, so the entire token family is revoked and a `critical` audit event is
written. Only the SHA-256 of the `jti` is stored, so a database leak yields
nothing usable.

**Frontend.** `src/lib/api.js` refreshes reactively on `401 TOKEN_EXPIRED` and
`AuthContext` refreshes proactively at 75% of token life. Concurrent refreshes
share one in-flight promise — without that, ten parallel requests would trigger
ten rotations and nine would be treated as replays, killing the session.

**Prevents.** Token replay, indefinite session lifetime, algorithm confusion,
XSS-based theft of the long-lived credential.

---

### 3. RBAC

**Why.** Broken access control is #1 in the OWASP Top 10 because it is usually an
*inconsistency* bug. `if (user.role === 'admin')` scattered across 149 route
files cannot be audited and drifts the moment a role is added.

**Implementation.** `middleware/rbac.js` — one capability matrix.

Four canonical tiers, each inheriting the one below:

| Tier | Maps from | Adds |
|---|---|---|
| **Viewer** | `buyer_team_member`, `buyer_accountant` | read company/document/report/request |
| **User** | `broker_team_member`, `client_team_member`, `buyer_primary`, … | upload, generate reports, create/update requests |
| **Manager** | `broker_primary`, `company_owner` | create/update users & companies, approve, delete, manage integrations |
| **Admin** | `role = 'admin'` | delete users/companies, audit log, revoke sessions, unlock accounts |

`role = 'admin'` always wins and is never downgraded by a `sub_role`. An
unrecognised role resolves to **Viewer** — least privilege on the failure path.

Authorization is two-dimensional. `requirePermission` answers *may this role do
this at all*; `requireCompanyAccess` answers *may this user do it to **this
company's** data*. Both are required — a Manager with `report:read` must still
not read another tenant's balance sheet. That second check is what stops IDOR,
which no amount of role checking prevents on its own.

`requirePermission` throws at **startup** on an unknown capability name, so a
typo is a boot failure rather than a silent allow.

**Frontend.** `src/components/auth/Can.jsx` hides unusable controls. That is
cosmetic — the file says so explicitly. Every capability is independently
enforced server-side.

---

### 4. Session timeout

**Why.** A finance app left open on an unattended laptop is a data breach.

**Implementation.** Two independent server-side clocks in `auth_sessions`:

- **Idle** — `last_seen_at`, default 30 min, slides on activity.
- **Absolute** — `absolute_expires_at`, default 12 h, never extended.

Checked on every authenticated request in `requireAuth`. `last_seen_at` writes
are throttled to once per minute per session to avoid write amplification.

The client mirrors both (`src/lib/session.js`) purely so the UI logs out
promptly. It adopts the server's values via `/auth/me` and takes the stricter of
the two, so it can never enforce a *longer* window than the server honours.
Proactive refresh deliberately does **not** fire for an idle session — otherwise
the refresh loop would keep a walked-away session alive forever.

Configurable: `SESSION_IDLE_TIMEOUT_SECONDS`, `SESSION_ABSOLUTE_TIMEOUT_SECONDS`.

---

### 5. Single-device login

**Why.** Concurrent sessions mask account compromise: the legitimate user notices
nothing while an attacker works alongside them.

**Implementation.** With `SINGLE_DEVICE_LOGIN=true`, `createSession` revokes all
other live sessions for the user **before** inserting the new one, so there is no
window where two are simultaneously valid.

The displaced device learns why: its next request returns
`401 SESSION_REVOKED`, and the UI shows *"You were signed out because your
account was signed in on another device."* That message is itself a compromise
signal for the user.

---

### 6. Password policy

**Why.** Length dominates resistance to offline cracking; a blocklist removes the
small set of passwords behind most successful credential stuffing.

**Implementation.** `security/passwordPolicy.js` — 12–72 characters (72 is
bcrypt's truncation point; longer input is rejected rather than silently
truncated), all four character classes, plus:

- **Blocklist**, checked against five normalised forms of the candidate. Padding
  and leet substitutions are stripped first, so `Password123!` and `P@ssw0rd123!`
  are both caught — hashcat's default rule sets generate exactly those.
- **Low-entropy runs** — `aaaa`, `12345`, `abcde` rejected.
- **Personal information** — must not contain the user's name or email local part.

`CLIENT_STATIC_PASSWORD` is deleted. It was a shared secret defaulting to
`"123456"` that authenticated every client account. New client accounts get an
independent 24-character random password that is never transmitted or logged, and
are flagged `must_change_password`; the holder gains access through the
email-verified reset flow. The old export is now a **throwing getter**, so any
missed call site fails loudly instead of quietly reintroducing a shared credential.

---

### 7. Row Level Security

**Read this section carefully — it is the one with a caveat.**

The API connects with the **service-role key**, which has `BYPASSRLS`. RLS
policies therefore do **not** constrain API traffic. Tenant isolation for the API
is enforced in the application layer by `requireCompanyAccess` and
`canAccessCompany`. That is where the real multi-tenant boundary lives.

**What migration 090 actually buys** — and it is the single highest-impact fix
in this work:

The `anon` key is shipped to browsers by design. With RLS disabled, **anyone who
opens devtools can query every table directly through PostgREST**, bypassing
Express and every authorization check in it. Full database disclosure. Migration
090 enables *and forces* RLS on every table with no permissive policies, revokes
all grants from `anon`/`authenticated`, and sets default privileges so future
tables are covered too. A table with RLS on and no policies denies everything.

Explicit `RESTRICTIVE ... USING (false)` policies are named on `users`,
`auth_sessions`, `security_events`, `account_lockouts` and `companies` so the
intent is visible in `\d+` rather than reading as an oversight.

Identity-based policies using `auth.uid()` are included **commented out**. They
cannot be enabled today: the app mints its own JWTs, so `auth.uid()` is NULL for
every request and such policies would deny all access. The file documents the
migration path.

For the `pg` connection path, `current_app_user_id()` and
`current_app_company_ids()` read transaction-local GUCs, giving database-level
tenant enforcement there too if you adopt it.

---

### 8. Rate limiting

`middleware/rateLimit.js` — four layers, because one is not enough:

| Layer | Window | Limit | Key |
|---|---|---|---|
| Burst | 5 s | 40 | user id, else IP |
| Sustained | 60 s | 600 | user id, else IP |
| Auth endpoints | 15 min | 10 | IP (successful requests skipped) |
| Email-sending | 1 h | 5 | IP |
| Uploads | 60 s | 20 | user id |

Authenticated traffic keys on **user id**, not IP — otherwise a whole office
behind one NAT shares a budget while an attacker with an address pool evades the
limit entirely.

Repeat offenders are temporarily blocked with exponential backoff capped at 24 h,
checked before body parsing so abuse costs almost nothing to reject. Returns
`429` with `Retry-After` and IETF `RateLimit-*` headers.

> **Scaling caveat.** The store is in-process. On more than one Render instance
> each holds its own counters, so effective limits multiply by instance count.
> Swap in `rate-limit-redis` before scaling out.

---

### 9. CORS

Strict allowlist from `CORS_ALLOWED_ORIGINS`, validated at startup: no
wildcards, `https://` only in production.

The previous policy allowed **any** `*.vercel.app` host with `credentials: true`.
Anyone can deploy to `vercel.app` for free — that was a complete
CSRF/data-exfiltration primitive against any logged-in user. Localhost origins
are added only outside production. Rejected origins are logged as security events.

---

### 10. Directory listing

The API serves JSON exclusively. `express.static` appears nowhere; without it
there is no code path that can list a directory. Vercel serves the frontend with
`cleanUrls` and an SPA rewrite, so no path resolves to a directory index.

---

### 11. HTTP security headers

`middleware/securityHeaders.js` via Helmet. The API serves no HTML, so its CSP
is locked to `default-src 'none'` — that removes reflected-XSS-via-content-sniffing
entirely. `frame-ancestors 'none'`, `nosniff`, `strict-origin-when-cross-origin`,
HSTS (2 years, `includeSubDomains`, `preload`), `Cross-Origin-Resource-Policy:
same-site`, a restrictive `Permissions-Policy`, and `Cache-Control: no-store,
private` on every response — a shared proxy caching one tenant's response and
serving it to another is a breach.

`X-Powered-By` is removed at three levels. Every response carries `X-Request-Id`
for tracing.

The frontend's own (necessarily looser) CSP lives in `vercel.json`. Note
`script-src 'self'` with **no** `unsafe-inline` or `unsafe-eval` — that is the
directive that actually blocks injected script. `style-src` retains
`'unsafe-inline'` because Tailwind and React inline styles require it.

---

### 12. HTTPS

`FORCE_HTTPS` redirects GET/HEAD with a 301 and **rejects** cleartext POST/PUT/
DELETE outright — a POST carrying credentials has already leaked them by the time
we see it, and redirecting would also silently drop the body. HSTS closes the
SSL-strip window after the first successful response.

The original scheme arrives in `X-Forwarded-Proto`, trustworthy only because
`trust proxy` is a **fixed hop count** (`TRUST_PROXY_HOPS=1`). With
`trust proxy: true` any client could spoof both the protocol and their IP,
defeating every per-IP limit and audit record. A malformed `Host` header is
rejected rather than reflected into a `Location` — that is an open-redirect
primitive.

---

### 13. SQL injection

Supabase (PostgREST) and `pg` both parameterise; no SQL string is built by
concatenation anywhere in the codebase. Classic injection is not reachable.

The residual risk is different: PostgREST filter operators are string-driven, so
an unvalidated `?order=` or a search term containing `,` `.` `(` `)` `*` `%` can
be turned into a filter expression against columns the endpoint never meant to
expose. `middleware/validate.js` addresses that with Zod schemas that **replace**
`req.body`/`query`/`params` with the parsed result — a handler physically cannot
read an undeclared field. `.strict()` rejects unexpected keys, closing mass
assignment (`{"role": "admin"}` in a signup body). `searchTerm` strips PostgREST
metacharacters; `sortField` binds sorting to a closed enum.

`sanitizeBody` strips `__proto__`, `constructor` and `prototype` from every
parsed body — one `Object.assign(target, req.body)` downstream would otherwise
poison the global prototype. Verified by test.

---

### 14. File uploads

`security/fileUpload.js` — layered, because each layer alone is bypassable:

1. **Extension** against an allowlist; 60+ dangerous extensions blocked including
   inner ones (`report.php.pdf`). SVG is blocked — it is XML and executes script.
2. **Null bytes** and **bidi override characters** rejected — both disguise the
   real extension.
3. **Executable signatures** (MZ, ELF, Mach-O, shebang, archives) rejected first,
   whatever the claimed type.
4. **Declared MIME** must agree with the extension.
5. **Magic bytes** must agree with both.
6. **Active content scan** — `vbaProject.bin` in an XLSX, `/JavaScript`,
   `/Launch`, `/EmbeddedFile` in a PDF, binary in a CSV. ZIP central-directory
   filenames are scanned as plaintext rather than decompressed, which also avoids
   zip-bomb exposure.
7. **Rename** to `<uuid><ext>`. The client name never reaches a path — that
   removes traversal, truncation, Windows reserved names and overwrite collisions
   in one step.
8. **Size** capped per type and globally (`UPLOAD_MAX_BYTES`, default 25 MB).

Uploads authenticate **before** body parsing. Previously `express.raw` ran first
with a 200 MB limit, so an unauthenticated client could force a 200 MB allocation
per request. Storage prefixes come from a closed set; the header value was
previously concatenated into the object path.

Downloads force `attachment` except for a small inline-safe allowlist, and send
`nosniff` plus a sandbox CSP. `sanitizeCsvCell` neutralises formula injection
(`=cmd|'/c calc'!A1` is RCE on whoever opens the export).

---

### 15. Password storage

bcrypt, cost **12** (configurable, floor of 12), via `security/passwordPolicy.js`.

The critical fix: `verifyPassword` accepts **only** bcrypt hashes. Anything else
— legacy plaintext, a corrupted row, a manual insert — fails closed. The previous
code ran `ok = rawPassword === storedPassword` when the stored value was not a
bcrypt hash, so those rows authenticated on a string match.

Timing is equalised. A request for a non-existent account performs an equivalent
bcrypt comparison against a fixed dummy hash, so latency does not reveal which
addresses are registered.

---

### 16. Environment variables

`config/env.js` validates at startup and **exits** on any failure. Secrets must
be ≥32 characters, are checked against a placeholder blocklist (`change_me`,
`secret`, …) and a character-diversity floor. `JWT_SECRET` and
`JWT_REFRESH_SECRET` must differ. CORS origins must be `https://` and
wildcard-free. Verified in both directions by test.

Development generates ephemeral secrets with a loud warning so a fresh clone
boots; production never does.

Nothing secret reaches the frontend: Vite inlines every `VITE_*` variable into
the public bundle, and CI greps `dist/` for secret-shaped material.

---

### 17. Logging

`security/logger.js`. Structured JSON in production, with:

- **Key-based redaction** — anything matching password/secret/token/jwt/auth/
  cookie/session/api-key/credential/connection-string/hash/otp/ssn/card…
- **Value-based redaction** — JWTs, connection strings, Bearer/Basic headers,
  vendor key prefixes (Stripe, GitHub, Slack, Google, OpenAI, Anthropic), bcrypt
  hashes, PEM blocks — caught anywhere in the payload regardless of key name.
- **PII minimisation** — emails masked to `a***@example.com`; IPs stored as a
  salted truncated hash so abuse stays correlatable without retaining the address.
- Cycle-safe, depth-capped, length-capped.

`morgan("dev")` was removed: it logged the full URL including any query string —
exactly where a legacy `?token=` would appear.

---

### 18. Account lockout

`services/accountLockoutService.js`. 5 failures in 15 minutes locks for 15
minutes (all configurable). Keyed by **email**, not user id, so attempts against
non-existent accounts still count — otherwise enumeration is possible by
observing which addresses can be hammered without ever locking. `citext` means
`Attacker@x.com` and `attacker@x.com` share one counter.

Per-account lockout alone enables a trivial DoS (lock everyone by guessing
wrong), so it is paired with per-IP limiting and uses a time-boxed lock. The
holder is notified once per lock, and only if the account exists — so the
endpoint is neither a mail bomb nor an enumeration oracle.

Fails **closed**: if the store errors we return 503 rather than let the attempt
through, so an attacker who can induce DB errors cannot also disable lockout.

---

### 19. Dependencies

Backend: **12 vulnerabilities (6 high) → 1 moderate.** `xlsx` had no npm fix and
is aliased to `@e965/xlsx@0.20.3`, the maintained build that patches the
prototype-pollution and ReDoS advisories — verified by a round-trip test.

Frontend: **20 (2 critical, 11 high) → 4.** The remainder are documented below.

CI fails on **critical**, reports **high**, and runs weekly — new advisories are
published against code that has not changed, so a build-triggered scan alone
misses them indefinitely. `npm ci --ignore-scripts` prevents install-time script
execution.

---

### 20. Production build

`vite.config.js`: no source maps, esbuild minification, `console`/`debugger`
dropped, legal comments stripped, `NODE_ENV=production` pinned so React's dev
build (which leaks component names and props to DevTools) cannot ship.
Content-hashed filenames. Dev server binds to loopback with `fs.strict`.

CI fails the build if any `.map` file or `sourceMappingURL` reference survives —
**verified: 0 of each in the current build**.

---

### 21. CI/CD

`.github/workflows/security.yml`, `permissions: contents: read` by default:

- `npm audit` on both workspaces
- **gitleaks** over full history, plus explicit checks that no `.env` is tracked
  and that no `.env.example` holds a real secret (including the exact Gmail
  app-password pattern that was committed here)
- **CodeQL** with `security-and-quality`
- **Invariant greps** — no fallback signing secrets, no `rejectUnauthorized:
  false` outside the reviewed pool factory, no wildcard CORS, no `trust proxy:
  true`, no plaintext password comparison
- Boots the server with a production environment, then asserts it **refuses** to
  boot with a weak secret
- Verifies the bundle contains no source maps and no secret-shaped strings

Runs on pull requests as well as push — a vulnerability caught after merge is
already on the default branch and, with continuous deploy, may already be live.

---

### 22. Encryption

**In transit.** TLS everywhere. `db/pgPool.js` replaced 12 instances of
`rejectUnauthorized: false`, which accepted *any* certificate and reduced TLS to
obfuscation. Verification is on by default in production; supply
`DATABASE_CA_CERT` for a private CA rather than disabling it. The escape hatch
still exists but logs a warning on every pool creation.

**At rest.** Supabase encrypts the volume, which only protects against physical
disk theft — not a leaked service-role key, a rogue backup, or an over-broad
support query. `security/crypto.js` provides AES-256-GCM field encryption for the
highest-value columns (OAuth refresh tokens, banking identifiers): random 96-bit
IV per operation, authenticated so tampering throws rather than producing
attacker-influenced plaintext, versioned envelope for key rotation, plus an HMAC
blind index for querying encrypted columns without decrypting the table.

Set `DATA_ENCRYPTION_KEY` to enable it. Refresh-token `jti`s are stored as
SHA-256 hashes; passwords as bcrypt.

---

## Known gaps

Stated plainly rather than left for you to discover.

1. **RLS does not constrain the API.** By design — see §7. The service-role key
   bypasses it. Application-layer checks are the tenant boundary. If you want
   database-enforced isolation for API traffic, migrate to Supabase Auth and
   enable the commented policies in migration 090.

2. **Rate limiting is per-instance.** See §8. Move to Redis before scaling out.

3. **4 frontend advisories remain.**
   - `vite` (dev dependency, 3 advisories): all require reaching the dev server.
     Mitigated by binding to `127.0.0.1` and `fs.strict`. A full fix needs Vite 6/7
     — a major upgrade, deliberately not bundled into a security change.
   - `react-router` RSC-mode CSRF: this app does not use RSC mode. The fix is
     v8.3.0, a major upgrade.

4. **Existing route handlers still use `requireAuth`/`requireRole`.** The
   capability matrix and `requireCompanyAccess` are wired into the new endpoints
   (`/auth`, `/security`, `/uploads`). Migrating the remaining ~140 route files
   to `requirePermission` is mechanical but touches a lot of surface — it should
   be done incrementally with the existing role checks left in place until each
   is converted. **Tenant isolation is unaffected**: `canAccessCompany` already
   guards company-scoped handlers.

5. **No antivirus scanning.** `validateUpload` rejects executables, active
   content and type mismatches, but does not detect malware inside a
   structurally-valid document. Add ClamAV or a scanning API if you accept
   uploads from outside your customer base.

6. **In-process user cache (30 s).** A role change takes up to 30 s to propagate.
   Bumping `token_version` evicts immediately; `changePassword` already does.

7. **`must_change_password` is set but not yet enforced at login.** The flag and
   the API response field exist; the frontend needs to route flagged users to a
   forced-change screen.

---

## Incident response

```sql
-- Force a user offline everywhere
UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'admin_revoked'
 WHERE user_id = $1 AND revoked_at IS NULL;
UPDATE users SET token_version = token_version + 1 WHERE id = $1;

-- Refresh-token theft (critical events)
SELECT * FROM security_events
 WHERE event_type = 'refresh_token_reuse_detected'
 ORDER BY created_at DESC;

-- Credential stuffing
SELECT email, count(*) FROM login_attempts
 WHERE successful = false AND attempted_at > now() - interval '1 hour'
 GROUP BY email HAVING count(*) > 10;
```

Or via API (admin only): `GET /security/events`,
`POST /security/users/:id/revoke-sessions`, `POST /security/accounts/unlock`.

---

## Reporting

Email security@sagehealthy.com. Please do not open a public issue.
