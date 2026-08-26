import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createQaRouter } from "./router.js";
import type { QaService } from "./service.js";

/**
 * The Deal Q&A HTTP contract.
 *
 * The integration suite drives the happy paths against a real database; what is
 * left uncovered is the router's own decisions — which malformed bodies are
 * refused before a service is touched, and which failures become which status.
 * Both matter here more than usual: this surface decides what a buyer is shown,
 * so a body that slips through unvalidated is a disclosure question.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

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

  const item = { id: ITEM, question: "What are the top five customers?" };
  const service = {
    listCategories: record("listCategories", []),
    replaceNominees: record("replaceNominees", { nominees: [] }),
    listItems: record("listItems", [item]),
    createItem: record("createItem", item),
    getItem: record("getItem", item),
    updateItem: record("updateItem", item),
    replaceAssignees: record("replaceAssignees", { assignees: [] }),
    postResponse: record("postResponse", { id: "resp-1" }),
    writePresentation: record("writePresentation", { id: "pres-1" }),
    publishPresentation: record("publishPresentation", { id: "pres-1" }),
    audit: record("audit", { entries: [] }),
    attach: record("attach", { id: "att-1" }),
    setVisibility: record("setVisibility", { visible_to: [] }),
    ...over,
  } as unknown as QaService;

  const app = express();
  app.use(
    createQaRouter({
      service,
      requireAuth: authAs("caller-1"),
      ...(over.features ? { features: over.features as never } : {}),
    }),
  );
  return { app, calls };
}

const methods = (calls: Array<{ method: string }>) => calls.map((c) => c.method);

describe("reading", () => {
  it("lists categories, items, one item and its audit", async () => {
    const { app, calls } = stub();
    await request(app).get(`/qa/companies/${COMPANY}/categories`).expect(200);
    await request(app).get(`/qa/companies/${COMPANY}/items`).expect(200);
    await request(app).get(`/qa/items/${ITEM}`).expect(200);
    await request(app).get(`/qa/items/${ITEM}/audit`).expect(200);

    expect(methods(calls)).toEqual(["listCategories", "listItems", "getItem", "audit"]);
  });
});

describe("bodies the router refuses before reaching the service", () => {
  it("refuses a malformed create, assignee list, response and visibility change", async () => {
    // Each of these decides what somebody is shown or held accountable for; an
    // unvalidated body reaching the service is the wrong place to find out.
    const { app, calls } = stub();

    await request(app).post(`/qa/companies/${COMPANY}/items`).send({}).expect(400);
    await request(app).post(`/qa/items/${ITEM}/assignees`).send({ user_ids: [] }).expect(400);
    await request(app).post(`/qa/items/${ITEM}/responses`).send({}).expect(400);
    await request(app).post(`/qa/items/${ITEM}/visibility`).send({ visible_to: "nope" }).expect(400);

    expect(calls).toEqual([]);
  });

  it("refuses a malformed listing query", async () => {
    // The query decides which questions somebody is shown. An unvalidated one
    // reaching the service is the wrong place to find out it was nonsense.
    const { app, calls } = stub();
    await request(app).get(`/qa/companies/${COMPANY}/items?mine=whoever`).expect(400);
    expect(calls).toEqual([]);
  });

  it("refuses a malformed attachment", async () => {
    const { app, calls } = stub();
    await request(app).post(`/qa/items/${ITEM}/attachments`).send({}).expect(400);
    expect(calls).toEqual([]);
  });

  it("names the field a message does not name", async () => {
    // Zod answers "Required" for a missing field, which is identical whichever
    // field it was.
    const { app } = stub();
    const res = await request(app).post(`/qa/items/${ITEM}/attachments`).send({}).expect(400);
    expect(String(res.body.error)).toMatch(/:/);
  });

  it("refuses a malformed nominee replacement", async () => {
    const { app, calls } = stub();
    await request(app)
      .put(`/qa/companies/${COMPANY}/categories/cat-1/nominees`)
      .send({ nominees: "nope" })
      .expect(400);
    expect(calls).toEqual([]);
  });

  it("names the first problem rather than answering with an empty error", async () => {
    const { app } = stub();
    const res = await request(app).post(`/qa/companies/${COMPANY}/items`).send({}).expect(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });
});

describe("a sub-feature that is switched off", () => {
  it("404s rather than falling through to legacy", async () => {
    // Falling through would proxy the request to a backend that answers it
    // differently, so a flag meant to hide a feature would instead swap which
    // implementation serves it.
    const { app, calls } = stub({ features: { presentation: false, nominations: false } });

    const nominees = await request(app)
      .put(`/qa/companies/${COMPANY}/categories/cat-1/nominees`)
      .send({ user_ids: [USER] })
      .expect(404);
    expect(String(nominees.body.error)).toMatch(/nomination/i);

    await request(app)
      .post(`/qa/items/${ITEM}/presentation`)
      .send({ source_response_id: USER, body: "x" })
      .expect(404);
    expect(calls).toEqual([]);
  });

  it("is on unless the deployment says otherwise", async () => {
    const { app } = stub();
    await request(app)
      .put(`/qa/companies/${COMPANY}/categories/cat-1/nominees`)
      .send({ user_ids: [USER] })
      .expect(200);
  });
});

describe("presentation", () => {
  it("writes a draft and publishes it as separate operations", async () => {
    // A draft is the broker thinking aloud; publishing is what a buyer sees.
    // Collapsing the two would put unreviewed wording in front of a bidder.
    const { app, calls } = stub();
    await request(app)
      .post(`/qa/items/${ITEM}/presentation`)
      .send({ source_response_id: USER, body: "Tidied for a buyer." })
      .expect(201);
    await request(app).post(`/qa/items/${ITEM}/presentation/pres-1/publish`).send({}).expect(200);

    expect(methods(calls)).toEqual(["writePresentation", "publishPresentation"]);
  });

  it("refuses a presentation with nothing in it", async () => {
    const { app, calls } = stub();
    await request(app).post(`/qa/items/${ITEM}/presentation`).send({}).expect(400);
    expect(calls).toEqual([]);
  });
});

describe("what a domain error becomes on the wire", () => {
  it("maps each failure to its own status", async () => {
    const cases: Array<[Error, number]> = [
      [new BadRequestError("bad"), 400],
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("Not found"), 404],
    ];
    for (const [err, status] of cases) {
      const { app } = stub({ getItem: () => Promise.reject(err) });
      const res = await request(app).get(`/qa/items/${ITEM}`).expect(status);
      expect(res.body.error).toBe(err.message);
    }
  });

  it("passes an unexpected failure on rather than reporting success", async () => {
    const { app } = stub({ listItems: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/qa/companies/${COMPANY}/items`).expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    const { app } = stub();
    await request(app).get(`/companies/${COMPANY}/requests`).expect(404);
    await request(app).get(`/qa/items/${ITEM}/unknown`).expect(404);
  });
});

describe("assignment and attachment", () => {
  it("replaces assignees and records an attachment", async () => {
    const { app, calls } = stub();
    await request(app).post(`/qa/items/${ITEM}/assignees`).send({ user_ids: [USER] });
    await request(app)
      .post(`/qa/items/${ITEM}/attachments`)
      .send({
        document_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        folder_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      });

    expect(methods(calls)).toEqual(["replaceAssignees", "attach"]);
  });
});
