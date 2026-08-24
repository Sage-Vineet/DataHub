import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import {
  DrizzleBankStatementDocumentPort,
  DrizzleDocumentBytesPort,
  DrizzleStatementDocumentPort,
  DrizzleTaxReturnDocumentPort,
} from "./tax-return.drizzle.js";

/**
 * Finding a company's documents, against a real database.
 *
 * This is where the fix for the filesystem read lives, so it is the part worth
 * proving against real joins rather than a fake: the version this replaces
 * looked a PDF up by filename in a directory and could reach any file on the
 * machine. Every query here filters on the company, and these tests exist to
 * fail if one ever stops.
 */

const BROKER_ID = "11111111-1111-4111-8111-111111111111";

let client: PGlite;
let db: Db;
let ours: string;
let theirs: string;
let ourFolder: string;
let theirFolder: string;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;

  await db.insert(schema.users).values({
    id: BROKER_ID,
    name: "Bea",
    email: "bea@example.test",
    passwordHash: "!",
    role: "broker",
  });

  ours = randomUUID();
  theirs = randomUUID();
  await db.insert(schema.companies).values([
    { id: ours, name: "Ours", industry: "" },
    { id: theirs, name: "Theirs", industry: "" },
  ]);

  const folders = await db
    .insert(schema.folders)
    .values([
      { companyId: ours, name: "Financials", createdBy: BROKER_ID },
      { companyId: theirs, name: "Financials", createdBy: BROKER_ID },
    ])
    .returning();
  ourFolder = folders[0]!.id;
  theirFolder = folders[1]!.id;
});

afterEach(async () => {
  await client.close();
});

async function addDocument(
  companyId: string,
  folderId: string,
  name: string,
  options: { bytes?: Buffer; contentType?: string } = {},
): Promise<string> {
  let uploadId: string | null = null;
  if (options.bytes) {
    const [upload] = await db
      .insert(schema.uploads)
      .values({
        fileName: name,
        contentType: options.contentType ?? "application/pdf",
        sizeBytes: options.bytes.length,
        data: options.bytes,
        uploadedBy: BROKER_ID,
      })
      .returning();
    uploadId = upload!.id;
  }

  const [document] = await db
    .insert(schema.documents)
    .values({
      companyId,
      folderId,
      name,
      fileUrl: `/uploads/${name}`,
      size: String(options.bytes?.length ?? 1),
      ext: name.split(".").pop() ?? "pdf",
      status: "under-review" as never,
      uploadedBy: BROKER_ID,
      uploadId,
    })
    .returning();
  return document!.id;
}

async function linkToVersion(
  companyId: string,
  documentId: string,
  category: string,
): Promise<string> {
  const [version] = await db
    .insert(schema.keyReportVersions)
    .values({ companyId, versionNumber: 1 })
    .returning();
  await db.insert(schema.keyReportFileMappings).values({
    versionId: version!.id,
    companyId,
    reportCategory: category,
    documentId,
  });
  return version!.id;
}

describe("finding a tax return (real Postgres)", () => {
  it("finds the one a version links", async () => {
    const doc = await addDocument(ours, ourFolder, "Return 2023.pdf");
    const version = await linkToVersion(ours, doc, "tax_return");

    const port = new DrizzleTaxReturnDocumentPort(db);
    expect(await port.forVersion(ours, version)).toEqual([{ id: doc, name: "Return 2023.pdf" }]);
  });

  it("finds NOTHING through another company's version", async () => {
    // The join demands the company on both sides. A version id from elsewhere
    // reaching a document is exactly the shape the filesystem read had.
    const theirDoc = await addDocument(theirs, theirFolder, "Their Return.pdf");
    const theirVersion = await linkToVersion(theirs, theirDoc, "tax_return");

    const port = new DrizzleTaxReturnDocumentPort(db);
    expect(await port.forVersion(ours, theirVersion)).toEqual([]);
  });

  it("ignores a document linked under a different category", async () => {
    const doc = await addDocument(ours, ourFolder, "Balance Sheet.pdf");
    const version = await linkToVersion(ours, doc, "balance_sheet");

    const port = new DrizzleTaxReturnDocumentPort(db);
    expect(await port.forVersion(ours, version)).toEqual([]);
  });

  it("falls back to the company's most recent tax-return PDF", async () => {
    await addDocument(ours, ourFolder, "Invoice.pdf");
    const doc = await addDocument(ours, ourFolder, "Tax Return 2023.pdf");

    const port = new DrizzleTaxReturnDocumentPort(db);
    expect((await port.latest(ours))?.id).toBe(doc);
  });

  it("recognises the names a return is filed under", async () => {
    const port = new DrizzleTaxReturnDocumentPort(db);
    for (const name of ["Form 1120-S.pdf", "1065 Partnership.pdf", "2023 Return.pdf"]) {
      const doc = await addDocument(ours, ourFolder, name);
      expect((await port.latest(ours))?.id).toBe(doc);
      await db.delete(schema.documents).where(eq(schema.documents.id, doc));
    }
  });

  it("does not reach another company's return", async () => {
    await addDocument(theirs, theirFolder, "Their Tax Return.pdf");
    const port = new DrizzleTaxReturnDocumentPort(db);
    expect(await port.latest(ours)).toBeNull();
  });

  it("answers null rather than an unrelated document", async () => {
    // A false positive here reads the wrong document and reports its figures
    // as the company's tax position.
    await addDocument(ours, ourFolder, "Photo.pdf");
    const port = new DrizzleTaxReturnDocumentPort(db);
    expect(await port.latest(ours)).toBeNull();
  });
});

describe("finding bank statements (real Postgres)", () => {
  it("prefers the ones a version links", async () => {
    const linked = await addDocument(ours, ourFolder, "Wells Fargo Jan.pdf");
    await addDocument(ours, ourFolder, "Chase Statement.pdf");
    const version = await linkToVersion(ours, linked, "bank_statement");

    const port = new DrizzleBankStatementDocumentPort(db);
    const found = await port.forCompany(ours, {
      sourceKey: "manual_upload_excel_pdf",
      keyReportVersionId: version,
    });
    // A version that links statements IS the answer. Mixing in the company's
    // others is the thing selecting a version is meant to prevent.
    expect(found).toEqual([{ id: linked, name: "Wells Fargo Jan.pdf" }]);
  });

  it("falls back to the company's statement-looking documents", async () => {
    await addDocument(ours, ourFolder, "Invoice.pdf");
    const statement = await addDocument(ours, ourFolder, "Bank Statement Jan.pdf");

    const port = new DrizzleBankStatementDocumentPort(db);
    const found = await port.forCompany(ours, { sourceKey: "manual_upload_excel_pdf" });
    expect(found.map((d) => d.id)).toEqual([statement]);
  });

  it("does not reach another company's statements", async () => {
    await addDocument(theirs, theirFolder, "Their Bank Statement.pdf");
    const port = new DrizzleBankStatementDocumentPort(db);
    expect(await port.forCompany(ours, { sourceKey: "manual_upload_excel_pdf" })).toEqual([]);
  });

  it("finds nothing through another company's version", async () => {
    const theirDoc = await addDocument(theirs, theirFolder, "Their Bank Statement.pdf");
    const theirVersion = await linkToVersion(theirs, theirDoc, "bank_statement");

    const port = new DrizzleBankStatementDocumentPort(db);
    expect(
      await port.forCompany(ours, {
        sourceKey: "manual_upload_excel_pdf",
        keyReportVersionId: theirVersion,
      }),
    ).toEqual([]);
  });
});

describe("loading a document's bytes (real Postgres)", () => {
  it("returns the file behind it", async () => {
    const doc = await addDocument(ours, ourFolder, "Return.pdf", {
      bytes: Buffer.from("%PDF-1.7 hello"),
    });

    const port = new DrizzleDocumentBytesPort(db);
    const file = await port.bytesFor(doc);
    expect(file!.bytes.toString()).toBe("%PDF-1.7 hello");
    expect(file!.mimeType).toBe("application/pdf");
  });

  it("returns null for a document with no upload behind it", async () => {
    const doc = await addDocument(ours, ourFolder, "Ghost.pdf");
    const port = new DrizzleDocumentBytesPort(db);
    expect(await port.bytesFor(doc)).toBeNull();
  });

  it("returns null for a document that does not exist", async () => {
    const port = new DrizzleDocumentBytesPort(db);
    expect(await port.bytesFor(randomUUID())).toBeNull();
  });

  it("falls back to the extension for a type the browser could not identify", async () => {
    // `content_type` is NOT NULL, so it is always something — but a browser
    // that could not identify a file sends `application/octet-stream`, and a
    // model asked to read that refuses.
    const doc = await addDocument(ours, ourFolder, "Return.pdf", {
      bytes: Buffer.from("x"),
      contentType: "application/octet-stream",
    });

    const port = new DrizzleDocumentBytesPort(db);
    expect((await port.bytesFor(doc))!.mimeType).toBe("application/pdf");
  });

  it("believes a specific stored type over the extension", async () => {
    // What the uploader's own browser determined beats an extension anybody
    // can rename.
    const doc = await addDocument(ours, ourFolder, "Statement.pdf", {
      bytes: Buffer.from("x"),
      contentType: "text/csv",
    });

    const port = new DrizzleDocumentBytesPort(db);
    expect((await port.bytesFor(doc))!.mimeType).toBe("text/csv");
  });
});

describe("finding the balance sheets behind the bank grid (real Postgres)", () => {
  /**
   * `DrizzleStatementDocumentPort` is the generic form of the two ports above,
   * and the one the bank-activity grid reads its balance sheets through. It
   * had no test at all — so the company filter it shares with them, which is
   * the whole reason these ports exist, was unproven on this one.
   */
  const port = () =>
    new DrizzleStatementDocumentPort(db, "balance_sheet", /balance\s*sheet|\bbs\b/i);

  it("lists what a version links, newest first", async () => {
    const older = await addDocument(ours, ourFolder, "Balance Sheet 2023.pdf");
    const newer = await addDocument(ours, ourFolder, "Balance Sheet 2024.pdf");
    const versionId = await linkToVersion(ours, older, "balance_sheet");
    await db.insert(schema.keyReportFileMappings).values({
      versionId,
      companyId: ours,
      reportCategory: "balance_sheet",
      documentId: newer,
    });

    const found = await port().forVersion(ours, versionId);
    expect(found.map((d) => d.id)).toEqual([newer, older]);
  });

  it("lists nothing through another company's version", async () => {
    // The company is filtered on BOTH sides of the join. A mapping row naming
    // one company and a document belonging to another must reach neither.
    const ourDoc = await addDocument(ours, ourFolder, "Balance Sheet 2024.pdf");
    const versionId = await linkToVersion(ours, ourDoc, "balance_sheet");

    expect(await port().forVersion(theirs, versionId)).toEqual([]);
  });

  it("ignores a document linked under a different category", async () => {
    const doc = await addDocument(ours, ourFolder, "Balance Sheet 2024.pdf");
    const versionId = await linkToVersion(ours, doc, "tax_return");

    expect(await port().forVersion(ours, versionId)).toEqual([]);
  });

  it("falls back to the company's most recent balance-sheet-looking document", async () => {
    await addDocument(ours, ourFolder, "Engagement Letter.pdf");
    const sheet = await addDocument(ours, ourFolder, "BS 2024.pdf");

    expect((await port().latest(ours))?.id).toBe(sheet);
  });

  it("does not reach another company's balance sheet", async () => {
    await addDocument(theirs, theirFolder, "Balance Sheet 2024.pdf");
    expect(await port().latest(ours)).toBeNull();
  });

  it("answers null rather than an unrelated document", async () => {
    // Handing back whatever was uploaded most recently would put an engagement
    // letter through the model as a balance sheet.
    await addDocument(ours, ourFolder, "Engagement Letter.pdf");
    expect(await port().latest(ours)).toBeNull();
  });
});
