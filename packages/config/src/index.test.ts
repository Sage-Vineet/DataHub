import { describe, expect, it } from "vitest";
import { CONFIG_FILES, configFile } from "./index.js";

describe("@datahub/config", () => {
  it("exposes the shared config file names", () => {
    expect(CONFIG_FILES.tsconfig).toBe("tsconfig.base.json");
    expect(CONFIG_FILES.vitest).toBe("vitest.base.ts");
  });

  it("resolves a config file by key", () => {
    expect(configFile("eslint")).toBe("eslint.base.js");
    expect(configFile("prettier")).toBe("prettier.config.js");
  });
});
