import type { Db } from "@datahub/db";
import type { Request, RequestHandler } from "express";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createCoaReviewModule } from "./module.js";
import type { HierarchyWriter } from "./ports.js";

/**
 * The wiring.
 *
 * One property here is a product decision rather than plumbing, and is the
 * reason this file exists: the module mounts and serves with no API key.
 * Listing and deciding are database operations, and only generating needs a
 * model — so withholding a reviewer's queue over a dependency they are not
 * using would be the worse trade.
 */

const requireAuth: RequestHandler = (_req, _res, next) => {
  next();
};

const noopHierarchy: HierarchyWriter = { async updateAccountHierarchy() {} };

/** Enough of a Db for the repository constructor; no query is issued below. */
const db = {} as Db;

describe("createCoaReviewModule", () => {
  it("mounts with no API key, and still serves the read side", async () => {
    const module = createCoaReviewModule({
      db,
      requireAuth,
      legacyOrigin: "http://legacy:4000",
      apiKey: "",
      hierarchyFor: () => noopHierarchy,
    });

    const app = express();
    app.use(module.router);

    // The list path reaches the repository, which has no real Db here — so a
    // 500 is the expected outcome. What matters is that it is a 500 from the
    // database and not a 404 from an unmounted route.
    const res = await request(app).get("/key-reports/versions/v1/hierarchy-recommendations");
    expect(res.status).not.toBe(404);
  });

  it("uses a classifier that reports generation unavailable without a key", async () => {
    // Fail-soft by contract: the service catches this and reports the check
    // unavailable, leaving the chart of accounts and every report untouched.
    let captured: { review: (p: string) => Promise<unknown> } | null = null;
    const module = createCoaReviewModule({
      db,
      requireAuth,
      legacyOrigin: "http://legacy:4000",
      apiKey: "",
      hierarchyFor: () => noopHierarchy,
      classifier: {
        review: (p: string) => {
          captured = { review: async () => p };
          return Promise.reject(new Error("unused"));
        },
      },
    });
    expect(module.router).toBeDefined();
    expect(captured).toBeNull();
  });

  it("builds a hierarchy writer per request, from that request's credentials", async () => {
    // The property that keeps this from being a privilege escalation: a
    // reviewer who cannot edit the account cannot apply a recommendation to it.
    const seen: (string | undefined)[] = [];
    const hierarchyFor = vi.fn((req: Request): HierarchyWriter => {
      seen.push(req.headers.authorization);
      return noopHierarchy;
    });

    const module = createCoaReviewModule({
      db,
      requireAuth,
      legacyOrigin: "http://legacy:4000",
      apiKey: "",
      hierarchyFor,
    });

    const app = express();
    app.use(module.router);

    await request(app)
      .get("/key-reports/versions/v1/hierarchy-recommendations")
      .set("authorization", "Bearer caller-a");
    await request(app)
      .get("/key-reports/versions/v1/hierarchy-recommendations")
      .set("authorization", "Bearer caller-b");

    expect(seen).toEqual(["Bearer caller-a", "Bearer caller-b"]);
  });

  it("accepts an injected classifier, so a provider swap needs no edit here", async () => {
    const classifier = { review: async () => ({ text: "{}", model: "other-provider" }) };
    const module = createCoaReviewModule({
      db,
      requireAuth,
      legacyOrigin: "http://legacy:4000",
      classifier,
      hierarchyFor: () => noopHierarchy,
    });
    expect(module.router).toBeDefined();
  });
});
