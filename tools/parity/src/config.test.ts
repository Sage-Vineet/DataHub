import { describe, expect, it } from "vitest";
import { ConfigError, parseConfigForTest } from "./config.js";

const valid = {
  controlUrl: "http://localhost:8080",
  candidateUrl: "http://localhost:8081",
  credentials: { broker: { email: "b@example.com", password: "pw" } },
  fixtures: { companyId: "c1", foreignCompanyId: "c2" },
};

describe("parity config", () => {
  it("accepts a complete config", () => {
    const cfg = parseConfigForTest(valid, "test");
    expect(cfg.controlUrl).toBe("http://localhost:8080");
    expect(cfg.fixtures.companyId).toBe("c1");
    expect(cfg.allowMutating).toBe(false);
  });

  it("requires credentials, since every authed scenario would otherwise error", () => {
    expect(() => parseConfigForTest({ ...valid, credentials: {} }, "test")).toThrow(ConfigError);
  });

  it.each(["controlUrl", "candidateUrl"])("requires %s", (field) => {
    const broken = { ...valid, [field]: "" };
    expect(() => parseConfigForTest(broken, "test")).toThrow(ConfigError);
  });

  it("requires the cross-tenant fixture, which is the control for access scenarios", () => {
    const broken = { ...valid, fixtures: { companyId: "c1" } };
    expect(() => parseConfigForTest(broken, "test")).toThrow(/foreignCompanyId/);
  });

  it("rejects a non-object config", () => {
    expect(() => parseConfigForTest("nope", "test")).toThrow(ConfigError);
  });

  it("defaults optional fixtures to undefined so their scenarios are skipped", () => {
    const cfg = parseConfigForTest(valid, "test");
    expect(cfg.fixtures.folderId).toBeUndefined();
    expect(cfg.fixtures.reportVersionId).toBeUndefined();
  });

  it("carries through allowMutating and timeoutMs", () => {
    const cfg = parseConfigForTest({ ...valid, allowMutating: true, timeoutMs: 5000 }, "test");
    expect(cfg.allowMutating).toBe(true);
    expect(cfg.timeoutMs).toBe(5000);
  });
});
