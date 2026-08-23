import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createFoldersRouter } from "./router.js";
import type { FoldersService } from "./service.js";

/**
 * The folders and folder-access HTTP contract.
 *
 * The access routes matter most. `/folders/:id/access` is what decides who can
 * see a deal's documents, so the router must reach the right service method for
 * each verb — a grant handled as an update, or a revoke as a read, is a
 * permission bug that a 200 hides.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOLDER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ACCESS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

  const folder = { id: FOLDER, name: "Financials" };
  const service = {
    tree: record("tree", []),
    list: record("list", [folder]),
    create: record("create", folder),
    ensureDefaultsForCompany: record("ensureDefaultsForCompany", { created: 3 }),
    update: record("update", folder),
    delete: record("delete", undefined),
    move: record("move", folder),
    archive: record("archive", folder),
    unarchive: record("unarchive", folder),
    listAccess: record("listAccess", []),
    createAccess: record("createAccess", { id: ACCESS }),
    updateAccess: record("updateAccess", { id: ACCESS }),
    deleteAccess: record("deleteAccess", undefined),
    ...over,
  } as unknown as FoldersService;

  const app = express();
  app.use(createFoldersRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const methods = (calls: Array<{ method: string }>) => calls.map((c) => c.method);

describe("reading a company's folders", () => {
  it("lists and returns the tree from different endpoints", async () => {
    const { app, calls } = stub();
    await request(app).get(`/companies/${COMPANY}/folders`).expect(200);
    await request(app).get(`/companies/${COMPANY}/folders/tree`).expect(200);

    // `/tree` is declared before `/folders`, so a mix-up here shows as the
    // wrong method having been called rather than as a failure.
    expect(methods(calls)).toEqual(["list", "tree"]);
  });
});

describe("changing folders", () => {
  it("creates, renames, moves, archives, unarchives and deletes", async () => {
    const { app, calls } = stub();
    await request(app).post(`/companies/${COMPANY}/folders`).send({ name: "New" });
    await request(app).patch(`/folders/${FOLDER}`).send({ name: "Renamed" });
    await request(app).post(`/folders/${FOLDER}/move`).send({ parent_id: null });
    await request(app).post(`/folders/${FOLDER}/archive`).send({});
    await request(app).post(`/folders/${FOLDER}/unarchive`).send({});
    await request(app).delete(`/folders/${FOLDER}`).expect(204);

    expect(methods(calls)).toEqual(["create", "update", "move", "archive", "unarchive", "delete"]);
  });

  it("provisions the default set for a company", async () => {
    const { app, calls } = stub();
    await request(app).post(`/companies/${COMPANY}/folders/ensure-defaults`).send({}).expect(200);
    expect(methods(calls)).toContain("ensureDefaultsForCompany");
  });
});

describe("folder access", () => {
  it("routes each verb to its own operation", async () => {
    // A grant handled as an update, or a revoke as a read, is a permission bug
    // that a 200 would hide.
    const { app, calls } = stub();
    await request(app).get(`/folders/${FOLDER}/access`).expect(200);
    await request(app)
      .post(`/folders/${FOLDER}/access`)
      .send({ user_id: "11111111-1111-4111-8111-111111111111", can_read: true });
    await request(app).patch(`/folder-access/${ACCESS}`).send({ can_write: true });
    await request(app).delete(`/folder-access/${ACCESS}`);

    expect(methods(calls)).toEqual(["listAccess", "createAccess", "updateAccess", "deleteAccess"]);
  });

  it("passes the access id through on update and revoke", async () => {
    const { app, calls } = stub();
    await request(app).patch(`/folder-access/${ACCESS}`).send({ can_write: true });
    await request(app).delete(`/folder-access/${ACCESS}`);

    for (const call of calls) expect(call.args).toContain(ACCESS);
  });
});

describe("what a domain error becomes on the wire", () => {
  it("400s a body the contract rejects, before the service is reached", async () => {
    const { app, calls } = stub();
    const res = await request(app).post(`/companies/${COMPANY}/folders`).send({}).expect(400);
    expect(typeof res.body.error).toBe("string");
    expect(calls).toEqual([]);
  });

  it("400s a grant naming both a user and a group, or neither", async () => {
    // Exactly one, or the row means two different things at once.
    const { app } = stub();
    await request(app).post(`/folders/${FOLDER}/access`).send({ can_read: true }).expect(400);
    await request(app)
      .post(`/folders/${FOLDER}/access`)
      .send({
        user_id: "11111111-1111-4111-8111-111111111111",
        group_id: "22222222-2222-4222-8222-222222222222",
        can_read: true,
      })
      .expect(400);
  });

  it("400s a domain rejection from the service too", async () => {
    const { app } = stub({ move: () => Promise.reject(new BadRequestError("cannot nest")) });
    const res = await request(app).post(`/folders/${FOLDER}/move`).send({ parent_id: null }).expect(400);
    expect(res.body).toEqual({ error: "cannot nest" });
  });

  it("403s a company the caller is not on", async () => {
    const { app } = stub({ list: () => Promise.reject(new ForbiddenError("denied")) });
    await request(app).get(`/companies/${COMPANY}/folders`).expect(403);
  });

  it("404s a folder that does not exist", async () => {
    const { app } = stub({ update: () => Promise.reject(new NotFoundError("Not found")) });
    await request(app).patch(`/folders/${FOLDER}`).send({ name: "x" }).expect(404);
  });

  it("passes an unexpected failure on rather than reporting success", async () => {
    const { app } = stub({ tree: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/companies/${COMPANY}/folders/tree`).expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    const { app } = stub();
    await request(app).get(`/companies/${COMPANY}/requests`).expect(404);
    await request(app).get("/uploads/x/content").expect(404);
  });
});
