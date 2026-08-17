import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSuite } from "./runner.js";
import type { Scenario } from "./scenario.js";

/**
 * End-to-end tests over two real HTTP servers.
 *
 * The harness only earns trust if it can be shown to FAIL on a difference that
 * matters and PASS on one that does not. Both are asserted here — including a
 * reproduction of the real defect this harness found in the folders module,
 * where legacy reads `?includeArchived` and the module read `?include_archived`,
 * so the filter silently stopped applying after cutover.
 */

interface Upstream {
  url: string;
  server: Server;
}

type Behaviour = "legacy" | "module";

/** A miniature of the two implementations, sharing one seeded dataset. */
function startUpstream(behaviour: Behaviour): Promise<Upstream> {
  const app = express();
  app.use(express.json());

  const folders = [
    { id: "f1", name: "Financials", archived: false },
    { id: "f2", name: "Old Stuff", archived: true },
  ];

  app.post("/auth/login", (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (password !== "correct") {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }
    // Legacy hands back a bearer token; the module also sets a cookie session.
    if (behaviour === "module") res.setHeader("set-cookie", `datahub.session_token=sess-${email!}; Path=/; HttpOnly`);
    res.json({ token: `token-for-${email!}` });
  });

  function authed(req: express.Request): boolean {
    return Boolean(req.headers.authorization ?? req.headers.cookie);
  }

  app.get("/companies/:id/folders/tree", (req, res) => {
    if (!authed(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // THE DEFECT: the two sides read differently-cased query parameters, so the
    // module ignores the filter the SPA actually sends.
    const raw =
      behaviour === "legacy" ? req.query.includeArchived : req.query.include_archived;
    const includeArchived = raw === "true";
    res.json(folders.filter((f) => includeArchived || !f.archived));
  });

  app.get("/companies/:id/requests", (req, res) => {
    if (!authed(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // Same rows, different order and different generated ids — both legitimate.
    const rows = [
      { id: behaviour === "legacy" ? "r-legacy-1" : "r-module-1", title: "Alpha" },
      { id: behaviour === "legacy" ? "r-legacy-2" : "r-module-2", title: "Beta" },
    ];
    res.json(behaviour === "legacy" ? rows : [...rows].reverse());
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

let control: Upstream;
let candidate: Upstream;

beforeAll(async () => {
  [control, candidate] = await Promise.all([startUpstream("legacy"), startUpstream("module")]);
});

afterAll(() => {
  control.server.close();
  candidate.server.close();
});

function options() {
  return {
    controlUrl: control.url,
    candidateUrl: candidate.url,
    credentials: { broker: { email: "broker@example.com", password: "correct" } },
  };
}

const archivedScenario: Scenario = {
  id: "tree-include-archived",
  domain: "folders",
  spec: "folders-domain > Tenant-scoped folder listing and tree > Archived filter",
  persona: "broker",
  request: {
    method: "GET",
    path: "/companies/c1/folders/tree",
    query: { includeArchived: "true" },
  },
  normalize: { sortArraysBy: { "": "name", $: "name" } },
};

describe("parity runner", () => {
  it("detects the renamed query parameter that silently drops a filter", async () => {
    const summary = await runSuite([archivedScenario], options());

    expect(summary.clean).toBe(false);
    expect(summary.counts.differs).toBe(1);
    // Legacy returns both folders; the module returns only the unarchived one.
    const [result] = summary.results;
    expect(result?.differences.some((d) => d.path.includes("length"))).toBe(true);
  });

  it("passes when only ids and ordering differ", async () => {
    // Different generated ids and a different row order are expected between two
    // implementations; a harness that flagged them would be unusable.
    const summary = await runSuite(
      [
        {
          id: "list",
          domain: "requests",
          spec: "requests-domain > Tenant-scoped requests > Cross-tenant denied",
          persona: "broker",
          request: { method: "GET", path: "/companies/c1/requests" },
          normalize: { sortArraysBy: { "": "title", $: "title" } },
        },
      ],
      options(),
    );

    expect(summary.clean).toBe(true);
    expect(summary.counts.match).toBe(1);
  });

  it("reports the ordering difference when order is part of the contract", async () => {
    // Same scenario without a sort rule: order now counts, so it is reported.
    const summary = await runSuite(
      [
        {
          id: "list-ordered",
          domain: "requests",
          spec: "requests-domain > Tenant-scoped requests > Cross-tenant denied",
          persona: "broker",
          request: { method: "GET", path: "/companies/c1/requests" },
        },
      ],
      options(),
    );
    expect(summary.clean).toBe(false);
  });

  it("authenticates each upstream separately, bearer or cookie", async () => {
    // control issues a token, candidate a cookie; both must reach an authed route.
    const summary = await runSuite([{ ...archivedScenario, id: "authed" }], options());
    expect(summary.results[0]?.control?.status).toBe(200);
    expect(summary.results[0]?.candidate?.status).toBe(200);
  });

  it("enforces an absolute expectation even when both sides agree", async () => {
    const summary = await runSuite(
      [
        {
          id: "anonymous-rejected",
          domain: "folders",
          spec: "folders-domain > Per-folder access grants > Only privileged users manage access",
          persona: "anonymous",
          request: { method: "GET", path: "/companies/c1/folders/tree" },
          expectStatus: 200, // deliberately wrong: both return 401
        },
      ],
      options(),
    );
    expect(summary.clean).toBe(false);
    expect(summary.results[0]?.expectationFailures).toHaveLength(2);
  });

  it("skips mutating scenarios unless explicitly allowed", async () => {
    const mutating: Scenario = {
      id: "create",
      domain: "folders",
      spec: "folders-domain > Create, update, move folders > Create nested folder",
      persona: "broker",
      request: { method: "POST", path: "/companies/c1/folders", body: { name: "New" } },
      mutating: true,
    };
    const skipped = await runSuite([mutating], options());
    expect(skipped.counts.skipped).toBe(1);
    expect(skipped.clean).toBe(true);
  });

  it("records an error instead of throwing when an upstream is unreachable", async () => {
    const summary = await runSuite([archivedScenario], {
      ...options(),
      candidateUrl: "http://127.0.0.1:1",
    });
    expect(summary.counts.error).toBe(1);
    expect(summary.clean).toBe(false);
  });

  it("surfaces a login failure as a scenario error, not a false pass", async () => {
    const summary = await runSuite([archivedScenario], {
      ...options(),
      credentials: { broker: { email: "broker@example.com", password: "wrong" } },
    });
    expect(summary.counts.error).toBe(1);
    expect(summary.results[0]?.error).toMatch(/Login failed/);
  });
});
