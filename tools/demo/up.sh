#!/usr/bin/env bash
# Bring up the local full-stack demo: SPA → gateway → legacy → Postgres, seeded.
#
# Database bootstrap still takes several steps, because no single artefact in this
# repo can build a working database — but the Drizzle half of it is now one call:
#
#   1. backend/sql/schema.sql   the legacy world. Does NOT apply cleanly — line 278
#                               indexes bank_transactions(client_id), a column the
#                               table never declares. Loaded WITHOUT ON_ERROR_STOP
#                               so that one known-bad statement is skipped and
#                               reported, instead of aborting the whole load.
#   2. legacy 049/050           key-report entry tables and the general-ledger
#                               columns that 0002_qoe_bridge ALTERs. They must land
#                               before the migration runner, which is the only
#                               ordering constraint in the whole sequence.
#   3. db:migrate               every packages/db migration, in order, once, in a
#                               transaction, recorded in schema_migrations. Until
#                               this existed the three files below were applied by
#                               hand here and a dev checkout had no bootstrap at
#                               all (openspec/changes/devenv-schema-bootstrap).
#   4. seed.sql + backfill      demo rows, then the users → auth_user/account
#                               backfill so login works with the flag either way.
#   5. QoE engagement           the anonymized walkthrough engagement loaded into
#                               chart_of_accounts + general_ledger_entries.
#
# Step 1 is still the finding: the legacy schema cannot describe itself. Phase C
# replaces it with a production snapshot and a reconciled schema.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE="docker compose -f docker-compose.demo.yml"

# LEGACY_MODE=1 turns every module off, so the same stack runs entirely on the
# legacy backend. Useful for a side-by-side — but slow without real Supabase
# credentials, since legacy tries Supabase first on every read.
if [[ "${LEGACY_MODE:-0}" == "1" ]]; then
  export BETTER_AUTH_ENABLED=false COMPANIES_MODULE_ENABLED=false USERS_MODULE_ENABLED=false \
         FOLDERS_MODULE_ENABLED=false UPLOADS_MODULE_ENABLED=false REQUESTS_MODULE_ENABLED=false \
         MESSAGES_MODULE_ENABLED=false REPORTS_MODULE_ENABLED=false QOE_MODULE_ENABLED=false
fi
# The QoE bridge has no legacy predecessor at /qoe, so it defaults ON — there is
# nothing to fall back to and nothing it can shadow.
export QOE_MODULE_ENABLED="${QOE_MODULE_ENABLED:-true}"
QOE_VERSION_ID="${QOE_DEMO_VERSION_ID:-d0000000-0000-4000-8000-000000000001}"
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

step "1/5 Loading the legacy schema (tolerating its one known-bad statement)"
# No ON_ERROR_STOP: psql reports the bad index and carries on. Anything else that
# fails here is new and worth reading in the output.
if psql_demo < backend/sql/schema.sql 2>&1 | grep -E '^(ERROR|psql:)' ; then
  echo "   ^ expected: bank_transactions(client_id) does not exist (schema.sql:278)"
fi

step "2/5 Applying the legacy tables the Drizzle migrations build on"
# 049/050 create general_ledger_entries and its raw-row columns; both are
# idempotent. They must precede db:migrate because 0002_qoe_bridge ALTERs them.
psql_demo -v ON_ERROR_STOP=1 < backend/sql/migrations/049_key_reports_entry_tables.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < backend/sql/migrations/050_general_ledger_entries_new_columns.sql >/dev/null

step "3/5 Applying the Drizzle migrations"
DATABASE_URL="$DB_URL" pnpm --filter @datahub/db db:migrate

step "4/5 Seeding demo data and backfilling Better Auth identities"
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed.sql >/dev/null
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo backfill

step "5/5 Loading the QoE engagement"
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo seed-qoe

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

# The QoE bridge, asserted against the engagement workbook over live HTTP. These
# are the same figures packages/financial-engine's golden suite asserts, so a
# mismatch here means the pipeline disagrees with the arithmetic.
# The chart of accounts is seeded UNCLASSIFIED, exactly as a fresh ingest leaves
# it. Classifying is the step that has to work on a customer's account names —
# in particular it must not mistake this company's four operating-tax accounts
# for income tax, which is what the previous implementation did.
CLASSIFY=$(curl -s -X POST "$GW/qoe/versions/${QOE_VERSION_ID}/classify" -b "$JAR")
jqc() { printf '%s' "$CLASSIFY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1],{},{'d':d}))" "$1" 2>/dev/null || echo "n/a"; }
check "QoE classified account count" "3" "$(jqc "d['applied_count']")"
check "QoE income tax accounts found" "0" "$(jqc "len([c for c in d['applied'] if c['role']=='income_tax'])")"
check "QoE operating taxes excluded" "4" "$(jqc "len([c for c in d['unclassified'] if c['rule']=='exclude.operating-tax'])")"

BRIDGE=$(curl -s "$GW/qoe/bridge?version_id=${QOE_VERSION_ID}" -b "$JAR")
jqn() { printf '%s' "$BRIDGE" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"{eval(sys.argv[1],{},{'d':d}):.2f}\")" "$1" 2>/dev/null || echo "n/a"; }
check "QoE FY2024 net income"      "47568.23"  "$(jqn "d['netIncome']['amounts']['2024']")"
check "QoE FY2024 revenue"         "2511740.83" "$(jqn "d['revenue']['2024']")"
check "QoE FY2024 Reported EBITDA" "347403.35" "$(jqn "d['reportedEbitda']['2024']")"

# The balance sheet is rolled from the ingested statements: it must balance in
# every one of the 48 monthly periods, and tie to the closing statement it was
# not rolled from. The extracted sheet was out by exactly the unclassified
# retained-earnings account, every year.
BS=$(curl -s "$GW/qoe/balance-sheet?version_id=${QOE_VERSION_ID}" -b "$JAR")
jqb() { printf '%s' "$BS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1],{},{'d':d}))" "$1" 2>/dev/null || echo "n/a"; }
check "QoE balance sheet balances"        "True" "$(jqb "d['balances']")"
check "QoE periods out of balance"        "0"    "$(jqb "len([c for c in d['checks'] if not c['balances']])")"
check "QoE ties to the closing statement" "True" "$(jqb "d['tieOut']['ties']")"
check "QoE Dec-2025 retained earnings"    "112021.03" "$(jqb "round(d['retainedEarnings']['2025-12'],2)")"
# UAT #7: the sheet must be organised into bank accounts, fixed assets, credit
# cards and so on — not one flat list.
check "QoE balance sheet lines grouped"   "0"    "$(jqb "len([l for l in d['lines'] if not l['group']])")"
check "QoE asset sub-headings"            "True" "$(jqb "len({l['group'] for l in d['lines'] if l['section']=='asset'}) >= 3")"

# Openings are real: balance-sheet accounts carry the prior closing, P&L
# accounts genuinely open at zero. Both were zero before.
TB=$(curl -s "$GW/qoe/trial-balance?version_id=${QOE_VERSION_ID}" -b "$JAR")
jqt() { printf '%s' "$TB" | python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1],{},{'d':d}))" "$1" 2>/dev/null || echo "n/a"; }
check "QoE trial balance balances"     "True" "$(jqt "d['balances']")"
check "QoE P&L accounts open at zero"  "0"    "$(jqt "len([r for e in d['entries'] for r in e['rows'] if r['statementType']=='profit_loss' and r['openingBalance']!=0])")"
check "QoE BS accounts have openings"  "True" "$(jqt "any(r['openingBalance']!=0 for e in d['entries'] for r in e['rows'] if r['statementType']=='balance_sheet')")"

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
