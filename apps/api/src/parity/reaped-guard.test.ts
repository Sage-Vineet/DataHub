import { describe, expect, it } from "vitest";
import { EnvConfigError, MODULE_FLAGS, type ModuleFlag } from "../env.js";
import { assertReapedModulesEnabled, reapedGaps } from "./reaped-guard.js";
import { reapedRoutes } from "./routes.js";

/**
 * The hole a shrinking legacy opens up.
 *
 * `env.ts` calls unset "the safe default: fall through to legacy", and it was.
 * Once a legacy handler is deleted there is nothing to fall through to, and an
 * off flag stops meaning "not migrated yet" and starts meaning "this route
 * 404s". Nothing in the boot sequence can tell those two apart, which is
 * exactly why it has to be a startup error.
 */

const allFlags = (value: boolean): Record<ModuleFlag, boolean> =>
  Object.fromEntries(MODULE_FLAGS.map((f) => [f, value])) as Record<ModuleFlag, boolean>;

describe("modules that own reaped routes", () => {
  it("has something to guard — routes have actually been reaped", () => {
    // If this ever hits zero the guard is vacuous, and a green test would say
    // nothing at all.
    expect(reapedRoutes().size).toBeGreaterThan(0);
  });

  it("refuses to start when a module owning reaped routes is off", () => {
    expect(() => assertReapedModulesEnabled(allFlags(false))).toThrow(EnvConfigError);
  });

  it("names the flag to set, and some of what would break", () => {
    // A message that says "misconfigured" and stops there costs an hour.
    let message = "";
    try {
      assertReapedModulesEnabled(allFlags(false));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("REPORTS_MODULE_ENABLED=true");

    // Quotes real routes rather than a placeholder — checked against the
    // reaped set rather than a hardcoded path, which goes stale as the reaping
    // order changes.
    const quoted = [...reapedRoutes()].filter((route) => message.includes(route));
    expect(quoted.length).toBeGreaterThan(0);
  });

  it("starts cleanly with every module on", () => {
    expect(() => assertReapedModulesEnabled(allFlags(true))).not.toThrow();
  });

  it("reports every offending domain at once, not one per restart", () => {
    const gaps = reapedGaps(allFlags(false));
    expect(gaps.length).toBeGreaterThan(1);
    for (const gap of gaps) {
      expect(gap.routes.length).toBeGreaterThan(0);
      expect(MODULE_FLAGS).toContain(gap.flag);
    }
  });

  it("says nothing about a module that is on", () => {
    const gaps = reapedGaps({ ...allFlags(false), REPORTS_MODULE_ENABLED: true });
    expect(gaps.map((g) => g.domain)).not.toContain("reports");
  });

  it("lists only reaped routes, never a module's whole surface", () => {
    // The point is the routes with nothing behind them, not every route the
    // module happens to serve.
    const reaped = reapedRoutes();
    for (const gap of reapedGaps(allFlags(false))) {
      for (const route of gap.routes) expect(reaped.has(route)).toBe(true);
    }
  });

  it("abbreviates rather than printing a hundred routes", () => {
    let message = "";
    try {
      assertReapedModulesEnabled(allFlags(false));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/and \d+ more/);
  });
});
