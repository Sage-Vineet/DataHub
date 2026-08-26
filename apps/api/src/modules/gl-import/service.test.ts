import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { ColumnMapping } from "./column-mapping.js";
import type {
  GlImportRepository,
  LedgerWriter,
  StoredMapping,
  UploadRecord,
} from "./ports.js";
import { GlImportService } from "./service.js";

/**
 * The guards around a ledger import.
 *
 * Every one of these refuses something rather than importing it, and each
 * refusal is the point: an import that runs on a broken mapping produces a
 * ledger nobody can tell apart from a correct one until it fails to balance.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();
const UPLOAD = randomUUID();

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const CSV = "Date,Account,Amount\n2024-01-15,Sales,1200.00\n2024-02-15,Rent,-400.00\n";

class FakeRepo implements GlImportRepository {
  uploads = new Map<string, UploadRecord>();
  owned = new Set<string>();
  mappings = new Map<string, StoredMapping>();
  saved: Array<{ uploadId: string; mapping: ColumnMapping }> = [];

  seed(id = UPLOAD, fileName = "gl.csv", data = CSV): void {
    this.uploads.set(id, {
      id,
      fileName,
      contentType: "text/csv",
      data: Buffer.from(data, "utf8"),
    });
    this.owned.add(id);
  }

  getUpload(uploadId: string): Promise<UploadRecord | null> {
    return Promise.resolve(this.uploads.get(uploadId) ?? null);
  }

  getMapping(_companyId: string, uploadId: string): Promise<StoredMapping | null> {
    return Promise.resolve(this.mappings.get(uploadId) ?? null);
  }

  saveMapping(input: {
    companyId: string;
    uploadId: string;
    mapping: ColumnMapping;
  }): Promise<StoredMapping> {
    this.saved.push({ uploadId: input.uploadId, mapping: input.mapping });
    const stored: StoredMapping = {
      uploadId: input.uploadId,
      mapping: input.mapping,
      detected: {},
      confirmedBy: "someone",
      confirmedAt: "2026-01-01T00:00:00.000Z",
    };
    this.mappings.set(input.uploadId, stored);
    return Promise.resolve(stored);
  }

  uploadBelongsToCompany(_companyId: string, uploadId: string): Promise<boolean> {
    return Promise.resolve(this.owned.has(uploadId));
  }
}

const ledger: LedgerWriter = {
  write: () => Promise.resolve({ inserted: 0 }),
  originOf: () => Promise.resolve(null),
} as unknown as LedgerWriter;

function build() {
  const repo = new FakeRepo();
  return { repo, service: new GlImportService({ repo, ledger }) };
}

describe("naming a company", () => {
  it("refuses a request naming none", async () => {
    const { service } = build();
    await expect(service.columns(USER, "", UPLOAD)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("refuses one the caller cannot reach", async () => {
    const { service } = build();
    await expect(service.columns(USER, OTHER, UPLOAD)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("naming an upload", () => {
  it("refuses a request naming none", async () => {
    const { service } = build();
    await expect(service.columns(USER, COMPANY, "")).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      service.saveMapping(USER, COMPANY, { uploadId: "", mapping: {} }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("checks ownership BEFORE reading the bytes", async () => {
    // Parsing another tenant's upload and handing back its columns and sample
    // rows is a disclosure, not a mis-fetch. The upload exists here; it simply
    // is not this company's.
    const { repo, service } = build();
    repo.seed();
    repo.owned.delete(UPLOAD);

    await expect(service.columns(USER, COMPANY, UPLOAD)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.saveMapping(USER, COMPANY, { uploadId: UPLOAD, mapping: {} }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an upload the company owns but whose bytes are gone", async () => {
    const { repo, service } = build();
    repo.owned.add(UPLOAD);
    await expect(service.columns(USER, COMPANY, UPLOAD)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reading a file's columns", () => {
  it("reports the columns, a sample and a detected mapping", async () => {
    const { repo, service } = build();
    repo.seed();
    const view = await service.columns(USER, COMPANY, UPLOAD);

    expect(view.columns).toEqual(["Date", "Account", "Amount"]);
    expect(view.rowCount).toBe(2);
    expect(view.sample).toHaveLength(2);
    expect(view.confirmed).toBe(false);
    expect(view.mapping.date).toBe("Date");
  });

  it("sends a handful of rows rather than the file", async () => {
    // Enough to recognise what is being mapped, not enough to ship the ledger
    // to the browser.
    const rows = Array.from({ length: 40 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")},Sales,${i}`);
    const { repo, service } = build();
    repo.seed(UPLOAD, "big.csv", `Date,Account,Amount\n${rows.join("\n")}\n`);

    const view = await service.columns(USER, COMPANY, UPLOAD);
    expect(view.rowCount).toBe(40);
    expect(view.sample).toHaveLength(10);
  });

  it("prefers a mapping somebody confirmed over one it detected", async () => {
    // They were looking at the file. Re-detecting would quietly discard their
    // correction every time the screen reloaded.
    const { repo, service } = build();
    repo.seed();
    await service.saveMapping(USER, COMPANY, {
      uploadId: UPLOAD,
      mapping: { date: "Date", account_name: "Amount", split_amount: "Amount" },
    });

    const view = await service.columns(USER, COMPANY, UPLOAD);
    expect(view.confirmed).toBe(true);
    expect(view.mapping.account_name).toBe("Amount");
  });
});

describe("saving a mapping", () => {
  it("refuses one that names a column the file does not have", async () => {
    // A mapping pointing at nothing imports a column of blanks — a ledger of
    // zeroes rather than an error anybody sees.
    const { repo, service } = build();
    repo.seed();
    await expect(
      service.saveMapping(USER, COMPANY, {
        uploadId: UPLOAD,
        mapping: { split_amount: "Total Value" },
      }),
    ).rejects.toThrow(/Total Value/);
    expect(repo.saved).toEqual([]);
  });

  it("accepts one that names only real columns", async () => {
    const { repo, service } = build();
    repo.seed();
    const stored = await service.saveMapping(USER, COMPANY, {
      uploadId: UPLOAD,
      mapping: { date: "Date", account_name: "Account", split_amount: "Amount" },
    });
    expect(stored.uploadId).toBe(UPLOAD);
    expect(repo.saved).toHaveLength(1);
  });
});

describe("staging", () => {
  it("refuses a run naming no version", async () => {
    const { service } = build();
    await expect(
      service.stage(USER, COMPANY, { versionId: "", uploadIds: [UPLOAD] }),
    ).rejects.toThrow(/versionId/);
  });

  it("refuses a run with no uploads at all", async () => {
    const { service } = build();
    await expect(
      service.stage(USER, COMPANY, { versionId: "v1", uploadIds: [] }),
    ).rejects.toThrow(/At least one upload/);
  });
});

describe("previewing what would be imported", () => {
  it("reads the rows under the confirmed mapping", async () => {
    const { repo, service } = build();
    repo.seed();
    await service.saveMapping(USER, COMPANY, {
      uploadId: UPLOAD,
      mapping: { date: "Date", account_name: "Account", split_amount: "Amount" },
    });

    const preview = await service.preview(USER, COMPANY, UPLOAD);
    expect(preview.fileName).toBe("gl.csv");
    expect(preview.rows).toHaveLength(2);
  });

  it("refuses when a required field is not mapped, and names it", async () => {
    // An import on a broken mapping produces a ledger nobody can tell apart
    // from a correct one until it fails to balance.
    const { repo, service } = build();
    repo.seed(UPLOAD, "odd.csv", "Alpha,Beta\n1,2\n");
    await expect(service.preview(USER, COMPANY, UPLOAD)).rejects.toThrow(/not mapped/);
  });

  it("says 'is' for one missing field and 'are' for several", async () => {
    // The message is what the person mapping the file reads. Getting the verb
    // wrong is small; reading it out loud in front of a client is not.
    const { repo, service } = build();
    repo.seed(UPLOAD, "one.csv", "Date,Account,Memo\n2024-01-15,Sales,Consulting\n");
    await expect(service.preview(USER, COMPANY, UPLOAD)).rejects.toThrow(/\bis not mapped\./);

    const second = build();
    second.repo.seed(UPLOAD, "several.csv", "Alpha,Beta\n1,2\n");
    await expect(second.service.preview(USER, COMPANY, UPLOAD)).rejects.toThrow(
      /\bare not mapped\./,
    );
  });

  it("reports an upload that vanished under it as gone, not as a fault", async () => {
    /**
     * The ownership check and the read are two calls. A file deleted between
     * them — or two repository methods disagreeing — lands here, and the answer
     * has to be the same 404 the ownership check would have given rather than a
     * TypeError reading `upload.data`.
     */
    const { repo, service } = build();
    repo.seed();
    repo.uploads.delete(UPLOAD); // still `owned`, no longer readable

    await expect(
      service.saveMapping(USER, COMPANY, { uploadId: UPLOAD, mapping: { date: "Date" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
