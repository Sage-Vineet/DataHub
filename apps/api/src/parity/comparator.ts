/**
 * Response comparison for the parity harness.
 *
 * Byte equality is the wrong bar and would fail on every response: identifiers,
 * timestamps and ordering legitimately differ between two engines reading the same
 * database. So comparison runs in three widening bands (design D2):
 *
 *   1. **Status** — exact, always.
 *   2. **Shape** — the same keys with the same types, recursively, after collapsing
 *      volatile values to type placeholders.
 *   3. **Declared invariants** — per-endpoint semantic assertions supplied by the
 *      domain. Optional, and where the real confidence comes from: shape equality
 *      proves the response looks right, not that it says the same thing.
 *
 * Latency is recorded and never gates.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export type Shape = string | ShapeObject | [Shape] | [];
interface ShapeObject {
  [key: string]: Shape;
}

/**
 * Collapse a value to its type shape. Volatile scalars become placeholders, so a
 * differing id or timestamp is not a difference. Arrays collapse to a single
 * representative element shape: a list of 3 and a list of 4 have the same shape,
 * and *count* differences are a semantic question for an invariant, not a
 * structural one.
 */
export function shapeOf(value: unknown): Shape {
  if (value === null || value === undefined) return "<null>";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const shapes = value.map(shapeOf).map((s) => JSON.stringify(s));
    const unique = [...new Set(shapes)];
    // A heterogeneous array is itself a shape fact worth surfacing.
    return unique.length === 1 ? [shapeOf(value[0])] : [`<mixed:${unique.length}>`];
  }
  if (typeof value === "object") {
    const out: ShapeObject = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shapeOf(v);
    }
    return out;
  }
  if (typeof value === "string") {
    if (UUID.test(value)) return "<uuid>";
    if (ISO_DATE.test(value)) return "<timestamp>";
    return "<string>";
  }
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return "<boolean>";
  return `<${typeof value}>`;
}

export interface Difference {
  /** Dotted path to the differing field, e.g. `body.items.name`. */
  field: string;
  reason: string;
  legacy: string;
  module: string;
}

function diffShapes(a: Shape, b: Shape, path: string, out: Difference[]): void {
  const aIsObj = typeof a === "object" && !Array.isArray(a);
  const bIsObj = typeof b === "object" && !Array.isArray(b);

  if (aIsObj && bIsObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      const here = path ? `${path}.${key}` : key;
      if (!(key in a)) {
        out.push({
          field: here,
          reason: "field present in the module response but not in legacy",
          legacy: "<absent>",
          module: JSON.stringify((b as ShapeObject)[key]),
        });
        continue;
      }
      if (!(key in b)) {
        out.push({
          field: here,
          reason: "field returned by legacy is missing from the module response",
          legacy: JSON.stringify((a as ShapeObject)[key]),
          module: "<absent>",
        });
        continue;
      }
      diffShapes((a as ShapeObject)[key]!, (b as ShapeObject)[key]!, here, out);
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0 || b.length === 0) return; // an empty list matches any element shape
    diffShapes(a[0] as Shape, b[0] as Shape, `${path}[]`, out);
    return;
  }

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({
      field: path || "body",
      reason: "type differs",
      legacy: JSON.stringify(a),
      module: JSON.stringify(b),
    });
  }
}

export interface ResponseSnapshot {
  status: number;
  body: unknown;
  durationMs: number;
}

export type Verdict = "pass" | "fail";

export interface Invariant {
  description: string;
  holds(legacy: unknown, module: unknown): boolean;
}

export interface ComparisonResult {
  verdict: Verdict;
  differences: Difference[];
  latency: { legacyMs: number; moduleMs: number; deltaMs: number };
}

export function compareResponses(
  legacy: ResponseSnapshot,
  module: ResponseSnapshot,
  invariants: ReadonlyArray<Invariant> = [],
): ComparisonResult {
  const differences: Difference[] = [];

  if (legacy.status !== module.status) {
    differences.push({
      field: "status",
      reason: "status code differs",
      legacy: String(legacy.status),
      module: String(module.status),
    });
  }

  diffShapes(shapeOf(legacy.body), shapeOf(module.body), "body", differences);

  for (const invariant of invariants) {
    if (!invariant.holds(legacy.body, module.body)) {
      differences.push({
        field: "invariant",
        reason: `declared invariant does not hold: ${invariant.description}`,
        legacy: "—",
        module: "—",
      });
    }
  }

  return {
    verdict: differences.length === 0 ? "pass" : "fail",
    differences,
    latency: {
      legacyMs: legacy.durationMs,
      moduleMs: module.durationMs,
      deltaMs: module.durationMs - legacy.durationMs,
    },
  };
}

/** Convenience invariants domains can reuse. */
export const invariants = {
  sameLength(): Invariant {
    return {
      description: "both responses return the same number of items",
      holds: (a, b) => !Array.isArray(a) || !Array.isArray(b) || a.length === b.length,
    };
  },
  sameValues(field: string): Invariant {
    return {
      description: `both responses return the same set of \`${field}\` values`,
      holds: (a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b)) return true;
        const pick = (rows: unknown[]): string =>
          JSON.stringify(
            rows
              .map((r) => (r as Record<string, unknown>)?.[field])
              .map((v) => JSON.stringify(v))
              .sort(),
          );
        return pick(a) === pick(b);
      },
    };
  },
};
