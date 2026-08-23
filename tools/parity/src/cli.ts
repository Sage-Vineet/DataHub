/* eslint-disable no-console -- this is a CLI: the report on stdout is its output,
   not incidental logging. Diagnostics still go to stderr via console.error. */
import { ConfigError, loadConfig } from "./config.js";
import { coverageFor, formatCoverage } from "./coverage.js";
import { assertSafeTarget, ParityRefusal } from "./guards.js";
import { databaseMarkerReader } from "./marker.js";
import { formatJson, formatText } from "./report.js";
import { verdictFor } from "./verdict.js";
import { runSuite, selectScenarios } from "./runner.js";
import { DOMAINS, DOMAIN_FLAG, type Domain } from "./scenario.js";
import { buildScenarios } from "./scenarios/index.js";

/**
 * Parity CLI.
 *
 * Exit codes are the contract, because this is meant to gate a cutover:
 *   0  parity clean
 *   1  differences or scenario errors — do not flip
 *   2  the run could not be performed (bad config/args)
 *   3  refused to run — production target, or no staging marker
 *
 * Code 3 is deliberately distinct from 2. A refusal is not a broken invocation:
 * it means the harness was pointed somewhere it must not go, and CI should be
 * able to tell "you configured this wrong" from "you nearly ran writes against
 * production". These guards existed in `guards.ts` for some time without ever
 * being called — the module had no importer — so a run against production would
 * simply have proceeded.
 */

interface Args {
  config: string;
  domains: Domain[];
  json: boolean;
  allowMutating: boolean;
}

const USAGE = `
parity — replay requests against legacy and the new module, and diff the responses

  pnpm --filter @datahub/parity parity -- --config <path> [--domain <name>]...

Options
  --config <path>     Parity config JSON (see parity.config.example.json).
  --domain <name>     Restrict to a domain; repeatable. Default: all.
                      One of: ${DOMAINS.join(", ")}
  --allow-mutating    Also run scenarios that write. These hit BOTH upstreams,
                      so they write twice to the shared database. Staging only,
                      and REQUIRES PARITY_DATABASE_URL so the staging marker can
                      be checked before anything is written.
  --json              Emit machine-readable JSON instead of the text report.
  -h, --help          Show this help.

Environment
  PARITY_PRODUCTION_HOSTS   Comma-separated hosts that must never be a target.
                            REQUIRED — with nothing to check against, the run is
                            refused rather than assumed safe.
  PARITY_DATABASE_URL       Target database, read to confirm the staging marker.
                            Required for --allow-mutating.

The two upstreams are the SAME gateway with the domain's flag off (control) and
on (candidate) — e.g. ${DOMAIN_FLAG.companies}. Pointing both at the same URL
compares an environment against itself and will always pass; that is a
misconfiguration, and it is rejected.
`.trim();

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { config: "", domains: [], json: false, allowMutating: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--config") {
      args.config = argv[++i] ?? "";
    } else if (arg === "--domain") {
      const value = argv[++i] ?? "";
      if (!DOMAINS.includes(value as Domain)) {
        throw new ConfigError(`Unknown domain "${value}". Expected one of: ${DOMAINS.join(", ")}`);
      }
      args.domains.push(value as Domain);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--allow-mutating") {
      args.allowMutating = true;
    } else {
      throw new ConfigError(`Unrecognised argument "${arg}".\n\n${USAGE}`);
    }
  }
  if (args.config === "") {
    throw new ConfigError(`--config is required.\n\n${USAGE}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);

  if (config.controlUrl === config.candidateUrl) {
    throw new ConfigError(
      `controlUrl and candidateUrl are the same ("${config.controlUrl}"). Every scenario ` +
        `would trivially pass. Point control at the gateway with the domain flag OFF and ` +
        `candidate at the gateway with it ON.`,
    );
  }

  const scenarios = selectScenarios(buildScenarios(config.fixtures), args.domains);
  if (scenarios.length === 0) {
    throw new ConfigError("No scenarios selected.");
  }

  const allowMutating = args.allowMutating || config.allowMutating === true;

  // Before a single request is issued, and before anything is written.
  const databaseUrl = process.env.PARITY_DATABASE_URL;
  await assertSafeTarget({
    urls: [config.controlUrl, config.candidateUrl],
    env: process.env,
    marker: databaseUrl ? databaseMarkerReader(databaseUrl) : undefined,
    allowMutating,
  });

  const coverage = coverageFor(scenarios, args.domains.length > 0 ? args.domains : undefined);

  const scope = args.domains.length > 0 ? args.domains.join(", ") : "all domains";
  if (!args.json) {
    console.log(`parity: ${scenarios.length} scenarios (${scope})`);
    console.log(`  control   (legacy) ${config.controlUrl}`);
    console.log(`  candidate (module) ${config.candidateUrl}`);
    console.log("");
    // Above the verdict: coverage frames every number that follows, and a reader
    // who stops after the first lines should still know whether this run sampled
    // the surface or covered it.
    console.log(formatCoverage(coverage));
    console.log("");
  }

  const summary = await runSuite(scenarios, {
    controlUrl: config.controlUrl,
    candidateUrl: config.candidateUrl,
    credentials: config.credentials,
    allowMutating,
    timeoutMs: config.timeoutMs,
  });

  console.log(args.json ? formatJson(summary) : formatText(summary));

  const verdict = verdictFor(summary.clean, coverage);
  for (const line of verdict.errors) console.error(`\n${line}`);
  for (const line of verdict.warnings) console.error(`\n${line}`);
  return verdict.code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ParityRefusal) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 2;
  });
