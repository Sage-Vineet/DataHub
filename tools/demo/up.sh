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
# Some hosts — rootless podman-backed Docker among them — cannot reach the
# network from BuildKit's per-step netns, even though the host and ordinary
# containers can. The symptom is every `pnpm install` and `corepack prepare`
# dying on ETIMEDOUT against registry.npmjs.org while `curl` from the same
# machine is fine. Building with host networking is the escape hatch; it needs
# an entitlement that Compose cannot express, so the images are built directly
# and Compose is then told not to rebuild them.
#
# Opt in with DEMO_BUILD_HOST_NETWORK=1. Off by default: on a normal Docker host
# the plain path works and host networking would be an unnecessary privilege.
if [[ "${DEMO_BUILD_HOST_NETWORK:-0}" == "1" ]]; then
  BUILDER="${DEMO_BUILDX_BUILDER:-datahub-hostnet}"
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    echo "   creating buildx builder '$BUILDER' with host networking"
    docker buildx create --name "$BUILDER" --driver docker-container \
      --driver-opt network=host \
      --buildkitd-flags '--allow-insecure-entitlement network.host' >/dev/null
  fi
  # Service -> Dockerfile straight out of the compose file, so a service added
  # later is picked up rather than silently skipped by a hardcoded list.
  $COMPOSE config --format json \
    | python3 -c 'import json,sys
for name, svc in json.load(sys.stdin)["services"].items():
    build = svc.get("build")
    if build: print(name, build["dockerfile"])' \
    | while read -r svc dockerfile; do
        echo "   building $svc via $BUILDER (host network)"
        docker buildx build --builder "$BUILDER" --allow network.host --network host \
          -f "$dockerfile" -t "datahub-demo-${svc}:latest" --load .
      done
  $COMPOSE up -d --no-build
else
  $COMPOSE up -d --build
fi

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
check "features.qoe matches its flag"      "${QOE_MODULE_ENABLED}"      "$(feat qoe)"
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
#
# The subject is a dedicated empty folder. It used to be Legal, which holds the Q&A
# evidence document — so the one link the demo is built around pointed into a folder
# the normal view filters out.
live=$(curl -s "$GW/companies/$ACME/folders" -b "$JAR" | grep -c '"Superseded"' || true)
arch=$(curl -s "$GW/companies/$ACME/folders?includeArchived=true" -b "$JAR" | grep -c '"Superseded"' || true)
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

  # The evidence loop. The seeded answer carries a document, and that document is
  # in a folder the normal view can actually reach — Legal used to be archived, so
  # the one link the demo is built around pointed somewhere invisible.
  EVIDENCE_FOLDER=""
  QA3=$(curl -s "$GW/qa/companies/$ACME/items" -b "$JAR" \
    | python3 -c "import json,sys;print(next(i['id'] for i in json.load(sys.stdin) if i['reference']=='QA-003'))" 2>/dev/null || echo "")
  if [[ -n "$QA3" ]]; then
    DETAIL3=$(curl -s "$GW/qa/items/$QA3" -b "$JAR")
    check "Q&A: the answer carries its evidence" "Lease Agreement.txt" \
      "$(printf '%s' "$DETAIL3" | jq_get "[a['name'] for r in d['responses'] for a in r['attachments']][0]")"
    EVIDENCE_FOLDER=$(printf '%s' "$DETAIL3" | jq_get "[a['folder_id'] for r in d['responses'] for a in r['attachments']][0]")
    check "Q&A: the evidence sits in a folder you can navigate to" 1 \
      "$(curl -s "$GW/companies/$ACME/folders" -b "$JAR" | jq_get "len([f for f in d if f['id']=='$EVIDENCE_FOLDER'])")"
  fi

  # The seller's path, driven over HTTP exactly as the tablet drives it: answer,
  # upload through the chunked route, link. This is the check most likely to catch
  # a regression on demo morning.
  # Guarded on the ids as well as the flag: under `set -u` an unresolved one
  # would abort the whole bringup, and a check that cannot run should be skipped
  # and said so, never turned into a crash.
  #
  # `uuid` is not fussiness. jq_get's failure sentinel is the string "n/a", which
  # contains a SLASH, so pasting it into a path silently produces a different
  # route — /qa/items/n/a/responses falls through to legacy and comes back 401,
  # which reads as an auth regression rather than "the id was never resolved".
  uuid() { [[ "${1:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }

  # Prefer a question nobody has answered; on a re-run there may be none left,
  # because the previous run answered it. Falling back to any item keeps this
  # meaningful on every invocation instead of only against a virgin database —
  # and the T-48h rehearsal in docs/DEMO_FREEZE_CHECKLIST.md IS a re-run.
  # Answering twice supersedes rather than edits, which is exactly the behaviour
  # the Q&A module is built around, so the fallback exercises a real path.
  OPEN_ITEM=$(curl -s "$GW/qa/companies/$ACME/items?status=open" -b "$JAR" | jq_get "d[0]['id']")
  uuid "$OPEN_ITEM" || OPEN_ITEM=$(curl -s "$GW/qa/companies/$ACME/items" -b "$JAR" | jq_get "d[0]['id']")

  if [[ "${DATAROOM_CHUNKED_UPLOAD_ENABLED}" == "true" ]] && uuid "$EVIDENCE_FOLDER" && uuid "$OPEN_ITEM"; then
    NEW_RESP=$(curl -s -X POST "$GW/qa/items/$OPEN_ITEM/responses" -H 'Content-Type: application/json' \
      -b "$JAR" -d '{"body":"Attached, see the data room.","kind":"answer"}' | jq_get "d['id']")
    EV_BYTES="demo evidence"
    EV_SESSION=$(curl -s -X POST "$GW/dataroom/uploads/sessions" -H 'Content-Type: application/json' -b "$JAR" \
      -d "{\"folder_id\":\"$EVIDENCE_FOLDER\",\"file_name\":\"Evidence.txt\",\"content_type\":\"text/plain\",\"total_bytes\":${#EV_BYTES},\"chunk_size\":1048576}" \
      | jq_get "d['id']")
    printf '%s' "$EV_BYTES" | curl -s -X PUT "$GW/dataroom/uploads/sessions/$EV_SESSION/chunks/0" \
      -H 'Content-Type: application/octet-stream' -b "$JAR" --data-binary @- -o /dev/null
    EV_DOC=$(curl -s -X POST "$GW/dataroom/uploads/sessions/$EV_SESSION/complete" -b "$JAR" | jq_get "d['document_id']")
    check "seller path: upload produced a document" "True" "$(uuid "$EV_DOC" && echo True || echo False)"
    check "seller path: attach lands" 204 \
      "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/qa/items/$OPEN_ITEM/attachments" \
         -H 'Content-Type: application/json' -b "$JAR" \
         -d "{\"document_id\":\"$EV_DOC\",\"folder_id\":\"$EVIDENCE_FOLDER\",\"response_id\":\"$NEW_RESP\"}")"
    check "seller path: the broker sees the file on the answer" "True" \
      "$(curl -s "$GW/qa/items/$OPEN_ITEM" -b "$JAR" \
         | jq_get "'Evidence.txt' in [a['name'] for r in d['responses'] for a in r['attachments']]")"
  elif [[ "${DATAROOM_CHUNKED_UPLOAD_ENABLED}" == "true" ]]; then
    printf '   - %-46s %s\n' "seller path" "skipped: no evidence folder or Q&A item"
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

# Flag-guarded like every other capability above. Without this, the T-48h
# rehearsal — re-running with a flag false, which is what the freeze checklist
# tells someone to do — turns 23 correctly-disabled checks into red lines and a
# non-zero exit. At T-48h, under pressure, that reads as "the demo is broken"
# rather than "the feature is off", which is the opposite of what a kill-switch
# drill is for.
if [[ "${QOE_MODULE_ENABLED}" == "true" ]]; then
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

  # The add-backs are the exhibit the bridge is named after. Without them Adjusted
  # EBITDA equals Reported EBITDA — the same number twice in the header, and the
  # whole middle of the bridge empty. Each figure below is sourced from the seeded
  # ledger, so these assertions also prove the four sourcing kinds still resolve:
  # vendor-scoped GL, whole-account GL, a recast against a normalized value, and a
  # manual amount keyed by year.
  jqi() { printf '%s' "$BRIDGE" | jq_get "$1"; }
  check "QoE add-back groups"          "2" "$(jqi "len(d['addbackGroups'])")"
  check "QoE add-backs in the bridge"  "6" "$(jqi "sum(len(g['items']) for g in d['addbackGroups'])")"
  check "QoE FY2024 vendor-scoped vehicles" "6016.37" \
    "$(jqn "[i for g in d['addbackGroups'] for i in g['items'] if 'vehicle' in i['label']][0]['amounts']['2024']")"
  check "QoE FY2024 related-party rent recast" "24741.20" \
    "$(jqn "[i for g in d['addbackGroups'] for i in g['items'] if 'rent' in i['label']][0]['amounts']['2024']")"
  # A negative add-back: non-recurring income comes OUT of the bridge. It lands in
  # 2022 only, which is also the check that per-year values are not smeared.
  check "QoE FY2022 non-recurring gain removed" "-38400.00" \
    "$(jqn "[i for g in d['addbackGroups'] for i in g['items'] if 'Gain on sale' in i['label']][0]['amounts']['2022']")"
  # Owner compensation is lifted out of the groups onto its own line, net of ONE
  # market-rate replacement salary. That netting is the sole structural difference
  # between Adjusted EBITDA and SDE, so if the replacement salary goes missing this
  # is the check that says so.
  check "QoE FY2024 owner comp net of replacement" "85000.00" \
    "$(jqn "d['ownerCompensation']['amounts']['2024']")"
  check "QoE FY2024 Adjusted EBITDA" "483824.78" "$(jqn "d['adjusted']['2024']")"
  # The headline the exhibit exists to make: the two numbers differ.
  check "QoE Adjusted exceeds Reported" "True" \
    "$(jqi "d['adjusted']['2024'] > d['reportedEbitda']['2024']")"

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
fi

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
