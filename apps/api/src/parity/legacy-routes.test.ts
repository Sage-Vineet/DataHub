import { describe, expect, it } from "vitest";
import {
  contractRoutes,
  deriveLegacyRoutesFromSource,
  legacyRoutes,
  legacySourceAvailable,
  reapedRoutes,
} from "./routes.js";

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

  it("keeps the SPA-facing surface whole as legacy shrinks", () => {
    // The silent-empty failure mode this guards: an absent `backend/` derives an
    // EMPTY legacy surface, every module route becomes additive, nothing is
    // comparable, and the harness reports a clean run having compared nothing.
    //
    // Asserted on the contract surface rather than on legacy, because reaping is
    // *supposed* to shrink legacy — a floor under it would fail the moment the
    // migration made progress, and would be raised out of the way rather than
    // investigated.
    expect(contractRoutes().size).toBeGreaterThan(200);
  });

  it.skipIf(!legacySourceAvailable())("derives a non-empty surface while legacy exists", () => {
    expect(deriveLegacyRoutesFromSource().size).toBeGreaterThan(0);
  });

  it("holds normalized METHOD /path keys", () => {
    for (const key of legacyRoutes()) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
      // Param names are collapsed, so a rename in either engine is not a diff.
      expect(key).not.toMatch(/:(?!p\b)[A-Za-z]/);
    }
  });
});

describe("the reaped surface", () => {
  it("is disjoint from what legacy still serves", () => {
    // A route in both lists means a handler was recorded as deleted and is still
    // there — the reap did not happen, and the contract guard would not notice.
    const still = [...reapedRoutes()].filter((r) => legacyRoutes().has(r));
    expect(still).toEqual([]);
  });

  it("keeps a reaped path inside the contract", () => {
    // The whole point: deleting legacy's handler must not make the module that
    // replaced it look like drift.
    const reaped = [...reapedRoutes()];
    expect(reaped.length).toBeGreaterThan(0);
    for (const route of reaped) expect(contractRoutes().has(route)).toBe(true);
  });

  it("is the union of both, and larger than either", () => {
    const contract = contractRoutes();
    expect(contract.size).toBe(legacyRoutes().size + reapedRoutes().size);
    expect(contract.size).toBeGreaterThan(legacyRoutes().size);
  });
});
