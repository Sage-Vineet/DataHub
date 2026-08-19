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

    expect(after.adjusted["2024"] - before.adjusted["2024"]).toBeCloseTo(12000, 2);
    // Reported EBITDA is above the add-back section and must not move.
    expect(after.reportedEbitda["2024"]).toBeCloseTo(before.reportedEbitda["2024"], 2);
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
    expect(after.reportedEbitda["2024"]).toBeCloseTo(
      before.reportedEbitda["2024"] + 37820.18,
      2,
    );
    await repo.setAccountRole(VERSION, "meals-tax", null);
  });
});
