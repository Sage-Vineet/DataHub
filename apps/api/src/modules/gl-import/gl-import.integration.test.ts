import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createGlImportModule } from "./index.js";

/**
 * The ledger import against a real database.
 *
 * The one that matters most is ownership: an upload row carries no company of
 * its own, so reaching it through `documents` is the only thing standing
 * between a guessed id and another tenant's file contents.
 */

const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "B",
  email: "b@x.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
};

const LEDGER = [
  ["Date", "Distribution Account", "Debit", "Credit", "Memo/Description"],
  ["2024-01-15", "Sales", "", "1200.00", "Consulting work for Q1"],
  ["2024-02-03", "Materials", "450.00", "", "Materials for the workshop"],
];

function workbook(rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;
let otherId: string;
let uploadId: string;

/** An upload, and the document that ties it to a company. */
async function addUpload(
  ownerId: string,
  data: Buffer,
  fileName = "gl.xlsx",
): Promise<string> {
  const [upload] = await db
    .insert(schema.uploads)
    .values({
      fileName,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: data.length,
      data,
      uploadedBy: BROKER.id,
    })
    .returning();
  // A folder per upload, named after the file: `folders` is unique on
  // (company_id, name), so a shared "Financials" collides on the second call.
  const [folder] = await db
    .insert(schema.folders)
    .values({ companyId: ownerId, name: `Financials — ${fileName}`, createdBy: BROKER.id })
    .returning();
  await db.insert(schema.documents).values({
    name: fileName,
    companyId: ownerId,
    folderId: folder!.id,
    fileUrl: `/uploads/${upload!.id}/content`,
    size: String(data.length),
    ext: "xlsx",
    status: "under-review" as never,
    uploadedBy: BROKER.id,
    uploadId: upload!.id,
  });
  return upload!.id;
}

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  await db.insert(schema.users).values({
    id: BROKER.id,
    name: BROKER.name,
    email: `${BROKER.id}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  companyId = randomUUID();
  otherId = randomUUID();
  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "" },
    { id: otherId, name: "Other", industry: "" },
  ]);
  current = { ...BROKER, company_ids: [companyId] };

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createGlImportModule({ db, requireAuth }).router);

  uploadId = await addUpload(companyId, workbook(LEDGER));
});

afterEach(async () => {
  await client.close();
});

const columns = (id = uploadId) =>
  request(app).get(`/manual-gl/columns/${id}`).set("X-Client-Id", companyId);

describe("reading an uploaded ledger", () => {
  it("returns its columns and a mapping to start from", async () => {
    const res = await columns().expect(200);
    expect(res.body.columns).toEqual([
      "Date",
      "Distribution Account",
      "Debit",
      "Credit",
      "Memo/Description",
    ]);
    expect(res.body.mapping.date).toBe("Date");
    expect(res.body.mapping.account_name).toBe("Distribution Account");
    expect(res.body.canAutoProcess).toBe(true);
  });

  it("sends a sample and a count, not the whole file", async () => {
    const res = await columns().expect(200);
    expect(res.body.rowCount).toBe(2);
    expect(res.body.sample).toHaveLength(2);
  });

  it("400s a file it cannot read, naming it", async () => {
    const junk = await addUpload(companyId, Buffer.from([0, 1, 2, 3]), "photo.png");
    const res = await columns(junk).expect(400);
    expect(res.body.error).toContain("photo.png");
  });
});

describe("whose file it is", () => {
  it("404s an upload belonging to another company", async () => {
    // An upload row carries no company of its own. Without reaching it through
    // `documents`, a guessed id returns another tenant's columns and sample
    // rows — the file contents, to somebody with no right to them.
    const theirs = await addUpload(otherId, workbook(LEDGER), "theirs.xlsx");
    await request(app)
      .get(`/manual-gl/columns/${theirs}`)
      .set("X-Client-Id", companyId)
      .expect(404);
  });

  it("404s an upload that does not exist", async () => {
    await columns(randomUUID()).expect(404);
  });

  it("403s a company the caller cannot reach", async () => {
    current = { ...BROKER, company_ids: [] };
    await columns().expect(403);
  });

  it("refuses to save a mapping against another company's upload", async () => {
    const theirs = await addUpload(otherId, workbook(LEDGER), "theirs.xlsx");
    await request(app)
      .post("/manual-gl/save-mapping")
      .set("X-Client-Id", companyId)
      .send({ uploadId: theirs, mapping: { date: "Date" } })
      .expect(404);
  });
});

describe("confirming a mapping", () => {
  const confirm = (mapping: Record<string, string>) =>
    request(app)
      .post("/manual-gl/save-mapping")
      .set("X-Client-Id", companyId)
      .send({ uploadId, mapping });

  it("stores it and reads it back on the next look", async () => {
    await confirm({
      date: "Date",
      account_name: "Memo/Description",
      debit: "Debit",
      credit: "Credit",
    }).expect(200);

    const res = await columns().expect(200);
    // Their correction, not the detection that disagreed with it.
    expect(res.body.mapping.account_name).toBe("Memo/Description");
    expect(res.body.confirmed).toBe(true);
  });

  it("replaces rather than accumulating", async () => {
    await confirm({ date: "Date", account_name: "Distribution Account", debit: "Debit", credit: "Credit" }).expect(200);
    await confirm({ date: "Date", account_name: "Memo/Description", debit: "Debit", credit: "Credit" }).expect(200);

    const rows = await db.select().from(schema.glImportMappings);
    expect(rows).toHaveLength(1);
  });

  it("keeps what detection thought alongside what they chose", async () => {
    // Being able to see that somebody overrode a confident guess is the
    // difference between diagnosing a bad import and staring at it.
    await confirm({ date: "Date", account_name: "Memo/Description", debit: "Debit", credit: "Credit" }).expect(200);
    const [row] = await db.select().from(schema.glImportMappings);
    const detected = row!.detected as { mapping?: Record<string, string> };
    expect(detected.mapping?.account_name).toBe("Distribution Account");
  });

  it("400s a mapping naming a column the file does not have", async () => {
    // A mapping pointing at nothing imports a column of blanks, which is a
    // ledger of zeroes rather than an error anybody sees.
    const res = await confirm({ date: "Settlement Date" }).expect(400);
    expect(res.body.error).toContain("Settlement Date");
    expect(res.body.error).toContain("gl.xlsx");
  });
});

describe("previewing what would be imported", () => {
  it("shows the rows and the sign convention", async () => {
    const res = await request(app)
      .get(`/manual-gl/preview/${uploadId}`)
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.rowCount).toBe(2);
    const sales = res.body.rows.find((r: { accountName: string }) => r.accountName === "Sales");
    expect(sales.amount).toBe(-1200);
  });

  it("reports the rows it would drop rather than importing them as zeroes", async () => {
    const partial = await addUpload(
      companyId,
      workbook([
        ["Date", "Distribution Account", "Debit", "Credit"],
        ["2024-01-15", "Sales", "", "1200.00"],
        ["2024-02-03", "", "450.00", ""],
        ["", "Rent", "900.00", ""],
      ]),
      "partial.xlsx",
    );

    const res = await request(app)
      .get(`/manual-gl/preview/${partial}`)
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.rowCount).toBe(1);
    expect(res.body.skipped.noAccount).toBe(1);
    expect(res.body.skipped.noDate).toBe(1);
  });

  it("refuses when a required field is unmapped, saying which", async () => {
    // An import on a broken mapping produces a ledger nobody can tell apart
    // from a correct one until it fails to balance.
    const vague = await addUpload(
      companyId,
      workbook([
        ["Alpha", "Beta"],
        ["one", "two"],
      ]),
      "vague.xlsx",
    );
    const res = await request(app)
      .get(`/manual-gl/preview/${vague}`)
      .set("X-Client-Id", companyId)
      .expect(400);
    expect(res.body.error).toContain("vague.xlsx");
  });

  it("caps how many rows it sends back", async () => {
    const big = [LEDGER[0]!];
    for (let i = 0; i < 120; i++) {
      big.push([`2024-01-${String((i % 28) + 1).padStart(2, "0")}`, "Sales", "", "10.00", "x"]);
    }
    const bigId = await addUpload(companyId, workbook(big), "big.xlsx");

    const res = await request(app)
      .get(`/manual-gl/preview/${bigId}?limit=25`)
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.rowCount).toBe(120);
    expect(res.body.rows).toHaveLength(25);
  });
});
