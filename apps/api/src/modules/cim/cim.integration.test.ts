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
import { createQaModule } from "../qa/index.js";
import { createCimModule } from "./index.js";
import { DrizzleCimDataRoomPort, QaServiceAdapter } from "./adapters.js";

/**
 * The CIM builder against real Postgres, wired to the real Q&A module.
 *
 * The whole point of these is the seam. `CM - 0004`'s guided questions could
 * have been built privately inside the CIM — the SPA already has a questionnaire
 * stored as a JSON blob — and this asserts that they were not: the questions
 * land as ordinary Q&A items, the answer comes back through the Q&A module, and
 * the only thing crossing the boundary is an opaque block id.
 */
const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TYPE user_role AS ENUM ('admin','broker','buyer');
CREATE TYPE user_status AS ENUM ('active','inactive');
-- The enum the deployed database actually has. packages/db declares
-- ('active','processing','error') instead, which shares no value with it — a
-- drift that is real and is why document inserts here use explicit SQL.
CREATE TYPE document_status AS ENUM ('verified','under-review','rejected');
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
  size text NOT NULL, ext text NOT NULL, status document_status NOT NULL DEFAULT 'under-review',
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
  module_tag text NOT NULL DEFAULT 'Unclassified', section_tag text, account_ref text, external_ref text,
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
  body text NOT NULL, author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
CREATE TABLE cim_decks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL, template_key text NOT NULL DEFAULT 'source-38',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE cim_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id uuid NOT NULL REFERENCES cim_decks(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','seller_approved','published','archived')),
  cover jsonb NOT NULL DEFAULT '{}'::jsonb, theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL, approved_at timestamptz,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (deck_id, version_no)
);
CREATE UNIQUE INDEX cim_versions_one_open ON cim_versions (deck_id)
  WHERE status IN ('draft','in_review');
CREATE TABLE cim_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES cim_versions(id) ON DELETE CASCADE,
  section_key text NOT NULL, title text NOT NULL, sort_order integer NOT NULL,
  UNIQUE (version_id, section_key)
);
CREATE TABLE cim_slides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES cim_versions(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES cim_sections(id) ON DELETE CASCADE,
  slide_class text NOT NULL DEFAULT 'qualitative'
    CHECK (slide_class IN ('qualitative','financial_exhibit')),
  layout_key text NOT NULL, slide_no integer NOT NULL, sort_order integer NOT NULL,
  UNIQUE (version_id, sort_order)
);
CREATE TABLE cim_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES cim_versions(id) ON DELETE CASCADE,
  slide_id uuid NOT NULL REFERENCES cim_slides(id) ON DELETE CASCADE,
  block_key text NOT NULL,
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','table','chart','repeatable')),
  label text, content jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_class text NOT NULL DEFAULT 'deal' CHECK (content_class IN ('deal','firm_boilerplate')),
  content_class_locked boolean NOT NULL DEFAULT false,
  populated_by text CHECK (populated_by IS NULL OR populated_by IN ('author','answer','loader','autofill')),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (version_id, block_key)
);
CREATE TABLE cim_question_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'system' CHECK (scope IN ('system','firm','user')),
  owner_id uuid, section_key text NOT NULL, layout_key text, block_key_pattern text,
  question_text text NOT NULL, help_text text, sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz
);
CREATE TABLE cim_block_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL REFERENCES cim_blocks(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('qa_answer','loader','autofill','broker')),
  qa_item_id text, qa_response_id text,
  respondent_id uuid REFERENCES users(id) ON DELETE SET NULL, answered_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'accepted' CHECK (outcome IN ('accepted','discarded')),
  raw_answer text
);
CREATE TABLE cim_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL UNIQUE REFERENCES cim_versions(id) ON DELETE CASCADE,
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  sha256 text NOT NULL, page_count integer, byte_size bigint,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
`;

const BROKER_ID = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "22222222-2222-4222-8222-222222222222";

let client: PGlite;
let db: Db;
let cimApp: express.Express;
let qaApp: express.Express;
let companyId: string;
let folderId: string;
let broker: SessionUser;
let seller: SessionUser;
let qaCurrent: SessionUser;

async function newDeck() {
  const res = await request(cimApp)
    .post(`/cim/companies/${companyId}/decks`)
    .send({ name: "Project Atlas CIM" });
  expect(res.status).toBe(201);
  return res.body as { id: string; current_version_id: string };
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
  ]);
  folderId = randomUUID();
  await db
    .insert(schema.folders)
    .values({ id: folderId, companyId, name: "Financials", createdBy: BROKER_ID });

  broker = {
    id: BROKER_ID, name: "Blake Broker", email: "b@x.test", role: "broker",
    company_id: companyId, status: "active", company_ids: [companyId],
  };
  seller = { ...broker, id: SELLER_ID, name: "Dana Seller", role: "buyer" };
  qaCurrent = seller;

  const qa = createQaModule({
    db,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      req.user = qaCurrent;
      next();
    },
  });
  qaApp = express();
  qaApp.use("/", qa.router);

  const cim = createCimModule({
    db,
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
      req.user = broker;
      next();
    },
    dataRoom: new DrizzleCimDataRoomPort(db, async () => folderId),
    // No `|| BROKER_ID` fallback: an earlier version of this test had one, and it
    // masked an adapter that passed an empty user id on every read — which
    // reaches Postgres as an empty uuid and fails the query outright.
    qa: new QaServiceAdapter(qa.service, (cId, userId) => ({
      id: userId,
      name: "CIM",
      email: "",
      role: "broker",
      company_id: cId,
      status: "active",
      company_ids: [cId],
    })),
  });
  cimApp = express();
  cimApp.use("/", cim.router);
});

afterEach(async () => {
  await client.close();
});

describe("a new CIM (real Postgres)", () => {
  it("lands the full outline in the database", async () => {
    const deck = await newDeck();

    const detail = await request(cimApp).get(`/cim/versions/${deck.current_version_id}`);

    expect(detail.body.sections).toHaveLength(11);
    const blocks = await db.select().from(schema.cimBlocks);
    expect(blocks.length).toBeGreaterThan(20);
    expect(blocks.every((b) => b.contentClass === "deal")).toBe(true);
  });

  it("refuses a second open draft at the database level", async () => {
    const deck = await newDeck();

    // The partial unique index is the backstop; the service checks first, but a
    // race would otherwise leave a deck with two drafts and no answer to "what
    // am I editing".
    await expect(
      db.insert(schema.cimVersions).values({ deckId: deck.id, versionNo: 2 }),
    ).rejects.toThrow();
  });
});

describe("the guided Q&A loop, across both modules (real Postgres)", () => {
  it("sends questions as ordinary Q&A items carrying an opaque block reference", async () => {
    const deck = await newDeck();
    const gaps = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/gaps`);
    const target = gaps.body[0];

    const sent = await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/questions`)
      .send({ questions: [{ block_id: target.block_id, text: "Describe the business." }] });

    expect(sent.status).toBe(201);
    const items = await db.select().from(schema.qaItems);
    expect(items).toHaveLength(1);
    // Ordinary items, tagged with where they came from — not a private store.
    expect(items[0]!.origin).toBe("cim_guided");
    expect(items[0]!.externalRef).toBe(target.block_id);
    expect(items[0]!.body).toBe("Describe the business.");
  });

  it("shows the seller the question through the Q&A module, not the CIM", async () => {
    const deck = await newDeck();
    const gaps = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/gaps`);
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/questions`)
      .send({ questions: [{ block_id: gaps.body[0].block_id, text: "Describe the business." }] });

    qaCurrent = seller;
    const asSeller = await request(qaApp).get(`/qa/companies/${companyId}/items`);

    expect(asSeller.body).toHaveLength(1);
    expect(asSeller.body[0].body).toBe("Describe the business.");
  });

  it("carries a seller's answer back into the review queue", async () => {
    const deck = await newDeck();
    const gaps = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/gaps`);
    const target = gaps.body[0];
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/questions`)
      .send({ questions: [{ block_id: target.block_id, text: "Describe the business." }] });

    qaCurrent = seller;
    const items = await request(qaApp).get(`/qa/companies/${companyId}/items`);
    await request(qaApp)
      .post(`/qa/items/${items.body[0].id}/responses`)
      .send({ body: "We make industrial fasteners.", kind: "answer" })
      .expect(201);

    const queue = await request(cimApp).get(
      `/cim/versions/${deck.current_version_id}/review-queue`,
    );
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].answer_text).toBe("We make industrial fasteners.");
    expect(queue.body[0].respondent_name).toBe("Dana Seller");
  });

  async function answeredDeck() {
    const deck = await newDeck();
    const gaps = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/gaps`);
    const target = gaps.body[0];
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/questions`)
      .send({ questions: [{ block_id: target.block_id, text: "Describe the business." }] });
    qaCurrent = seller;
    const items = await request(qaApp).get(`/qa/companies/${companyId}/items`);
    await request(qaApp)
      .post(`/qa/items/${items.body[0].id}/responses`)
      .send({ body: "We make industrial fasteners.", kind: "answer" });
    const queue = await request(cimApp).get(
      `/cim/versions/${deck.current_version_id}/review-queue`,
    );
    return { deck, target, review: queue.body[0] };
  }

  it("writes an accepted answer onto the slide and locks its class", async () => {
    const { deck, target, review } = await answeredDeck();

    await request(cimApp)
      .post(`/cim/blocks/${target.block_id}/accept-answer`)
      .send({ qa_item_id: review.qa_item_id, qa_response_id: review.qa_response_id })
      .expect(200);

    const [block] = await db
      .select()
      .from(schema.cimBlocks)
      .where(eq(schema.cimBlocks.id, target.block_id));
    expect(block!.content).toBe("We make industrial fasteners.");
    expect(block!.populatedBy).toBe("answer");
    // CM-0002: deal content must never travel into a firm template.
    expect(block!.contentClassLocked).toBe(true);
    void deck;
  });

  it("refuses to reclassify an answer-populated block as firm boilerplate", async () => {
    const { deck, target, review } = await answeredDeck();
    await request(cimApp)
      .post(`/cim/blocks/${target.block_id}/accept-answer`)
      .send({ qa_item_id: review.qa_item_id, qa_response_id: review.qa_response_id });

    await request(cimApp)
      .put(`/cim/versions/${deck.current_version_id}/blocks`)
      .send({
        blocks: [
          { block_key: target.block_key, content: "edited", content_class: "firm_boilerplate" },
        ],
      })
      .expect(200);

    const [block] = await db
      .select()
      .from(schema.cimBlocks)
      .where(eq(schema.cimBlocks.id, target.block_id));
    expect(block!.contentClass).toBe("deal");
    // The edit still lands; only the classification is pinned.
    expect(block!.content).toBe("edited");
  });

  it("keeps the respondent's original words when the broker edits before accepting", async () => {
    const { target, review } = await answeredDeck();

    await request(cimApp)
      .post(`/cim/blocks/${target.block_id}/accept-answer`)
      .send({
        qa_item_id: review.qa_item_id,
        qa_response_id: review.qa_response_id,
        text: "A precision fastener manufacturer.",
      });

    const [provenance] = await db.select().from(schema.cimBlockProvenance);
    expect(provenance!.rawAnswer).toBe("We make industrial fasteners.");
    expect(provenance!.respondentId).toBe(SELLER_ID);
    const [block] = await db
      .select()
      .from(schema.cimBlocks)
      .where(eq(schema.cimBlocks.id, target.block_id));
    expect(block!.content).toBe("A precision fastener manufacturer.");
  });

  it("takes a decided answer out of the queue and keeps a discarded one on record", async () => {
    const { deck, target, review } = await answeredDeck();

    await request(cimApp)
      .post(`/cim/blocks/${target.block_id}/discard-answer`)
      .send({ qa_item_id: review.qa_item_id, qa_response_id: review.qa_response_id })
      .expect(204);

    const queue = await request(cimApp).get(
      `/cim/versions/${deck.current_version_id}/review-queue`,
    );
    expect(queue.body).toHaveLength(0);
    const [provenance] = await db.select().from(schema.cimBlockProvenance);
    expect(provenance!.outcome).toBe("discarded");
    expect(provenance!.rawAnswer).toBe("We make industrial fasteners.");
  });

  it("does not overwrite authored content without an explicit mode", async () => {
    const { deck, target, review } = await answeredDeck();
    await request(cimApp)
      .put(`/cim/versions/${deck.current_version_id}/blocks`)
      .send({ blocks: [{ block_key: target.block_key, content: "the broker wrote this" }] });

    const result = await request(cimApp)
      .post(`/cim/blocks/${target.block_id}/accept-answer`)
      .send({ qa_item_id: review.qa_item_id, qa_response_id: review.qa_response_id });

    expect(result.body.accepted).toBe(false);
    const [block] = await db
      .select()
      .from(schema.cimBlocks)
      .where(eq(schema.cimBlocks.id, target.block_id));
    expect(block!.content).toBe("the broker wrote this");
  });
});

describe("publishing into the data room (real Postgres)", () => {
  it("stores the artifact, lands a tracked document, and freezes the version", async () => {
    const deck = await newDeck();
    const pdf = Buffer.from("%PDF-1.7 the rendered deck\n%%EOF");

    const published = await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/publish`)
      .set("Content-Type", "application/pdf")
      .set("x-page-count", "14")
      .send(pdf);

    expect(published.status).toBe(201);
    expect(published.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The bytes really landed in the shared blob store...
    const [upload] = await db
      .select()
      .from(schema.uploads)
      .where(eq(schema.uploads.id, published.body.upload_id));
    expect(Buffer.compare(Buffer.from(upload!.data), pdf)).toBe(0);

    // ...and the data room has a tracked document pointing at it.
    const [document] = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, published.body.document_id));
    expect(document!.name).toBe("Project Atlas CIM v1.pdf");
    expect(document!.folderId).toBe(folderId);

    const [version] = await db
      .select()
      .from(schema.cimVersions)
      .where(eq(schema.cimVersions.id, deck.current_version_id));
    expect(version!.status).toBe("published");
  });

  it("refuses to edit a published version", async () => {
    const deck = await newDeck();
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/publish`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("pdf"));

    const edit = await request(cimApp)
      .put(`/cim/versions/${deck.current_version_id}/blocks`)
      .send({ blocks: [{ block_key: "2:headline", content: "sneaky" }] });

    expect(edit.status).toBe(400);
    expect(edit.body.error).toMatch(/cannot be edited/i);
  });

  it("forks a new draft, leaving the published version and its artifact intact", async () => {
    const deck = await newDeck();
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/publish`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("v1 pdf"));

    const draft = await request(cimApp).post(`/cim/decks/${deck.id}/versions`).expect(201);

    expect(draft.body.version_no).toBe(2);
    const versions = await request(cimApp).get(`/cim/decks/${deck.id}/versions`);
    const v1 = versions.body.find((v: { version_no: number }) => v.version_no === 1);
    expect(v1.status).toBe("published");
    expect(v1.sha256).toBeTruthy();
    expect(v1.document_id).toBeTruthy();
  });

  it("refuses an empty document rather than freezing around nothing", async () => {
    const deck = await newDeck();

    const res = await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/publish`)
      .set("Content-Type", "application/pdf")
      .send(Buffer.alloc(0));

    expect(res.status).toBe(400);
  });
});

describe("the Q&A adapter never invents an identity", () => {
  it("reads the review queue as the person who asked for it", async () => {
    // The failure this guards against is not subtle in production and was
    // invisible in a fake: a placeholder id reaches Postgres as an empty uuid
    // and the whole query errors.
    const deck = await newDeck();
    const gaps = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/gaps`);
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/questions`)
      .send({ questions: [{ block_id: gaps.body[0].block_id, text: "q" }] });

    const queue = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/review-queue`);

    expect(queue.status).toBe(200);
  });

  it("reports deck health without a synthesized session", async () => {
    const deck = await newDeck();
    const gaps = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/gaps`);
    await request(cimApp)
      .post(`/cim/versions/${deck.current_version_id}/questions`)
      .send({ questions: [{ block_id: gaps.body[0].block_id, text: "q" }] });

    const health = await request(cimApp).get(`/cim/versions/${deck.current_version_id}/health`);

    expect(health.status).toBe(200);
    expect(health.body.outstanding_questions).toBe(1);
  });
});

describe("tenant isolation (real Postgres)", () => {
  it("refuses another company's CIMs", async () => {
    const otherCompany = randomUUID();
    await db.insert(schema.companies).values({ id: otherCompany, name: "Elsewhere" });

    const res = await request(cimApp).get(`/cim/companies/${otherCompany}/decks`);

    expect(res.status).toBe(403);
  });
});
