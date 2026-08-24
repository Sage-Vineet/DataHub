import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import type { AskInput, DocumentReader } from "../../shared/gemini.js";
import { InMemoryStatementsRepository } from "../statements/repository.memory.js";
import { InMemoryReportsRepository } from "./repository.memory.js";
import { KeyReportSyncService, type StatementEntryWriter, type SyncLogWriter } from "./key-report-sync.js";
import type { StatementEntryRow } from "./statement-entries.js";

/**
 * Reading a version's linked statements into the entry tables.
 *
 * These are the financial engine's input — the balance sheet is rolled forward
 * from them and the chart of accounts is regenerated from them — and nothing
 * in the gateway wrote either table until this existed.
 */

const COMPANY = randomUUID();
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
  rows: [
    {
      name: "Assets",
      amount: 5000,
      children: [{ name: "1000 Operating Cash", amount: 5000, type: "asset" }],
    },
  ],
};

interface Written {
  documentId: string;
  kind: string;
  fiscalYear: number;
  asOfDate: string | null;
  rows: readonly StatementEntryRow[];
}

function entryWriter() {
  const written: Written[] = [];
  let cleared = 0;
  const writer: StatementEntryWriter = {
    clearGenerated: () => {
      cleared += 1;
      return Promise.resolve(0);
    },
    replaceForDocument: (input) => {
      written.push({ ...input });
      return Promise.resolve(input.rows.length);
    },
  };
  return { writer, written, clearedCount: () => cleared };
}

function logWriter() {
  const finished: Array<{ status: string; errorMessage?: string | null }> = [];
  let started = 0;
  const logs: SyncLogWriter = {
    start: () => {
      started += 1;
      return Promise.resolve(started);
    },
    finish: (_id, input) => {
      finished.push({ status: input.status, errorMessage: input.errorMessage ?? null });
      return Promise.resolve();
    },
  };
  return { logs, finished, startedCount: () => started };
}

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

async function build(options: { answers?: Record<string, unknown>; missing?: Set<string> } = {}) {
  const versions = new InMemoryReportsRepository();
  const version = await versions.create({
    companyId: COMPANY,
    versionName: "v1",
    metadata: {},
    createdBy: USER.id,
  });
  const statements = new InMemoryStatementsRepository();
  const entries = entryWriter();
  const logs = logWriter();
  const model = reader(options.answers);

  return {
    version,
    versions,
    statements,
    entries,
    logs,
    reader: model,
    service: new KeyReportSyncService({
      versions,
      statements,
      entries: entries.writer,
      logs: logs.logs,
      bytes: {
        bytesFor: (id: string) =>
          Promise.resolve(
            options.missing?.has(id)
              ? null
              : { bytes: Buffer.from("a file"), mimeType: "application/pdf" },
          ),
      },
      reader: model,
    }),
  };
}

const link = (
  statements: InMemoryStatementsRepository,
  documentId: string,
  category: string,
  name = `${category}.pdf`,
  versionId = "v1",
) => statements.seedLinkedDocument({ documentId, name, folderName: "Financials", category }, versionId);

describe("reading a version's statements", () => {
  it("writes the balance sheet and the P&L into their own tables", async () => {
    const { service, statements, entries, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    link(statements, "doc-pl", "profit_loss", "PL.pdf", version.id);

    const result = await service.sync(USER, version.id, NOW);

    expect(result.processed.map((p) => p.kind).sort()).toEqual([
      "balance_sheet",
      "profit_and_loss",
    ]);
    expect(entries.written.map((w) => w.kind).sort()).toEqual([
      "balance_sheet",
      "profit_and_loss",
    ]);
    expect(result.totalRowsInserted).toBeGreaterThan(0);
  });

  it("files each statement under the year it states", async () => {
    const { service, statements, entries, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    await service.sync(USER, version.id, NOW);

    expect(entries.written[0]).toMatchObject({ fiscalYear: 2025, asOfDate: "2025-12-31" });
  });

  it("gives a balance sheet a date even when it stated none", async () => {
    // A position with no date anchors nothing — the roll-forward has no point
    // to start from and the whole engagement comes back empty.
    const { service, statements, entries, version } = await build({
      answers: { default: { rows: STATEMENT.rows } },
    });
    link(statements, "doc-bs", "balance_sheet", "Balance Sheet 2023.pdf", version.id);
    await service.sync(USER, version.id, NOW);

    expect(entries.written[0]).toMatchObject({ fiscalYear: 2023, asOfDate: "2023-12-31" });
  });

  it("clears the rows it generated before reading anything", async () => {
    // A carry-forward has to be recomputed from freshly extracted figures, or
    // it compounds whatever produced it.
    const { service, statements, entries, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    await service.sync(USER, version.id, NOW);
    expect(entries.clearedCount()).toBe(1);
  });

  it("replaces one document's rows rather than the whole version's", async () => {
    // A re-sync of one file must not empty the others.
    const { service, statements, entries, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    await service.sync(USER, version.id, NOW);

    expect(entries.written[0]?.documentId).toBe("doc-bs");
  });

  it("marks the version synced once something landed", async () => {
    const { service, statements, versions, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    await service.sync(USER, version.id, NOW);

    expect((await versions.getById(version.id))?.status).toBe("synced");
  });

  it("leaves a tax return or a bank statement to the module that owns it", async () => {
    // Those are read into `statement_extracts` by their own modules.
    // Duplicating them here would be two stores disagreeing about one file.
    const { service, statements, entries, reader: model, version } = await build();
    link(statements, "doc-tax", "tax_return", "Return.pdf", version.id);
    link(statements, "doc-bank", "bank_statement", "Bank.pdf", version.id);

    const result = await service.sync(USER, version.id, NOW);
    expect(result.skipped).toBe(2);
    expect(entries.written).toEqual([]);
    expect(model.asks).toEqual([]);
  });

  it("reports the years it covered", async () => {
    const { service, statements, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    expect((await service.sync(USER, version.id, NOW)).years).toEqual([2025]);
  });
});

describe("when a file cannot be read", () => {
  it("carries on with the others, and names what failed", async () => {
    const { service, statements, version } = await build({
      answers: { "0": STATEMENT, "1": new Error("the model is down") },
    });
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    link(statements, "doc-pl", "profit_loss", "PL.pdf", version.id);

    const result = await service.sync(USER, version.id, NOW);
    expect(result.processed).toHaveLength(1);
    expect(result.failed).toEqual([
      { documentId: "doc-pl", fileName: "PL.pdf", reason: "the model is down" },
    ]);
  });

  it("refuses to store a statement nothing could be read out of", async () => {
    // Written to the entry tables it takes the year's place in every report
    // derived from them, and reports every figure as zero.
    const { service, statements, entries, version } = await build({
      answers: { default: { rows: [] } },
    });
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);

    const result = await service.sync(USER, version.id, NOW);
    expect(entries.written).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(/Nothing could be read/);
  });

  it("names a document with no file behind it", async () => {
    const { service, statements, version } = await build({ missing: new Set(["doc-bs"]) });
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);

    const result = await service.sync(USER, version.id, NOW);
    expect(result.failed[0]?.reason).toMatch(/No file is stored/);
  });

  it("does not mark the version synced when nothing landed at all", async () => {
    // Marking it would leave the page saying the figures are current when no
    // figure was written.
    const { service, statements, versions, logs, version } = await build({
      answers: { default: new Error("no") },
    });
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);

    await service.sync(USER, version.id, NOW);
    expect((await versions.getById(version.id))?.status).not.toBe("synced");
    expect(logs.finished[0]).toMatchObject({ status: "failed" });
  });
});

describe("the sync log", () => {
  it("opens one and closes it on success", async () => {
    const { service, statements, logs, version } = await build();
    link(statements, "doc-bs", "balance_sheet", "BS.pdf", version.id);
    await service.sync(USER, version.id, NOW);

    expect(logs.startedCount()).toBe(1);
    expect(logs.finished).toEqual([{ status: "success", errorMessage: null }]);
  });

  it("closes it when the run throws outright", async () => {
    // An open row reads as a sync still running, forever.
    const { versions, statements, logs, version } = await build();
    const service = new KeyReportSyncService({
      versions,
      statements,
      entries: {
        clearGenerated: () => Promise.reject(new Error("connection lost")),
        replaceForDocument: () => Promise.resolve(0),
      },
      logs: logs.logs,
      bytes: { bytesFor: () => Promise.resolve(null) },
      reader: reader(),
    });

    await expect(service.sync(USER, version.id, NOW)).rejects.toThrow(/connection lost/);
    expect(logs.finished[0]).toMatchObject({ status: "failed", errorMessage: "connection lost" });
  });

  it("completes a version with nothing linked at all", async () => {
    const { service, logs, version } = await build();
    const result = await service.sync(USER, version.id, NOW);
    expect(result.processed).toEqual([]);
    expect(logs.finished[0]?.status).toBe("success");
  });
});

describe("asking about a version that is not there", () => {
  it("404s rather than opening a log against nothing", async () => {
    const { service, logs } = await build();
    await expect(service.sync(USER, randomUUID(), NOW)).rejects.toBeInstanceOf(NotFoundError);
    expect(logs.startedCount()).toBe(0);
  });

  it("refuses a request naming no version", async () => {
    const { service } = await build();
    await expect(service.sync(USER, "", NOW)).rejects.toBeInstanceOf(BadRequestError);
  });
});
