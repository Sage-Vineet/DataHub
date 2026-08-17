import type { Difference, Verdict } from "./comparator.js";

/**
 * The parity report.
 *
 * The design constraint here is not formatting, it is honesty (design D7): a
 * report showing twelve green endpoints and saying nothing about the thirty it
 * never touched reads as "parity proven" when it means "parity sampled". Since a
 * green report is what authorizes deleting a legacy handler — the one irreversible
 * step in the program — coverage is not an optional section. Every renderer here
 * prints it, and `compared` is always shown against the domain total.
 */

export type SkipReason =
  | "mutation-not-permitted"
  | "no-fixture"
  | "auth-required"
  | "additive-endpoint"
  | "request-failed";

export interface EndpointVerdict {
  route: string;
  verdict: Verdict;
  differences: Difference[];
  latency: { legacyMs: number; moduleMs: number; deltaMs: number };
}

export interface SkippedEndpoint {
  route: string;
  reason: SkipReason;
  detail?: string;
}

export interface DomainReport {
  domain: string;
  /** Every route the domain claims that legacy also serves. */
  total: number;
  verdicts: EndpointVerdict[];
  skipped: SkippedEndpoint[];
}

export interface ParityReport {
  target: string;
  seededAt: string;
  mutationAllowed: boolean;
  domains: DomainReport[];
}

export function domainPassed(report: DomainReport): boolean {
  return report.verdicts.every((v) => v.verdict === "pass");
}

export function reportPassed(report: ParityReport): boolean {
  return report.domains.every(domainPassed);
}

/** True only when every comparable endpoint was actually compared. */
export function isComplete(report: DomainReport): boolean {
  return report.verdicts.length === report.total;
}

const SKIP_LABEL: Record<SkipReason, string> = {
  "mutation-not-permitted": "mutating verb, and mutation is not enabled",
  "no-fixture": "no fixture to build a valid request",
  "auth-required": "needs an authenticated session the harness could not obtain",
  "additive-endpoint": "module-only endpoint, absent from legacy — nothing to compare against",
  "request-failed": "request could not be issued",
};

export function renderText(report: ParityReport): string {
  const lines: string[] = [];
  lines.push(`Parity report — target ${report.target} (seeded ${report.seededAt})`);
  lines.push(`Mutating requests: ${report.mutationAllowed ? "enabled" : "read-only"}`);
  lines.push("");

  for (const domain of report.domains) {
    const passed = domain.verdicts.filter((v) => v.verdict === "pass").length;
    const failed = domain.verdicts.length - passed;
    lines.push(`## ${domain.domain}`);
    // Coverage first, deliberately: it frames every number that follows.
    lines.push(
      `   coverage: compared ${domain.verdicts.length} of ${domain.total} comparable endpoints` +
        (isComplete(domain) ? "" : `  ← PARTIAL, ${domain.skipped.length} skipped`),
    );
    lines.push(`   verdicts: ${passed} pass, ${failed} fail`);

    for (const verdict of domain.verdicts.filter((v) => v.verdict === "fail")) {
      lines.push(`   ✗ ${verdict.route}`);
      for (const d of verdict.differences) {
        lines.push(`       ${d.field}: ${d.reason} (legacy ${d.legacy}, module ${d.module})`);
      }
    }
    for (const skip of domain.skipped) {
      lines.push(
        `   – ${skip.route}: skipped — ${SKIP_LABEL[skip.reason]}${skip.detail ? ` (${skip.detail})` : ""}`,
      );
    }
    // Informational only — latency never gates a verdict.
    const slowest = [...domain.verdicts].sort((a, b) => b.latency.deltaMs - a.latency.deltaMs)[0];
    if (slowest) {
      lines.push(
        `   latency: worst delta ${slowest.latency.deltaMs}ms on ${slowest.route} (informational)`,
      );
    }
    lines.push("");
  }

  const totalCompared = report.domains.reduce((n, d) => n + d.verdicts.length, 0);
  const totalComparable = report.domains.reduce((n, d) => n + d.total, 0);
  lines.push(
    `Overall: ${reportPassed(report) ? "PASS" : "FAIL"} — ` +
      `compared ${totalCompared} of ${totalComparable} comparable endpoints.`,
  );
  if (totalCompared < totalComparable) {
    lines.push(
      "This run SAMPLED the surface. A green result here does not authorize deleting a legacy " +
        "handler — see the skipped list above.",
    );
  }
  return lines.join("\n");
}

/** Machine-readable form, so a cutover change can attach the evidence it acted on. */
export function renderJson(report: ParityReport): string {
  return JSON.stringify(
    {
      target: report.target,
      seeded_at: report.seededAt,
      mutation_allowed: report.mutationAllowed,
      passed: reportPassed(report),
      coverage: {
        compared: report.domains.reduce((n, d) => n + d.verdicts.length, 0),
        comparable: report.domains.reduce((n, d) => n + d.total, 0),
        complete: report.domains.every(isComplete),
      },
      domains: report.domains.map((d) => ({
        domain: d.domain,
        comparable: d.total,
        compared: d.verdicts.length,
        complete: isComplete(d),
        passed: domainPassed(d),
        verdicts: d.verdicts,
        skipped: d.skipped,
      })),
    },
    null,
    2,
  );
}
