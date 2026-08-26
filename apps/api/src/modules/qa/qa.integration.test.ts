import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createQaModule } from "./index.js";

/**
 * Deal Q&A against real Postgres.
 *
 * What only a database can prove: the partial unique index that permits exactly
 * one current version per answer lineage, the visibility predicate running as a
 * NOT EXISTS inside the listing query rather than as a filter over its results,
 * and the citation reference's uniqueness constraint.
 */

const BROKER_ID = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "22222222-2222-4222-8222-222222222222";
const CFO_ID = "33333333-3333-4333-8333-333333333333";

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;
let broker: SessionUser;
let seller: SessionUser;
let cfo: SessionUser;

async function categories() {
  const res = await request(app).get(`/qa/companies/${companyId}/categories`);
  return res.body as Array<{ id: string; key: string; nominees: Array<{ user_id: string }> }>;
}

async function ask(body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/qa/companies/${companyId}/items`)
    .send({ title: "Explain Q3", body: "Revenue moved 18%", ...body });
  expect(res.status).toBe(201);
  return res.body;
}

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;

  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  await db.insert(schema.users).values([
    { id: BROKER_ID, name: "Blake Broker", email: "b@x.test", passwordHash: "x", role: "broker", companyId },
    { id: SELLER_ID, name: "Dana Seller", email: "s@x.test", passwordHash: "x", role: "buyer", companyId },
    { id: CFO_ID, name: "Casey CFO", email: "c@x.test", passwordHash: "x", role: "buyer", companyId },
  ]);

  broker = {
    id: BROKER_ID, name: "Blake Broker", email: "b@x.test", role: "broker",
    company_id: companyId, status: "active", company_ids: [companyId],
  };
  seller = { ...broker, id: SELLER_ID, name: "Dana Seller", role: "buyer" };
  cfo = { ...broker, id: CFO_ID, name: "Casey CFO", role: "buyer" };
  current = broker;

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createQaModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

describe("categories provision on first use (real Postgres)", () => {
  it("creates the default vocabulary for a company that has none", async () => {
    const list = await categories();

    expect(list.map((c) => c.key)).toEqual([
      "finance", "legal", "compliance", "hr", "tax", "ma", "other",
    ]);
  });

  it("does not duplicate them when two reads race", async () => {
    // The unique index plus onConflictDoNothing is what makes this safe.
    await Promise.all([categories(), categories(), categories()]);

    const rows = await db.select().from(schema.qaCategories);
    expect(rows).toHaveLength(7);
  });
});

describe("nomination drives assignment (real Postgres)", () => {
  it("assigns the nominee without the asker naming them", async () => {
    const finance = (await categories()).find((c) => c.key === "finance")!;
    current = seller;
    await request(app)
      .put(`/qa/companies/${companyId}/categories/${finance.id}/nominees`)
      .send({ user_ids: [CFO_ID] })
      .expect(200);

    current = broker;
    const item = await ask({ category_id: finance.id });

    expect(item.assignees.map((a: { user_id: string }) => a.user_id)).toEqual([CFO_ID]);
  });

  it("replaces the nominee set rather than accumulating", async () => {
    const finance = (await categories()).find((c) => c.key === "finance")!;
    await request(app)
      .put(`/qa/companies/${companyId}/categories/${finance.id}/nominees`)
      .send({ user_ids: [CFO_ID] });

    const after = await request(app)
      .put(`/qa/companies/${companyId}/categories/${finance.id}/nominees`)
      .send({ user_ids: [SELLER_ID] });

    const updated = (after.body as Array<{ key: string; nominees: Array<{ user_id: string }> }>)
      .find((c) => c.key === "finance")!;
    expect(updated.nominees.map((n) => n.user_id)).toEqual([SELLER_ID]);
  });

  it("refuses a nominee who is not on the deal", async () => {
    const finance = (await categories()).find((c) => c.key === "finance")!;
    const stranger = randomUUID();
    await db.insert(schema.users).values({
      id: stranger, name: "Stranger", email: "x@y.test", passwordHash: "x", role: "buyer",
    });

    const res = await request(app)
      .put(`/qa/companies/${companyId}/categories/${finance.id}/nominees`)
      .send({ user_ids: [stranger] });

    expect(res.status).toBe(400);
  });
});

describe("answers are immutable and versioned (real Postgres)", () => {
  it("has no route that can edit or delete a posted response", async () => {
    const item = await ask();
    const posted = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "original", kind: "answer" });

    // QA-0002 is enforced by the verb not existing. Both fall through the module
    // entirely, because it defines neither.
    const patched = await request(app)
      .patch(`/qa/responses/${posted.body.id}`)
      .send({ body: "rewritten" });
    const deleted = await request(app).delete(`/qa/responses/${posted.body.id}`);

    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    const rows = await db.select().from(schema.qaResponses);
    expect(rows[0]!.body).toBe("original");
  });

  it("permits exactly one current version per answer lineage", async () => {
    const item = await ask();
    const v1 = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "about 4m", kind: "answer" });

    await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "actually 4.2m", kind: "answer", supersedes_id: v1.body.id });

    const rows = await db
      .select()
      .from(schema.qaResponses)
      .where(eq(schema.qaResponses.answerRootId, v1.body.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows.find((r) => r.isCurrent)!.body).toBe("actually 4.2m");
  });

  it("refuses a second current version at the database level", async () => {
    const item = await ask();
    const v1 = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "first", kind: "answer" });

    // The partial unique index is the backstop behind the service's transaction.
    // Drizzle wraps the driver error, so the constraint name lives on the cause
    // rather than the message — assert the invariant it protects, and the name
    // where it actually appears.
    let cause: unknown;
    await expect(
      db
        .insert(schema.qaResponses)
        .values({
          itemId: item.id,
          citationRef: "QA-001.R99",
          body: "sneaky second current",
          authorId: BROKER_ID,
          answerRootId: v1.body.id,
          answerVersion: 2,
        })
        .catch((err: unknown) => {
          cause = (err as { cause?: unknown }).cause;
          throw err;
        }),
    ).rejects.toThrow();
    expect(String((cause as { message?: string } | undefined)?.message ?? "")).toMatch(
      /qa_responses_current_root_uq/,
    );

    const rows = await db
      .select()
      .from(schema.qaResponses)
      .where(eq(schema.qaResponses.answerRootId, v1.body.id));
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  it("keeps every citation reference unique and resolvable", async () => {
    const item = await ask();
    const v1 = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "first", kind: "answer" });
    const v2 = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "second", kind: "answer", supersedes_id: v1.body.id });

    const detail = await request(app).get(`/qa/items/${item.id}`);

    expect(v1.body.citation_ref).not.toBe(v2.body.citation_ref);
    const byRef = (ref: string) =>
      detail.body.responses.find((r: { citation_ref: string }) => r.citation_ref === ref);
    expect(byRef(v1.body.citation_ref).body).toBe("first");
    expect(byRef(v2.body.citation_ref).body).toBe("second");
  });

  it("records the date answered once, on the first answer", async () => {
    const item = await ask();
    await request(app).post(`/qa/items/${item.id}/responses`).send({ body: "a1", kind: "answer" });
    const first = await request(app).get(`/qa/items/${item.id}`);

    await request(app).post(`/qa/items/${item.id}/responses`).send({ body: "a2", kind: "answer" });

    const second = await request(app).get(`/qa/items/${item.id}`);
    expect(second.body.item.answered_at).toBe(first.body.item.answered_at);
  });
});

describe("the broker's rewording (real Postgres)", () => {
  it("writes to its own table, leaving the answer untouched", async () => {
    const item = await ask();
    current = seller;
    const answer = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "we lost Henderson, it got messy", kind: "answer" });

    current = broker;
    await request(app)
      .post(`/qa/items/${item.id}/presentation`)
      .send({ source_response_id: answer.body.id, body: "One customer transitioned out." })
      .expect(201);

    const responses = await db.select().from(schema.qaResponses);
    expect(responses[0]!.body).toBe("we lost Henderson, it got messy");
    const presentations = await db.select().from(schema.qaPresentations);
    expect(presentations[0]!.body).toBe("One customer transitioned out.");
    expect(presentations[0]!.sourceResponseId).toBe(answer.body.id);
  });

  it("keeps a draft away from the other side until it is published", async () => {
    const item = await ask();
    const answer = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "raw", kind: "answer" });
    const draft = await request(app)
      .post(`/qa/items/${item.id}/presentation`)
      .send({ source_response_id: answer.body.id, body: "still thinking" });

    current = seller;
    const beforePublish = await request(app).get(`/qa/items/${item.id}`);
    current = broker;
    await request(app)
      .post(`/qa/items/${item.id}/presentation/${draft.body.id}/publish`)
      .expect(200);
    current = seller;
    const afterPublish = await request(app).get(`/qa/items/${item.id}`);

    expect(beforePublish.body.presentations).toHaveLength(0);
    expect(afterPublish.body.presentations.map((p: { body: string }) => p.body)).toEqual([
      "still thinking",
    ]);
  });

  it("stops a counterparty writing one", async () => {
    const item = await ask();
    const answer = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "raw", kind: "answer" });

    current = seller;
    const res = await request(app)
      .post(`/qa/items/${item.id}/presentation`)
      .send({ source_response_id: answer.body.id, body: "self-serving" });

    expect(res.status).toBe(403);
  });
});

describe("visibility runs inside the query (real Postgres)", () => {
  it("keeps a hidden item out of the listing entirely", async () => {
    const hidden = await ask({ title: "Sensitive" });
    await ask({ title: "Ordinary" });
    await request(app)
      .post(`/qa/items/${hidden.id}/visibility`)
      .send({ user_id: CFO_ID, effect: "hide" })
      .expect(204);

    current = cfo;
    const listed = await request(app).get(`/qa/companies/${companyId}/items`);

    expect(listed.body.map((i: { title: string }) => i.title)).toEqual(["Ordinary"]);
  });

  it("makes a hidden item unreachable by id", async () => {
    const hidden = await ask();
    await request(app).post(`/qa/items/${hidden.id}/visibility`).send({
      user_id: CFO_ID,
      effect: "hide",
    });

    current = cfo;
    const res = await request(app).get(`/qa/items/${hidden.id}`);

    // Not found rather than forbidden — confirming existence is itself a leak.
    expect(res.status).toBe(404);
  });

  it("lets an explicit allow carve one person out of a role-wide hide", async () => {
    const item = await ask();
    await request(app).post(`/qa/items/${item.id}/visibility`).send({
      role_key: "buyer",
      effect: "hide",
    });
    await request(app).post(`/qa/items/${item.id}/visibility`).send({
      user_id: SELLER_ID,
      effect: "allow",
    });

    current = seller;
    const asSeller = await request(app).get(`/qa/companies/${companyId}/items`);
    current = cfo;
    const asCfo = await request(app).get(`/qa/companies/${companyId}/items`);

    expect(asSeller.body).toHaveLength(1);
    expect(asCfo.body).toHaveLength(0);
  });

  it("refuses a visibility rule naming both a user and a role", async () => {
    const item = await ask();

    const res = await request(app)
      .post(`/qa/items/${item.id}/visibility`)
      .send({ user_id: SELLER_ID, role_key: "buyer", effect: "hide" });

    expect(res.status).toBe(400);
  });
});

describe("evidence attaches to an answer (real Postgres)", () => {
  /**
   * A document inserted the way the deployed database requires.
   *
   * `documents.status` is NOT NULL with no overlap between the deployed enum and
   * the one packages/db declares, so this goes in as explicit SQL with an
   * explicit `under-review` rather than through Drizzle.
   */
  async function fileInDataRoom(name: string) {
    const folderId = randomUUID();
    const documentId = randomUUID();
    await client.exec(`
      INSERT INTO folders (id, company_id, name, created_by)
      VALUES ('${folderId}', '${companyId}', 'Legal', '${BROKER_ID}');
      INSERT INTO documents (id, company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
      VALUES ('${documentId}', '${companyId}', '${folderId}', '${name}', '', '12 KB', 'pdf',
              'under-review', '${SELLER_ID}');
    `);
    return { folderId, documentId };
  }

  it("returns the attachment on the answer it was bound to", async () => {
    const item = await ask();
    current = seller;
    const answer = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "Attached the signed lease.", kind: "answer" });
    const { folderId, documentId } = await fileInDataRoom("lease.pdf");

    const attached = await request(app)
      .post(`/qa/items/${item.id}/attachments`)
      .send({ document_id: documentId, folder_id: folderId, response_id: answer.body.id });
    expect(attached.status).toBe(204);

    current = broker;
    const detail = await request(app).get(`/qa/items/${item.id}`);
    const withFile = detail.body.responses.find(
      (r: { attachments: unknown[] }) => r.attachments.length > 0,
    );
    expect(withFile.id).toBe(answer.body.id);
    expect(withFile.attachments[0]).toMatchObject({ document_id: documentId, folder_id: folderId, name: "lease.pdf" });
  });

  it("binds to the current answer when the caller names no response", async () => {
    // The client attaches straight after answering and does not always have the
    // response id to hand. Without this the row is written and never returned.
    const item = await ask();
    current = seller;
    await request(app).post(`/qa/items/${item.id}/responses`).send({ body: "Here it is.", kind: "answer" });
    const { folderId, documentId } = await fileInDataRoom("aging.xlsx");

    await request(app)
      .post(`/qa/items/${item.id}/attachments`)
      .send({ document_id: documentId, folder_id: folderId })
      .expect(204);

    const detail = await request(app).get(`/qa/items/${item.id}`);
    const names = detail.body.responses.flatMap((r: { attachments: Array<{ name: string }> }) =>
      r.attachments.map((a) => a.name),
    );
    expect(names).toEqual(["aging.xlsx"]);
  });

  it("records one row when the same document is attached twice", async () => {
    // The seller's client retries a failed link against the document it already
    // uploaded. That retry is only safe because the second attach is a no-op.
    const item = await ask();
    current = seller;
    const answer = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "Attached.", kind: "answer" });
    const { folderId, documentId } = await fileInDataRoom("lease.pdf");
    const body = { document_id: documentId, folder_id: folderId, response_id: answer.body.id };

    await request(app).post(`/qa/items/${item.id}/attachments`).send(body).expect(204);
    await request(app).post(`/qa/items/${item.id}/attachments`).send(body).expect(204);

    const rows = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM qa_attachments WHERE document_id = $1`,
      [documentId],
    );
    expect(rows.rows[0]!.n).toBe(1);

    const detail = await request(app).get(`/qa/items/${item.id}`);
    const all = detail.body.responses.flatMap((r: { attachments: unknown[] }) => r.attachments);
    expect(all).toHaveLength(1);
  });

  it("refuses a document belonging to another deal", async () => {
    const item = await ask();
    const otherCompany = randomUUID();
    const folderId = randomUUID();
    const documentId = randomUUID();
    await client.exec(`
      INSERT INTO companies (id, name, industry)
      VALUES ('${otherCompany}', 'Other Co', '');
      INSERT INTO folders (id, company_id, name, created_by)
      VALUES ('${folderId}', '${otherCompany}', 'Legal', '${BROKER_ID}');
      INSERT INTO documents (id, company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
      VALUES ('${documentId}', '${otherCompany}', '${folderId}', 'theirs.pdf', '', '1 KB', 'pdf',
              'under-review', '${BROKER_ID}');
    `);

    const res = await request(app)
      .post(`/qa/items/${item.id}/attachments`)
      .send({ document_id: documentId, folder_id: folderId });

    expect(res.status).toBe(403);
    const rows = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM qa_attachments`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });
});

describe("assignment history (real Postgres)", () => {
  it("records who moved an item, and from what to what", async () => {
    const item = await ask({ requestee_ids: [SELLER_ID] });

    current = cfo;
    await request(app)
      .post(`/qa/items/${item.id}/assignees`)
      .send({ user_ids: [CFO_ID], kind: "delegate" })
      .expect(200);

    const detail = await request(app).get(`/qa/items/${item.id}`);
    const last = detail.body.history.at(-1);
    expect(last.action).toBe("delegated");
    expect(last.prior_user_ids).toEqual([SELLER_ID]);
    expect(last.new_user_ids).toEqual([CFO_ID]);
    expect(last.actor_name).toBe("Casey CFO");
  });

  it("keeps a removed assignee's row for the audit trail", async () => {
    const item = await ask({ requestee_ids: [SELLER_ID] });

    await request(app)
      .post(`/qa/items/${item.id}/assignees`)
      .send({ user_ids: [CFO_ID], kind: "requestee" });

    const rows = await db.select().from(schema.qaAssignees);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.removedAt === null)).toHaveLength(1);
  });
});

describe("the audit trail (real Postgres)", () => {
  it("reconstructs the whole exchange, in order, from three separate records", async () => {
    const item = await ask({ requestee_ids: [SELLER_ID] });
    await request(app)
      .post(`/qa/items/${item.id}/assignees`)
      .send({ user_ids: [CFO_ID], kind: "delegate" });
    current = cfo;
    const v1 = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "about 4m", kind: "answer" });
    await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "actually 4.2m", kind: "answer", supersedes_id: v1.body.id });
    current = broker;
    const draft = await request(app)
      .post(`/qa/items/${item.id}/presentation`)
      .send({ source_response_id: v1.body.id, body: "Approximately 4.2 million." });
    await request(app).post(`/qa/items/${item.id}/presentation/${draft.body.id}/publish`);

    const audit = await request(app).get(`/qa/items/${item.id}/audit`);

    expect(audit.status).toBe(200);
    const kinds = (audit.body.entries as Array<{ kind: string; at: string }>).map((e) => e.kind);
    // Asked, assigned, delegated, answered, corrected, reworded — the exchange,
    // in the order it happened, without the reader interleaving three lists.
    expect(kinds).toContain("asked");
    expect(kinds).toContain("delegated");
    expect(kinds).toContain("answered");
    expect(kinds).toContain("corrected");
    expect(kinds).toContain("reworded");
    const times = (audit.body.entries as Array<{ kind: string; at: string }>).map((e) => e.at);
    expect([...times].sort()).toEqual(times);
  });

  it("attributes every entry to a person", async () => {
    const item = await ask({ requestee_ids: [SELLER_ID] });
    current = seller;
    await request(app).post(`/qa/items/${item.id}/responses`).send({ body: "answered", kind: "answer" });
    current = broker;

    const audit = await request(app).get(`/qa/items/${item.id}/audit`);

    expect(
      (audit.body.entries as Array<{ actor_name: string | null }>).every((e) => e.actor_name),
    ).toBe(true);
  });

  it("keeps an unpublished rewording out of the record", async () => {
    // A draft is the broker thinking aloud; an audit showing it would
    // misrepresent what was ever actually put forward.
    const item = await ask();
    const answer = await request(app)
      .post(`/qa/items/${item.id}/responses`)
      .send({ body: "raw", kind: "answer" });
    await request(app)
      .post(`/qa/items/${item.id}/presentation`)
      .send({ source_response_id: answer.body.id, body: "not published" });

    const audit = await request(app).get(`/qa/items/${item.id}/audit`);

    expect((audit.body.entries as Array<{ kind: string; at: string }>).map((e) => e.kind)).not.toContain("reworded");
  });

  it("refuses the audit of a question the viewer cannot see", async () => {
    const hidden = await ask();
    await request(app).post(`/qa/items/${hidden.id}/visibility`).send({
      user_id: CFO_ID,
      effect: "hide",
    });

    current = cfo;
    const res = await request(app).get(`/qa/items/${hidden.id}/audit`);

    expect(res.status).toBe(404);
  });
});

describe("filters and tenant isolation (real Postgres)", () => {
  it("separates raised-by-me from assigned-to-me", async () => {
    await ask({ requestee_ids: [SELLER_ID] });

    const raised = await request(app).get(`/qa/companies/${companyId}/items?mine=requestor`);
    current = seller;
    const assigned = await request(app).get(`/qa/companies/${companyId}/items?mine=requestee`);

    expect(raised.body).toHaveLength(1);
    expect(assigned.body).toHaveLength(1);
  });

  it("refuses another company's questions", async () => {
    await ask();
    current = { ...broker, company_id: randomUUID(), company_ids: [] };

    const res = await request(app).get(`/qa/companies/${companyId}/items`);

    expect(res.status).toBe(403);
  });

  it("ignores a client trying to claim its question came from a generator", async () => {
    // Provenance is server context. A caller that could set `origin` could make
    // a hand-typed question look machine-generated in the audit trail.
    const item = await ask({ origin: "qe_generator", external_ref: "spoofed" });

    expect(item.origin).toBe("manual");
    expect(item.external_ref).toBeNull();
  });
});
