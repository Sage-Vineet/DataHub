import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createDataRoomRouter } from "./router.js";
import type { DataRoomService } from "./service.js";

/**
 * The data-room HTTP contract.
 *
 * The integration suite drives the resumable upload against a real database.
 * What is left is the router's own handling: a chunk index arrives in the path
 * as a string and must become a number, and an abandoned session must be
 * abortable — otherwise a stalled upload holds its slot forever.
 */

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

const authAs = (id: string): RequestHandler => (req, _res, next) => {
  req.user = {
    id,
    name: "Dana",
    email: "dana@example.test",
    role: "broker",
    company_id: null,
    status: "active",
    company_ids: [],
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
    listVersions: record("listVersions", []),
    versionUploadId: record("versionUploadId", null),
    restoreVersion: record("restoreVersion", { id: VERSION }),
    listComments: record("listComments", []),
    addComment: record("addComment", { id: "c1" }),
    deleteComment: record("deleteComment", undefined),
    openSession: record("openSession", { id: SESSION }),
    getSession: record("getSession", { id: SESSION, received: [] }),
    putChunk: record("putChunk", { received: [0] }),
    completeSession: record("completeSession", { version_id: VERSION }),
    abortSession: record("abortSession", undefined),
    ...over,
  } as unknown as DataRoomService;

  // A storage port that holds nothing, so the content route exercises its
  // "stored content not found" branch rather than needing a real blob store.
  const storage = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(undefined),
  } as unknown as Parameters<typeof createDataRoomRouter>[0]["storage"];

  const app = express();
  app.use(
    createDataRoomRouter({
      service,
      requireAuth: authAs("caller-1"),
      storage,
      features: { versions: true, comments: true, chunkedUpload: true },
    }),
  );
  return { app, calls };
}

const methods = (calls: Array<{ method: string }>) => calls.map((c) => c.method);
const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("versions and comments", () => {
  it("lists versions and comments for a document", async () => {
    const { app, calls } = stub();
    await request(app).get(`/dataroom/documents/${DOCUMENT}/versions`).expect(200);
    await request(app).get(`/dataroom/documents/${DOCUMENT}/comments`).expect(200);
    expect(methods(calls)).toEqual(["listVersions", "listComments"]);
  });

  it("restores a version", async () => {
    const { app, calls } = stub();
    await request(app)
      .post(`/dataroom/documents/${DOCUMENT}/versions/${VERSION}/restore`)
      .send({})
      .expect(201);
    expect(methods(calls)).toContain("restoreVersion");
  });

  it("400s a comment with no body, and deletes one", async () => {
    const { app, calls } = stub();
    await request(app).post(`/dataroom/documents/${DOCUMENT}/comments`).send({}).expect(400);
    await request(app).delete("/dataroom/comments/c1").expect(204);
    expect(methods(calls)).toEqual(["deleteComment"]);
  });

  it("404s content for a version with nothing stored", async () => {
    const { app } = stub();
    await request(app).get(`/dataroom/versions/${VERSION}/content`).expect(404);
  });
});

describe("the resumable upload", () => {
  it("opens, reports, receives a chunk, and completes", async () => {
    const { app, calls } = stub();
    await request(app)
      .post("/dataroom/uploads/sessions")
      .send({
        document_id: DOCUMENT,
        file_name: "big.pdf",
        content_type: "application/pdf",
        size_bytes: 1024,
        chunk_size_bytes: 512,
      });
    await request(app).get(`/dataroom/uploads/sessions/${SESSION}`).expect(200);
    await request(app)
      .put(`/dataroom/uploads/sessions/${SESSION}/chunks/0`)
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("data"));
    await request(app).post(`/dataroom/uploads/sessions/${SESSION}/complete`).send({});

    expect(methods(calls)).toContain("putChunk");
    expect(methods(calls)).toContain("completeSession");
  });

  it("passes the chunk index as a number, not the string from the path", async () => {
    // Chunk 10 arriving as "10" would sort and compare as text, so a resumed
    // upload could reassemble in the wrong order.
    const { app, calls } = stub();
    await request(app)
      .put(`/dataroom/uploads/sessions/${SESSION}/chunks/10`)
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("x"));

    expect(argsOf(calls, "putChunk").some((a) => a === 10)).toBe(true);
  });

  it("aborts an abandoned session rather than leaving it holding its slot", async () => {
    const { app, calls } = stub();
    await request(app).delete(`/dataroom/uploads/sessions/${SESSION}`).expect(204);
    expect(methods(calls)).toEqual(["abortSession"]);
  });

  it("400s a session the contract rejects", async () => {
    const { app, calls } = stub();
    await request(app).post("/dataroom/uploads/sessions").send({}).expect(400);
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
      const { app } = stub({ listVersions: () => Promise.reject(err) });
      await request(app).get(`/dataroom/documents/${DOCUMENT}/versions`).expect(status);
    }
  });

  it("passes an unexpected failure on", async () => {
    const { app } = stub({ listComments: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/dataroom/documents/${DOCUMENT}/comments`).expect(500);
  });
});
