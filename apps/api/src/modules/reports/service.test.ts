import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reports as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { LegacyReportSyncPort } from "./adapters.js";
import {
  InMemoryEngagementPort,
  InMemoryLedgerDetailPort,
  InMemoryReportsRepository,
} from "./repository.memory.js";
import { ReportsService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryReportsRepository();
  const engagement = new InMemoryEngagementPort();
  const ledger = new InMemoryLedgerDetailPort();
  return {
    repo,
    engagement,
    ledger,
    service: new ReportsService({ repo, sync: new LegacyReportSyncPort(), engagement, ledger }),
  };
}
const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(), name: "U", email: "u@x.com", role: "broker", company_id: null, status: "active", company_ids: [COMPANY], ...over,
});

describe("ReportsService — version lifecycle", () => {
  it("auto-numbers, updates, duplicates (new draft), and deletes", async () => {
    const { service } = make();
    const user = session();
    const v1 = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY, version_name: "First" }));
    const v2 = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    expect(v1.version_number).toBe(1);
    expect(v2.version_number).toBe(2);

    const updated = await service.update(user, v1.id, contracts.reportVersionUpdate.parse({ status: "synced" }));
    expect(updated.status).toBe("synced");

    const dup = await service.duplicate(user, v1.id);
    expect(dup.version_number).toBe(3);
    expect(dup.is_active).toBe(false);
    expect(dup.version_name).toBe("First");

    await service.delete(user, v2.id);
    await expect(service.get(user, v2.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps exactly one active version per company", async () => {
    const { service } = make();
    const user = session();
    const a = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    const b = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));

    await service.activate(user, a.id);
    let list = await service.list(user, COMPANY);
    expect(list.filter((v) => v.is_active).map((v) => v.id)).toEqual([a.id]);

    await service.activate(user, b.id);
    list = await service.list(user, COMPANY);
    expect(list.filter((v) => v.is_active).map((v) => v.id)).toEqual([b.id]); // a deactivated
  });

  it("denies cross-tenant and 501s the deferred sync", async () => {
    const { service } = make();
    const v = await service.create(session(), contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    await expect(service.get(session({ role: "buyer", company_ids: [OTHER] }), v.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.sync(session(), v.id)).rejects.toMatchObject({ status: 501 });
  });
});

/**
 * The Profit & Loss is company-scoped, so the service has to choose a version
 * before it can load an engagement at all. Which one it picks, and what it does
 * when there is none, is the whole of the decision.
 */
describe("ReportsService — profit & loss", () => {
  const engagementFor = (companyId: string) => ({
    companyId,
    companyName: "Acme",
    profitMetric: "adjusted_ebitda" as const,
    marketRateReplacementSalary: null,
    fiscalYears: [2024],
    accounts: [
      { id: "sales", name: "Sales", statementType: "profit_loss" as const, accountType: "income" as const },
      { id: "rent", name: "Rent", statementType: "profit_loss" as const, accountType: "expense" as const },
    ],
    entries: [
      { accountId: "sales", fiscalYear: 2024, month: 1, amount: 500 },
      { accountId: "rent", fiscalYear: 2024, month: 1, amount: 200 },
    ],
    anchors: [],
  });

  it("serves it from the company's active version", async () => {
    const { repo, engagement, service } = make();
    const user = session();
    const a = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    const b = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    await service.activate(user, b.id);

    engagement.seed(b.id, engagementFor(COMPANY));
    const payload = await service.profitLoss(user, COMPANY);

    expect(engagement.lastVersionId).toBe(b.id);
    expect(payload.netProfitByYear[2024]).toBe(300);
    expect(a.id).not.toBe(b.id);
    expect(repo).toBeDefined();
  });

  it("falls back to the only version there is when none is marked active", async () => {
    // A company that has never activated anything still has a statement to
    // show; refusing would be a worse answer than the obvious one.
    const { engagement, service } = make();
    const user = session();
    const v = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    engagement.seed(v.id, engagementFor(COMPANY));

    const payload = await service.profitLoss(user, COMPANY);
    expect(engagement.lastVersionId).toBe(v.id);
    expect(payload.years).toEqual([2024]);
  });

  it("404s a company with no version at all", async () => {
    const { service } = make();
    await expect(service.profitLoss(session(), COMPANY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s when the version exists but its engagement cannot be loaded", async () => {
    const { service } = make();
    const user = session();
    await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    await expect(service.profitLoss(user, COMPANY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a company the caller cannot access, before reading anything", async () => {
    const { engagement, service } = make();
    await expect(
      service.profitLoss(session({ role: "buyer", company_ids: [OTHER] }), COMPANY),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(engagement.lastVersionId).toBeNull();
  });

  it("passes the year filter through to the statement", async () => {
    const { engagement, service } = make();
    const user = session();
    const v = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    engagement.seed(v.id, engagementFor(COMPANY));

    const payload = await service.profitLoss(user, COMPANY, { fiscalYears: [2024] });
    expect(payload.yearCols).toEqual([{ key: "y2024", label: "2024" }]);
  });
});

describe("ReportsService — monthly detail", () => {
  const engagementFor = () => ({
    companyId: COMPANY,
    companyName: "Acme",
    profitMetric: "adjusted_ebitda" as const,
    marketRateReplacementSalary: null,
    fiscalYears: [2024],
    accounts: [
      { id: "sales", name: "Sales", statementType: "profit_loss" as const, accountType: "income" as const },
    ],
    entries: [],
    anchors: [],
  });

  const row = (amount: number) => ({
    id: "1",
    accountId: "sales",
    fiscalYear: 2024,
    month: 1,
    date: "2024-01-10",
    vendorName: null,
    description: null,
    reference: null,
    journalType: null,
    amount,
    debit: null,
    credit: null,
  });

  it("reads the drill-down from the same version the statement came from", async () => {
    // Two versions, two ledgers. Taking the statement from one and the
    // transactions from the other would put rows under a line that do not
    // add to it — the exact failure the view exists to make impossible.
    const { engagement, ledger, service } = make();
    const user = session();
    const a = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    const b = await service.create(user, contracts.reportVersionCreate.parse({ company_id: COMPANY }));
    await service.activate(user, b.id);

    engagement.seed(b.id, engagementFor());
    ledger.seed(a.id, [row(999)]);
    ledger.seed(b.id, [row(500)]);

    const payload = await service.monthlyDetail(user, COMPANY, { fiscalYear: 2024 });
    expect(ledger.lastVersionId).toBe(b.id);
    expect(payload.sections.find((s) => s.key === "income")!.total).toBe(500);
  });

  it("refuses a company the caller cannot access, before reading the ledger", async () => {
    const { ledger, service } = make();
    await expect(
      service.monthlyDetail(session({ role: "buyer", company_ids: [OTHER] }), COMPANY),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(ledger.lastVersionId).toBeNull();
  });

  it("404s a company with no version rather than an empty month grid", async () => {
    const { service } = make();
    await expect(service.monthlyDetail(session(), COMPANY)).rejects.toBeInstanceOf(NotFoundError);
  });
});
