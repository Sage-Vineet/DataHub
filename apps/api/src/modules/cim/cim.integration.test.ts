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
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;

  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
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
    await db.insert(schema.companies).values({ id: otherCompany, name: "Elsewhere", industry: "" });

    const res = await request(cimApp).get(`/cim/companies/${otherCompany}/decks`);

    expect(res.status).toBe(403);
  });
});
