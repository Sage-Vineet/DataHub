import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createRequestsRouter } from "./router.js";
import type { RequestsService } from "./service.js";

/**
 * The requests HTTP contract.
 *
 * The narrative endpoints are the interesting pair: `/narrative` 404s when
 * nothing has been written, while `/narrative/file` answers 200 with empty
 * content — the detail pane renders an editor either way, and asking for the
 * resource is a different question from asking what to render.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST = "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
const DOCUMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

  const req = { id: REQUEST, title: "Q2 statements" };
  const service = {
    list: record("list", [req]),
    listReminders: record("listReminders", []),
    create: record("create", req),
    createBulk: record("createBulk", [req]),
    get: record("get", req),
    update: record("update", req),
    approve: record("approve", req),
    delete: record("delete", undefined),
    addReminder: record("addReminder", { sent: true }),
    getNarrative: record("getNarrative", { content: "written" }),
    getNarrativeFile: record("getNarrativeFile", {
      content: "",
      author_name: null,
      author_role: null,
      updated_at: null,
    }),
    updateNarrative: record("updateNarrative", { content: "new" }),
    listDocuments: record("listDocuments", []),
    linkDocument: record("linkDocument", { document_id: DOCUMENT }),
    ...over,
  } as unknown as RequestsService;

  const app = express();
  app.use(createRequestsRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const methods = (calls: Array<{ method: string }>) => calls.map((c) => c.method);
const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

const validCreate = {
  title: "Send Q2 statements",
  description: "please",
  category: "Finance",
  response_type: "Upload",
  priority: "high",
  due_date: "2099-12-31",
};

describe("listing", () => {
  it("serves requests and the derived reminder view from the same module", async () => {
    // Reminders are a projection over requests, not a table — which is why they
    // live here rather than in a module of their own.
    const { app, calls } = stub();
    await request(app).get(`/companies/${COMPANY}/requests`).expect(200);
    await request(app).get(`/companies/${COMPANY}/reminders`).expect(200);
    expect(methods(calls)).toEqual(["list", "listReminders"]);
  });
});

describe("creating", () => {
  it("creates one", async () => {
    const { app, calls } = stub();
    await request(app).post(`/companies/${COMPANY}/requests`).send(validCreate).expect(201);
    expect(methods(calls)).toContain("create");
  });

  it("creates many, and does not confuse the bulk route for a single one", async () => {
    const { app, calls } = stub();
    await request(app)
      .post(`/companies/${COMPANY}/requests/bulk`)
      .send({ items: [validCreate] })
      .expect(201);
    expect(methods(calls)).toEqual(["createBulk"]);
  });

  it("400s a body the contract rejects, before reaching the service", async () => {
    const { app, calls } = stub();
    await request(app).post(`/companies/${COMPANY}/requests`).send({}).expect(400);
    await request(app).post(`/companies/${COMPANY}/requests/bulk`).send({}).expect(400);
    expect(calls).toEqual([]);
  });
});

describe("one request", () => {
  it("reads, updates, approves and deletes", async () => {
    const { app, calls } = stub();
    await request(app).get(`/requests/${REQUEST}`).expect(200);
    await request(app).patch(`/requests/${REQUEST}`).send({ title: "Renamed" }).expect(200);
    await request(app).post(`/requests/${REQUEST}/approve`).send({}).expect(200);
    await request(app).delete(`/requests/${REQUEST}`).expect(204);

    expect(methods(calls)).toEqual(["get", "update", "approve", "delete"]);
  });

  it("records a reminder against it", async () => {
    const { app, calls } = stub();
    await request(app).post(`/requests/${REQUEST}/reminders`).send({}).expect(201);
    expect(argsOf(calls, "addReminder")[1]).toBe(REQUEST);
  });
});

describe("the narrative pair", () => {
  it("404s the resource when nothing has been written", async () => {
    const { app } = stub({ getNarrative: () => Promise.resolve(null) });
    const res = await request(app).get(`/requests/${REQUEST}/narrative`).expect(404);
    expect(res.body).toEqual({ error: "No narrative." });
  });

  it("answers 200 with empty content on the render path", async () => {
    // The detail pane draws an editor either way; an absent narrative is empty
    // content, not a missing resource.
    const { app } = stub();
    const res = await request(app).get(`/requests/${REQUEST}/narrative/file`).expect(200);
    expect(res.body).toEqual({
      content: "",
      author_name: null,
      author_role: null,
      updated_at: null,
    });
  });

  it("does not treat `file` as a narrative id", async () => {
    // `/narrative/file` is a sibling route, not `/narrative/:id`.
    const { app, calls } = stub();
    await request(app).get(`/requests/${REQUEST}/narrative/file`).expect(200);
    expect(methods(calls)).toEqual(["getNarrativeFile"]);
  });

  it("writes one, and refuses a body the contract rejects", async () => {
    const { app, calls } = stub();
    await request(app).patch(`/requests/${REQUEST}/narrative`).send({ content: "text" }).expect(200);
    await request(app).patch(`/requests/${REQUEST}/narrative`).send({}).expect(400);
    expect(methods(calls)).toEqual(["updateNarrative"]);
  });
});

describe("documents", () => {
  it("lists and links them", async () => {
    const { app, calls } = stub();
    await request(app).get(`/requests/${REQUEST}/documents`).expect(200);
    await request(app)
      .post(`/requests/${REQUEST}/documents`)
      .send({ document_id: DOCUMENT, visible: true })
      .expect(201);
    expect(methods(calls)).toEqual(["listDocuments", "linkDocument"]);
  });

  it("400s a link with no document", async () => {
    const { app } = stub();
    await request(app).post(`/requests/${REQUEST}/documents`).send({}).expect(400);
  });
});

describe("what a domain error becomes on the wire", () => {
  it("400s, 403s and 404s from the service", async () => {
    const cases: Array<[Error, number]> = [
      [new BadRequestError("bad"), 400],
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("Not found"), 404],
    ];
    for (const [err, status] of cases) {
      const { app } = stub({ get: () => Promise.reject(err) });
      await request(app).get(`/requests/${REQUEST}`).expect(status);
    }
  });

  it("passes an unexpected failure on rather than reporting success", async () => {
    const { app } = stub({ list: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/companies/${COMPANY}/requests`).expect(500);
  });
});
