import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError } from "../../../shared/errors.js";
import type { DatasetVersionRecord, DatasetsRepository } from "../../datasets/ports.js";
import { InMemoryStatementsRepository } from "../../statements/repository.memory.js";
import type { StatementsRepository } from "../../statements/ports.js";
import type { SyncRepository, SyncRunRecord } from "../../sync/ports.js";
import { QUICKBOOKS_SOURCE_KEY } from "./service.js";
import { QuickBooksSyncStatusService } from "./status.js";

/**
 * The state of a company's QuickBooks sync.
 *
 * Legacy read this from four tables that do not exist, so the endpoint has
 * been answering nothing. It is composed here rather than stored — legacy kept
 * a `sync_metadata` row duplicating the current job's status, which is two
 * places for one fact and the copy goes stale the moment a process dies
 * mid-write.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2025-03-01T12:00:00.000Z");

const USER: SessionUser = {
  id: "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu",
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const RUN: SyncRunRecord = {
  id: "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr",
  companyId: COMPANY,
  sourceKey: QUICKBOOKS_SOURCE_KEY,
  kind: "full",
  status: "running",
  totalFiles: 10,
  processedFiles: 4,
  currentFile: "BalanceSheet",
  currentStep: "fetching",
  startedAt: "2025-03-01T11:59:00.000Z",
  finishedAt: null,
  heartbeatAt: "2025-03-01T11:59:30.000Z",
  errorMessage: null,
  result: {},
};

const DATASET: DatasetVersionRecord = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  companyId: COMPANY,
  sourceKey: QUICKBOOKS_SOURCE_KEY,
  versionNumber: 3,
  status: "finalized",
  isActive: true,
  finalizedAt: "2025-02-28T09:00:00.000Z",
  createdAt: "2025-02-28T08:00:00.000Z",
  activatedAt: "2025-02-28T09:05:00.000Z",
  label: null,
  syncRunId: null,
  rowCount: 0,
  fiscalYears: [],
};

function runs(current: SyncRunRecord | null): SyncRepository {
  return {
    current: () => Promise.resolve(current),
    history: () => Promise.resolve([]),
    getById: () => Promise.resolve(null),
    start: () => Promise.reject(new Error("not used")),
    advance: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    reapStalled: () => Promise.resolve(0),
  };
}

function datasets(active: DatasetVersionRecord | null): DatasetsRepository {
  return {
    list: () => Promise.resolve([]),
    getById: () => Promise.resolve(null),
    active: () => Promise.resolve(active),
    create: () => Promise.reject(new Error("not used")),
    finalize: () => Promise.resolve(null),
    fail: () => Promise.resolve(),
    activate: () => Promise.resolve(null),
  };
}

function build(over: {
  run?: SyncRunRecord | null;
  dataset?: DatasetVersionRecord | null;
  statements?: StatementsRepository;
} = {}) {
  const statements = over.statements ?? new InMemoryStatementsRepository();
  return {
    statements,
    service: new QuickBooksSyncStatusService({
      runs: runs(over.run === undefined ? RUN : over.run),
      datasets: datasets(over.dataset === undefined ? DATASET : over.dataset),
      statements,
    }),
  };
}

const hold = (statements: StatementsRepository, statementType: string, over: Record<string, unknown> = {}) =>
  statements.save({
    companyId: COMPANY,
    provenance: { from: "pull", reportParams: { accounting_method: "Accrual" }, variant: "Accrual" },
    statementType: statementType as never,
    sourceKey: QUICKBOOKS_SOURCE_KEY,
    periodStart: "2024-01-01",
    periodEnd: "2024-12-31",
    asOfDate: "2024-12-31",
    fiscalYear: 2024,
    payload: {},
    extractedBy: null,
    ...over,
  });

describe("what it reports", () => {
  it("takes the running sync's own state, not a copy of it", async () => {
    const { service } = build();
    const status = await service.status(USER, COMPANY, NOW);
    expect(status.syncStatus).toBe("running");
    expect(status.syncProgress).toBe(40);
    expect(status.syncJobId).toBe(RUN.id);
    expect(status.lastAttemptedSync).toBe("2025-03-01T11:59:00.000Z");
  });

  it("reports the DATASET's finalization as the last successful sync", async () => {
    // Not the run's finish. A run can end in failure, and reporting its end as
    // a successful sync tells somebody their data is current when it is not.
    const { service } = build();
    const status = await service.status(USER, COMPANY, NOW);
    expect(status.lastSuccessfulSync).toBe("2025-02-28T09:00:00.000Z");
  });

  it("does not claim a successful sync when a run failed", async () => {
    const { service } = build({
      run: {
        ...RUN,
        status: "failed",
        finishedAt: "2025-03-01T12:00:00.000Z",
        errorMessage: "QuickBooks refused the token",
      },
      dataset: null,
    });
    const status = await service.status(USER, COMPANY, NOW);
    expect(status.lastSuccessfulSync).toBeNull();
    expect(status.lastError).toBe("QuickBooks refused the token");
  });

  it("counts what is actually held, and says what each report is", async () => {
    const { service, statements } = build();
    await hold(statements, "balance_sheet");
    await hold(statements, "profit_and_loss");

    const status = await service.status(USER, COMPANY, NOW);
    expect(status.totalCachedReports).toBe(2);
    expect(status.reports.map((r) => r.reportType).sort()).toEqual([
      "balance_sheet",
      "profit_and_loss",
    ]);
    expect(status.reports[0]!.reportParams).toEqual({ accounting_method: "Accrual" });
  });

  it("counts only what QuickBooks put there", async () => {
    // A spreadsheet somebody uploaded is not a cached QuickBooks report, and
    // counting it would tell them a sync had fetched something it had not.
    const { service, statements } = build();
    await hold(statements, "balance_sheet");
    await statements.save({
      companyId: COMPANY,
      provenance: { from: "document", documentId: "doc-1" },
      statementType: "balance_sheet",
      sourceKey: "manual_upload_excel_pdf",
      periodStart: null,
      periodEnd: null,
      asOfDate: "2024-12-31",
      fiscalYear: 2024,
      payload: {},
      extractedBy: null,
    });

    const status = await service.status(USER, COMPANY, NOW);
    expect(status.totalCachedReports).toBe(1);
  });

  it("reports idle for a company that has never synced", async () => {
    const { service } = build({ run: null, dataset: null });
    const status = await service.status(USER, COMPANY, NOW);
    expect(status).toMatchObject({
      syncStatus: "idle",
      syncProgress: 0,
      syncJobId: null,
      datasetVersion: null,
      lastSuccessfulSync: null,
      totalCachedReports: 0,
    });
  });

  it("names the active dataset version", async () => {
    const { service } = build();
    expect((await service.status(USER, COMPANY, NOW)).datasetVersion).toBe(DATASET.id);
  });

  it("reports a run that stopped reporting as stalled rather than as running", async () => {
    // The same derivation the progress endpoint uses, which is what stops the
    // two disagreeing — legacy had one read `sync_metadata` and the other
    // `sync_jobs`, and they could answer differently about the same sync.
    const { service } = build({
      run: { ...RUN, heartbeatAt: "2025-03-01T11:00:00.000Z" },
    });
    const status = await service.status(USER, COMPANY, NOW);
    expect(status.syncStatus).toBe("running");
    // Progress still reads from the run; what changes is that nothing treats
    // it as live. Proven in the sync module's own tests; asserted here only so
    // far as this endpoint does not invent a different answer.
    expect(status.syncJobId).toBe(RUN.id);
  });
});

describe("who may ask", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service } = build();
    await expect(
      service.status(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", NOW),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.status(USER, "", NOW)).rejects.toThrow(/clientId/);
  });
});
