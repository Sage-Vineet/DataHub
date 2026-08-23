import express from "express";
import type { Request, RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createCoaReviewRouter } from "./router.js";
import type { CoaReviewService } from "./service.js";
import type { ApplyResult } from "./ports.js";

/**
 * The HTTP contract.
 *
 * Two things here are worth a test rather than a reading. A stale
 * recommendation must be a **409** and not a generic failure — the difference
 * between "re-run the check" and "this proposal was unsafe" is the whole reason
 * `apply` exists alongside `accept`. And the service must be built per request,
 * because the hierarchy writer forwards the caller's own credentials; a
 * boot-time singleton would have to hold a service identity and would turn the
 * review UI into a privilege escalation.
 */

const authAs = (id: string | null): RequestHandler => (req, _res, next) => {
  // A full session user, not `{ id }`: `req.user` is typed as `SessionUser`,
  // and a partial one only typechecked because tests were excluded from tsc.
  if (id) {
    req.user = {
      id,
      name: "Reviewer",
      email: `${id}@example.test`,
      role: "broker",
      company_id: null,
      status: "active",
      company_ids: [],
    };
  }
  next();
};

/** A service where each method is scripted, and every call is recorded. */
function stubService(over: Partial<CoaReviewService> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const service = {
    listRecommendations: record("list", [{ id: "r1", status: "PENDING" }]),
    applyRecommendation: record<ApplyResult>("apply", { ok: true, accountId: "acc-1" }),
    acceptRecommendation: record("accept", { accountId: "acc-1" }),
    rejectRecommendation: record("reject", { ok: true as const }),
    ignoreRecommendation: record("reject", { ok: true as const }),
    now: () => new Date(),
    ...over,
  } as unknown as CoaReviewService;

  return { service, calls };
}

function appWith(service: CoaReviewService, userId: string | null = "user-1") {
  const seen: Request[] = [];
  const app = express();
  app.use(
    createCoaReviewRouter({
      serviceFor: (req) => {
        seen.push(req);
        return service;
      },
      requireAuth: authAs(userId),
    }),
  );
  return { app, seen };
}

describe("GET hierarchy-recommendations", () => {
  it("returns the list in the shape the SPA already reads", async () => {
    const { service, calls } = stubService();
    const { app } = appWith(service);

    const res = await request(app).get("/key-reports/versions/ver-1/hierarchy-recommendations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, recommendations: [{ id: "r1", status: "PENDING" }] });
    expect(calls[0]).toMatchObject({ method: "list", args: ["ver-1"] });
  });
});

describe("POST .../apply", () => {
  it("returns the outcome on success", async () => {
    const { service } = stubService();
    const { app } = appWith(service);

    const res = await request(app).post("/key-reports/hierarchy-recommendations/r1/apply");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, accountId: "acc-1" });
  });

  it("answers 409 for a stale recommendation, not a generic error", async () => {
    // The distinction this endpoint exists for: a conflict is regenerable, and
    // "re-run the check" is a different message from "that was unsafe".
    const { service } = stubService({
      applyRecommendation: () =>
        Promise.resolve({
          ok: false,
          conflict: true,
          code: "STALE_RECOMMENDATION",
          message: "This account has changed.",
        } as ApplyResult),
    });
    const { app } = appWith(service);

    const res = await request(app).post("/key-reports/hierarchy-recommendations/r1/apply");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "STALE_RECOMMENDATION" });
  });

  it("answers 422 for a recommendation that is merely inapplicable", async () => {
    const { service } = stubService({
      applyRecommendation: () =>
        Promise.resolve({
          ok: false,
          code: "UNSAFE_RECOMMENDATION",
          message: "not a usable path",
        } as ApplyResult),
    });
    const { app } = appWith(service);

    const res = await request(app).post("/key-reports/hierarchy-recommendations/r1/apply");
    expect(res.status).toBe(422);
  });

  it("passes the acting user through, and null when anonymous", async () => {
    const { service, calls } = stubService();
    const { app } = appWith(service, "user-9");
    await request(app).post("/key-reports/hierarchy-recommendations/r1/apply");
    expect(calls[0]!.args).toEqual(["r1", "user-9"]);

    const anon = stubService();
    const { app: anonApp } = appWith(anon.service, null);
    await request(anonApp).post("/key-reports/hierarchy-recommendations/r1/apply");
    expect(anon.calls[0]!.args).toEqual(["r1", null]);
  });
});

describe("POST .../accept — the legacy name, same guarantees", () => {
  it("returns the outcome on success", async () => {
    const { service } = stubService();
    const { app } = appWith(service);
    const res = await request(app).post("/key-reports/hierarchy-recommendations/r1/accept");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, accountId: "acc-1" });
  });

  it("maps its thrown conflict to 409, so the two endpoints agree", async () => {
    // `accept` keeps the original throwing contract; if it reported a stale row
    // differently from `apply`, the SPA would get two answers to one question.
    const err = Object.assign(new Error("This account has changed."), {
      code: "STALE_RECOMMENDATION",
      conflict: true,
    });
    const { service } = stubService({ acceptRecommendation: () => Promise.reject(err) });
    const { app } = appWith(service);

    const res = await request(app).post("/key-reports/hierarchy-recommendations/r1/accept");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: "STALE_RECOMMENDATION" });
  });

  it("maps a non-conflict failure to 422", async () => {
    const err = Object.assign(new Error("already rejected"), { code: "ALREADY_REJECTED" });
    const { service } = stubService({ acceptRecommendation: () => Promise.reject(err) });
    const { app } = appWith(service);
    expect((await request(app).post("/key-reports/hierarchy-recommendations/r1/accept")).status).toBe(
      422,
    );
  });
});

describe("POST .../reject and .../ignore", () => {
  it("records a reason", async () => {
    const { service, calls } = stubService();
    const { app } = appWith(service);

    const res = await request(app)
      .post("/key-reports/hierarchy-recommendations/r1/reject")
      .send({ reason: "presentation is fine" });

    expect(res.status).toBe(200);
    expect(calls[0]!.args).toEqual(["r1", "user-1", "presentation is fine"]);
  });

  it("sends null rather than a non-string reason", async () => {
    const { service, calls } = stubService();
    const { app } = appWith(service);
    await request(app)
      .post("/key-reports/hierarchy-recommendations/r1/reject")
      .send({ reason: { nested: true } });
    expect(calls[0]!.args[2]).toBeNull();
  });

  it("treats ignore as the same operation", async () => {
    // The original engine's name, kept because the existing SPA hook calls it.
    const { service, calls } = stubService();
    const { app } = appWith(service);
    await request(app).post("/key-reports/hierarchy-recommendations/r1/ignore");
    expect(calls[0]!.method).toBe("reject");
  });
});

describe("request scoping", () => {
  it("builds a service per request, from that request", async () => {
    const { service } = stubService();
    const { app, seen } = appWith(service);

    await request(app).get("/key-reports/versions/v1/hierarchy-recommendations");
    await request(app).post("/key-reports/hierarchy-recommendations/r1/apply");

    // Two requests, two constructions, each handed its own request — which is
    // what lets the hierarchy writer carry the caller's credentials.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
