import { SessionPool, type PersonaCredentials } from "./auth.js";
import { diffResponses, worstSeverity, type Difference, type Severity } from "./diff.js";
import { send, type HttpResponse } from "./http.js";
import { normalize } from "./normalize.js";
import { COMMON_VOLATILE, type Domain, type Scenario } from "./scenario.js";

export interface RunnerOptions {
  /** Legacy upstream — the gateway with the domain's flag OFF, or legacy direct. */
  controlUrl: string;
  /** Candidate upstream — the gateway with the domain's flag ON. */
  candidateUrl: string;
  credentials: PersonaCredentials;
  /** Run scenarios that write. Off by default: they write to BOTH upstreams. */
  allowMutating?: boolean;
  timeoutMs?: number;
}

export type Outcome = "match" | "differs" | "skipped" | "error";

export interface ScenarioResult {
  scenario: Scenario;
  outcome: Outcome;
  severity?: Severity;
  differences: Difference[];
  /** Present unless the scenario was skipped or errored before responding. */
  control?: { status: number; durationMs: number };
  candidate?: { status: number; durationMs: number };
  /** Absolute expectation failures, reported even when both sides agree. */
  expectationFailures: string[];
  error?: string;
}

export interface RunSummary {
  results: ScenarioResult[];
  counts: Record<Outcome, number>;
  worst?: Severity;
  /** True when nothing blocks a flag flip: no differences, no errors. */
  clean: boolean;
}

function summarise(response: HttpResponse): { status: number; durationMs: number } {
  return { status: response.status, durationMs: response.durationMs };
}

/**
 * Run one scenario against both upstreams.
 *
 * The two calls are issued CONCURRENTLY for read-only scenarios (halves wall
 * clock, and both see the same database state) but SEQUENTIALLY for mutating
 * ones, where overlapping writes could interleave and produce a difference that
 * is an artefact of the harness rather than of the code under test.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunnerOptions,
  sessions: SessionPool,
): Promise<ScenarioResult> {
  const base: ScenarioResult = { scenario, outcome: "match", differences: [], expectationFailures: [] };

  if (scenario.mutating && !options.allowMutating) {
    return { ...base, outcome: "skipped" };
  }

  try {
    const [controlAuth, candidateAuth] = await Promise.all([
      sessions.headersFor(options.controlUrl, scenario.persona),
      sessions.headersFor(options.candidateUrl, scenario.persona),
    ]);

    const request = scenario.request;
    const controlReq = { ...request, headers: { ...request.headers, ...controlAuth } };
    const candidateReq = { ...request, headers: { ...request.headers, ...candidateAuth } };

    let control: HttpResponse;
    let candidate: HttpResponse;
    if (scenario.mutating) {
      control = await send(options.controlUrl, controlReq, options.timeoutMs);
      candidate = await send(options.candidateUrl, candidateReq, options.timeoutMs);
    } else {
      [control, candidate] = await Promise.all([
        send(options.controlUrl, controlReq, options.timeoutMs),
        send(options.candidateUrl, candidateReq, options.timeoutMs),
      ]);
    }

    const spec = {
      ...scenario.normalize,
      volatile: [...COMMON_VOLATILE, ...(scenario.normalize?.volatile ?? [])],
    };
    const differences = diffResponses(
      { status: control.status, body: normalize(control.body, spec) },
      { status: candidate.status, body: normalize(candidate.body, spec) },
    );

    const expectationFailures: string[] = [];
    if (scenario.expectStatus !== undefined) {
      if (control.status !== scenario.expectStatus) {
        expectationFailures.push(
          `control returned ${control.status}, expected ${scenario.expectStatus}`,
        );
      }
      if (candidate.status !== scenario.expectStatus) {
        expectationFailures.push(
          `candidate returned ${candidate.status}, expected ${scenario.expectStatus}`,
        );
      }
    }

    const failed = differences.length > 0 || expectationFailures.length > 0;
    return {
      scenario,
      outcome: failed ? "differs" : "match",
      severity: worstSeverity(differences),
      differences,
      control: summarise(control),
      candidate: summarise(candidate),
      expectationFailures,
    };
  } catch (err) {
    return { ...base, outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Run a suite, preserving declaration order so create→read→delete flows hold. */
export async function runSuite(
  scenarios: readonly Scenario[],
  options: RunnerOptions,
): Promise<RunSummary> {
  const sessions = new SessionPool(options.credentials);
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, options, sessions));
  }

  const counts: Record<Outcome, number> = { match: 0, differs: 0, skipped: 0, error: 0 };
  for (const r of results) counts[r.outcome] += 1;

  return {
    results,
    counts,
    worst: worstSeverity(results.flatMap((r) => r.differences)),
    clean: counts.differs === 0 && counts.error === 0,
  };
}

export function selectScenarios(
  all: readonly Scenario[],
  domains: readonly Domain[],
): readonly Scenario[] {
  if (domains.length === 0) return all;
  const wanted = new Set(domains);
  return all.filter((s) => wanted.has(s.domain));
}
