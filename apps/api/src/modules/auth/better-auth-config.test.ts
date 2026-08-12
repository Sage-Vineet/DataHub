import { describe, expect, it } from "vitest";
import { loadBetterAuthConfig } from "./better-auth.js";

describe("loadBetterAuthConfig", () => {
  it("fails closed when the secret is missing or an insecure default (audit C2)", () => {
    expect(() => loadBetterAuthConfig({} as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => loadBetterAuthConfig({ JWT_SECRET: "change_me" } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => loadBetterAuthConfig({ JWT_SECRET: "  Secret " } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
  });

  it("parses trusted origins and derives a base URL", () => {
    const cfg = loadBetterAuthConfig({
      JWT_SECRET: "a-strong-secret-value-1234567890",
      AUTH_TRUSTED_ORIGINS: "https://app.example.com, https://admin.example.com ,",
      PORT: "9000",
    } as NodeJS.ProcessEnv);
    expect(cfg.trustedOrigins).toEqual(["https://app.example.com", "https://admin.example.com"]);
    expect(cfg.baseURL).toBe("http://localhost:9000");
  });

  it("honors an explicit BETTER_AUTH_URL", () => {
    const cfg = loadBetterAuthConfig({
      JWT_SECRET: "a-strong-secret-value-1234567890",
      BETTER_AUTH_URL: "https://api.datahub.test",
    } as NodeJS.ProcessEnv);
    expect(cfg.baseURL).toBe("https://api.datahub.test");
    expect(cfg.trustedOrigins).toEqual([]);
  });
});
