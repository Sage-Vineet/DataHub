import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createCimRouter } from "./router.js";
import type { CimService } from "./service.js";

/**
 * The CIM builder HTTP contract.
 *
 * The integration and service suites drive the behaviour; what is left is the
 * router's own decisions. The accept/discard pair is worth pinning: accepting
 * puts a seller's answer into a document a buyer reads, discarding retains it
 * as history, and they are separate routes precisely so one cannot be mistaken
 * for the other.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECK = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const BLOCK = "33333333-3333-4333-8333-333333333333";

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
    listDecks: record("listDecks", []),
    createDeck: record("createDeck", { id: DECK }),
    listVersions: record("listVersions", []),
    createVersion: record("createVersion", { id: VERSION }),
    getVersion: record("getVersion", { id: VERSION, blocks: [] }),
    upsertBlocks: record("upsertBlocks", { updated: 1 }),
    setApproval: record("setApproval", { approved: true }),
    gaps: record("gaps", []),
    generateQuestions: record("generateQuestions", { created: 2 }),
    reviewQueue: record("reviewQueue", []),
    acceptAnswer: record("acceptAnswer", { block_id: BLOCK }),
    discardAnswer: record("discardAnswer", { block_id: BLOCK }),
    health: record("health", { ready: true }),
    publish: record("publish", { published: true }),
    ...over,
  } as unknown as CimService;

  const app = express();
  app.use(createCimRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const methods = (calls: Array<{ method: string }>) => calls.map((c) => c.method);

describe("decks and versions", () => {
  it("lists and reads without confusing the two levels", async () => {
    const { app, calls } = stub();
    await request(app).get(`/cim/companies/${COMPANY}/decks`).expect(200);
    await request(app).get(`/cim/decks/${DECK}/versions`).expect(200);
    await request(app).get(`/cim/versions/${VERSION}`).expect(200);

    expect(methods(calls)).toEqual(["listDecks", "listVersions", "getVersion"]);
  });

  it("400s a deck with no name", async () => {
    const { app, calls } = stub();
    await request(app).post(`/cim/companies/${COMPANY}/decks`).send({}).expect(400);
    expect(calls).toEqual([]);
  });
});

describe("the review queue", () => {
  it("keeps accepting and discarding as separate routes", async () => {
    // Accepting puts a seller's answer into a document a buyer reads;
    // discarding retains it as history. One must not be reachable as the other.
    const { app, calls } = stub();
    await request(app)
      .post(`/cim/blocks/${BLOCK}/accept-answer`)
      .send({ qa_item_id: DECK, qa_response_id: VERSION, mode: "skip" });
    await request(app)
      .post(`/cim/blocks/${BLOCK}/discard-answer`)
      .send({ qa_item_id: DECK, qa_response_id: VERSION });

    expect(methods(calls)).toEqual(["acceptAnswer", "discardAnswer"]);
  });

  it("400s an accept that names no answer", async () => {
    const { app, calls } = stub();
    await request(app).post(`/cim/blocks/${BLOCK}/accept-answer`).send({}).expect(400);
    expect(calls).toEqual([]);
  });

  it("serves the queue, the gaps and the health check", async () => {
    const { app, calls } = stub();
    await request(app).get(`/cim/versions/${VERSION}/review-queue`).expect(200);
    await request(app).get(`/cim/versions/${VERSION}/gaps`).expect(200);
    await request(app).get(`/cim/versions/${VERSION}/health`).expect(200);

    expect(methods(calls)).toEqual(["reviewQueue", "gaps", "health"]);
  });
});

describe("editing and publishing", () => {
  it("400s a block upsert the contract rejects", async () => {
    const { app, calls } = stub();
    await request(app).put(`/cim/versions/${VERSION}/blocks`).send({ blocks: "nope" }).expect(400);
    expect(calls).toEqual([]);
  });

  it("records approval and publishes", async () => {
    const { app, calls } = stub();
    await request(app).post(`/cim/versions/${VERSION}/approval`).send({ approved: true });
    await request(app).post(`/cim/versions/${VERSION}/publish`).send({});

    expect(methods(calls)).toContain("publish");
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
      const { app } = stub({ getVersion: () => Promise.reject(err) });
      await request(app).get(`/cim/versions/${VERSION}`).expect(status);
    }
  });

  it("passes an unexpected failure on rather than reporting success", async () => {
    const { app } = stub({ listDecks: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/cim/companies/${COMPANY}/decks`).expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    const { app } = stub();
    await request(app).get(`/companies/${COMPANY}/folders`).expect(404);
  });
});
