import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
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
const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TYPE user_role AS ENUM ('admin','broker','buyer');
CREATE TYPE user_status AS ENUM ('active','inactive');
CREATE TYPE document_status AS ENUM ('active','processing','error');
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text,
  contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false, manual_upload_active boolean NOT NULL DEFAULT false,
  last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
  phone text, password_hash text NOT NULL, role user_role NOT NULL, company_id uuid,
  status user_status NOT NULL DEFAULT 'active',
  sub_role text, designation text, buyer_company_name text, parent_user_id uuid,
  date_of_birth date, occupation text, address text, broker_company text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_companies (
  user_id uuid NOT NULL, company_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, parent_id uuid,
  name text NOT NULL, color text, created_by uuid NOT NULL, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL, content_type text NOT NULL,
  size_bytes integer NOT NULL, data bytea NOT NULL, prefix text, uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name text NOT NULL, file_url text, upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  size text NOT NULL, ext text NOT NULL, status document_status NOT NULL DEFAULT 'active',
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  current_version_id uuid, version_count integer NOT NULL DEFAULT 1
);
CREATE TABLE qa_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key text NOT NULL, label text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (company_id, key)
);
CREATE TABLE qa_nominations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES qa_categories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE (category_id, user_id)
);
CREATE TABLE qa_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id uuid REFERENCES qa_categories(id) ON DELETE SET NULL,
  reference text, title text NOT NULL, body text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','follow_up','closed')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','qe_generator','cim_guided')),
  module_tag text NOT NULL DEFAULT 'Unclassified', section_tag text, account_ref text,
  external_ref text,
  requestor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asked_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz, due_date date, closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE qa_assignees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'requestee' CHECK (kind IN ('requestee','delegate')),
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
  UNIQUE (item_id, user_id, kind)
);
CREATE TABLE qa_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('assigned','reassigned','delegated','removed','status_changed')),
  prior_user_ids uuid[] NOT NULL DEFAULT '{}', new_user_ids uuid[] NOT NULL DEFAULT '{}',
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE qa_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  citation_ref text NOT NULL,
  kind text NOT NULL DEFAULT 'answer' CHECK (kind IN ('answer','comment','clarification')),
  body text NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  posted_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid REFERENCES qa_responses(id) ON DELETE SET NULL,
  answer_root_id uuid, answer_version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX qa_responses_citation_uq ON qa_responses (citation_ref);
CREATE UNIQUE INDEX qa_responses_current_root_uq ON qa_responses (answer_root_id)
  WHERE is_current AND kind = 'answer' AND answer_root_id IS NOT NULL;
CREATE TABLE qa_presentations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  source_response_id uuid NOT NULL REFERENCES qa_responses(id) ON DELETE CASCADE,
  body text NOT NULL, version integer NOT NULL DEFAULT 1, is_current boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE qa_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  response_id uuid REFERENCES qa_responses(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (response_id, document_id)
);
CREATE TABLE qa_item_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES qa_items(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, role_key text,
  effect text NOT NULL DEFAULT 'hide' CHECK (effect IN ('hide','allow')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_item_visibility_subject CHECK ((user_id IS NOT NULL) <> (role_key IS NOT NULL))
);
`;

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
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;

  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme" });
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
