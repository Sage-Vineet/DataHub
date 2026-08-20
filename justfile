# Recipes for this repo. `just test` is what the thegn merge-queue gate runs
# (merge_queue.gate_command), matching the convention in the other repos.
#
# The gate uses a frozen install on purpose: lockfile drift then fails at the
# fold instead of in CI, Docker, or a fresh clone. That skew is exactly what
# blocked the ba/product-surface-specs fold on 2026-08-18.

# Merge-queue gate: frozen install + full test suite
test:
    pnpm install --frozen-lockfile
    pnpm test

# Type-check every workspace
typecheck:
    pnpm typecheck

# Lint every workspace
lint:
    pnpm lint

# Build every workspace
build:
    pnpm build

# Check spec structure, orphan requirements, and unarchived completed changes
spec-validate:
    node tools/openspec/validate.mjs

# Apply outstanding schema migrations. Needs DATABASE_URL.
db-migrate:
    pnpm --filter @datahub/db db:migrate

# Report what is applied, pending, or drifted without changing anything.
db-status:
    pnpm --filter @datahub/db db:migrate --status
