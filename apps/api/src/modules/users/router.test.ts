import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createUsersRouter } from "./router.js";
import type { UsersService } from "./service.js";

/**
 * The `/users` HTTP contract.
 *
 * The service is tested against a fake repository elsewhere. What only the
 * router decides is checked here: that the named routes are reachable at all —
 * `/find-by-email` and `/broker-team/*` sit in front of `/:id` and would
 * otherwise be swallowed as an id — which validation failures become a 400, and
 * that granting or revoking company access emits an activity event, since that
 * is the record of who was given sight of which deal.
 */

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

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function stub(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const service = {
    list: record("list", [{ id: USER_ID }]),
    create: record("create", { id: USER_ID }),
    findByEmail: record("findByEmail", { id: USER_ID }),
    get: record("get", { id: USER_ID }),
    update: record("update", { id: USER_ID }),
    delete: record("delete", undefined),
    inviteBrokerToTeam: record("inviteBrokerToTeam", undefined),
    removeBrokerFromTeam: record("removeBrokerFromTeam", undefined),
    addCompanies: record("addCompanies", { company_ids: [COMPANY] }),
    removeCompanies: record("removeCompanies", { company_ids: [] }),
    ...over,
  } as unknown as UsersService;

  const app = express();
  app.use("/users", createUsersRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

const validUser = {
  name: "New Person",
  email: "new@example.test",
  password: "correct1horse",
  role: "buyer",
};

describe("listing and reading", () => {
  it("lists users for the caller", async () => {
    const { app } = stub();
    const res = await request(app).get("/users").expect(200);
    expect(res.body).toEqual([{ id: USER_ID }]);
  });

  it("reads one by id", async () => {
    const { app, calls } = stub();
    await request(app).get(`/users/${USER_ID}`).expect(200);
    expect(argsOf(calls, "get")[1]).toBe(USER_ID);
  });
});

describe("the named routes in front of /:id", () => {
  it("finds by email rather than treating it as an id", async () => {
    // Declared before `/:id`. If that order ever changes, this asks the service
    // for a user whose id is the string "find-by-email".
    const { app, calls } = stub();
    await request(app).get("/users/find-by-email?email=someone@example.test").expect(200);

    expect(calls.map((c) => c.method)).toContain("findByEmail");
    expect(argsOf(calls, "findByEmail")[1]).toBe("someone@example.test");
  });

  it("400s a find with no email", async () => {
    const { app } = stub();
    const res = await request(app).get("/users/find-by-email").expect(400);
    expect(res.body.error).toMatch(/email query parameter/);
  });

  it("404s a find that matches nobody", async () => {
    const { app } = stub({ findByEmail: () => Promise.resolve(null) });
    await request(app).get("/users/find-by-email?email=nobody@example.test").expect(404);
  });

  it("invites a broker to the team", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .post("/users/broker-team/invite")
      .send({ invited_broker_id: USER_ID })
      .expect(201);

    expect(res.body).toEqual({ message: "Broker invited to team." });
    expect(argsOf(calls, "inviteBrokerToTeam")[1]).toBe(USER_ID);
  });

  it("400s an invite with no broker", async () => {
    const { app } = stub();
    await request(app).post("/users/broker-team/invite").send({}).expect(400);
  });

  it("removes a broker from the team", async () => {
    const { app, calls } = stub();
    await request(app).delete(`/users/broker-team/invite/${USER_ID}`).expect(204);
    expect(argsOf(calls, "removeBrokerFromTeam")[1]).toBe(USER_ID);
  });
});

describe("creating and updating", () => {
  it("creates and answers 201", async () => {
    const { app } = stub();
    const res = await request(app).post("/users").send(validUser).expect(201);
    expect(res.body).toEqual({ id: USER_ID });
  });

  it("400s a create the contract rejects, naming the first problem", async () => {
    const { app } = stub();
    const res = await request(app)
      .post("/users")
      .send({ ...validUser, email: "not-an-email" })
      .expect(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it("updates by id", async () => {
    const { app, calls } = stub();
    await request(app).patch(`/users/${USER_ID}`).send({ name: "Renamed" }).expect(200);
    expect(argsOf(calls, "update")[1]).toBe(USER_ID);
  });

  it("400s an update the contract rejects", async () => {
    const { app } = stub();
    await request(app).patch(`/users/${USER_ID}`).send({ email: "nope" }).expect(400);
  });

  it("deletes with no content", async () => {
    const { app, calls } = stub();
    await request(app).delete(`/users/${USER_ID}`).expect(204);
    expect(argsOf(calls, "delete")[1]).toBe(USER_ID);
  });
});

describe("company access", () => {
  it("grants access and records who granted it", async () => {
    // The activity entry is the record of who was given sight of which deal.
    const { app, calls } = stub();
    const res = await request(app)
      .post(`/users/${USER_ID}/add-companies`)
      .send({ company_ids: [COMPANY] })
      .expect(200);

    expect(res.body).toEqual({ company_ids: [COMPANY] });
    expect(argsOf(calls, "addCompanies")[2]).toEqual([COMPANY]);
  });

  it("revokes access", async () => {
    const { app, calls } = stub();
    await request(app)
      .delete(`/users/${USER_ID}/remove-companies`)
      .send({ company_ids: [COMPANY] })
      .expect(200);
    expect(argsOf(calls, "removeCompanies")[2]).toEqual([COMPANY]);
  });

  it("400s either without a valid company list", async () => {
    const { app } = stub();
    await request(app).post(`/users/${USER_ID}/add-companies`).send({}).expect(400);
    await request(app)
      .delete(`/users/${USER_ID}/remove-companies`)
      .send({ company_ids: "not-an-array" })
      .expect(400);
  });
});

describe("what a domain error becomes on the wire", () => {
  it("404s a user who does not exist", async () => {
    const { app } = stub({ get: () => Promise.reject(new NotFoundError("Not found")) });
    const res = await request(app).get(`/users/${USER_ID}`).expect(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("403s a caller who may not see them", async () => {
    const { app } = stub({ get: () => Promise.reject(new ForbiddenError("denied")) });
    await request(app).get(`/users/${USER_ID}`).expect(403);
  });

  it("passes an unexpected failure on rather than reporting success", async () => {
    const { app } = stub({ list: () => Promise.reject(new Error("boom")) });
    await request(app).get("/users").expect(500);
  });
});
