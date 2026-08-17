import { describe, expect, it } from "vitest";
import { EnvConfigError, MODULE_FLAGS, loadGatewayEnv, parseFlag } from "./env.js";

describe("gateway env", () => {
  it("treats an unset or empty flag as off (fall through to legacy)", () => {
    expect(parseFlag("X_ENABLED", undefined)).toBe(false);
    expect(parseFlag("X_ENABLED", "")).toBe(false);
    expect(parseFlag("X_ENABLED", "  ")).toBe(false);
  });

  it('accepts exactly "true" and "false"', () => {
    expect(parseFlag("X_ENABLED", "true")).toBe(true);
    expect(parseFlag("X_ENABLED", " true ")).toBe(true);
    expect(parseFlag("X_ENABLED", "false")).toBe(false);
  });

  // The point of the strict parse: these all look like "on" to an operator, and
  // all previously meant "off" — a cutover that appears to happen but does not.
  it.each(["1", "TRUE", "True", "yes", "on", "enabled", "0"])(
    "rejects the near-miss value %o instead of silently reading it as off",
    (value) => {
      expect(() => parseFlag("COMPANIES_MODULE_ENABLED", value)).toThrow(EnvConfigError);
      expect(() => parseFlag("COMPANIES_MODULE_ENABLED", value)).toThrow(
        /COMPANIES_MODULE_ENABLED/,
      );
    },
  );

  it("validates every documented cutover flag", () => {
    for (const flag of MODULE_FLAGS) {
      expect(() => loadGatewayEnv({ [flag]: "1" } as NodeJS.ProcessEnv)).toThrow(EnvConfigError);
    }
  });

  it("defaults the port to 8080 and parses a valid one", () => {
    expect(loadGatewayEnv({} as NodeJS.ProcessEnv).port).toBe(8080);
    expect(loadGatewayEnv({ PORT: "9000" } as NodeJS.ProcessEnv).port).toBe(9000);
  });

  it.each(["abc", "0", "70000", "8080.5", "-1"])("rejects the invalid PORT %o", (port) => {
    expect(() => loadGatewayEnv({ PORT: port } as NodeJS.ProcessEnv)).toThrow(EnvConfigError);
  });

  it("splits trusted origins and drops blanks", () => {
    const env = loadGatewayEnv({
      AUTH_TRUSTED_ORIGINS: "https://a.test, ,https://b.test",
    } as NodeJS.ProcessEnv);
    expect(env.corsOrigins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("reports all flags off for an empty environment", () => {
    const { flags } = loadGatewayEnv({} as NodeJS.ProcessEnv);
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });
});
