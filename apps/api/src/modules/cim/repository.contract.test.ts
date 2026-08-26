import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { DecksRepository, StructureRepository, VersionsRepository } from "./ports.js";
import {
  DrizzleDecksRepository,
  DrizzleStructureRepository,
  DrizzleVersionsRepository,
} from "./repository.drizzle.js";
import { CimStore, memoryCim } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * The rule doing the work is that a deck has at most ONE open version. Two
 * open drafts means two people editing what each believes is the next version,
 * and whichever publishes second silently discards the other's work.
 *
 * The other is that content class LOCKS when a block is written from an
 * accepted answer: answer-derived text must never be reclassified as firm
 * boilerplate and travel into another company's template.
 */

const OUTLINE = [
  {
    sectionKey: "exec",
    title: "Executive Summary",
    slides: [
      {
        layoutKey: "title-body",
        slideNo: 1,
        blocks: [{ blockKey: "exec.summary", label: "What does the business do?", kind: "text" as const }],
      },
    ],
  },
];

interface Store {
  decks: DecksRepository;
  versions: VersionsRepository;
  structure: StructureRepository;
  companyId: string;
  userId: string;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    name: "Uma",
    email: `${userId}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });

  return {
    decks: new DrizzleDecksRepository(db),
    versions: new DrizzleVersionsRepository(db),
    structure: new DrizzleStructureRepository(db),
    companyId,
    userId,
  };
}

function memoryStore(): Promise<Store> {
  const ports = memoryCim(new CimStore());
  return Promise.resolve({
    decks: ports.decks,
    versions: ports.versions,
    structure: ports.structure,
    companyId: randomUUID(),
    userId: randomUUID(),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("CIM decks and versions (%s)", (_name, open) => {
  const newDeck = async (store: Store, name = "Project Atlas CIM") => {
    const deck = await store.decks.create({
      companyId: store.companyId,
      name,
      templateKey: "standard",
      createdBy: store.userId,
    });
    const version = await store.versions.create({
      deckId: deck.id,
      versionNo: await store.versions.nextVersionNo(deck.id),
      cover: {},
      theme: {},
    });
    await store.structure.createOutline(version.id, OUTLINE);
    return { deck, version };
  };

  it("has nothing to report for a company with no CIM", async () => {
    const store = await open();
    expect(await store.decks.listFor(store.companyId)).toEqual([]);
    expect(await store.decks.getById(randomUUID())).toBeNull();
    expect(await store.versions.getById(randomUUID())).toBeNull();
  });

  it("creates a deck with a first version and an outline", async () => {
    const store = await open();
    const { deck, version } = await newDeck(store);

    expect(version.versionNo).toBe(1);
    expect(version.status).toBe("draft");
    expect((await store.decks.listFor(store.companyId)).map((d) => d.id)).toEqual([deck.id]);
    expect(await store.structure.sectionsFor(version.id)).toHaveLength(1);
    expect(await store.structure.blocksFor(version.id)).toHaveLength(1);
  });

  it("numbers versions from one, per deck", async () => {
    const store = await open();
    const { deck } = await newDeck(store);
    expect(await store.versions.nextVersionNo(deck.id)).toBe(2);

    const { deck: other } = await newDeck(store, "Second CIM");
    expect(await store.versions.nextVersionNo(other.id)).toBe(2);
  });

  it("refuses a second open version, in the database rather than in code", async () => {
    // Two open drafts means two people editing what each believes is the next
    // version, and whichever publishes second discards the other's work. The
    // partial unique index is where that refusal has to live, because it is
    // the only thing two gateway instances share.
    const store = await open();
    const { deck } = await newDeck(store);
    // The message differs between the driver and the fake; that it REFUSES is
    // the contract, and where the refusal comes from is the point.
    await expect(
      store.versions.create({ deckId: deck.id, versionNo: 2, cover: {}, theme: {} }),
    ).rejects.toThrow();
  });

  it("reports the deck's one open version, and none once it is published", async () => {
    // Two open drafts means two people editing what each believes is the next
    // version, and whichever publishes second discards the other's work.
    const store = await open();
    const { deck, version } = await newDeck(store);
    expect((await store.versions.openVersionFor(deck.id))?.id).toBe(version.id);

    await store.versions.markPublished(version.id, store.userId);
    expect(await store.versions.openVersionFor(deck.id)).toBeNull();
    expect((await store.versions.getById(version.id))?.status).toBe("published");
  });

  it("records an approval without publishing", async () => {
    // Approval and publication are separate: one says a person signed it off,
    // the other freezes it around a rendered document.
    const store = await open();
    const { version } = await newDeck(store);
    await store.versions.recordApproval(version.id, store.userId);

    const after = await store.versions.getById(version.id);
    expect(after?.approvedBy).toBe(store.userId);
    expect(after?.approvedAt).toBeTruthy();
    expect(after?.status).not.toBe("published");
  });

  it("stores a cover and reads it back", async () => {
    const store = await open();
    const { version } = await newDeck(store);
    await store.versions.setCover(version.id, { title: "Project Atlas", subtitle: "Confidential" });
    expect((await store.versions.getById(version.id))?.cover).toMatchObject({
      title: "Project Atlas",
    });
  });

  it("lists a deck's versions, newest first", async () => {
    const store = await open();
    const { deck, version } = await newDeck(store);
    await store.versions.markPublished(version.id, store.userId);
    const second = await store.versions.create({
      deckId: deck.id,
      versionNo: await store.versions.nextVersionNo(deck.id),
      cover: {},
      theme: {},
    });

    expect((await store.decks.versionsFor(deck.id)).map((v) => v.id)).toEqual([
      second.id,
      version.id,
    ]);
  });

  it("keeps one company's decks out of another's", async () => {
    const store = await open();
    await newDeck(store);
    expect(await store.decks.listFor(randomUUID())).toEqual([]);
  });
});

describe.each(STORES)("CIM blocks (%s)", (_name, open) => {
  const withBlock = async (store: Store) => {
    const deck = await store.decks.create({
      companyId: store.companyId,
      name: "CIM",
      templateKey: "standard",
      createdBy: store.userId,
    });
    const version = await store.versions.create({
      deckId: deck.id,
      versionNo: 1,
      cover: {},
      theme: {},
    });
    await store.structure.createOutline(version.id, OUTLINE);
    const block = (await store.structure.blocksFor(version.id))[0]!;
    return { deck, version, block };
  };

  it("answers null for a block nobody has", async () => {
    const store = await open();
    expect(await store.structure.getBlock(randomUUID())).toBeNull();
  });

  it("writes a block's content, keyed by its block key", async () => {
    const store = await open();
    const { version, block } = await withBlock(store);
    await store.structure.upsertBlocks(
      version.id,
      [{ blockKey: block.blockKey, content: "A manufacturer of widgets." }],
      store.userId,
    );

    expect((await store.structure.getBlock(block.id))?.content).toBe("A manufacturer of widgets.");
  });

  it("ignores a block key the version does not have", async () => {
    // Rather than creating one: a block that is not in the outline has no
    // slide to sit on, and would render nowhere while counting as filled.
    const store = await open();
    const { version } = await withBlock(store);
    await store.structure.upsertBlocks(
      version.id,
      [{ blockKey: "not.in.the.outline", content: "orphan" }],
      store.userId,
    );
    expect(await store.structure.blocksFor(version.id)).toHaveLength(1);
  });

  it("locks the content class when a block is written from an answer", async () => {
    // Answer-derived text must never be reclassified as firm boilerplate and
    // travel into another company's template.
    const store = await open();
    const { block } = await withBlock(store);
    await store.structure.writeAcceptedAnswer({
      blockId: block.id,
      content: "From the seller.",
      acceptedBy: store.userId,
    });

    const after = await store.structure.getBlock(block.id);
    expect(after?.content).toBe("From the seller.");
    expect(after?.populatedBy).toBe("answer");
    expect(after?.contentClassLocked).toBe(true);
  });

  it("keeps the lock against a later save that names a class", async () => {
    /**
     * The assertion above proves the lock is SET. This proves it does
     * something — which is the whole point of it, and was not covered.
     *
     * The block is saved again with an explicit class, as the editor does
     * whenever somebody edits answer-derived text and the form posts the
     * template's class back. Taking it would reclassify the seller's own words
     * as firm boilerplate, and boilerplate travels into the next company's
     * deck.
     */
    const store = await open();
    const { version, block } = await withBlock(store);
    await store.structure.writeAcceptedAnswer({
      blockId: block.id,
      content: "From the seller.",
      acceptedBy: store.userId,
    });

    await store.structure.upsertBlocks(
      version.id,
      [{ blockKey: block.blockKey, content: "Edited by the broker.", contentClass: "firm_boilerplate" }],
      store.userId,
    );

    const after = await store.structure.getBlock(block.id);
    expect(after?.content).toBe("Edited by the broker.");
    expect(after?.contentClass).not.toBe("firm_boilerplate");
    expect(after?.contentClassLocked).toBe(true);
  });

  it("takes a class on a block that is not locked", async () => {
    // The other side of the same rule: without the lock the class is the
    // caller's to set, which is how a template's blocks get classified at all.
    const store = await open();
    const { version, block } = await withBlock(store);
    await store.structure.upsertBlocks(
      version.id,
      [{ blockKey: block.blockKey, content: "Boilerplate.", contentClass: "firm_boilerplate" }],
      store.userId,
    );
    expect((await store.structure.getBlock(block.id))?.contentClass).toBe("firm_boilerplate");
  });

  it("does nothing, rather than failing, for an id nobody has", async () => {
    /**
     * These are reached from routes that took the id from a URL. A row deleted
     * between the page loading and the button being pressed lands here, and
     * the two stores have to agree on the answer or the in-memory suite proves
     * nothing about the real one.
     *
     * No-op rather than throw, because every one of these is idempotent by
     * intent: publishing a version that is gone, approving one that is gone,
     * writing an answer into a block that is gone. There is nothing to undo
     * and nobody to tell.
     */
    const store = await open();
    const ghost = randomUUID();

    await expect(store.versions.markPublished(ghost, store.userId)).resolves.toBeUndefined();
    await expect(store.versions.recordApproval(ghost, store.userId)).resolves.toBeUndefined();
    await expect(store.versions.setCover(ghost, { title: "x" })).resolves.toBeUndefined();
    await expect(
      store.structure.writeAcceptedAnswer({
        blockId: ghost,
        content: "From the seller.",
        acceptedBy: store.userId,
      }),
    ).resolves.toBeUndefined();

    expect(await store.versions.getById(ghost)).toBeNull();
    expect(await store.structure.getBlock(ghost)).toBeNull();
  });

  it("clones a version's structure and content into a fresh draft", async () => {
    const store = await open();
    const { deck, version, block } = await withBlock(store);
    await store.structure.upsertBlocks(
      version.id,
      [{ blockKey: block.blockKey, content: "Carried forward." }],
      store.userId,
    );

    // Published first: the database permits exactly one OPEN version per deck,
    // and forking is what happens after the current one is frozen.
    await store.versions.markPublished(version.id, store.userId);
    const next = await store.versions.create({
      deckId: deck.id,
      versionNo: 2,
      cover: {},
      theme: {},
    });
    await store.structure.cloneInto(version.id, next.id);

    const cloned = await store.structure.blocksFor(next.id);
    expect(cloned).toHaveLength(1);
    expect(cloned[0]!.content).toBe("Carried forward.");
    expect(cloned[0]!.id).not.toBe(block.id);
    expect(await store.structure.sectionsFor(next.id)).toHaveLength(1);
    expect(await store.structure.slidesFor(next.id)).toHaveLength(1);
  });
});
