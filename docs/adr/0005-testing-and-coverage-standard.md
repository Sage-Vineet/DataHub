# ADR-0005 — 100% TypeScript + 90% coverage on new code

- **Status:** Accepted (2026-08-07)
- **Deciders:** CTO / platform
- **Implemented by:** commit `8a1fd22` (`packages/config`, CI); ratcheting

## Context

The codebase has **0 automated tests** across ~132k lines of financial-processing code, is **0% TypeScript**, the backend `lint` script is a no-op (`echo "No lint configured"`), and there are 31 swallowed catch blocks and 863 raw `console` calls. Every change is validated by manual clicking. This is the largest single risk to changing anything safely.

## Decision

- **All new/migrated code is TypeScript** under a strict `tsconfig.base.json` (`strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, …) exported from `packages/config`.
- **CI gates every PR** on typecheck + lint + test + coverage (Vitest, V8), enforced **per-package** with the legacy tree excluded from coverage.
- Coverage thresholds start at 80/70/80 and **ratchet toward the 90% program target** as modules land.

## Reasons

- **Compile-time safety** — TypeScript converts a whole class of runtime failures (the kind a 9,088-line untyped service quietly ships) into errors caught before merge.
- **A real safety net** — tests are the precondition for the refactors in [ADR-0003](0003-parallel-rewrite-behind-gateway.md)/[ADR-0004](0004-modular-monolith.md); you cannot safely decompose a god-file you can't test.
- **Per-package coverage, legacy excluded** — measuring the huge untyped legacy tree would either dilute the number to meaninglessness or block delivery on untestable code; excluding it keeps the 90% target honest and achievable.
- **Ratchet, not a cliff** — jumping straight to 90% globally would stall delivery; thresholds rise as coverage naturally accrues.

## Consequences

- New packages ship with tests from day one (the gateway already sits at 94% stmts / 100% funcs).
- **Deviations, tracked, not hidden:** the legacy SPA's lint is advisory until its TS-migration phase (235 pre-existing errors), and the dependency audit is non-blocking until `xlsx`/`pdf-parse` are replaced (audit H7). Both are recorded in the Phase 0 change's `tasks.md`.

## References

- `packages/config/{tsconfig.base.json,eslint.base.js,vitest.base.ts}`
- `.github/workflows/ci.yml`
- Audit: testing (F), CI/CD (F), type safety (F)
