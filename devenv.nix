{ pkgs, ... }:

let
  # Local Postgres port. 5432 is commonly taken (it is on the maintainer's box),
  # so default to 5433. Override in a git-ignored devenv.local.nix if needed.
  pgPort = 5433;
  database = "datahub_dev";
  databaseUrl = "postgres://127.0.0.1:${toString pgPort}/${database}?sslmode=disable";
in
{
  # Node 22 + pnpm pinned via corepack (resolves the repo's packageManager: pnpm@9.15.9).
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
  };

  packages = [
    pkgs.git
    pkgs.openssl
    pkgs.jq
    pkgs.postgresql_16 # provides psql on PATH
  ];

  # Local Postgres so packages/db introspection and the auth module work with no external infra.
  services.postgres = {
    enable = true;
    package = pkgs.postgresql_16;
    listen_addresses = "127.0.0.1";
    port = pgPort;
    initialDatabases = [ { name = database; } ];
  };

  env = {
    DATABASE_URL = databaseUrl;
    # Dev-only signing secret — NOT for any deployed environment.
    JWT_SECRET = "dev-only-insecure-secret-do-not-use-in-prod";
    # The gateway forwards here by default; the SPA in turn talks to the gateway,
    # so local dev exercises the same cutover seam a deployment does (ADR-0003).
    LEGACY_ORIGIN = "http://127.0.0.1:4000";
    VITE_API_BASE_URL = "http://localhost:8080";
    # NOTE: PGHOST/PGPORT/PGDATABASE are set by devenv's postgres module — do not
    # redefine them here (option-type conflict). AUTH_MODULE_ENABLED is left unset;
    # opt in per session:  AUTH_MODULE_ENABLED=true pnpm dev:api
  };

  # Thin wrappers over the existing pnpm/turbo commands (no second source of truth).
  # NOTE on starting Postgres:
  #   - In a terminal (inside this shell):        devenv up          (foreground, TUI)
  #   - Detached / headless / CI (repo root, standalone devenv CLI):
  #                                               devenv up -d --no-tui   /   devenv processes down
  # The `devenv` available inside `nix develop` is a reduced flake wrapper (up is
  # foreground-only), so detached control uses the standalone CLI at the repo root.
  scripts.db-up.exec = "devenv up";
  # Bootstrap a dev database, in the order the pieces actually depend on.
  #
  # This used to be a single `psql -f backend/sql/schema.sql`, which cannot do the
  # job its name claims: that file ends with 14 statements indexing tables it
  # never creates, and it carries none of the DDL the modernized modules need.
  #
  # The Drizzle half is now one command with a recorded history and a checksum
  # guard (packages/db/scripts/migrate.mjs). The legacy half is still a tolerant
  # load of a drifted file, because no authoritative source for it exists yet —
  # that remains Phase C's problem rather than this script's.
  scripts.load-schema.exec = ''
    set -uo pipefail
    echo "==> legacy schema (tolerating the objects it never creates)"
    skipped=$(psql "$DATABASE_URL" -f backend/sql/schema.sql 2>&1 | grep -cE '^ERROR' || true)
    echo "    $skipped statements skipped"
    set -e
    echo "==> legacy tables the Drizzle migrations build on"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/migrations/049_key_reports_entry_tables.sql >/dev/null
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/sql/migrations/050_general_ledger_entries_new_columns.sql >/dev/null
    echo "==> Drizzle migrations"
    pnpm --filter @datahub/db db:migrate
  '';
  scripts.db-status.exec = "pnpm --filter @datahub/db db:migrate --status";
  scripts.introspect.exec = "pnpm --filter @datahub/db db:pull";
  scripts.stack.exec = "pnpm dev:stack";

  enterShell = ''
    echo "DataHub dev shell — node $(node -v), pnpm $(pnpm -v 2>/dev/null || echo 'run: corepack pnpm -v')"
    echo "DATABASE_URL=$DATABASE_URL"
    echo "scripts: db-up (start Postgres) · load-schema · db-status · introspect · stack"
  '';
}
