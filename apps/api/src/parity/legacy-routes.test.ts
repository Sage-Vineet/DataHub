import { describe, expect, it } from "vitest";
import { deriveLegacyRoutesFromSource, legacyRoutes, legacySourceAvailable } from "./routes.js";

/**
 * The frozen legacy surface must match the legacy source, for as long as there
 * is legacy source.
 *
 * `legacyRoutes()` is the denominator of the whole parity effort: a module route
 * is "comparable" if legacy also serves it, and "additive" if not. Deriving that
 * by scanning `backend/src` meant the measuring instrument read the code being
 * deleted — and the failure was silent in the worst direction. An absent
 * `backend/` yields an EMPTY surface, every module route becomes additive,
 * nothing is comparable, and the harness reports a clean run having compared
 * nothing at all.
 *
 * Freezing the surface removes that coupling. This test is what stops the
 * fixture from going stale in the meantime, and it disappears on its own when
 * legacy does.
 */

describe("the committed legacy surface", () => {
  it.skipIf(!legacySourceAvailable())("still matches backend/src", () => {
    const frozen = [...legacyRoutes()].sort();
    const derived = [...deriveLegacyRoutesFromSource()].sort();

    // Diffed both ways so the message names what moved, rather than only that
    // two large sets differ.
    const added = derived.filter((r) => !frozen.includes(r));
    const removed = frozen.filter((r) => !derived.includes(r));

    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it("is non-empty, which an absent backend/ would not be", () => {
    // The assertion that would have caught the silent-empty failure mode.
    expect(legacyRoutes().size).toBeGreaterThan(200);
  });

  it("holds normalized METHOD /path keys", () => {
    for (const key of legacyRoutes()) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
      // Param names are collapsed, so a rename in either engine is not a diff.
      expect(key).not.toMatch(/:(?!p\b)[A-Za-z]/);
    }
  });
});
