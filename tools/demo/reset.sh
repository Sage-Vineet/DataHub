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
  upload_sessions,
  -- Requests, and the three tables that hang off them. They used to be re-seeded
  -- without being cleared, and `seed-requests.sql` inserts ON CONFLICT DO
  -- NOTHING — so a visitor who approved a request or dragged a card left it that
  -- way through every later reset, and the next `up.sh` failed its "one awaiting
  -- approval" and "all four statuses present" checks with no way back short of
  -- `down -v`. CASCADE would take the children anyway; naming them keeps the
  -- RESTART IDENTITY explicit and the intent readable.
  requests,
  request_documents,
  request_narratives,
  request_reminders,
  -- The activity log is demo-owned too. Leaving it made the feed grow across
  -- resets, so the seeded state was never actually restored, and the assertion
  -- below could only ever hold on a database nobody had touched.
  activity_log
RESTART IDENTITY CASCADE;

-- Documents and their versions, but only the ones the seeds created: anything a
-- visitor uploaded during the demo goes with them, which is the point.
--
-- `file_references.document_id` is ON DELETE RESTRICT, so the references have to
-- go first or the delete below fails outright. The `90%` prefix is the breadth
-- seed's reserved company range (tools/demo/seed-extra.sql); without it those
-- documents survive while `DELETE FROM uploads` removes the bytes underneath
-- them, and the reset leaves the room full of documents that cannot be opened.
DELETE FROM file_references WHERE company_id IN (
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003'
) OR company_id::text LIKE '90%';

-- Everything that points at a document with ON DELETE RESTRICT has to be either
-- cleared first or stepped around. The QoE engagement's source file is the one
-- that matters: `balance_sheet_entries`, `general_ledger_entries` and their three
-- siblings all reference it, reset.sh does NOT re-run seed-qoe, and deleting it
-- would take the earnings bridge with it. So it is preserved rather than deleted
-- — which is also why this reset failed outright on any stack that had QoE
-- loaded, i.e. every stack up.sh has ever built.
DELETE FROM documents d WHERE (
  d.company_id IN (
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000003'
  ) OR d.company_id::text LIKE '90%'
)
  AND NOT EXISTS (SELECT 1 FROM balance_sheet_entries   x WHERE x.source_file_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM general_ledger_entries  x WHERE x.source_file_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM profit_loss_entries     x WHERE x.source_file_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM tax_return_entries      x WHERE x.source_file_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM bank_statement_entries  x WHERE x.source_file_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM key_report_file_mappings x WHERE x.document_id   = d.id);

-- Only the bytes nothing points at any more. `DELETE FROM uploads WHERE prefix =
-- 'documents'` was unconditional, which fails the moment a single document is
-- preserved above.
DELETE FROM uploads u WHERE u.prefix = 'documents'
  AND NOT EXISTS (SELECT 1 FROM documents                   x WHERE x.upload_id        = u.id)
  AND NOT EXISTS (SELECT 1 FROM document_versions           x WHERE x.upload_id        = u.id)
  AND NOT EXISTS (SELECT 1 FROM upload_sessions             x WHERE x.upload_id        = u.id)
  AND NOT EXISTS (SELECT 1 FROM cim_publications            x WHERE x.upload_id        = u.id)
  AND NOT EXISTS (SELECT 1 FROM key_report_file_mappings    x WHERE x.upload_id        = u.id)
  AND NOT EXISTS (SELECT 1 FROM manual_gl_staged_transactions x WHERE x.source_upload_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM manual_gl_balance_sheet_lines x WHERE x.source_upload_id = u.id);
COMMIT;
SQL

step "Re-seeding"
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-dataroom.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-qa.sql >/dev/null
# Requests are TRUNCATEd above first. `seed-requests.sql` inserts ON CONFLICT DO
# NOTHING, so re-running it over rows a visitor had modified changed nothing —
# the clear is what makes this a restore rather than a no-op.
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-requests.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-cim-questions.sql >/dev/null
psql_demo -v ON_ERROR_STOP=1 < tools/demo/seed-extra.sql >/dev/null
DATABASE_URL="$DB_URL" pnpm --filter @datahub/demo seed-cim 2>&1 | sed 's/^/   /'

step "Verifying"
# `check` is exact; `check_min` passes when the value is at or above a floor —
# for counts that are allowed to grow but must not silently collapse to zero.
check_min() {
  local label="$1" floor="$2" actual="$3"
  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual >= floor )); then
    printf '   ✓ %-40s %s\n' "$label" "$actual (>= $floor)"
  else
    printf '   ✗ %-40s %s (expected >= %s)\n' "$label" "$actual" "$floor"
    FAILED=1
  fi
}

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

# The Acme fixture. Scoped to the original three companies rather than counted
# globally: the breadth seed adds content on five more, and a global count would
# have to be edited every time that file grows.
ORIG="'a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000003'"
# Seven, not six: the six seed-dataroom documents plus the QoE general ledger,
# which is preserved above because the earnings bridge references it. The old
# expectation of six described a state this script could never actually reach,
# since the delete that would have produced it failed on that document's foreign
# keys every time.
check "documents across 3 companies" 7 "$(q "select count(*) from documents where company_id in ($ORIG) and name not like '%CIM v%'")"
check "large file present"       12582912 "$(q "select max(size_bytes) from uploads")"
check "versions on the model"    3 "$(q "select count(*) from document_versions v join documents d on d.id=v.document_id where d.name='Financial Model.txt'")"
check "comments"                 3 "$(q "select count(*) from document_comments where company_id in ($ORIG)")"
check "Q&A items"                5 "$(q "select count(*) from qa_items where company_id='a0000000-0000-4000-8000-000000000001'")"
check "published rewordings"     1 "$(q "select count(*) from qa_presentations where status='published'")"
check "CIM question library"     608 "$(q "select count(*) from cim_question_library")"
check "CIM versions"             2 "$(q "select count(*) from cim_versions")"
check "published CIM in the room" 1 "$(q "select count(*) from documents where name like '%CIM v1%'")"

# The breadth seed (tools/demo/seed-extra.sql). These are the screens that were
# empty on every company a visitor clicked into, so a reset that silently dropped
# them would put the demo back to the state this content exists to fix.
check "portfolio companies"      8 "$(q "select count(*) from companies")"
check "people who can sign in"   15 "$(q "select count(*) from users")"
check "companies with content"   8 "$(q "select count(distinct company_id) from documents")"
check "portfolio documents"      60 "$(q "select count(*) from documents where company_id::text like '90%'")"
check "portfolio requests"       45 "$(q "select count(*) from requests where company_id::text like '90%'")"
check "portfolio Q&A items"      30 "$(q "select count(*) from qa_items where company_id::text like '90%'")"
# A floor, not an exact count. This asserted 129 against a table the reset did
# not clear, so any visitor activity — or any probe against the running stack —
# made the next reset exit 1 while having restored perfectly well. The table is
# truncated now, so the count is the seed's own; asserting "the breadth seed
# loaded" is what this check is actually for.
check_min "activity feed entries" 120 "$(q "select count(*) from activity_log")"
check "reminders"                49 "$(q "select count(*) from reminders")"
check "messages"                 55 "$(q "select (select count(*) from company_messages)+(select count(*) from direct_messages)+(select count(*) from group_messages)")"
check "folder grants"            28 "$(q "select count(*) from folder_access")"
check "buyer group members"      12 "$(q "select count(*) from buyer_group_members")"

elapsed=$(( $(date +%s) - started ))
if [[ "$FAILED" == "1" ]]; then
  printf '\n\033[31mReset finished in %ss with failures above.\033[0m\n' "$elapsed"
  exit 1
fi
printf '\n\033[32mReset complete in %ss. Sign in as broker@demo.test / demo1234.\033[0m\n' "$elapsed"
