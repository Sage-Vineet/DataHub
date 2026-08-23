/**
 * Reading JSON out of a language model's reply.
 *
 * A model asked for JSON returns JSON MOST of the time. The rest of the time it
 * returns JSON wrapped in a markdown fence, or with a sentence before it, or
 * with a trailing "Let me know if you need anything else." Each of those makes
 * `JSON.parse` throw, and a throw here becomes "extraction failed" on a page
 * where the extraction actually succeeded.
 *
 * WHAT THE VERSION THIS REPLACES DID
 * ----------------------------------
 *   Strip a leading ```json fence, then strip a trailing one, then parse.
 *
 * That handles exactly one shape: a fence with nothing outside it. A reply with
 * any prose around the fence keeps the prose and fails to parse. A reply with
 * two fenced blocks keeps both and fails to parse. And a bare `{...}` preceded
 * by a sentence fails, because there is no fence to strip.
 *
 * The approach here is to FIND the JSON rather than to strip what surrounds it:
 * take the first balanced `{…}` or `[…]`, which is what the model was asked
 * for and what every one of those shapes contains.
 */

/**
 * The first balanced JSON value in a string.
 *
 * Balanced, not greedy-to-the-last-brace: a reply ending "…} Let me know if
 * you need {anything} else" has a later brace, and matching to it captures
 * prose. Balanced, not lazy-to-the-first: `{"a":{"b":1}}` would stop at the
 * inner close.
 *
 * String contents are skipped, so a brace inside a value — `{"note":"} end"}` —
 * does not end the scan.
 */
export function findJsonBlock(text: string): string | null {
  const source = String(text ?? "");
  for (let start = 0; start < source.length; start += 1) {
    const opener = source[start];
    if (opener !== "{" && opener !== "[") continue;

    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const char = source[i]!;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) depth += 1;
      else if (char === closer) {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    // Unbalanced from here. Another opener later might still balance, so the
    // outer loop carries on rather than giving up.
  }
  return null;
}

export class ModelReplyError extends Error {
  constructor(
    message: string,
    /** What the model actually said, truncated — for a log somebody reads. */
    readonly reply: string,
  ) {
    super(message);
    this.name = "ModelReplyError";
  }
}

/**
 * Parse a model's reply as JSON.
 *
 * Throws with the reply attached rather than returning null, because every
 * caller has to stop, and an error naming what came back is the difference
 * between diagnosing a bad prompt and staring at "extraction failed".
 */
export function parseModelJson<T = unknown>(reply: string): T {
  const block = findJsonBlock(reply);
  if (block === null) {
    throw new ModelReplyError(
      "The model's reply contained no JSON.",
      String(reply ?? "").slice(0, 500),
    );
  }
  try {
    return JSON.parse(block) as T;
  } catch (error) {
    throw new ModelReplyError(
      `The model's reply was not valid JSON: ${(error as Error).message}`,
      block.slice(0, 500),
    );
  }
}

/**
 * A number from a model's reply.
 *
 * Models write money the way a person does — `"1,234.56"`, `"$1,234"`,
 * `"(500)"` for a negative — and `Number()` gives NaN for every one of those.
 * `Number(x) || 0` then turns them all into ZERO, which is how a company's
 * revenue silently becomes nothing.
 *
 * Returns null for genuinely unreadable input, so a caller can tell "the model
 * did not say" from "the model said nought".
 */
export function modelNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim();
  if (text === "") return null;

  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()]/g, "").replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

/** The same, with a floor of zero for a caller that must have a figure. */
export function modelNumberOr(value: unknown, fallback: number): number {
  return modelNumber(value) ?? fallback;
}
