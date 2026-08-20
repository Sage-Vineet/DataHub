#!/usr/bin/env bash
# Bring up the local full-stack demo: SPA → gateway → legacy → Postgres, seeded.
#
# Database bootstrap still takes several steps, because no single artefact in this
# repo can build a working database — but the Drizzle half of it is now one call:
#
#   1. backend/sql/schema.sql   the legacy world. Does NOT apply cleanly: it ends
#                               with 14 statements that index or constrain six
#                               tables it never creates — ebitda_adjustments and
#                               its four satellites, plus dataset_versions.
#                               Loaded WITHOUT ON_ERROR_STOP so those are skipped
#                               and reported instead of aborting the whole load.
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
# The greenfield capabilities have no legacy predecessor at their prefixes, so they
# default ON — there is nothing to fall back to and nothing they can shadow.
# LEGACY_MODE leaves them on for the same reason: turning them off would not show
# you the legacy behaviour, because there isn't any.
export QOE_MODULE_ENABLED="${QOE_MODULE_ENABLED:-true}"
export DATAROOM_MODULE_ENABLED="${DATAROOM_MODULE_ENABLED:-true}"
export DATAROOM_VERSIONS_ENABLED="${DATAROOM_VERSIONS_ENABLED:-true}"
export DATAROOM_COMMENTS_ENABLED="${DATAROOM_COMMENTS_ENABLED:-true}"
export DATAROOM_CHUNKED_UPLOAD_ENABLED="${DATAROOM_CHUNKED_UPLOAD_ENABLED:-true}"
export QA_MODULE_ENABLED="${QA_MODULE_ENABLED:-true}"
export QA_PRESENTATION_ENABLED="${QA_PRESENTATION_ENABLED:-true}"
export QA_NOMINATIONS_ENABLED="${QA_NOMINATIONS_ENABLED:-true}"
export CIM_MODULE_ENABLED="${CIM_MODULE_ENABLED:-true}"
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

step "1/6 Loading the legacy schema (tolerating the objects it never creates)"
# No ON_ERROR_STOP: psql reports each orphaned statement and carries on. Anything
# beyond the expected 14 is new and worth reading in the output.
#
# The count is asserted rather than described, because a comment saying "one known
# bad statement" is what this file used to carry — accurate when written, silently
# wrong once schema.sql moved underneath it.
schema_errors=$(psql_demo < backend/sql/schema.sql 2>&1 | grep -cE '^ERROR' || true)
if [[ "$schema_errors" == "14" ]]; then
  echo "   14 statements skipped, as expected: indexes and constraints on"
  echo "   ebitda_adjustments (+4 satellites) and dataset_versions, which"
  echo "   schema.sql references but never creates."
else
  echo "   ⚠ expected 14 skipped statements, got ${schema_errors}. The legacy"
  echo "     schema has changed — read the errors above before trusting this stack."
fi

step "2/6 Applying the legacy tables the Drizzle migrations build on"
# 049/050 create general_ledger_entries and its raw-row columns; both are
# idempotent. They must precede db:migrate because 0002_qoe_bridge ALTERs them.
psql_demo -v ON_ERROR_STOP=1 < backend/sql/migrations/049_key_reports_entry_tables.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < backend/sql/migrations/050_general_ledger_entries_new_columns.sql >/dev/null

step "3/6 Applying the Drizzle migrations"
DATABASE_URL="$DB_URL" pnpm --filter @datahub/db db:migrate

step "4/6 Seeding demo data and backfilling Better Auth identities"
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed.sql >/dev/null
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo backfill

step "5/6 Loading the QoE engagement"
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo seed-qoe

step "6/6 Seeding the data room, Q&A and CIM"
# Content, not just rows: documents with real bytes and version history, a Q&A
# thread with a superseded answer and a published rewording, and a CIM with one
# version already published into the data room. A stack that works perfectly and
# shows three empty folders is the failure mode this exists to prevent.
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-dataroom.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-qa.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-cim-questions.sql >/dev/null
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo seed-cim

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

# The kill switch, asserted rather than assumed. /healthz declares which
# greenfield capabilities are live; the SPA reads exactly this to decide what to
# render, so if it disagrees with the flags the demo shows a feature that is not
# there. Re-run with a flag false and this flips with it — that IS the T-48h
# rehearsal (docs/DEMO_FREEZE_CHECKLIST.md).
feat() { curl -s "$GW/healthz" | python3 -c "import json,sys;print(str(json.load(sys.stdin)['features'].get('$1')).lower())" 2>/dev/null || echo "n/a"; }
check "features.dataroom matches its flag" "${DATAROOM_MODULE_ENABLED}" "$(feat dataroom)"
check "features.qa matches its flag"       "${QA_MODULE_ENABLED}"       "$(feat qa)"
check "features.cim matches its flag"      "${CIM_MODULE_ENABLED}"      "$(feat cim)"

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

# ── the three new surfaces ──────────────────────────────────────────────────
#
# Each block is guarded by its own flag, so re-running with a feature switched
# off SKIPS its checks rather than failing them. That is what makes this script
# the T-48h rehearsal rather than something that has to be edited before one
# (docs/DEMO_FREEZE_CHECKLIST.md).

# Read a value out of a JSON response. The argument is a full Python expression
# with the parsed body bound to `d` — `d[0]["name"]`, or a comprehension over it.
# (An earlier version prepended `d`, which silently broke every expression that
# was not a bare subscript and reported "n/a" as though the endpoint had failed.)
jq_len() { python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "n/a"; }
jq_get() { python3 -c "import json,sys;print(eval(sys.argv[1],{},{'d':json.load(sys.stdin)}))" "$1" 2>/dev/null || echo "n/a"; }

if [[ "${DATAROOM_MODULE_ENABLED}" == "true" ]]; then
  DOC=$(curl -s "$GW/folders/c0000000-0000-4000-8000-000000000001/documents" -b "$JAR" \
    | python3 -c "import json,sys;print(next(d['id'] for d in json.load(sys.stdin) if d['name']=='Financial Model.txt'))" 2>/dev/null || echo "")
  check "data room: document found" "true" "$([[ -n "$DOC" ]] && echo true || echo false)"

  if [[ "${DATAROOM_VERSIONS_ENABLED}" == "true" && -n "$DOC" ]]; then
    VER=$(curl -s "$GW/dataroom/documents/$DOC/versions" -b "$JAR")
    check "data room: three versions" 3 "$(printf '%s' "$VER" | jq_get "d['version_count']")"
    V1=$(printf '%s' "$VER" | python3 -c "import json,sys;print(next(v['id'] for v in json.load(sys.stdin)['versions'] if v['version_no']==1))" 2>/dev/null || echo "")
    # The promise of versioning: v1's own bytes, not the current file's.
    check "data room: v1 content is v1" "Financial Model v1 — prepared 2026-06-01" \
      "$(curl -s "$GW/dataroom/versions/$V1/content" -b "$JAR")"
  fi

  if [[ "${DATAROOM_COMMENTS_ENABLED}" == "true" && -n "$DOC" ]]; then
    check "data room: broker sees both comments" 2 \
      "$(curl -s "$GW/dataroom/documents/$DOC/comments" -b "$JAR" | jq_len)"
  fi
fi

if [[ "${QA_MODULE_ENABLED}" == "true" ]]; then
  check "Q&A: five seeded questions" 5 \
    "$(curl -s "$GW/qa/companies/$ACME/items" -b "$JAR" | jq_len)"
  check "Q&A: categories provisioned" 7 \
    "$(curl -s "$GW/qa/companies/$ACME/categories" -b "$JAR" | jq_len)"
  QA_ITEM=$(curl -s "$GW/qa/companies/$ACME/items" -b "$JAR" \
    | python3 -c "import json,sys;print(next(i['id'] for i in json.load(sys.stdin) if i['reference']=='QA-001'))" 2>/dev/null || echo "")
  if [[ -n "$QA_ITEM" ]]; then
    DETAIL=$(curl -s "$GW/qa/items/$QA_ITEM" -b "$JAR")
    # A superseded answer keeps both versions readable — the whole point of the
    # supersede chain rather than an edit.
    check "Q&A: both answer versions readable" 2 \
      "$(printf '%s' "$DETAIL" | jq_get "len([r for r in d['responses'] if r['answer_root_id']])")"
    check "Q&A: exactly one current" 1 \
      "$(printf '%s' "$DETAIL" | jq_get "len([r for r in d['responses'] if r['answer_root_id'] and r['is_current']])")"
    if [[ "${QA_PRESENTATION_ENABLED}" == "true" ]]; then
      check "Q&A: rewording published beside it" 1 \
        "$(printf '%s' "$DETAIL" | jq_get "len([p for p in d['presentations'] if p['status']=='published'])")"
    fi
  fi
fi

if [[ "${CIM_MODULE_ENABLED}" == "true" ]]; then
  DECKS=$(curl -s "$GW/cim/companies/$ACME/decks" -b "$JAR")
  check "CIM: deck seeded" "Project Atlas CIM" "$(printf '%s' "$DECKS" | jq_get "d[0]['name']")"
  DECK_ID=$(printf '%s' "$DECKS" | jq_get "d[0]['id']")
  VERSION_ID=$(printf '%s' "$DECKS" | jq_get "d[0]['current_version_id']")
  check "CIM: draft is the current version" "draft" "$(printf '%s' "$DECKS" | jq_get "d[0]['current_status']")"
  check "CIM: gaps to fill" "true" \
    "$(curl -s "$GW/cim/versions/$VERSION_ID/gaps" -b "$JAR" | python3 -c "import json,sys;print(str(len(json.load(sys.stdin))>0).lower())" 2>/dev/null || echo n/a)"
  check "CIM: v1 published, v2 draft" 2 "$(curl -s "$GW/cim/decks/$DECK_ID/versions" -b "$JAR" | jq_len)"
  # Writing to a published version must be refused — the freeze, asserted.
  PUBLISHED=$(curl -s "$GW/cim/decks/$DECK_ID/versions" -b "$JAR" \
    | python3 -c "import json,sys;print(next(v['id'] for v in json.load(sys.stdin) if v['status']=='published'))" 2>/dev/null || echo "")
  check "CIM: published version refuses edits" 400 \
    "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$GW/cim/versions/$PUBLISHED/blocks" \
       -H 'Content-Type: application/json' -d '{"blocks":[{"block_key":"2:headline","content":"x"}]}' -b "$JAR")"
  check "CIM: cross-tenant denied" 403 \
    "$(curl -s -o /dev/null -w '%{http_code}' "$GW/cim/companies/$CARDINAL/decks" -b "$JAR")"
fi

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
