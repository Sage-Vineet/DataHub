import { isRecord, type Json } from "./normalize.js";

/**
 * Structural diff between the legacy response (control) and the new module's
 * (candidate), over ALREADY-normalised values.
 *
 * Differences are classified, because they are not equally alarming and a flat
 * list gives an operator no way to triage before a flag flip:
 *
 *   status          the endpoints disagree on the HTTP status — a client-visible
 *                   behaviour change, and the single most important signal.
 *   missing-field   legacy returns a key the module does not — most likely to
 *                   break a consumer, since the SPA may read it.
 *   extra-field     the module returns a key legacy does not — additive, usually
 *                   safe, but worth seeing (it is unspecified surface).
 *   type            same key, different JSON type — e.g. "3" vs 3. Silently
 *                   corrupts arithmetic and comparisons downstream.
 *   value           same key and type, different value.
 */

export type DifferenceKind = "status" | "missing-field" | "extra-field" | "type" | "value";

export type Severity = "critical" | "major" | "minor";

export interface Difference {
  kind: DifferenceKind;
  /** Dotted path into the body, or "$status" for the status line. */
  path: string;
  control: Json | undefined;
  candidate: Json | undefined;
  severity: Severity;
}

const SEVERITY: Record<DifferenceKind, Severity> = {
  status: "critical",
  type: "critical",
  "missing-field": "major",
  value: "major",
  "extra-field": "minor",
};

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "major", "minor"];

function formatPath(path: readonly string[]): string {
  let out = "$";
  for (const segment of path) {
    out += segment === "[]" ? "[]" : `.${segment}`;
  }
  return out;
}

function jsonType(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function push(out: Difference[], kind: DifferenceKind, path: readonly string[], control: Json | undefined, candidate: Json | undefined): void {
  out.push({ kind, path: formatPath(path), control, candidate, severity: SEVERITY[kind] });
}

/** Diff two normalised bodies. */
export function diffBodies(control: Json, candidate: Json): Difference[] {
  const out: Difference[] = [];
  compare(control, candidate, [], out);
  return out;
}

function compare(
  control: Json,
  candidate: Json,
  path: readonly string[],
  out: Difference[],
): void {
  const controlType = jsonType(control);
  const candidateType = jsonType(candidate);

  if (controlType !== candidateType) {
    push(out, "type", path, control, candidate);
    return;
  }

  if (Array.isArray(control) && Array.isArray(candidate)) {
    if (control.length !== candidate.length) {
      // Report the length as a value difference at the array itself, then stop:
      // element-wise diffs of mismatched lists are noise, not information.
      push(out, "value", [...path, "length"], control.length, candidate.length);
      return;
    }
    const childPath = [...path, "[]"];
    for (let i = 0; i < control.length; i++) {
      compare(control[i]!, candidate[i]!, childPath, out);
    }
    return;
  }

  if (isRecord(control) && isRecord(candidate)) {
    const keys = new Set([...Object.keys(control), ...Object.keys(candidate)]);
    for (const key of [...keys].sort()) {
      const childPath = [...path, key];
      const inControl = key in control;
      const inCandidate = key in candidate;
      if (inControl && !inCandidate) {
        push(out, "missing-field", childPath, control[key], undefined);
      } else if (!inControl && inCandidate) {
        push(out, "extra-field", childPath, undefined, candidate[key]);
      } else {
        compare(control[key]!, candidate[key]!, childPath, out);
      }
    }
    return;
  }

  if (control !== candidate) {
    push(out, "value", path, control, candidate);
  }
}

/** Diff a full response pair (status first, then body). */
export function diffResponses(
  control: { status: number; body: Json },
  candidate: { status: number; body: Json },
): Difference[] {
  const out: Difference[] = [];
  if (control.status !== candidate.status) {
    out.push({
      kind: "status",
      path: "$status",
      control: control.status,
      candidate: candidate.status,
      severity: "critical",
    });
  }
  out.push(...diffBodies(control.body, candidate.body));
  return out;
}

/** Highest severity present, or undefined when the responses match. */
export function worstSeverity(diffs: readonly Difference[]): Severity | undefined {
  for (const severity of SEVERITY_ORDER) {
    if (diffs.some((d) => d.severity === severity)) return severity;
  }
  return undefined;
}
