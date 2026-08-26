# Contributing to DataHub

Keep this open while you work. It's the short version of how we build on the `ba/rearch` line. Deeper context: [`docs/REARCH_LOG.md`](docs/REARCH_LOG.md), [`docs/adr/`](docs/adr/), [`docs/MODERNIZATION_PLAN.md`](docs/MODERNIZATION_PLAN.md).

> All new work goes on `ba/rearch`. `main` is frozen — never commit to it.

## 1. Quick start

```bash
direnv allow            # or: nix develop   (Node 22 + pnpm 9.15.9 + local Postgres)
devenv up -d --no-tui   # start Postgres on 127.0.0.1:5433  (standalone devenv CLI)
load-schema             # load backend/sql/schema.sql into the dev DB
pnpm install
pnpm test               # run the whole gate locally
```

Without Nix: install pnpm (`corepack enable`), then `pnpm install`. You provide your own Postgres and set `DATABASE_URL`.

## 2. The quality gate (must be green before merge)

```bash
pnpm typecheck    # strict TS across new packages
pnpm lint         # ESLint (new packages strict; legacy web is advisory)
pnpm test         # vitest + coverage thresholds per package
pnpm build        # Turborepo build incl. the SPA
```

CI runs the same on every PR to `ba/rearch` (`.github/workflows/ci.yml`). **No new code without tests.**

## 3. Making a change (spec-first)

We plan with OpenSpec so the intent is written down before the code.

```bash
/opsx:propose  "<what you want to build>"   # creates proposal + spec + design + tasks
/opsx:apply    <change-name>                # implement against the tasks
/opsx:archive  <change-name>                # sync specs, move to archive/ when done
```

Write an **ADR** in `docs/adr/` for any significant decision (context, options, why). Add a line to `docs/REARCH_LOG.md` when your change lands.

## 4. Building a backend domain — the blueprint

Copy the **shape** of `apps/api/src/modules/auth/` — the ports/adapters layout below is the worked reference. (Auth itself is a special case: the identity engine is **Better Auth**, [ADR-0007](docs/adr/0007-auth-library-vs-bespoke.md) — you don't reimplement login/sessions per domain; see the auth note under "Two hard rules".) Every *business* domain looks the same:

```
apps/api/src/modules/<domain>/
  contract.ts            zod schemas (re-exported from packages/contracts)
  ports.ts               Repository interfaces (the "ports")
  service.ts             business logic — the ONLY cross-module entry point
  repository.drizzle.ts  runtime adapter over packages/db (Postgres)
  repository.memory.ts   in-memory adapter — used by tests, no DB needed
  router.ts              thin HTTP surface; validate every input via the contract
  middleware.ts          domain-specific guards (role checks); NOT auth itself
  *.test.ts              vitest + supertest
```

**Two hard rules:**
1. Modules talk to each other **only through typed `service` interfaces** — never reach into another module's repository or tables.
2. **Raw SQL lives only in repositories** (via `packages/db`).

**Auth is not re-implemented per domain.** The identity engine is **Better Auth** (ADR-0007): sessions are httpOnly cookies, revocable server-side. Protect routes with the **shared session guard** (`requireSession` in `apps/api/src/shared/`, which resolves the Better Auth session and populates `req.user: SessionUser`) and the **shared `canAccessCompany`** for tenant scoping — both engine-agnostic, so a domain router only adds *domain-specific* guards (e.g. "broker/admin only"). Do **not** copy the auth module's `requireAuth`/`AuthService` into a domain; that bespoke path is the retiring rollback target.

### Definition of Done (per domain)

- [ ] Contract published as zod in `packages/contracts`, types inferred.
- [ ] Repository implemented twice: `repository.drizzle.ts` (runtime) + `repository.memory.ts` (tests).
- [ ] Service holds the logic and is the only cross-module entry.
- [ ] Router is thin and validates every request against the contract (400 on failure).
- [ ] Tests (vitest + supertest) meet the coverage gate — service is tested against the in-memory repo, no DB.
- [ ] Mounted in the gateway **behind an env flag** (`<DOMAIN>_MODULE_ENABLED`), default off → falls through to legacy.
- [ ] Routes protected via the shared `requireSession` (Better Auth) + `canAccessCompany` — not a hand-rolled auth check.
- [ ] Behavior stays at parity (same responses, same session cookie) so cutover and rollback are zero-downtime.
- [ ] Soaked green, then the legacy handlers are deleted (separate, reversible commit).

## 5. How we test

The service depends on a repository **interface**, not the database — so tests run with the in-memory adapter, fast and deterministic:

```ts
const repo = new InMemoryCompaniesRepository();
repo.addCompany({ /* ... */ });
const svc = new CompaniesService({ repo });
await expect(svc.get(userWithoutAccess, otherCompanyId)).rejects.toBeInstanceOf(ForbiddenError);
```

Router-level tests use `supertest` against the Express app with the in-memory repo wired in. Auth-dependent domains that need a real session (cookie/DB-backed, Better Auth) test against **PGlite** — see `apps/api/src/modules/auth/better-test-harness.ts` for the pattern (embedded Postgres, no external DB). UI tests use `@testing-library/react` + jsdom (see `packages/ui`).

## 6. Frontend

- Consume shared UI from `@datahub/ui` (`import { Dialog, Button } from "@datahub/ui"`). Vite transpiles the `.tsx`; a `.jsx` page can import it today.
- Match the current look with the shared token preset (`@datahub/ui/tailwind-preset`) — style with tokens (`bg-primary`, `rounded-card`), not ad-hoc colors.
- Convert `.jsx → .tsx` opportunistically as you touch files. Decompose god-components as you go — don't rewrite whole pages in one PR.

## 7. Conventions

| Area | Convention |
|---|---|
| **Branches** | Short-lived feature branches off `ba/rearch` + PR. Not long per-dev-per-day branches. |
| **Commits** | Conventional Commits: `feat:` `fix:` `chore:` `refactor:` `docs:` `test:`. |
| **Decisions** | Significant choice → an ADR in `docs/adr/`. |
| **Config** | Extend `@datahub/config` (tsconfig/eslint/prettier); don't redefine. |
| **Errors** | Handle or log — no empty `catch {}`. Use `pino`, not `console.*`. |
| **Secrets** | Never commit `.env`/`.db`/keys. Fail closed on missing secrets. Scanned — see §7.1. |
| **Boundaries** | Cross-module only via services; SQL only in repositories. |

### 7.1 Secret scanning

`gitleaks` runs in two places, against `.gitleaks.toml`:

- **Pre-commit**, over the staged diff. Enabled automatically on entering the
  dev shell (`devenv.nix` sets `core.hooksPath=.githooks`); enable it by hand
  with `git config core.hooksPath .githooks`.
- **CI**, over the pushed range. This is the enforcement point and it is a hard
  gate — unlike the dependency audit, it is not `continue-on-error`.

The hook warns and continues when `gitleaks` is not on PATH, so a commit from an
IDE or from outside the dev shell is never blocked by a missing tool. Bypass one
commit with `git commit --no-verify`; CI still scans it.

**A false positive is a config change, not a reason to disable the hook.** Add a
narrow entry to the `[allowlist]` in `.gitleaks.toml`, or annotate the line with
`# gitleaks:allow`. The allowlist already covers the values that are public on
purpose — the demo and devenv signing secrets, the seeded bcrypt digest of
`demo1234`, and local connection strings.

**If it catches something real**, the value must be rotated even if you amend the
commit away: it existed on disk in a reachable git object. `.env.example` files
are tracked, so they hold placeholders only — that file is exactly how audit
finding C3's credential reached this repository.

## 8. Gotchas

- Inside `nix develop`, `devenv` is a reduced wrapper — use the **standalone** `devenv` CLI at the repo root for `up -d` / `--no-tui` / `processes down`.
- Don't set `PGPORT`/`PGHOST` in `devenv.nix` env — the Postgres module owns them (type conflict).
- Keep `drizzle-kit` and `drizzle-orm` versions in step (kit 0.30.6 needs orm ≥ 0.40).

## 9. Where things live

- `apps/web` — React SPA · `apps/api` — TS gateway + `modules/`
- `packages/config` · `packages/contracts` (zod) · `packages/db` (Drizzle) · `packages/ui`
- `backend/` — legacy Express, retired domain-by-domain
- `docs/` — REARCH_LOG, ADRs, MODERNIZATION_PLAN · `openspec/` — change specs
