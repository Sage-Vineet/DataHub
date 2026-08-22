#!/usr/bin/env bash
# Run the gateway and the SPA from source against the demo's Postgres + legacy.
#
#   ./tools/demo/dev-local.sh          # start
#   ./tools/demo/dev-local.sh stop     # stop, and hand the ports back to compose
#
# Why this exists: `docker compose build` needs network access to fetch pnpm via
# corepack, and in a sandboxed or offline environment that step fails — so a code
# change cannot reach the running demo at all. This runs the same two services
# from the working tree instead, with the same environment the compose file sets,
# so an edit is visible immediately (vite HMR) without rebuilding an image.
#
# Postgres and legacy stay in compose. Legacy's port is published so the gateway
# can reach it from the host; the compose file only `expose`s it, which is enough
# container-to-container but not from outside.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE="docker compose -f docker-compose.demo.yml"
PG_PORT="${DEMO_PG_PORT:-5435}"
GATEWAY_PORT="${DEMO_GATEWAY_PORT:-8080}"
WEB_PORT="${DEMO_WEB_PORT:-5173}"
RUN_DIR="${TMPDIR:-/tmp}/datahub-dev-local"
mkdir -p "$RUN_DIR"

port_pid() { ss -lptnH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1; }

stop() {
  for port in "$GATEWAY_PORT" "$WEB_PORT"; do
    pid="$(port_pid "$port" || true)"
    [[ -n "${pid:-}" ]] && { echo "stopping :$port (pid $pid)"; kill "$pid" || true; }
  done
  echo
  echo "Ports released. To go back to the containerised stack:"
  echo "  $COMPOSE up -d gateway web"
  echo "(that needs a working image; rebuild with '$COMPOSE build gateway web' if the"
  echo " source has changed since the image was made — which requires network access.)"
}

if [[ "${1:-}" == "stop" ]]; then stop; exit 0; fi

# Legacy must be reachable from the host, not just from the compose network.
if ! curl -sf -o /dev/null "http://localhost:4000/health"; then
  echo "Publishing legacy's port so the gateway can reach it from the host…"
  cat > "$RUN_DIR/legacy-port.yml" <<'YML'
services:
  legacy:
    ports:
      - "4000:4000"
YML
  $COMPOSE -f "$RUN_DIR/legacy-port.yml" up -d legacy >/dev/null
  until curl -sf -o /dev/null "http://localhost:4000/health"; do sleep 1; done
fi

# The gateway and legacy MUST agree on this or every un-migrated route 401s —
# legacy verifies the HS256 token the bridge mints. Read it from the container
# rather than assuming the default, because compose takes it from the host
# environment at create time and it may not be the default any more.
JWT_SECRET="$(docker exec datahub-demo-legacy-1 printenv JWT_SECRET)"

$COMPOSE stop gateway web >/dev/null 2>&1 || true

(
  cd apps/api
  NODE_ENV=development PORT="$GATEWAY_PORT" \
  LEGACY_ORIGIN="http://localhost:4000" \
  DATABASE_URL="postgres://datahub:datahub@localhost:${PG_PORT}/datahub" \
  JWT_SECRET="$JWT_SECRET" \
  BETTER_AUTH_URL="http://localhost:${GATEWAY_PORT}" \
  AUTH_TRUSTED_ORIGINS="http://localhost:${WEB_PORT}" \
  BETTER_AUTH_ENABLED=true COMPANIES_MODULE_ENABLED=true USERS_MODULE_ENABLED=true \
  FOLDERS_MODULE_ENABLED=true UPLOADS_MODULE_ENABLED=true REQUESTS_MODULE_ENABLED=true \
  MESSAGES_MODULE_ENABLED=true REPORTS_MODULE_ENABLED=true QOE_MODULE_ENABLED=true \
  DATAROOM_MODULE_ENABLED=true DATAROOM_VERSIONS_ENABLED=true DATAROOM_COMMENTS_ENABLED=true \
  DATAROOM_CHUNKED_UPLOAD_ENABLED=true QA_MODULE_ENABLED=true QA_PRESENTATION_ENABLED=true \
  QA_NOMINATIONS_ENABLED=true CIM_MODULE_ENABLED=true LEGACY_AUTH_BRIDGE_ENABLED=true \
  setsid nohup pnpm exec tsx --conditions=development src/server.ts \
    > "$RUN_DIR/api.log" 2>&1 < /dev/null &
)

(
  cd apps/web
  VITE_API_BASE_URL="http://localhost:${GATEWAY_PORT}" \
  setsid nohup pnpm exec vite --port "$WEB_PORT" --host 127.0.0.1 --strictPort \
    > "$RUN_DIR/web.log" 2>&1 < /dev/null &
)

until curl -sf -o /dev/null "http://localhost:${GATEWAY_PORT}/healthz"; do sleep 1; done
until curl -sf -o /dev/null "http://localhost:${WEB_PORT}/"; do sleep 1; done

cat <<EOF

Running from source.

  SPA        http://localhost:${WEB_PORT}      (vite — edits are live)
  Gateway    http://localhost:${GATEWAY_PORT}
  Postgres   localhost:${PG_PORT}   (compose)
  Legacy     localhost:4000         (compose, port published for the gateway)

  Logs       $RUN_DIR/api.log
             $RUN_DIR/web.log

  Stop       ./tools/demo/dev-local.sh stop

Sign in with the usual demo accounts — password demo1234 for all:
  admin@demo.test · broker@demo.test · client@demo.test
EOF
