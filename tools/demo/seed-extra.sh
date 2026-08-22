#!/usr/bin/env bash
# Load the breadth seed into a demo stack that is already running.
#
#   ./tools/demo/seed-extra.sh
#
# `up.sh` runs this as step 7 on a cold build and `reset.sh` re-runs it on every
# reset, so this script exists for the third case: a stack that is already up and
# should not be rebuilt — the demo is in twenty minutes and the room is empty.
#
# Safe to run repeatedly. seed-extra.sql derives every id from a stable natural
# key, so a second run updates the same rows rather than creating new ones; the
# check at the end proves that rather than asserting it.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE="docker compose -f docker-compose.demo.yml"
PG_PORT="${DEMO_PG_PORT:-5435}"
GATEWAY_PORT="${DEMO_GATEWAY_PORT:-8080}"
DB_URL="postgres://datahub:datahub@127.0.0.1:${PG_PORT}/datahub"
GW="http://127.0.0.1:${GATEWAY_PORT}"

psql_demo() { $COMPOSE exec -T postgres psql -U datahub -d datahub "$@"; }
q() { psql_demo -tAc "$1" | tr -d '[:space:]'; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if ! psql_demo -c 'select 1' >/dev/null 2>&1; then
  echo "The demo database is not reachable on port ${PG_PORT}." >&2
  echo "Start the stack first: ./tools/demo/up.sh" >&2
  exit 1
fi

step "Seeding the rest of the portfolio"
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-extra.sql >/dev/null
echo "   companies, people, folders, documents, requests, Q&A, activity,"
echo "   reminders, messages, folder grants and buyer groups."

step "Backfilling Better Auth identities"
# The people this seed creates need `auth_user` + `account` rows or they cannot
# sign in while BETTER_AUTH_ENABLED is true. Idempotent — existing identities are
# left alone, so this is safe to run against a stack mid-demo.
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo backfill 2>&1 | sed 's/^/   /'

step "Verifying"
check() {
  if [[ "$2" == "$3" ]]; then printf '   ✓ %-38s %s\n' "$1" "$3"
  else printf '   ✗ %-38s %s (expected %s)\n' "$1" "$3" "$2"; FAILED=1; fi
}
FAILED=0

check "companies"            8  "$(q "select count(*) from companies")"
check "people"               15 "$(q "select count(*) from users")"
check "everyone can sign in" 15 "$(q "select count(*) from account")"
check "folders"              52 "$(q "select count(*) from folders")"
check "portfolio documents"  60 "$(q "select count(*) from documents where company_id::text like '90%'")"
check "portfolio requests"   45 "$(q "select count(*) from requests where company_id::text like '90%'")"
check "portfolio Q&A"        30 "$(q "select count(*) from qa_items where company_id::text like '90%'")"
check "activity entries"     129 "$(q "select count(*) from activity_log")"
check "reminders"            49 "$(q "select count(*) from reminders")"
check "messages"             55 "$(q "select (select count(*) from company_messages)+(select count(*) from direct_messages)+(select count(*) from group_messages)")"
check "folder grants"        28 "$(q "select count(*) from folder_access")"
check "buyer group members"  12 "$(q "select count(*) from buyer_group_members")"

# The Acme fixture is what up.sh asserts. If this seed ever starts writing into
# it, the verification suite fails on the next cold run rather than here — so it
# is checked here, where the cause is obvious.
check "Acme requests untouched" 6 \
  "$(q "select count(*) from requests where company_id='a0000000-0000-4000-8000-000000000001'")"
check "Acme Q&A untouched"      5 \
  "$(q "select count(*) from qa_items where company_id='a0000000-0000-4000-8000-000000000001'")"

# Through the gateway, not the database: a row that does not survive tenant
# scoping is not content anyone can reach.
if curl -s -o /dev/null -m 5 "$GW/healthz" 2>/dev/null; then
  JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT
  curl -s -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"broker@demo.test","password":"demo1234"}' -c "$JAR" -o /dev/null
  jq_len() { python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "n/a"; }
  check "broker sees seven companies" 7 "$(curl -s "$GW/companies" -b "$JAR" | jq_len)"
  check "new account signs in" 200 \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/auth/login" \
       -H 'Content-Type: application/json' \
       -d '{"email":"broker2@demo.test","password":"demo1234"}')"
else
  echo "   (gateway not reachable on ${GATEWAY_PORT} — skipped the API checks)"
fi

if [[ "$FAILED" == "1" ]]; then
  printf '\n\033[31mSeed finished with failures above.\033[0m\n'
  exit 1
fi

cat <<EOF

$(printf '\033[32mPortfolio seeded.\033[0m')

  Eight companies, fifteen people. Password is demo1234 for all of them.

    admin@demo.test        every company
    broker@demo.test       Acme, Northwind + the five new mandates
    broker2@demo.test      Harbor Point, Bluewater, Copperfield
    buyer.tanaka@demo.test Harbor Point only — the tenant-scoping demo
    owner.lin@demo.test    seller side, Harbor Point

  Acme is deliberately unchanged: up.sh asserts its exact counts.
EOF
