import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixtures, main } from "./cli.js";

/**
 * Exit codes are the operator's interface to this command, and they must stay
 * distinguishable: "refused to point at that database" (3) is not "the engines
 * disagreed" (1). Folding them together would send someone hunting for a
 * divergence that was never tested.
 */

let dir: string;
const silence = { log: vi.fn(), error: vi.fn() };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "parity-cli-"));
  vi.spyOn(console, "error").mockImplementation(silence.error);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration errors exit 2", () => {
  it("requires DATABASE_URL", async () => {
    await expect(main({} as NodeJS.ProcessEnv)).resolves.toBe(2);
  });

  it("requires both origins", async () => {
    await expect(
      main({ DATABASE_URL: "postgres://localhost/db" } as NodeJS.ProcessEnv),
    ).resolves.toBe(2);
  });
});

describe("refusals exit 3, distinctly from a parity failure", () => {
  it("refuses a production target", async () => {
    const code = await main({
      DATABASE_URL: "postgres://user:pw@db.prod.internal:5432/datahub",
      PARITY_LEGACY_ORIGIN: "http://legacy.test",
      PARITY_MODULE_ORIGIN: "http://module.test",
      PARITY_PRODUCTION_HOSTS: "db.prod.internal",
    } as NodeJS.ProcessEnv);

    expect(code).toBe(3);
    expect(silence.error).toHaveBeenCalledWith(expect.stringMatching(/Refusing to run/));
  });

  it("refuses when no production host list is configured", async () => {
    const code = await main({
      DATABASE_URL: "postgres://user:pw@db.staging.internal:5432/datahub",
      PARITY_LEGACY_ORIGIN: "http://legacy.test",
      PARITY_MODULE_ORIGIN: "http://module.test",
    } as NodeJS.ProcessEnv);

    expect(code).toBe(3);
    expect(silence.error).toHaveBeenCalledWith(
      expect.stringMatching(/PARITY_PRODUCTION_HOSTS is not set/),
    );
  });
});

describe("fixtures", () => {
  it("returns an empty map when no fixture file is configured", async () => {
    await expect(loadFixtures(undefined)).resolves.toEqual({});
  });

  it("loads request specs keyed by `METHOD /path`", async () => {
    const path = join(dir, "fixtures.json");
    await writeFile(
      path,
      JSON.stringify({ "GET /companies/:p": { method: "GET", path: "/companies/abc" } }),
      "utf8",
    );

    await expect(loadFixtures(path)).resolves.toEqual({
      "GET /companies/:p": { method: "GET", path: "/companies/abc" },
    });
  });

  it("surfaces a malformed fixture file rather than silently running with none", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{not json", "utf8");
    await expect(loadFixtures(path)).rejects.toThrow();
  });
});

describe("report artifact", () => {
  it("is not written when the run never got past its refusals", async () => {
    const out = join(dir, "report.json");
    const code = await main({
      DATABASE_URL: "postgres://user:pw@db.prod.internal:5432/datahub",
      PARITY_LEGACY_ORIGIN: "http://legacy.test",
      PARITY_MODULE_ORIGIN: "http://module.test",
      PARITY_PRODUCTION_HOSTS: "db.prod.internal",
      PARITY_JSON_OUT: out,
    } as NodeJS.ProcessEnv);

    expect(code).toBe(3);
    // A stale or absent report is better than one implying a run happened.
    await expect(readFile(out, "utf8")).rejects.toThrow();
  });
});
