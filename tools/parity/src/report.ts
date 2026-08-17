import type { Difference } from "./diff.js";
import type { RunSummary, ScenarioResult } from "./runner.js";

/**
 * Reporting. The audience is someone deciding whether to flip a flag, so the
 * output leads with that decision and only then explains it.
 */

const MARK: Record<ScenarioResult["outcome"], string> = {
  match: "ok  ",
  differs: "DIFF",
  skipped: "skip",
  error: "ERR ",
};

function truncate(value: unknown, max = 120): string {
  const text = value === undefined ? "(absent)" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDifference(diff: Difference): string {
  const head = `      [${diff.severity}] ${diff.kind} at ${diff.path}`;
  if (diff.kind === "extra-field") return `${head}\n        candidate: ${truncate(diff.candidate)}`;
  if (diff.kind === "missing-field") return `${head}\n        legacy:    ${truncate(diff.control)}`;
  return `${head}\n        legacy:    ${truncate(diff.control)}\n        candidate: ${truncate(diff.candidate)}`;
}

export function formatText(summary: RunSummary): string {
  const lines: string[] = [];

  for (const result of summary.results) {
    const { scenario } = result;
    const statuses =
      result.control && result.candidate
        ? ` (${result.control.status} vs ${result.candidate.status})`
        : "";
    lines.push(`  ${MARK[result.outcome]} ${scenario.domain}/${scenario.id}${statuses}`);

    if (result.outcome === "error") {
      lines.push(`      error: ${result.error ?? "unknown"}`);
    }
    for (const failure of result.expectationFailures) {
      lines.push(`      [critical] expectation: ${failure}`);
    }
    for (const diff of result.differences) {
      lines.push(formatDifference(diff));
    }
    if (result.outcome !== "match") {
      lines.push(`      spec: ${scenario.spec}`);
    }
  }

  const { counts } = summary;
  lines.push("");
  lines.push(
    `  ${counts.match} match · ${counts.differs} differ · ${counts.error} error · ${counts.skipped} skipped`,
  );

  if (summary.clean) {
    lines.push("");
    lines.push("  PARITY CLEAN — no behavioural differences found in this suite.");
    lines.push("  This is evidence for a flag flip, not proof of one: it covers the");
    lines.push("  scenarios declared here, against the data currently seeded.");
  } else {
    lines.push("");
    lines.push(`  PARITY FAILED — worst severity: ${summary.worst ?? "n/a"}.`);
    lines.push("  Do not flip the flag until each difference above is explained or fixed.");
  }
  return lines.join("\n");
}

/** Machine-readable form, for CI artefacts and soak records. */
export function formatJson(summary: RunSummary): string {
  return JSON.stringify(
    {
      clean: summary.clean,
      worst: summary.worst ?? null,
      counts: summary.counts,
      results: summary.results.map((r) => ({
        id: r.scenario.id,
        domain: r.scenario.domain,
        spec: r.scenario.spec,
        persona: r.scenario.persona,
        request: { method: r.scenario.request.method, path: r.scenario.request.path },
        outcome: r.outcome,
        severity: r.severity ?? null,
        control: r.control ?? null,
        candidate: r.candidate ?? null,
        expectationFailures: r.expectationFailures,
        differences: r.differences,
        error: r.error ?? null,
      })),
    },
    null,
    2,
  );
}
