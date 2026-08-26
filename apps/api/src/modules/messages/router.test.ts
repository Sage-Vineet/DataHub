import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../../shared/errors.js";
import { createMessagesRouter } from "./router.js";
import type { MessagesService } from "./service.js";

/**
 * The messages HTTP surface.
 *
 * Eighteen routes and, until now, no router test — the module's service and
 * repository were both covered, so what went unproven was the layer between
 * them: which service call each path makes, which arguments it hands over, and
 * what status comes back.
 *
 * That layer is where a rename goes unnoticed. A path calling the wrong method
 * fails the same way whether the method is wrong or missing, and the two
 * suites either side of it stay green.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP = "99999999-9999-4999-8999-999999999999";
const CALLER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

const MESSAGE = { id: "m-1", company_id: COMPANY, sender_id: CALLER, body: "hello", created_at: "2026-08-20T10:00:00.000Z" };
const GROUP_ROW = { id: GROUP, company_id: COMPANY, name: "Deal Team", group_type: "deal_team", auto_created: false };

function stub(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const service = {
    threads: record("threads", [{ company: { id: COMPANY, name: "Acme" }, last_message: null }]),
    myDirectContacts: record("myDirectContacts", []),
    companyList: record("companyList", [MESSAGE]),
    companySend: record("companySend", MESSAGE),
    directContacts: record("directContacts", { company: { id: COMPANY, name: "Acme" }, contacts: [] }),
    directList: record("directList", [MESSAGE]),
    directSend: record("directSend", MESSAGE),
    groupsForUser: record("groupsForUser", [GROUP_ROW]),
    groupsByCompany: record("groupsByCompany", [GROUP_ROW]),
    autoCreateGroups: record("autoCreateGroups", [GROUP_ROW]),
    createGroup: record("createGroup", GROUP_ROW),
    listMembers: record("listMembers", [CALLER]),
    addMember: record("addMember", [CALLER, OTHER]),
    removeMember: record("removeMember", undefined),
    groupMessages: record("groupMessages", [MESSAGE]),
    sendGroupMessage: record("sendGroupMessage", MESSAGE),
    markRead: record("markRead", undefined),
    unreadCount: record("unreadCount", { unread: 3 }),
    ...over,
  } as unknown as MessagesService;

  const app = express();
  app.use(createMessagesRouter({ service, requireAuth: authAs(CALLER) }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("the rails a person opens the page on", () => {
  it("answers the cross-company thread list", async () => {
    const { app, calls } = stub();
    const res = await request(app).get("/messages/threads").expect(200);
    expect(res.body).toHaveLength(1);
    expect(argsOf(calls, "threads")[0]).toMatchObject({ id: CALLER });
  });

  it("answers the caller's direct contacts across every deal", async () => {
    const { app, calls } = stub();
    await request(app).get("/my-direct-contacts").expect(200);
    expect(argsOf(calls, "myDirectContacts")[0]).toMatchObject({ id: CALLER });
  });

  it("answers the caller's own groups without naming a company", async () => {
    const { app, calls } = stub();
    await request(app).get("/my-groups").expect(200);
    expect(argsOf(calls, "groupsForUser")[0]).toMatchObject({ id: CALLER });
  });
});

describe("a company's conversation", () => {
  it("reads and posts against the company its path names", async () => {
    const { app, calls } = stub();
    await request(app).get(`/companies/${COMPANY}/messages`).expect(200);
    expect(argsOf(calls, "companyList")[1]).toBe(COMPANY);

    await request(app).post(`/companies/${COMPANY}/messages`).send({ body: "hello" }).expect(201);
    expect(argsOf(calls, "companySend")[2]).toBe("hello");
  });

  it("refuses a post with nothing in it", async () => {
    // An empty message posted to a deal room is noise nobody can delete.
    const { app, calls } = stub();
    await request(app).post(`/companies/${COMPANY}/messages`).send({ body: "" }).expect(400);
    expect(calls.filter((c) => c.method === "companySend")).toEqual([]);
  });
});

describe("a direct conversation", () => {
  it("reads and posts against the recipient its path names", async () => {
    const { app, calls } = stub();
    await request(app).get(`/companies/${COMPANY}/direct-messages/${OTHER}`).expect(200);
    expect(argsOf(calls, "directList")[2]).toBe(OTHER);

    await request(app)
      .post(`/companies/${COMPANY}/direct-messages/${OTHER}`)
      .send({ body: "hello" })
      .expect(201);
    expect(argsOf(calls, "directSend").slice(1)).toEqual([COMPANY, OTHER, "hello"]);
  });

  it("lists who can be messaged on one deal", async () => {
    const { app, calls } = stub();
    await request(app).get(`/companies/${COMPANY}/direct-messages/contacts`).expect(200);
    expect(argsOf(calls, "directContacts")[1]).toBe(COMPANY);
  });

  it("refuses a direct post with nothing in it", async () => {
    const { app } = stub();
    await request(app)
      .post(`/companies/${COMPANY}/direct-messages/${OTHER}`)
      .send({})
      .expect(400);
  });
});

describe("groups and who is in them", () => {
  it("lists a company's groups", async () => {
    const { app, calls } = stub();
    await request(app).get(`/companies/${COMPANY}/message-groups`).expect(200);
    expect(argsOf(calls, "groupsByCompany")[1]).toBe(COMPANY);
  });

  it("re-runs auto-creation for a company", async () => {
    const { app, calls } = stub();
    await request(app).post(`/companies/${COMPANY}/message-groups/auto-create`).expect(200);
    expect(argsOf(calls, "autoCreateGroups")[1]).toBe(COMPANY);
  });

  it("creates a group, and answers 201 rather than 200", async () => {
    const { app, calls } = stub();
    await request(app)
      .post(`/companies/${COMPANY}/message-groups`)
      .send({ name: "Deal Team", group_type: "deal_team" })
      .expect(201);
    expect(argsOf(calls, "createGroup")[2]).toMatchObject({ name: "Deal Team" });
  });

  it("names the field when a group create is malformed", async () => {
    // "Required" on its own leaves somebody guessing which field.
    const { app } = stub();
    const res = await request(app)
      .post(`/companies/${COMPANY}/message-groups`)
      .send({ group_type: "deal_team" })
      .expect(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("lists, adds and removes members", async () => {
    const { app, calls } = stub();
    await request(app).get(`/message-groups/${GROUP}/members`).expect(200);
    expect(argsOf(calls, "listMembers")[1]).toBe(GROUP);

    await request(app)
      .post(`/message-groups/${GROUP}/members`)
      .send({ user_id: OTHER })
      .expect(201);
    expect(argsOf(calls, "addMember").slice(1)).toEqual([GROUP, OTHER]);

    // 204: there is no body worth sending, and an empty 200 invites a client
    // to parse one.
    await request(app).delete(`/message-groups/${GROUP}/members/${OTHER}`).expect(204);
    expect(argsOf(calls, "removeMember").slice(1)).toEqual([GROUP, OTHER]);
  });

  it("refuses a member add naming nobody", async () => {
    const { app } = stub();
    await request(app).post(`/message-groups/${GROUP}/members`).send({}).expect(400);
  });
});

describe("a group's messages", () => {
  it("reads, posts, marks read and counts what is unread", async () => {
    const { app, calls } = stub();
    await request(app).get(`/message-groups/${GROUP}/messages`).expect(200);
    expect(argsOf(calls, "groupMessages")[1]).toBe(GROUP);

    await request(app)
      .post(`/message-groups/${GROUP}/messages`)
      .send({ body: "hello" })
      .expect(201);
    expect(argsOf(calls, "sendGroupMessage").slice(1)).toEqual([GROUP, "hello"]);

    await request(app).post(`/message-groups/${GROUP}/messages/mark-read`).expect(204);
    expect(argsOf(calls, "markRead")[1]).toBe(GROUP);

    const res = await request(app).get(`/message-groups/${GROUP}/messages/unread-count`).expect(200);
    expect(res.body).toEqual({ unread: 3 });
  });

  it("refuses a group post with nothing in it", async () => {
    const { app } = stub();
    await request(app).post(`/message-groups/${GROUP}/messages`).send({ body: "   " }).expect(400);
  });
});

describe("what the router does with a failure", () => {
  it("answers a refusal with the status it carries", async () => {
    const { app } = stub({
      companyList: () => Promise.reject(new ForbiddenError("Access denied")),
    });
    const res = await request(app).get(`/companies/${COMPANY}/messages`).expect(403);
    expect(res.body.error).toBe("Access denied");
  });

  it("hands anything else to the error handler rather than dressing it up", async () => {
    const { app } = stub({ threads: () => Promise.reject(new Error("boom")) });
    await request(app).get("/messages/threads").expect(500);
  });
});
