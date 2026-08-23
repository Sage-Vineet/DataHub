import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, HttpError } from "../../../shared/errors.js";
import { InMemorySyncRepository } from "../../sync/repository.memory.js";
import { SyncService } from "../../sync/service.js";
import { QuickBooksAuthError, type QbReportType } from "./client.js";
import { QUICKBOOKS_SOURCE_KEY } from "./service.js";
import {
  QuickBooksSyncService,
  SYNC_REPORT_TYPES,
  buildSyncPlan,
  yearlyPeriods,
  type ReportServer,
} from "./sync.js";

/**
 * Pulling a company's whole reporting history.
 *
 * Two of these tests exist because of specific things the version this
 * replaces got wrong: it tracked the running sync in a Map inside one process,
 * and it answered 202 after a sixty-millisecond sleep hoping the row existed.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const USER: SessionUser = {
  id: "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu",
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const TODAY = new Date("2026-08-23T10:00:00.000Z");

interface Call {
  reportType: QbReportType;
  query: Record<string, unknown>;
  force: boolean | undefined;
}

function reports(
  fail: (call: Call) => unknown = () => null,
): ReportServer & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    serve: (_user, _companyId, reportType, rawQuery, options) => {
      const call = { reportType, query: rawQuery, force: options?.force };
      calls.push(call);
      const problem = fail(call);
      if (problem) return Promise.reject(problem);
      return Promise.resolve({ ok: true });
    },
  };
}

function build(fail?: (call: Call) => unknown) {
  const repo = new InMemorySyncRepository();
  // The store's clock and the test's are the same instant. Left at the fake's
  // 2024 default, every run this starts looks two years stale and the reaper
  // closes it before the next assertion reads it.
  repo.now = TODAY;
  const runs = new SyncService({ repo });
  const served = reports(fail);
  return {
    repo,
    runs,
    reports: served,
    service: new QuickBooksSyncService({ runs, reports: served }),
  };
}

describe("the periods a sync covers", () => {
  it("counts whole calendar years back from this one", () => {
    expect(yearlyPeriods(3, TODAY)).toEqual([
      { startDate: "2026-01-01", endDate: "2026-12-31" },
      { startDate: "2025-01-01", endDate: "2025-12-31" },
      { startDate: "2024-01-01", endDate: "2024-12-31" },
    ]);
  });

  it("asks for at least one year and at most ten", () => {
    // The caller sends this, and a request for a thousand years is a thousand
    // round trips to Intuit on the company's rate limit.
    expect(yearlyPeriods(0, TODAY)).toHaveLength(1);
    expect(yearlyPeriods(-5, TODAY)).toHaveLength(1);
    expect(yearlyPeriods(500, TODAY)).toHaveLength(10);
    expect(yearlyPeriods(3.9, TODAY)).toHaveLength(3);
  });

  it("reads the year in UTC, not the server's zone", () => {
    // 1 Jan 00:30 UTC is still 31 December in New York. A sync that read the
    // local year would pull a different set of years depending on which
    // machine ran it.
    expect(yearlyPeriods(1, new Date("2026-01-01T00:30:00.000Z"))[0]!.startDate).toBe(
      "2026-01-01",
    );
  });
});

describe("the plan", () => {
  const plan = buildSyncPlan(4, TODAY);

  it("covers every report type", () => {
    expect(new Set(plan.map((step) => step.reportType))).toEqual(new Set(SYNC_REPORT_TYPES));
  });

  it("pulls the account list once, not once per year", () => {
    // It is the chart as it stands, so it has no period. Pulled per year it
    // would store the same list five times and make "the latest" mean
    // whichever year happened to finish last.
    const accountList = plan.filter((step) => step.reportType === "account_list");
    expect(accountList).toEqual([{ reportType: "account_list", period: null }]);
  });

  it("pulls every dated report once per year", () => {
    expect(plan.filter((step) => step.reportType === "balance_sheet")).toHaveLength(4);
    expect(plan).toHaveLength((SYNC_REPORT_TYPES.length - 1) * 4 + 1);
  });
});

describe("starting one", () => {
  it("creates the run before it answers", async () => {
    // Legacy slept sixty milliseconds hoping the worker had written its row,
    // then reported whatever it found. On a slow database it found nothing and
    // the caller got a status naming no run.
    const { service, repo } = build();
    const started = await service.start(USER, COMPANY, {}, TODAY);

    expect(started.run.id).toBeTruthy();
    expect(started.totalSteps).toBe(buildSyncPlan(4, TODAY).length);

    const current = await repo.current(COMPANY, { sourceKey: QUICKBOOKS_SOURCE_KEY });
    expect(current?.id).toBe(started.run.id);
    expect(current?.totalFiles).toBe(started.totalSteps);
  });

  it("records who started it", async () => {
    const { service, repo } = build();
    const { run } = await service.start(USER, COMPANY, {}, TODAY);
    expect((await repo.getById(COMPANY, run.id))?.id).toBe(run.id);
  });

  it("refuses a second while one is running", async () => {
    // The refusal lives in the DATABASE, not in a Map in one process — which
    // is the only place it can be correct, because it is the only thing two
    // gateway instances share.
    const { service } = build();
    await service.start(USER, COMPANY, {}, TODAY);
    await expect(service.start(USER, COMPANY, {}, TODAY)).rejects.toMatchObject({ status: 409 });
  });

  it("checks the company", async () => {
    const { service } = build();
    await expect(service.start(USER, OTHER, {}, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.start(USER, "", {}, TODAY)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("sizes the run to the years asked for", async () => {
    const { service } = build();
    const started = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    expect(started.totalSteps).toBe(SYNC_REPORT_TYPES.length);
  });
});

describe("running it", () => {
  it("fetches every step and completes", async () => {
    const { service, repo, reports: served } = build();
    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    const outcome = await service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY);

    expect(outcome).toEqual({ fetched: SYNC_REPORT_TYPES.length, failed: [] });
    expect(served.calls).toHaveLength(SYNC_REPORT_TYPES.length);

    const finished = await repo.getById(COMPANY, run.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.processedFiles).toBe(SYNC_REPORT_TYPES.length);
    expect(finished?.result).toMatchObject({ fetched: SYNC_REPORT_TYPES.length });
  });

  it("forces each pull past the cache", async () => {
    // A sync exists to refresh. Serving the cache would make the button do
    // nothing on its second press.
    const { service, reports: served } = build();
    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    await service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY);
    expect(served.calls.every((call) => call.force === true)).toBe(true);
  });

  it("sends a period with a dated report and none with the account list", async () => {
    const { service, reports: served } = build();
    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    await service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY);

    const balanceSheet = served.calls.find((call) => call.reportType === "balance_sheet");
    expect(balanceSheet?.query).toMatchObject({
      start_date: "2026-01-01",
      end_date: "2026-12-31",
    });
    expect(served.calls.find((call) => call.reportType === "account_list")?.query).toEqual({});
  });

  it("passes the accounting method through when one is asked for", async () => {
    const { service, reports: served } = build();
    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    await service.run(
      USER,
      COMPANY,
      run.id,
      { yearsBack: 1, accountingMethod: "Cash" },
      TODAY,
    );
    expect(served.calls[0]!.query).toMatchObject({ accounting_method: "Cash" });
  });

  it("reports progress as it goes", async () => {
    // The heartbeat and the progress bar are the same write: a run that stops
    // advancing is a run a reader can tell is stalled.
    const seen: number[] = [];
    const { runs, reports: served } = build();
    const service = new QuickBooksSyncService({
      runs: {
        start: runs.start.bind(runs),
        finish: runs.finish.bind(runs),
        advance: async (user, companyId, runId, patch) => {
          if (patch.processedFiles !== undefined) seen.push(patch.processedFiles);
          await runs.advance(user, companyId, runId, patch);
        },
      },
      reports: served,
    });

    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    await service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("carries on when one report is missing", async () => {
    // A company with no cash-flow report for 2019 should still get its other
    // years. What failed is counted and named rather than swallowed.
    const { service, repo } = build((call) =>
      call.reportType === "cash_flow" ? new HttpError(404, "No such report") : null,
    );
    const { run } = await service.start(USER, COMPANY, { yearsBack: 2 }, TODAY);
    const outcome = await service.run(USER, COMPANY, run.id, { yearsBack: 2 }, TODAY);

    expect(outcome.fetched).toBe(7);
    expect(outcome.failed).toEqual([
      { reportType: "cash_flow", period: "2026", message: "No such report" },
      { reportType: "cash_flow", period: "2025", message: "No such report" },
    ]);
    expect((await repo.getById(COMPANY, run.id))?.status).toBe("completed");
  });

  it("stops the whole run on an expired connection", async () => {
    // Every remaining step would fail the same way. Burning fifty round trips
    // to discover that wastes a minute and tells nobody anything.
    const { service, repo, reports: served } = build(() => new HttpError(401, "Token expired"));
    const { run } = await service.start(USER, COMPANY, { yearsBack: 4 }, TODAY);

    await expect(
      service.run(USER, COMPANY, run.id, { yearsBack: 4 }, TODAY),
    ).rejects.toMatchObject({ status: 401 });
    expect(served.calls).toHaveLength(1);

    const finished = await repo.getById(COMPANY, run.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.errorMessage).toBe("Token expired");
  });

  it("stops on the client's own auth error too", async () => {
    // The report client throws its own type rather than an HttpError, and it
    // means exactly the same thing.
    const { service, reports: served } = build(() => new QuickBooksAuthError("Reconnect"));
    const { run } = await service.start(USER, COMPANY, { yearsBack: 4 }, TODAY);
    await expect(
      service.run(USER, COMPANY, run.id, { yearsBack: 4 }, TODAY),
    ).rejects.toBeInstanceOf(QuickBooksAuthError);
    expect(served.calls).toHaveLength(1);
  });

  it("finishes the run rather than leaving it running when the store fails", async () => {
    // A row nobody closes reads as a live sync for five minutes and a stalled
    // one forever, and the company cannot start another until it is reaped.
    const { repo, runs, reports: served } = build();
    let advances = 0;
    const service = new QuickBooksSyncService({
      runs: {
        start: runs.start.bind(runs),
        finish: runs.finish.bind(runs),
        advance: async (user, companyId, runId, patch) => {
          advances += 1;
          if (advances > 2) throw new Error("connection lost");
          await runs.advance(user, companyId, runId, patch);
        },
      },
      reports: served,
    });

    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    await expect(
      service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY),
    ).rejects.toThrow(/connection lost/);
    expect((await repo.getById(COMPANY, run.id))?.status).toBe("failed");
  });

  it("fails a run where nothing at all could be fetched", async () => {
    // Zero reports is not a completed sync, whatever the counters say.
    const { service, repo } = build(() => new HttpError(500, "QuickBooks is down"));
    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    const outcome = await service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY);

    expect(outcome.fetched).toBe(0);
    const finished = await repo.getById(COMPANY, run.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.errorMessage).toMatch(/No report could be fetched/);
  });

  it("names a failure that is not an Error at all", async () => {
    const { service } = build(() => "just a string");
    const { run } = await service.start(USER, COMPANY, { yearsBack: 1 }, TODAY);
    const outcome = await service.run(USER, COMPANY, run.id, { yearsBack: 1 }, TODAY);
    expect(outcome.failed[0]!.message).toBe("just a string");
  });
});
