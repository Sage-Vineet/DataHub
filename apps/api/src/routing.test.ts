import { describe, expect, it } from "vitest";
import { parseRoutingTable, resolveTarget, RoutingConfigError } from "./routing.js";

describe("parseRoutingTable", () => {
  it("requires LEGACY_ORIGIN", () => {
    expect(() => parseRoutingTable({})).toThrow(RoutingConfigError);
  });

  it("defaults everything to legacy when no routes are set", () => {
    const table = parseRoutingTable({ LEGACY_ORIGIN: "http://legacy.local:3000" });
    expect(table.defaultOrigin).toBe("legacy");
    expect(table.routes).toHaveLength(0);
    expect(resolveTarget(table, "/anything")).toBe("http://legacy.local:3000");
  });

  it("routes a flipped prefix to the api origin, others to legacy", () => {
    const table = parseRoutingTable({
      LEGACY_ORIGIN: "http://legacy.local:3000",
      API_ORIGIN: "http://api.local:4000",
      GATEWAY_ROUTES: "/api/auth=api",
    });
    expect(resolveTarget(table, "/api/auth/login")).toBe("http://api.local:4000");
    expect(resolveTarget(table, "/api/companies")).toBe("http://legacy.local:3000");
  });

  it("prefers the longest matching prefix", () => {
    const table = parseRoutingTable({
      LEGACY_ORIGIN: "http://legacy.local:3000",
      API_ORIGIN: "http://api.local:4000",
      GATEWAY_ROUTES: "/api=legacy,/api/auth=api",
    });
    expect(resolveTarget(table, "/api/auth/login")).toBe("http://api.local:4000");
    expect(resolveTarget(table, "/api/other")).toBe("http://legacy.local:3000");
  });

  it("rejects a route with an unknown origin", () => {
    expect(() =>
      parseRoutingTable({ LEGACY_ORIGIN: "http://legacy.local:3000", GATEWAY_ROUTES: "/x=api" }),
    ).toThrow(/unknown origin/);
  });

  it("rejects a malformed route entry", () => {
    expect(() =>
      parseRoutingTable({ LEGACY_ORIGIN: "http://legacy.local:3000", GATEWAY_ROUTES: "no-equals" }),
    ).toThrow(RoutingConfigError);
  });

  it("rejects a prefix that does not start with /", () => {
    expect(() =>
      parseRoutingTable({ LEGACY_ORIGIN: "http://legacy.local:3000", GATEWAY_ROUTES: "api=legacy" }),
    ).toThrow(/must start with/);
  });

  it("rejects an invalid origin URL", () => {
    expect(() => parseRoutingTable({ LEGACY_ORIGIN: "not a url" })).toThrow(/valid URL/);
  });
});
