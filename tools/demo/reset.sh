#!/usr/bin/env bash
# Put the demo back to its seeded state, fast, without restarting anything.
#
# Unsupervised visitors generate mess: half-answered questions, a published deck
# with no draft, typed nonsense on a cover. Whoever is staffing the stand needs a
# way back that does not involve a terminal window and two minutes of Docker.
#
# So this is deliberately narrow. It truncates only the tables the seeds own,
# leaves the schema and the containers alone, and re-runs the same seed files
# `up.sh` uses — which is what keeps "reset" and "fresh" the same state rather
# than two states that drift.
#
#   ./tools/demo/reset.sh

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE="docker compose -f docker-compose.demo.yml"
PG_PORT="${DEMO_PG_PORT:-5435}"
DB_URL="postgres://datahub:datahub@127.0.0.1:${PG_PORT}/datahub"

psql_demo() {
  $COMPOSE exec -T postgres psql -U datahub -d datahub "$@"
}

step() { printf '\033[1m==> %s\033[0m\n' "$1"; }

started=$(date +%s)

step "Clearing demo-owned tables"
# RESTART IDENTITY CASCADE, and ordered so the cascade does the work: CIM decks
# take their versions, slides and blocks; documents take their versions and
# comments. Deliberately NOT touching companies, users or folders — those are the
# demo's fixed furniture, and rebuilding them would invalidate every bookmarked id.
psql_demo -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
BEGIN;
TRUNCATE
  cim_decks,
  cim_question_library,
  qa_items,
  qa_nominations,
  document_comments,
  upload_sessions
RESTART IDENTITY CASCADE;

-- Documents and their versions, but only the ones the seeds created: anything a
-- visitor uploaded during the demo goes with them, which is the point.
DELETE FROM documents WHERE company_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003'
);
DELETE FROM uploads WHERE prefix = 'documents';
COMMIT;
SQL

step "Re-seeding"
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-dataroom.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-qa.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-cim-questions.sql >/dev/null
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo seed-cim 2>&1 | sed 's/^/   /'

step "Verifying"
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '   ✓ %-40s %s\n' "$label" "$actual"
  else
    printf '   ✗ %-40s %s (expected %s)\n' "$label" "$actual" "$expected"
    FAILED=1
  fi
}
FAILED=0
q() { psql_demo -tAc "$1" | tr -d '[:space:]'; }

check "documents"                3 "$(q "select count(*) from documents where name not like '%CIM v1%'")"
check "versions on the model"    3 "$(q "select count(*) from document_versions v join documents d on d.id=v.document_id where d.name='Financial Model.txt'")"
check "comments"                 3 "$(q "select count(*) from document_comments")"
check "Q&A items"                5 "$(q "select count(*) from qa_items")"
check "published rewordings"     1 "$(q "select count(*) from qa_presentations where status='published'")"
check "CIM question library"     608 "$(q "select count(*) from cim_question_library")"
check "CIM versions"             2 "$(q "select count(*) from cim_versions")"
check "published CIM in the room" 1 "$(q "select count(*) from documents where name like '%CIM v1%'")"

elapsed=$(( $(date +%s) - started ))
if [[ "$FAILED" == "1" ]]; then
  printf '\n\033[31mReset finished in %ss with failures above.\033[0m\n' "$elapsed"
  exit 1
fi
printf '\n\033[32mReset complete in %ss. Sign in as broker@demo.test / demo1234.\033[0m\n' "$elapsed"
