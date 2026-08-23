import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { REPORT_SOURCE_KEYS, type SourceRecord } from "./ports.js";
import { InMemoryReportSourcesRepository } from "./repository.memory.js";
import { ReportSourcesService, availabilityOf, isReportSourceKey } from "./service.js";

/**
 * Which set of books the reports are read from.
 *
 * Legacy decided availability by probing four tables, three of which do not
 * exist. The rule is redefined against data that does — see `ports.ts` — so
 * these tests are mostly about that rule, and about the one thing it must not
 * become: a reason to stop somebody switching.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const make = () => {
  const repo = new InMemoryReportSourcesRepository();
  return { repo, service: new ReportSourcesService({ repo }) };
};

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "Dana",
  email: "dana@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

const sourceIn = (state: { sources: SourceRecord[] }, key: string): SourceRecord =>
  state.sources.find((s) => s.sourceKey === key)!;

describe("recognising a source key", () => {
  it("knows the four", () => {
    for (const key of Object.values(REPORT_SOURCE_KEYS)) {
      expect(isReportSourceKey(key)).toBe(true);
    }
  });

  it("rejects anything else, including near misses", () => {
    for (const key of ["", "quickbooks", "manual_gl", "QUICKBOOKS_ONLINE"]) {
      expect(isReportSourceKey(key)).toBe(false);
    }
  });
});

describe("what makes a source available", () => {
  const none = { hasGeneralLedger: false, hasLinkedDocuments: false };

  it("ties QuickBooks to the connection, not to synced data", () => {
    // Newly connected and nothing pulled yet is still available — that is the
    // state in which somebody goes and syncs.
    expect(availabilityOf(REPORT_SOURCE_KEYS.QUICKBOOKS, { quickbooksConnected: true }, none))
      .toEqual({ isAvailable: true, isConnected: true });
    expect(availabilityOf(REPORT_SOURCE_KEYS.QUICKBOOKS, { quickbooksConnected: false }, none))
      .toEqual({ isAvailable: false, isConnected: false });
  });

  it("ties manual GL to there being a ledger", () => {
    expect(
      availabilityOf(REPORT_SOURCE_KEYS.MANUAL_GL, { quickbooksConnected: false }, {
        ...none,
        hasGeneralLedger: true,
      }),
    ).toEqual({ isAvailable: true, isConnected: false });
  });

  it("ties manual upload to there being linked documents", () => {
    expect(
      availabilityOf(REPORT_SOURCE_KEYS.MANUAL_UPLOAD, { quickbooksConnected: false }, {
        ...none,
        hasLinkedDocuments: true,
      }),
    ).toEqual({ isAvailable: true, isConnected: false });
  });

  it("says outright that nothing backs quickbooks_manual", () => {
    // Reporting it as merely empty would suggest uploading something fixes it.
    expect(
      availabilityOf(REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL, { quickbooksConnected: true }, {
        hasGeneralLedger: true,
        hasLinkedDocuments: true,
      }),
    ).toEqual({ isAvailable: false, isConnected: false });
  });

  it("never marks a manual source connected", () => {
    // There is no connection to be in; a "connected" badge would be a lie.
    for (const key of [REPORT_SOURCE_KEYS.MANUAL_GL, REPORT_SOURCE_KEYS.MANUAL_UPLOAD]) {
      const result = availabilityOf(key, { quickbooksConnected: true }, {
        hasGeneralLedger: true,
        hasLinkedDocuments: true,
      });
      expect(result.isConnected).toBe(false);
    }
  });
});

describe("the state the selector renders", () => {
  it("offers all four sources, whatever is behind them", async () => {
    const { service } = make();
    const state = await service.getState(session(), COMPANY);
    expect(state.sources).toHaveLength(4);
    expect(state.sources.map((s) => s.sourceKey).sort()).toEqual(
      Object.values(REPORT_SOURCE_KEYS).sort(),
    );
  });

  it("defaults to QuickBooks when nothing has ever been chosen", async () => {
    const { service } = make();
    const state = await service.getState(session(), COMPANY);
    expect(state.selectedSource).toBe(REPORT_SOURCE_KEYS.QUICKBOOKS);
    expect(state.activeSource).toBe(REPORT_SOURCE_KEYS.QUICKBOOKS);
  });

  it("seeds from the company's cached choice rather than defaulting over it", async () => {
    // A company that switched before this module existed has its answer only on
    // the companies row; defaulting would silently revert them.
    const { repo, service } = make();
    repo.seedCompany({
      dataSourceType: REPORT_SOURCE_KEYS.MANUAL_GL,
      quickbooksConnected: false,
      lastSourceSwitchAt: null,
    });
    const state = await service.getState(session(), COMPANY);
    expect(state.selectedSource).toBe(REPORT_SOURCE_KEYS.MANUAL_GL);
  });

  it("ignores a cached choice that is not a real source", async () => {
    const { repo, service } = make();
    repo.seedCompany({
      dataSourceType: "some_old_key",
      quickbooksConnected: false,
      lastSourceSwitchAt: null,
    });
    const state = await service.getState(session(), COMPANY);
    expect(state.selectedSource).toBe(REPORT_SOURCE_KEYS.QUICKBOOKS);
  });

  it("reports a ledger's presence as availability on the manual-GL source", async () => {
    const { repo, service } = make();
    repo.seedAvailability({ hasGeneralLedger: true });
    const state = await service.getState(session(), COMPANY);
    expect(sourceIn(state, REPORT_SOURCE_KEYS.MANUAL_GL).isAvailable).toBe(true);
    expect(sourceIn(state, REPORT_SOURCE_KEYS.MANUAL_UPLOAD).isAvailable).toBe(false);
  });

  it("recomputes availability on every read, rather than trusting a stored flag", async () => {
    // It is derived from tables that change constantly. A cached flag would be
    // stale the moment a ledger landed, and the page would keep offering a
    // source it had just been given data for as empty.
    const { repo, service } = make();
    const user = session();
    expect(sourceIn(await service.getState(user, COMPANY), REPORT_SOURCE_KEYS.MANUAL_GL).isAvailable)
      .toBe(false);

    repo.seedAvailability({ hasGeneralLedger: true });
    expect(sourceIn(await service.getState(user, COMPANY), REPORT_SOURCE_KEYS.MANUAL_GL).isAvailable)
      .toBe(true);
  });

  it("says whether a manual source is the active one", async () => {
    const { service } = make();
    const user = session();
    expect((await service.getState(user, COMPANY)).manualUploadActive).toBe(false);

    await service.select(user, COMPANY, REPORT_SOURCE_KEYS.MANUAL_GL);
    expect((await service.getState(user, COMPANY)).manualUploadActive).toBe(true);
  });

  it("survives a company row that is not there", async () => {
    const { repo, service } = make();
    repo.seedCompany(null);
    const state = await service.getState(session(), COMPANY);
    expect(state.quickbooksConnected).toBe(false);
    expect(state.selectedSource).toBe(REPORT_SOURCE_KEYS.QUICKBOOKS);
  });
});

describe("switching", () => {
  it("moves the selection, and only one is selected at a time", async () => {
    const { service } = make();
    const user = session();
    const state = await service.select(user, COMPANY, REPORT_SOURCE_KEYS.MANUAL_GL);

    expect(state.selectedSource).toBe(REPORT_SOURCE_KEYS.MANUAL_GL);
    expect(state.sources.filter((s) => s.isSelected)).toHaveLength(1);
  });

  it("allows switching to a source with nothing in it yet", async () => {
    // Which is exactly what somebody does before uploading anything. Refusing
    // would make the page impossible to start from.
    const { service } = make();
    const state = await service.select(session(), COMPANY, REPORT_SOURCE_KEYS.MANUAL_UPLOAD);
    expect(state.selectedSource).toBe(REPORT_SOURCE_KEYS.MANUAL_UPLOAD);
    expect(sourceIn(state, REPORT_SOURCE_KEYS.MANUAL_UPLOAD).isAvailable).toBe(false);
  });

  it("answers the whole state, not just the key that changed", async () => {
    // The selector re-renders every badge afterwards.
    const { service } = make();
    const state = await service.select(session(), COMPANY, REPORT_SOURCE_KEYS.MANUAL_GL);
    expect(state.sources).toHaveLength(4);
    expect(state).toHaveProperty("quickbooksConnected");
    expect(state).toHaveProperty("lastSourceSwitchAt");
  });

  it("refuses a key that is not a source, naming what is", async () => {
    const { service } = make();
    let message = "";
    try {
      await service.select(session(), COMPANY, "quickbooks");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("quickbooks");
    expect(message).toContain(REPORT_SOURCE_KEYS.QUICKBOOKS);
  });

  it("refuses an empty key", async () => {
    const { service } = make();
    await expect(service.select(session(), COMPANY, "")).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("access", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service } = make();
    const stranger = session({ role: "buyer", company_ids: [OTHER] });
    await expect(service.getState(stranger, COMPANY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.select(stranger, COMPANY, REPORT_SOURCE_KEYS.MANUAL_GL),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request that names no company", async () => {
    const { service } = make();
    await expect(service.getState(session(), "")).rejects.toBeInstanceOf(BadRequestError);
  });
});
