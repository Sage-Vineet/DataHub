import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { StatementsRepository } from "./ports.js";
import { DrizzleStatementsRepository } from "./repository.drizzle.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * The in-memory statements repository is what lets the dashboards, the cash
 * flow and the source sync be tested without a database — and this session has
 * already found two fakes that had drifted from the store they stand in for.
 *
 * What is under test is the part every reader depends on: an extract is
 * identified by its DOCUMENT and type (so re-extraction replaces rather than
 * accumulates), "latest" means most recently extracted, and a pull is
 * separable from an upload because their payloads are different shapes.
 */

const USER = randomUUID();

interface Store {
  repo: StatementsRepository;
  companyId: string;
  otherCompanyId: string;
  /** A document of this company, with a name and a folder. */
  addDocument(name: string): Promise<string>;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  await db.insert(schema.users).values({
    id: USER,
    name: "Uma",
    email: `${USER}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "" },
    { id: otherCompanyId, name: "Beta", industry: "" },
  ]);
  const [folder] = await db
    .insert(schema.folders)
    .values({ companyId, name: "Financials", createdBy: USER })
    .returning();

  const repo = new DrizzleStatementsRepository(db);
  return {
    repo,
    companyId,
    otherCompanyId,
    addDocument: async (name: string) => {
      const [document] = await db
        .insert(schema.documents)
        .values({
          companyId,
          folderId: folder!.id,
          name,
          fileUrl: `/uploads/${name}`,
          size: "1",
          ext: name.split(".").pop() ?? "pdf",
          status: "under-review" as never,
          uploadedBy: USER,
        })
        .returning();
      return document!.id;
    },
  };
}

function memoryStore(): Promise<Store> {
  const repo = new InMemoryStatementsRepository();
  return Promise.resolve({
    repo,
    companyId: randomUUID(),
    otherCompanyId: randomUUID(),
    addDocument: (name: string) => {
      const id = randomUUID();
      repo.seedDocument(id, name, "Financials");
      return Promise.resolve(id);
    },
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("statement extracts (%s)", (_name, open) => {
  const saveDocument = (
    store: Store,
    documentId: string,
    over: Record<string, unknown> = {},
  ) =>
    store.repo.save({
      companyId: store.companyId,
      provenance: { from: "document", documentId },
      statementType: "balance_sheet",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: "2025-12-31",
      fiscalYear: 2025,
      payload: { rows: [{ name: "Total Assets", amount: 100 }] },
      extractedBy: USER,
      ...over,
    });

  const savePull = (store: Store, over: Record<string, unknown> = {}) =>
    store.repo.save({
      companyId: store.companyId,
      provenance: { from: "pull", reportParams: { accountingMethod: "Accrual" } },
      statementType: "balance_sheet",
      sourceKey: "quickbooks",
      periodStart: "2025-01-01",
      periodEnd: "2025-12-31",
      asOfDate: "2025-12-31",
      fiscalYear: 2025,
      payload: { Rows: {} },
      extractedBy: USER,
      ...over,
    });

  it("has nothing to report for a company with no extracts", async () => {
    const store = await open();
    expect(await store.repo.list(store.companyId, {})).toEqual([]);
    expect(await store.repo.latest(store.companyId, "balance_sheet", {})).toBeNull();
    expect(await store.repo.sourceTree(store.companyId, {})).toEqual([]);
  });

  it("stores an extract and reads it back with its document's name", async () => {
    // A reader who doubts a figure has to be able to get back to the file it
    // came from; the id alone does not do that.
    const store = await open();
    const documentId = await store.addDocument("Balance Sheet 2025.pdf");
    const saved = await saveDocument(store, documentId);

    expect(saved).toMatchObject({ documentId, fiscalYear: 2025, statementType: "balance_sheet" });
    const read = await store.repo.getById(store.companyId, saved.id);
    expect(read?.documentName).toBe("Balance Sheet 2025.pdf");
    expect(read?.folderName).toBe("Financials");
  });

  it("replaces rather than accumulating when one document is re-extracted", async () => {
    // Two extracts of one document under one type makes "the balance sheet"
    // ambiguous, and every reader picks whichever the query returned first.
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await saveDocument(store, documentId);
    await saveDocument(store, documentId, { payload: { rows: [{ name: "Total Assets", amount: 200 }] } });

    const all = await store.repo.list(store.companyId, { statementType: "balance_sheet" });
    expect(all).toHaveLength(1);
    expect(all[0]!.payload).toEqual({ rows: [{ name: "Total Assets", amount: 200 }] });
  });

  it("keeps two statement types read out of one file apart", async () => {
    const store = await open();
    const documentId = await store.addDocument("Accounts.xlsx");
    await saveDocument(store, documentId);
    await saveDocument(store, documentId, { statementType: "profit_and_loss" });

    expect(await store.repo.list(store.companyId, {})).toHaveLength(2);
    expect(await store.repo.forDocument(store.companyId, documentId, "profit_and_loss")).not.toBeNull();
  });

  it("answers nothing for a document it has not read", async () => {
    const store = await open();
    expect(await store.repo.forDocument(store.companyId, randomUUID(), "balance_sheet")).toBeNull();
  });

  it("makes re-extraction the newest, so `latest` follows the work", async () => {
    const store = await open();
    const first = await store.addDocument("First.pdf");
    const second = await store.addDocument("Second.pdf");
    await saveDocument(store, first);
    await saveDocument(store, second);

    expect((await store.repo.latest(store.companyId, "balance_sheet", {}))?.documentId).toBe(second);
  });

  it("narrows `latest` by source", async () => {
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await saveDocument(store, documentId);
    await savePull(store);

    expect(
      (await store.repo.latest(store.companyId, "balance_sheet", { sourceKey: "quickbooks" }))
        ?.sourceKey,
    ).toBe("quickbooks");
  });

  it("separates a pull from an upload, because their payloads differ", async () => {
    // One statement type holds both. A caller wanting the QuickBooks ladder
    // and handed an uploaded statement reads an object with none of the fields
    // it expects and renders nothing.
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await savePull(store);
    await saveDocument(store, documentId);

    const pull = await store.repo.latest(store.companyId, "balance_sheet", { provenance: "pull" });
    const uploaded = await store.repo.latest(store.companyId, "balance_sheet", {
      provenance: "document",
    });
    expect(pull?.documentId).toBeNull();
    expect(uploaded?.documentId).toBe(documentId);
  });

  it("narrows a listing by fiscal year and by document", async () => {
    const store = await open();
    const a = await store.addDocument("A.pdf");
    const b = await store.addDocument("B.pdf");
    await saveDocument(store, a, { fiscalYear: 2024 });
    await saveDocument(store, b, { fiscalYear: 2025 });

    expect(await store.repo.list(store.companyId, { fiscalYear: 2024 })).toHaveLength(1);
    expect(await store.repo.list(store.companyId, { documentIds: [b] })).toHaveLength(1);
    expect(await store.repo.list(store.companyId, { documentIds: [] })).toEqual([]);
  });

  it("builds a tree of what was UPLOADED, leaving pulls out", async () => {
    // A pulled statement has no document to sit under, and putting it in one
    // would invent a file that does not exist.
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await saveDocument(store, documentId);
    await saveDocument(store, documentId, { statementType: "profit_and_loss" });
    await savePull(store);

    const tree = await store.repo.sourceTree(store.companyId, {});
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ documentId, documentName: "BS.pdf", folderName: "Financials" });
    expect(tree[0]!.statements.map((s) => s.statementType).sort()).toEqual([
      "balance_sheet",
      "profit_and_loss",
    ]);
  });

  it("narrows the tree by source", async () => {
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await saveDocument(store, documentId);

    expect(await store.repo.sourceTree(store.companyId, { sourceKey: "quickbooks" })).toEqual([]);
    expect(
      await store.repo.sourceTree(store.companyId, { sourceKey: "manual_upload_excel_pdf" }),
    ).toHaveLength(1);
  });

  it("keeps one company's extracts out of another's", async () => {
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await saveDocument(store, documentId);

    expect(await store.repo.list(store.otherCompanyId, {})).toEqual([]);
    expect(await store.repo.latest(store.otherCompanyId, "balance_sheet", {})).toBeNull();
    expect(await store.repo.getById(store.otherCompanyId, (await store.repo.list(store.companyId, {}))[0]!.id)).toBeNull();
  });

  it("carries a pull's report params, and an upload's empty ones", async () => {
    const store = await open();
    const documentId = await store.addDocument("BS.pdf");
    await savePull(store);
    await saveDocument(store, documentId);

    const pull = await store.repo.latest(store.companyId, "balance_sheet", { provenance: "pull" });
    const uploaded = await store.repo.latest(store.companyId, "balance_sheet", {
      provenance: "document",
    });
    expect(pull?.reportParams).toEqual({ accountingMethod: "Accrual" });
    expect(uploaded?.reportParams).toEqual({});
  });
});
