import { describe, expect, it } from "vitest";
import { formatJson, formatText } from "./report.js";
import type { RunSummary, ScenarioResult } from "./runner.js";
import type { Scenario } from "./scenario.js";

const scenario: Scenario = {
  id: "tree-include-archived",
  domain: "folders",
  spec: "folders-domain > Tenant-scoped folder listing and tree > Archived filter",
  persona: "broker",
  request: { method: "GET", path: "/companies/c1/folders/tree" },
};

function summaryOf(results: ScenarioResult[]): RunSummary {
  const counts = { match: 0, differs: 0, skipped: 0, error: 0 };
  for (const r of results) counts[r.outcome] += 1;
  return {
    results,
    counts,
    worst: results.flatMap((r) => r.differences)[0]?.severity,
    clean: counts.differs === 0 && counts.error === 0,
  };
}

describe("text report", () => {
  it("states plainly when parity is clean, without overclaiming", () => {
    const text = formatText(
      summaryOf([
        {
          scenario,
          outcome: "match",
          differences: [],
          expectationFailures: [],
          control: { status: 200, durationMs: 5 },
          candidate: { status: 200, durationMs: 6 },
        },
      ]),
    );
    expect(text).toContain("PARITY CLEAN");
    // The caveat matters: a clean run is evidence, not proof.
    expect(text).toContain("not proof");
  });

  it("shows the difference, the severity and the spec it traces to", () => {
    const text = formatText(
      summaryOf([
        {
          scenario,
          outcome: "differs",
          severity: "major",
          differences: [
            { kind: "value", path: "$.length", control: 2, candidate: 1, severity: "major" },
          ],
          expectationFailures: [],
          control: { status: 200, durationMs: 5 },
          candidate: { status: 200, durationMs: 4 },
        },
      ]),
    );
    expect(text).toContain("DIFF");
    expect(text).toContain("$.length");
    expect(text).toContain("[major]");
    expect(text).toContain("Archived filter");
    expect(text).toContain("PARITY FAILED");
    expect(text).toContain("Do not flip the flag");
  });

  it("renders a missing field without inventing a candidate value", () => {
    const text = formatText(
      summaryOf([
        {
          scenario,
          outcome: "differs",
          severity: "major",
          differences: [
            { kind: "missing-field", path: "$.name", control: "Acme", candidate: undefined, severity: "major" },
          ],
          expectationFailures: [],
        },
      ]),
    );
    expect(text).toContain("legacy:");
    expect(text).not.toContain("candidate: undefined");
  });

  it("surfaces errors and expectation failures", () => {
    const text = formatText(
      summaryOf([
        { scenario, outcome: "error", differences: [], expectationFailures: [], error: "boom" },
        {
          scenario: { ...scenario, id: "anon" },
          outcome: "differs",
          differences: [],
          expectationFailures: ["control returned 200, expected 401"],
        },
      ]),
    );
    expect(text).toContain("error: boom");
    expect(text).toContain("expected 401");
  });
});

describe("json report", () => {
  it("emits the decision and per-scenario detail", () => {
    const json = JSON.parse(
      formatJson(
        summaryOf([
          {
            scenario,
            outcome: "differs",
            severity: "critical",
            differences: [
              { kind: "status", path: "$status", control: 200, candidate: 403, severity: "critical" },
            ],
            expectationFailures: [],
            control: { status: 200, durationMs: 5 },
            candidate: { status: 403, durationMs: 4 },
          },
        ]),
      ),
    ) as { clean: boolean; results: Array<Record<string, unknown>> };

    expect(json.clean).toBe(false);
    expect(json.results[0]).toMatchObject({
      id: "tree-include-archived",
      domain: "folders",
      outcome: "differs",
      severity: "critical",
    });
    expect(json.results[0]?.spec).toContain("folders-domain");
  });
});
