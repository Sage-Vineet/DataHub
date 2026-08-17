#!/usr/bin/env bash
# Bring up the local full-stack demo: SPA → gateway → legacy → Postgres, seeded.
#
# Database bootstrap is four steps rather than one, because no single artefact in
# this repo can build a working database:
#
#   1. backend/sql/schema.sql   the legacy world. Does NOT apply cleanly — line 278
#                               indexes bank_transactions(client_id), a column the
#                               table never declares. Loaded WITHOUT ON_ERROR_STOP
#                               so that one known-bad statement is skipped and
#                               reported, instead of aborting the whole load.
#   2. 0001_module_schema.sql   the DDL the new modules need on top of legacy
#                               (folders.archived_at + its provisioning unique
#                               index, email_verifications, the message-group
#                               tables, the approval_status enum). Until this
#                               migration was written that DDL existed only as
#                               TypeScript in packages/db/src/schema.ts.
#   3. better-auth migration    identity tables (ADR-0007).
#   4. seed.sql + backfill      demo rows, then the users → auth_user/account
#                               backfill so login works with the flag either way.
#
# That sequence is itself the finding: standing up a database from this repo takes
# a bespoke script. Phase C replaces steps 1–2 with a production snapshot and a
# reconciled schema.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE="docker compose -f docker-compose.demo.yml"

# LEGACY_MODE=1 turns every module off, so the same stack runs entirely on the
# legacy backend. Useful for a side-by-side — but slow without real Supabase
# credentials, since legacy tries Supabase first on every read.
if [[ "${LEGACY_MODE:-0}" == "1" ]]; then
  export BETTER_AUTH_ENABLED=false COMPANIES_MODULE_ENABLED=false USERS_MODULE_ENABLED=false \
         FOLDERS_MODULE_ENABLED=false UPLOADS_MODULE_ENABLED=false REQUESTS_MODULE_ENABLED=false \
         MESSAGES_MODULE_ENABLED=false REPORTS_MODULE_ENABLED=false
fi
PG_PORT="${DEMO_PG_PORT:-5435}"
GATEWAY_PORT="${DEMO_GATEWAY_PORT:-8080}"
WEB_PORT="${DEMO_WEB_PORT:-5173}"
export JWT_SECRET="${JWT_SECRET:-demo-only-insecure-secret}"
DB_URL="postgres://datahub:datahub@127.0.0.1:${PG_PORT}/datahub"

psql_demo() {
  $COMPOSE exec -T postgres psql -U datahub -d datahub "$@"
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Building and starting containers"
$COMPOSE up -d --build

step "Waiting for Postgres"
for _ in $(seq 1 60); do
  if psql_demo -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_demo -c 'select 1' >/dev/null

step "1/4 Loading the legacy schema (tolerating its one known-bad statement)"
# No ON_ERROR_STOP: psql reports the bad index and carries on. Anything else that
# fails here is new and worth reading in the output.
if psql_demo < backend/sql/schema.sql 2>&1 | grep -E '^(ERROR|psql:)' ; then
  echo "   ^ expected: bank_transactions(client_id) does not exist (schema.sql:278)"
fi

step "2/4 Applying the module schema migration (0001_module_schema)"
psql_demo -v ON_ERROR_STOP=1 < packages/db/migrations/0001_module_schema.sql >/dev/null

step "3/4 Applying the Better Auth identity migration"
psql_demo -v ON_ERROR_STOP=1 < packages/db/migrations/0000_better_auth_identity.sql >/dev/null

step "4/4 Seeding demo data and backfilling Better Auth identities"
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed.sql >/dev/null
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo backfill

step "Verifying the stack"
GW="http://127.0.0.1:${GATEWAY_PORT}"
ACME=a0000000-0000-4000-8000-000000000001
CARDINAL=a0000000-0000-4000-8000-000000000003
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

check() { # label expected actual
  if [[ "$2" == "$3" ]]; then printf '   ✓ %-46s %s\n' "$1" "$3"
  else printf '   ✗ %-46s %s (expected %s)\n' "$1" "$3" "$2"; FAILED=1; fi
}
FAILED=0

check "gateway /healthz" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/healthz")"

curl -s -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"broker@demo.test","password":"demo1234"}' -c "$JAR" -o /dev/null
check "login as broker" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"broker@demo.test","password":"demo1234"}')"

check "authenticated GET /companies" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/companies" -b "$JAR")"
check "anonymous GET /companies is rejected" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/companies")"
check "cross-tenant company is denied" 403 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/companies/$CARDINAL" -b "$JAR")"
check "folder tree" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/companies/$ACME/folders/tree" -b "$JAR")"

# The archived folder must be hidden by default and visible with the flag the SPA
# actually sends. This is the parity defect the harness found, asserted live.
live=$(curl -s "$GW/companies/$ACME/folders" -b "$JAR" | grep -c '"Legal"' || true)
arch=$(curl -s "$GW/companies/$ACME/folders?includeArchived=true" -b "$JAR" | grep -c '"Legal"' || true)
check "archived folder hidden by default" 0 "$live"
check "archived folder shown with ?includeArchived" 1 "$arch"

# QuickBooks OAuth lives under /api/auth/* in legacy. It must keep reaching legacy
# even with the auth module mounted at /auth.
check "QuickBooks OAuth still reaches legacy" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$GW/api/auth/status")"

check "SPA is served" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/")"

if [[ "$FAILED" != "0" ]]; then
  echo
  echo "   Some checks failed — see above." >&2
  exit 1
fi

cat <<EOF

$(printf '\033[1mDemo is up.\033[0m')

  SPA        http://localhost:${WEB_PORT}
  Gateway    http://localhost:${GATEWAY_PORT}   (proxies to legacy)
  Postgres   localhost:${PG_PORT}   datahub/datahub

  Sign in with any of these — password is the same for all:

    admin@demo.test    / demo1234    sees every company
    broker@demo.test   / demo1234    sees Acme + Northwind
    client@demo.test   / demo1234    sees Acme only

  Cardinal Foods belongs to nobody: it is the control that proves cross-tenant
  denial rather than assuming it.

  Every domain is served by the TypeScript modules. To run the same stack
  entirely on legacy and compare:

    LEGACY_MODE=1 ./tools/demo/up.sh

  (slow without real Supabase credentials — legacy tries Supabase on every read)

  Or move a single domain back:

    FOLDERS_MODULE_ENABLED=false ./tools/demo/up.sh

  Tear down (and drop the data):

    docker compose -f docker-compose.demo.yml down -v
EOF
