import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { AskInput, DocumentReader } from "../../shared/gemini.js";
import { InMemorySyncRepository } from "../sync/repository.memory.js";
import { SyncService } from "../sync/service.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";
import {
  SourceSyncService,
  statementTypeOfCategory,
  toDate,
  toStatementRows,
} from "./source-sync.js";

/**
 * Reading a source's uploaded files into statements.
 *
 * This is the writer the manual-upload pages were missing. The version it
 * replaces wrote to a table that does not exist, so these tests are about what
 * the pages need rather than about what the old code did.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();
const MANUAL = "manual_upload_excel_pdf";

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const NOW = new Date("2026-06-01T00:00:00.000Z");

const STATEMENT = {
  asOfDate: "2025-12-31",
  rows: [{ name: "Total Assets", amount: 100_000, children: [{ name: "Cash", amount: 25_000 }] }],
};

function reader(answers: Record<string, unknown> = {}): DocumentReader & { asks: AskInput[] } {
  const asks: AskInput[] = [];
  let index = 0;
  return {
    asks,
    ask: () => Promise.reject(new Error("not used")),
    askForJson: <T,>(input: AskInput): Promise<T> => {
      asks.push(input);
      const answer = answers[String(index++)] ?? answers.default ?? STATEMENT;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
  };
}

function bytes(missing: ReadonlySet<string> = new Set()) {
  return {
    bytesFor: (documentId: string) =>
      Promise.resolve(
        missing.has(documentId)
          ? null
          : { bytes: Buffer.from("a file"), mimeType: "application/pdf" },
      ),
  };
}

function build(options: { answers?: Record<string, unknown>; missing?: Set<string> } = {}) {
  const statements = new InMemoryStatementsRepository();
  const runRepo = new InMemorySyncRepository();
  runRepo.now = NOW;
  const runs = new SyncService({ repo: runRepo });
  const documentReader = reader(options.answers);
  return {
    statements,
    runRepo,
    reader: documentReader,
    service: new SourceSyncService({
      statements,
      bytes: bytes(options.missing),
      reader: documentReader,
      runs,
    }),
  };
}

const link = (
  statements: InMemoryStatementsRepository,
  documentId: string,
  category: string,
  name = `${category}.pdf`,
  versionId = "v1",
) => {
  statements.seedLinkedDocument({ documentId, name, folderName: "Financials", category }, versionId);
};

describe("which statement a category holds", () => {
  it("maps the link's category to a statement type", () => {
    expect(statementTypeOfCategory("balance_sheet")).toBe("balance_sheet");
    // The two vocabularies differ here and nowhere else, which is exactly why
    // the mapping is a table rather than a string comparison.
    expect(statementTypeOfCategory("profit_loss")).toBe("profit_and_loss");
    expect(statementTypeOfCategory("bank_statement")).toBe("bank_reconciliation");
  });

  it("has no type for a category nothing is filed under", () => {
    expect(statementTypeOfCategory("something_else")).toBeNull();
  });
});

describe("reading the model's answer", () => {
  it("takes the rows it returned", () => {
    expect(toStatementRows({ rows: [{ name: "Cash" }] })).toEqual([{ name: "Cash" }]);
  });

  it("treats anything that is not a list of rows as none", () => {
    expect(toStatementRows({ rows: "no" })).toEqual([]);
    expect(toStatementRows(null)).toEqual([]);
    expect(toStatementRows("a sentence")).toEqual([]);
  });

  it("takes a date only in the shape it asked for", () => {
    expect(toDate("2025-12-31")).toBe("2025-12-31");
    expect(toDate("December 2025")).toBeNull();
    expect(toDate(null)).toBeNull();
  });
});

describe("syncing a source", () => {
  it("reads every linked document into a statement", async () => {
    const { service, statements } = build();
    link(statements, "doc-bs", "balance_sheet");
    link(statements, "doc-pl", "profit_loss");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);

    expect(result.processed.map((p) => p.statementType).sort()).toEqual([
      "balance_sheet",
      "profit_and_loss",
    ]);
    expect(result.failed).toEqual([]);
    expect(await statements.latest(COMPANY, "balance_sheet", {})).toMatchObject({
      sourceKey: MANUAL,
      documentId: "doc-bs",
      payload: { rows: STATEMENT.rows },
    });
  });

  it("files each statement under the year it covers", async () => {
    // A statement on the wrong dashboard card is a card whose every figure is
    // plausible and wrong.
    const { service, statements } = build();
    link(statements, "doc-bs", "balance_sheet");
    await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect((await statements.latest(COMPANY, "balance_sheet", {}))?.fiscalYear).toBe(2025);
  });

  it("falls back to the file name for a statement that states no dates", async () => {
    const { service, statements } = build({
      answers: { default: { rows: [{ name: "Revenue", amount: 1 }] } },
    });
    link(statements, "doc-pl", "profit_loss", "Profit and Loss 2023.pdf");
    await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect((await statements.latest(COMPANY, "profit_and_loss", {}))?.fiscalYear).toBe(2023);
  });

  it("does not pay to read a document it has already read", async () => {
    // Legacy sent every file through the model on every sync, whether or not
    // anything had changed. An extraction does not change unless its document
    // does.
    const { service, statements, reader: model } = build();
    link(statements, "doc-bs", "balance_sheet");
    await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    const second = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);

    expect(second.skipped).toBe(1);
    expect(second.processed).toEqual([]);
    expect(model.asks).toHaveLength(1);
  });

  it("reads it again when the caller asks for a refresh", async () => {
    const { service, statements, reader: model } = build();
    link(statements, "doc-bs", "balance_sheet");
    await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    const second = await service.syncSource(USER, COMPANY, MANUAL, { force: true }, NOW);

    expect(second.processed).toHaveLength(1);
    expect(model.asks).toHaveLength(2);
  });

  it("keeps what it already had when one document fails", async () => {
    // Legacy deleted every row for the source BEFORE reading anything, so a
    // sync that then failed halfway left the company with less than it started
    // with and no way back.
    const { service, statements } = build({
      answers: { "0": STATEMENT, "1": new Error("the model is down") },
    });
    link(statements, "doc-bs", "balance_sheet");
    link(statements, "doc-pl", "profit_loss");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);

    expect(result.processed).toHaveLength(1);
    expect(result.failed).toEqual([
      { documentId: "doc-pl", fileName: "profit_loss.pdf", reason: "the model is down" },
    ]);
    expect(await statements.latest(COMPANY, "balance_sheet", {})).not.toBeNull();
  });

  it("refuses to store a document nothing could be read out of", async () => {
    // An empty tree saved as a statement takes the year's slot on the
    // dashboard and reports every figure as zero — worse than the warning that
    // says the year has no balance sheet.
    const { service, statements } = build({ answers: { default: { rows: [] } } });
    link(statements, "doc-bs", "balance_sheet");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect(result.processed).toEqual([]);
    expect(result.failed[0]!.reason).toMatch(/Nothing could be read/);
    expect(await statements.latest(COMPANY, "balance_sheet", {})).toBeNull();
  });

  it("falls back to the document's id when it has no name to give", async () => {
    // `documents.name` is nullable, and a failure that says
    // `Nothing could be read out of ""` names nothing a person can go and look
    // at. The id is ugly and findable, which is the right trade in an error.
    const { service, statements } = build({ answers: { default: { rows: [] } } });
    statements.seedLinkedDocument(
      { documentId: "doc-bs", name: null, folderName: "Financials", category: "balance_sheet" },
      "v1",
    );

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect(result.failed[0]!.reason).toContain("doc-bs");
  });

  it("reports a failure that is not an Error at all", async () => {
    // A rejection with a string, or an `undefined` from a library that throws
    // non-Errors. `String(error)` beats an empty `reason`, which reads on the
    // page as a file that failed for no reason.
    const { service, statements, reader: model } = build();
    link(statements, "doc-bs", "balance_sheet");
    model.askForJson = () => Promise.reject("the model container was evicted");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect(result.failed[0]!.reason).toBe("the model container was evicted");
  });

  it("names a document with no file behind it rather than throwing", async () => {
    const { service, statements } = build({ missing: new Set(["doc-bs"]) });
    link(statements, "doc-bs", "balance_sheet");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect(result.failed[0]!.reason).toMatch(/No file is stored/);
  });

  it("skips a link filed under a category no statement matches", async () => {
    const { service, statements, reader: model } = build();
    link(statements, "doc-odd", "engagement_letter");
    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);

    expect(result.processed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(model.asks).toEqual([]);
  });

  it("reads one version's documents when a version is named", async () => {
    const { service, statements } = build();
    link(statements, "doc-a", "balance_sheet", "2024.pdf", "v1");
    link(statements, "doc-b", "balance_sheet", "2025.pdf", "v2");

    const result = await service.syncSource(USER, COMPANY, MANUAL, { versionId: "v2" }, NOW);
    expect(result.processed.map((p) => p.documentId)).toEqual(["doc-b"]);
  });

  it("reads a document linked to two versions once", async () => {
    // Read twice it is extracted twice, and the page then chooses between two
    // identical statements.
    const { service, statements } = build();
    link(statements, "doc-bs", "balance_sheet", "2025.pdf", "v1");
    link(statements, "doc-bs", "balance_sheet", "2025.pdf", "v2");

    expect((await service.syncSource(USER, COMPANY, MANUAL, {}, NOW)).processed).toHaveLength(1);
  });

  it("files each source's statements under its own key", async () => {
    // One document belongs to one source — it was uploaded into one place —
    // and an extract is identified by its document, so a file cannot be a
    // balance sheet under two sources at once.
    const { service, statements } = build();
    link(statements, "doc-manual", "balance_sheet");
    await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);

    await service.parseDocuments(
      USER,
      COMPANY,
      "quickbooks_manual",
      [{ documentId: "doc-qms", statementType: "balance_sheet" }],
      {},
      NOW,
    );

    expect(
      (await statements.latest(COMPANY, "balance_sheet", { sourceKey: MANUAL }))?.documentId,
    ).toBe("doc-manual");
    expect(
      (await statements.latest(COMPANY, "balance_sheet", { sourceKey: "quickbooks_manual" }))
        ?.documentId,
    ).toBe("doc-qms");
  });

  it("refuses a company the caller cannot reach", async () => {
    const { service } = build();
    await expect(service.syncSource(USER, OTHER, MANUAL, {}, NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("refuses a request naming no company or no source", async () => {
    const { service } = build();
    await expect(service.syncSource(USER, "", MANUAL, {}, NOW)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(service.syncSource(USER, COMPANY, "", {}, NOW)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

describe("the run behind a sync", () => {
  it("records the sync against a run the page can watch", async () => {
    // Legacy kept progress in a module-level map, so two gateway instances
    // each had their own idea of how far along it was and a restart lost it
    // entirely while the work was half done.
    const { service, statements, runRepo } = build();
    link(statements, "doc-bs", "balance_sheet");
    link(statements, "doc-pl", "profit_loss");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    const run = await runRepo.getById(COMPANY, result.runId);

    expect(run).toMatchObject({
      sourceKey: MANUAL,
      status: "completed",
      totalFiles: 2,
      processedFiles: 2,
    });
    expect(run?.result).toMatchObject({ processed: 2, failed: 0, skipped: 0 });
  });

  it("refuses a second sync of the same source while one is running", async () => {
    const { service, statements, runRepo } = build();
    link(statements, "doc-bs", "balance_sheet");
    await runRepo.start({
      companyId: COMPANY,
      sourceKey: MANUAL,
      kind: "documents",
      totalFiles: 1,
      startedBy: USER.id,
    });

    await expect(service.syncSource(USER, COMPANY, MANUAL, {}, NOW)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("fails the run when nothing at all could be read", async () => {
    const { service, statements, runRepo } = build({ answers: { default: new Error("no") } });
    link(statements, "doc-bs", "balance_sheet");

    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    const run = await runRepo.getById(COMPANY, result.runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorMessage).toMatch(/No document could be read/);
  });

  it("completes a run that had nothing to do", async () => {
    const { service, runRepo } = build();
    const result = await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    expect((await runRepo.getById(COMPANY, result.runId))?.status).toBe("completed");
  });

  it("closes the run rather than leaving it open when the store fails", async () => {
    const { statements, runRepo } = build();
    link(statements, "doc-bs", "balance_sheet");
    const runs = new SyncService({ repo: runRepo });
    let advances = 0;

    const service = new SourceSyncService({
      statements,
      bytes: bytes(),
      reader: reader(),
      runs: {
        start: runs.start.bind(runs),
        finish: runs.finish.bind(runs),
        advance: async (user, companyId, runId, patch) => {
          advances += 1;
          if (advances > 1) throw new Error("connection lost");
          await runs.advance(user, companyId, runId, patch);
        },
      },
    });

    await expect(service.syncSource(USER, COMPANY, MANUAL, {}, NOW)).rejects.toThrow(
      /connection lost/,
    );
    const run = await runRepo.current(COMPANY, { sourceKey: MANUAL });
    expect(run?.status).toBe("failed");
  });
});

describe("parsing named documents", () => {
  it("reads exactly the documents it was given", async () => {
    // The "Choose Folder" flow. On a company with fifty statements, re-scanning
    // is fifty model calls to read the two that were just uploaded.
    const { service, statements, reader: model } = build();
    link(statements, "doc-other", "balance_sheet");

    const result = await service.parseDocuments(
      USER,
      COMPANY,
      MANUAL,
      [{ documentId: "doc-new", statementType: "profit_and_loss" }],
      {},
      NOW,
    );

    expect(result.processed.map((p) => p.documentId)).toEqual(["doc-new"]);
    expect(model.asks).toHaveLength(1);
  });

  it("takes the category spelling as well as the statement type", async () => {
    // The page sends whichever it has to hand, and refusing one of them is a
    // failure nobody can act on.
    const { service } = build();
    const result = await service.parseDocuments(
      USER,
      COMPANY,
      MANUAL,
      [{ documentId: "doc-pl", statementType: "profit_loss" }],
      {},
      NOW,
    );
    expect(result.processed[0]!.statementType).toBe("profit_and_loss");
  });

  it("refuses a type it does not recognise rather than guessing", async () => {
    // A statement stored under the wrong type is served to the page that asks
    // for that type, and its figures are wrong in a way nothing can show.
    const { service } = build();
    await expect(
      service.parseDocuments(
        USER,
        COMPANY,
        MANUAL,
        [{ documentId: "doc", statementType: "whatever" }],
        {},
        NOW,
      ),
    ).rejects.toThrow(/not a statement type/);
  });

  it("refuses a type no document is ever filed under", async () => {
    // Cash flow is derived from the other two rather than uploaded.
    const { service } = build();
    await expect(
      service.parseDocuments(
        USER,
        COMPANY,
        MANUAL,
        [{ documentId: "doc", statementType: "cash_flow" }],
        {},
        NOW,
      ),
    ).rejects.toThrow(/Nothing is ever filed under/);
  });

  it("refuses a document naming no id", async () => {
    const { service } = build();
    await expect(
      service.parseDocuments(USER, COMPANY, MANUAL, [{ statementType: "balance_sheet" }], {}, NOW),
    ).rejects.toThrow(/documentId/);
  });

  it("refuses an empty list rather than starting a run with nothing in it", async () => {
    const { service } = build();
    await expect(service.parseDocuments(USER, COMPANY, MANUAL, [], {}, NOW)).rejects.toThrow(
      /documents array/,
    );
  });

  it("clears only the source it was asked about", async () => {
    // Legacy cleared everything the company had before parsing two files, so a
    // targeted parse could empty a year of statements it was never asked to
    // touch.
    const { service, statements } = build();
    link(statements, "doc-manual", "balance_sheet");
    await service.syncSource(USER, COMPANY, MANUAL, {}, NOW);
    await service.parseDocuments(
      USER,
      COMPANY,
      "quickbooks_manual",
      [{ documentId: "doc-qms", statementType: "balance_sheet" }],
      {},
      NOW,
    );

    await service.parseDocuments(
      USER,
      COMPANY,
      "quickbooks_manual",
      [{ documentId: "doc-new", statementType: "profit_and_loss" }],
      { clearFirst: true },
      NOW,
    );

    expect(await statements.latest(COMPANY, "balance_sheet", { sourceKey: MANUAL })).not.toBeNull();
    expect(
      await statements.latest(COMPANY, "balance_sheet", { sourceKey: "quickbooks_manual" }),
    ).toBeNull();
  });

  it("re-reads a document it was explicitly given", async () => {
    // A caller who named these documents is asking for them to be read, not
    // for a report on what was already read.
    const { service, reader: model } = build();
    const named = [{ documentId: "doc-bs", statementType: "balance_sheet" }];
    await service.parseDocuments(USER, COMPANY, MANUAL, named, {}, NOW);
    await service.parseDocuments(USER, COMPANY, MANUAL, named, {}, NOW);
    expect(model.asks).toHaveLength(2);
  });

  it("checks the company", async () => {
    const { service } = build();
    await expect(
      service.parseDocuments(
        USER,
        OTHER,
        MANUAL,
        [{ documentId: "doc", statementType: "balance_sheet" }],
        {},
        NOW,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no source", async () => {
    const { service } = build();
    await expect(
      service.parseDocuments(
        USER,
        COMPANY,
        "",
        [{ documentId: "doc", statementType: "balance_sheet" }],
        {},
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
