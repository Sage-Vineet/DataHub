/**
 * Response normalisation.
 *
 * Two implementations of the same endpoint will never return byte-identical
 * payloads: ids are generated, timestamps differ by milliseconds, and SQL without
 * an ORDER BY returns rows in whatever order the plan produced. Diffing raw
 * responses therefore drowns the real findings in noise, and a harness that cries
 * wolf gets ignored — which is worse than not having one.
 *
 * So each scenario declares what is *allowed* to differ. Everything not declared
 * is signal. The declarations are deliberately narrow (`created_at`, not `*`) so
 * that widening them is a visible, reviewable act.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface NormalizeSpec {
  /**
   * Paths whose VALUES are legitimately non-deterministic (ids, timestamps).
   * The key is still compared — only the value is masked — so a field that
   * disappears entirely is still caught.
   */
  volatile?: readonly string[];
  /**
   * Paths pointing at arrays that carry no meaningful order, with the object key
   * to sort by. Use when the endpoint has no ORDER BY guarantee. If the order IS
   * part of the contract, leave it out so a reordering is reported.
   */
  sortArraysBy?: Readonly<Record<string, string>>;
  /** Paths dropped entirely, for fields outside the parity contract. */
  ignore?: readonly string[];
}

export const VOLATILE = "<volatile>";

/**
 * Match a concrete path against a pattern.
 *
 *   `id`                → the top-level id
 *   `[].id`             → id of every element of a top-level array
 *   `data[].created_at` → created_at of every element of `data`
 *   `*.token`           → token under any top-level key
 *   `**.updated_at`     → updated_at at any depth
 *
 * Concrete paths use the same shape with `[]` for array steps, so a pattern and a
 * path are compared segment-by-segment rather than by string equality.
 */
export function matchesPath(pattern: string, path: readonly string[]): boolean {
  const pat = splitPattern(pattern);
  return matchFrom(pat, 0, path, 0);
}

function splitPattern(pattern: string): string[] {
  // "data[].created_at" → ["data", "[]", "created_at"]
  const out: string[] = [];
  for (const chunk of pattern.split(".")) {
    if (chunk === "") continue;
    let rest = chunk;
    while (rest.endsWith("[]")) {
      rest = rest.slice(0, -2);
      // push the key first, then the array marker (order fixed below)
      out.push(rest === "" ? "[]" : rest, "[]");
      if (rest === "") out.pop();
      rest = "";
    }
    if (rest !== "") out.push(rest);
  }
  return out;
}

function matchFrom(
  pat: readonly string[],
  pi: number,
  path: readonly string[],
  si: number,
): boolean {
  if (pi === pat.length) return si === path.length;
  const token = pat[pi]!;
  if (token === "**") {
    // Match zero or more segments.
    for (let skip = si; skip <= path.length; skip++) {
      if (matchFrom(pat, pi + 1, path, skip)) return true;
    }
    return false;
  }
  if (si >= path.length) return false;
  const segment = path[si]!;
  const ok = token === "*" ? segment !== "[]" : token === segment;
  return ok && matchFrom(pat, pi + 1, path, si + 1);
}

function anyMatch(patterns: readonly string[] | undefined, path: readonly string[]): boolean {
  return patterns?.some((p) => matchesPath(p, path)) ?? false;
}

function sortKeyFor(
  spec: NormalizeSpec,
  path: readonly string[],
): string | undefined {
  const entries = Object.entries(spec.sortArraysBy ?? {});
  for (const [pattern, key] of entries) {
    if (matchesPath(pattern, path)) return key;
  }
  return undefined;
}

/** Stable, total ordering for sorting array elements by a key. */
function compareByKey(key: string): (a: Json, b: Json) => number {
  return (a, b) => {
    const av = isRecord(a) ? a[key] : undefined;
    const bv = isRecord(b) ? b[key] : undefined;
    const as = av === undefined ? "" : JSON.stringify(av);
    const bs = bv === undefined ? "" : JSON.stringify(bv);
    if (as < bs) return -1;
    if (as > bs) return 1;
    // Fall back to whole-value comparison so equal keys still order stably.
    const aw = JSON.stringify(a);
    const bw = JSON.stringify(b);
    return aw < bw ? -1 : aw > bw ? 1 : 0;
  };
}

export function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply a spec to a response body, producing the form that is actually compared.
 * Pure and deterministic: the same input always yields the same output, so a
 * reported difference is reproducible.
 */
export function normalize(value: Json, spec: NormalizeSpec = {}): Json {
  return walk(value, spec, []);
}

function walk(value: Json, spec: NormalizeSpec, path: readonly string[]): Json {
  if (anyMatch(spec.volatile, path)) return VOLATILE;

  if (Array.isArray(value)) {
    const childPath = [...path, "[]"];
    const mapped = value.map((item) => walk(item, spec, childPath));
    const key = sortKeyFor(spec, path);
    if (key !== undefined) {
      // Sort the ALREADY-normalised elements, so masked ids can't affect order.
      return [...mapped].sort(compareByKey(key));
    }
    return mapped;
  }

  if (isRecord(value)) {
    const out: { [key: string]: Json } = {};
    // Sort keys so object key order never registers as a difference.
    for (const key of Object.keys(value).sort()) {
      const childPath = [...path, key];
      if (anyMatch(spec.ignore, childPath)) continue;
      out[key] = walk(value[key]!, spec, childPath);
    }
    return out;
  }

  return value;
}
