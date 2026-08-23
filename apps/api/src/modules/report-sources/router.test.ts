import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { createReportSourcesRouter } from "./router.js";
import type { ReportSourcesService } from "./service.js";

/**
 * The report-source HTTP contract.
 *
 * The interesting part is that BOTH routes answer the whole state. The
 * selector re-renders every availability and connection badge after a switch,
 * so a response carrying only the new key would leave it showing the old ones.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const STATE = {
  sources: [
    { sourceKey: "quickbooks_online", sourceLabel: "QuickBooks Online", isSelected: true },
    { sourceKey: "manual_gl_upload", sourceLabel: "Manual GL Upload", isSelected: false },
  ],
  selectedSource: "quickbooks_online",
  activeSource: "quickbooks_online",
  quickbooksConnected: false,
  manualUploadActive: false,
  lastSourceSwitchAt: null,
};

const authAs = (id: string): RequestHandler => (req, _res, next) => {
  req.user = {
    id,
    name: "Dana",
    email: "dana@example.test",
    role: "broker",
    company_id: null,
    status: "active",
    company_ids: [COMPANY],
  };
  next();
};

function stub(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const service = {
    getState: record("getState", STATE),
    select: record("select", { ...STATE, selectedSource: "manual_gl_upload" }),
    ...over,
  } as unknown as ReportSourcesService;

  const app = express();
  app.use(createReportSourcesRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("reading the state", () => {
  it("answers the whole thing under the success envelope", async () => {
    const { app } = stub();
    const res = await request(app)
      .get("/report-sources")
      .set("x-client-id", COMPANY)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.sources).toHaveLength(2);
    expect(res.body.selectedSource).toBe("quickbooks_online");
    expect(res.body).toHaveProperty("quickbooksConnected");
    expect(res.body).toHaveProperty("manualUploadActive");
    expect(res.body).toHaveProperty("lastSourceSwitchAt");
  });

  it("takes the company from the header or the query string", async () => {
    const { app, calls } = stub();
    await request(app).get("/report-sources").set("x-client-id", COMPANY).expect(200);
    await request(app).get(`/report-sources?clientId=${COMPANY}`).expect(200);
    for (const call of calls) expect(call.args[1]).toBe(COMPANY);
  });

  it("surfaces a missing company as a 400 with success:false", async () => {
    const { app } = stub({
      getState: () => Promise.reject(new BadRequestError("Missing clientId.")),
    });
    const res = await request(app).get("/report-sources").expect(400);
    expect(res.body).toEqual({ success: false, error: "Missing clientId." });
  });
});

describe("switching", () => {
  it("passes the trimmed key down and answers the new state", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .put("/report-sources/selected")
      .set("x-client-id", COMPANY)
      .send({ sourceKey: "  manual_gl_upload  " })
      .expect(200);

    expect(argsOf(calls, "select")[2]).toBe("manual_gl_upload");
    expect(res.body.selectedSource).toBe("manual_gl_upload");
    // The whole state comes back, so every badge re-renders.
    expect(res.body.sources).toHaveLength(2);
  });

  it("takes the company from the body too, since the switch posts one", async () => {
    const { app, calls } = stub();
    await request(app)
      .put("/report-sources/selected")
      .send({ clientId: COMPANY, sourceKey: "manual_gl_upload" })
      .expect(200);
    expect(argsOf(calls, "select")[1]).toBe(COMPANY);
  });

  it("passes an absent key down as empty, for the service to refuse", async () => {
    const { app, calls } = stub();
    await request(app)
      .put("/report-sources/selected")
      .set("x-client-id", COMPANY)
      .send({})
      .expect(200);
    expect(argsOf(calls, "select")[2]).toBe("");
  });

  it("surfaces an unknown source as a 400", async () => {
    const { app } = stub({
      select: () => Promise.reject(new BadRequestError("Unknown report source: quickbooks.")),
    });
    const res = await request(app)
      .put("/report-sources/selected")
      .set("x-client-id", COMPANY)
      .send({ sourceKey: "quickbooks" })
      .expect(400);
    expect(res.body.error).toContain("quickbooks");
  });

  it("surfaces a company the caller cannot reach as a 403", async () => {
    const { app } = stub({ select: () => Promise.reject(new ForbiddenError("Access denied")) });
    await request(app)
      .put("/report-sources/selected")
      .set("x-client-id", COMPANY)
      .send({ sourceKey: "manual_gl_upload" })
      .expect(403);
  });

  it("passes an unexpected failure on rather than reporting a switch", async () => {
    const { app } = stub({ select: () => Promise.reject(new Error("boom")) });
    await request(app)
      .put("/report-sources/selected")
      .set("x-client-id", COMPANY)
      .send({ sourceKey: "manual_gl_upload" })
      .expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    const { app } = stub();
    await request(app).get("/report-sources/history").expect(404);
    await request(app).post("/report-sources").expect(404);
  });
});
