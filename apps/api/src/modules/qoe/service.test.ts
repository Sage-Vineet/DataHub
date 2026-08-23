import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { fixtureEngagement } from "./fixture.js";
import { InMemoryQoeRepository } from "./repository.memory.js";
import { QoeService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_COMPANY = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VERSION = "v-demo";
const USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const session = (companyIds: string[] = [COMPANY]): SessionUser => ({
  id: USER,
  name: "Reviewer",
  email: "reviewer@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: companyIds,
});

function make(allowed: string[] = [COMPANY]) {
  const repo = new InMemoryQoeRepository();
  repo.seedEngagement(VERSION, fixtureEngagement(COMPANY));
  return { repo, service: new QoeService({ repo }), user: session(allowed) };
}

describe("QoeService — bridge", () => {
  it("serves the workbook figures through the module", async () => {
    const { service, user } = make();
    const bridge = await service.bridge(user, VERSION);

    expect(bridge.netIncome.amounts["2024"]).toBeCloseTo(47568.23, 2);
    expect(bridge.reportedEbitda["2024"]).toBeCloseTo(347403.35, 2);
    expect(bridge.revenue["2024"]).toBeCloseTo(2511740.83, 2);
    expect(bridge.periods.map((p) => p.label)).toEqual([
      "FY2022",
      "FY2023",
      "FY2024",
      "FY2025",
    ]);
  });

  it("defaults to annual columns for every ingested year", async () => {
    const { service, user } = make();
    const bridge = await service.bridge(user, VERSION);
    expect(bridge.periods).toHaveLength(4);
    expect(bridge.periods.every((p) => p.month === null)).toBe(true);
  });

  it("honours a discrete period selection", async () => {
    const { service, user } = make();
    const bridge = await service.bridge(user, VERSION, { years: [2023, 2025] });
    expect(bridge.periods.map((p) => p.fiscalYear)).toEqual([2023, 2025]);
  });

  it("denies a company the user cannot access", async () => {
    const { service, user } = make([OTHER_COMPANY]);
    await expect(service.bridge(user, VERSION)).rejects.toMatchObject({ status: 403 });
  });

  it("404s an unknown version", async () => {
    const { service, user } = make();
    await expect(service.bridge(user, "nope")).rejects.toBeInstanceOf(HttpError);
  });
});

describe("QoeService — add-backs", () => {
  const manual = {
    companyId: COMPANY,
    versionId: VERSION,
    kind: "manual_adjustment" as const,
    dataSource: "company_financials" as const,
    typeKey: "personal_expense",
    name: "Owner's vehicle",
    linkedAccountId: null,
    vendorScope: [],
    granularity: "detail" as const,
    values: { "2024": 12000 },
    recastNormalizedValue: null,
    groupId: null,
    groupLabel: null,
    explanation: "Personal use of company vehicle.",
    commentary: null,
    createdBy: USER,
  };

  it("flows a new add-back into the bridge total", async () => {
    const { service, user } = make();
    const before = await service.bridge(user, VERSION);
    await service.createAddback(user, manual);
    const after = await service.bridge(user, VERSION);

    expect(after.adjusted["2024"]! - before.adjusted["2024"]!).toBeCloseTo(12000, 2);
    // Reported EBITDA is above the add-back section and must not move.
    expect(after.reportedEbitda["2024"]!).toBeCloseTo(before.reportedEbitda["2024"]!, 2);
  });

  it("rejects an add-back for a different company than the version", async () => {
    const { service, user } = make([COMPANY, OTHER_COMPANY]);
    await expect(
      service.createAddback(user, { ...manual, companyId: OTHER_COMPANY }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("never persists a commentary draft without confirmation", async () => {
    const repo = new InMemoryQoeRepository();
    repo.seedEngagement(VERSION, fixtureEngagement(COMPANY));
    const service = new QoeService({
      repo,
      commentary: { draft: async () => "Suggested narrative." },
    });
    const user = session();

    const created = await service.createAddback(user, manual);
    const { draft } = await service.draftCommentary(user, created.id);
    expect(draft).toBe("Suggested narrative.");
    expect((await repo.getAddback(created.id))!.commentary).toBeNull();

    await service.saveCommentary(user, created.id, "Edited narrative.");
    expect((await repo.getAddback(created.id))!.commentary).toBe("Edited narrative.");
  });
});

describe("QoeService — an add-back that is not there", () => {
  const missing = "dddddddd-dddd-dddd-dddd-dddddddddddd";

  it("404s every route that reaches one by id", async () => {
    // A 500 would send somebody looking for a fault in the engagement. The id
    // is simply wrong, and saying so is the whole answer.
    const { service, user } = make();
    await expect(service.deleteAddback(user, missing)).rejects.toMatchObject({ status: 404 });
    await expect(service.draftCommentary(user, missing)).rejects.toMatchObject({ status: 404 });
    await expect(service.saveCommentary(user, missing, "x")).rejects.toMatchObject({ status: 404 });
  });

  it("removes one that is there", async () => {
    const { repo, service, user } = make();
    const created = await service.createAddback(user, {
      companyId: COMPANY,
      versionId: VERSION,
      kind: "manual_adjustment" as const,
      dataSource: "company_financials" as const,
      typeKey: "personal_expense",
      name: "Owner's vehicle",
      linkedAccountId: null,
      vendorScope: [],
      granularity: "detail" as const,
      values: { "2024": 12000 },
      recastNormalizedValue: null,
      groupId: null,
      groupLabel: null,
      explanation: null,
      commentary: null,
      createdBy: USER,
    });
    await service.deleteAddback(user, created.id);
    expect(await repo.getAddback(created.id)).toBeNull();
    expect(await service.listAddbacks(user, VERSION)).toEqual([]);
  });
});

describe("QoeService — when commentary drafting is not configured", () => {
  it("says so with a 503 rather than failing obscurely", async () => {
    // A deployment fact rather than a fault: no model is wired up on this
    // server, and the difference tells whoever reads the log where to go.
    const { service, user } = make();
    const created = await service.createAddback(user, {
      companyId: COMPANY,
      versionId: VERSION,
      kind: "manual_adjustment" as const,
      dataSource: "company_financials" as const,
      typeKey: "personal_expense",
      name: "Owner's vehicle",
      linkedAccountId: null,
      vendorScope: [],
      granularity: "detail" as const,
      values: { "2024": 12000 },
      recastNormalizedValue: null,
      groupId: null,
      groupLabel: null,
      explanation: null,
      commentary: null,
      createdBy: USER,
    });
    await expect(service.draftCommentary(user, created.id)).rejects.toMatchObject({ status: 503 });
  });
});

describe("QoeService — the income statement's own options", () => {
  it("covers every ingested year unless the caller narrows it", async () => {
    const { service, user } = make();
    const all = await service.incomeStatement(user, VERSION);
    const one = await service.incomeStatement(user, VERSION, { years: [2024] });

    expect(all.periods.length).toBeGreaterThan(one.periods.length);
    expect(one.periods.every((p) => p.fiscalYear === 2024)).toBe(true);
  });

  it("reports annual columns unless asked for months", async () => {
    const { service, user } = make();
    expect((await service.incomeStatement(user, VERSION)).periods.every((p) => p.month === null))
      .toBe(true);
    const monthly = await service.incomeStatement(user, VERSION, {
      years: [2024],
      aggregation: "monthly",
    });
    expect(monthly.periods.some((p) => p.month !== null)).toBe(true);
  });

  it("ships the per-account breakdown as an object, not an empty one", async () => {
    // The engine answers with Maps. `res.json` turns a Map into `{}` without
    // complaining, which reads as a company with no accounts.
    const { service, user } = make();
    const lines = (await service.incomeStatement(user, VERSION)).lines;
    expect(lines.length).toBeGreaterThan(0);
    expect(Object.keys(lines[0]!.amounts).length).toBeGreaterThan(0);
    expect(lines[0]!.account_name).not.toBe("Unknown account");
  });

  it("orders the lines by account name", async () => {
    const { service, user } = make();
    const names = (await service.incomeStatement(user, VERSION)).lines.map((l) => l.account_name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("QoeService — a version with nothing to anchor on", () => {
  it("refuses the balance sheet and the trial balance, and says why", async () => {
    // The position cannot be derived from ledger movement alone, and a sheet
    // anchored at zero is confidently wrong rather than absent.
    const repo = new InMemoryQoeRepository();
    repo.seedEngagement(VERSION, { ...fixtureEngagement(COMPANY), anchors: [] });
    const service = new QoeService({ repo });
    const user = session();

    await expect(service.balanceSheet(user, VERSION)).rejects.toMatchObject({ status: 409 });
    await expect(service.trialBalance(user, VERSION)).rejects.toMatchObject({ status: 409 });
  });

  it("narrows both to the years the caller asked for", async () => {
    const { service, user } = make();
    const sheet = await service.balanceSheet(user, VERSION, { years: [2024] });
    expect(sheet.periods.every((p) => p.fiscalYear === 2024)).toBe(true);

    const trial = await service.trialBalance(user, VERSION, {
      years: [2024],
      aggregation: "monthly",
    });
    expect(trial.periods.every((p) => p.fiscalYear === 2024)).toBe(true);
  });
});

describe("QoeService — account roles drive the EBIT lines", () => {
  it("adding a role changes Reported EBITDA; nothing else does", async () => {
    const { repo, service, user } = make();
    const before = await service.bridge(user, VERSION);
    expect(before.ebitLines.some((l) => l.key === "income_tax")).toBe(false);

    // Flag an operating tax account as income tax — the exact mistake the
    // legacy label-matching bridge made — and watch the total move.
    await service.setAccountRole(user, VERSION, "meals-tax", "income_tax");
    const after = await service.bridge(user, VERSION);

    const taxLine = after.ebitLines.find((l) => l.key === "income_tax");
    expect(taxLine!.amounts["2024"]).toBeCloseTo(37820.18, 2);
    expect(after.reportedEbitda["2024"]!).toBeCloseTo(
      before.reportedEbitda["2024"]! + 37820.18,
      2,
    );
    await repo.setAccountRole(VERSION, "meals-tax", null);
  });
});
