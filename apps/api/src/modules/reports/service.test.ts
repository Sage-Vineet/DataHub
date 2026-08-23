import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reports as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { LegacyReportSyncPort } from "./adapters.js";
import {
  InMemoryEngagementPort,
  InMemoryLedgerDetailPort,
  InMemoryMappingsRepository,
  InMemoryReportsRepository,
} from "./repository.memory.js";
import { ReportsService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryReportsRepository();
  const engagement = new InMemoryEngagementPort();
  const ledger = new InMemoryLedgerDetailPort();
  const mappings = new InMemoryMappingsRepository();
  return {
    repo,
    engagement,
    ledger,
    mappings,
    service: new ReportsService({
      repo,
      sync: new LegacyReportSyncPort(),
      engagement,
      ledger,
      mappings,
    }),
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

/**
 * Linking Data Room documents to a version.
 *
 * Two things carry real consequence here and both are asserted: a file that is
 * linked must not be deletable from the Data Room, and it must become deletable
 * again exactly when the last mapping to it goes — not before, and not never.
 */
describe("ReportsService — mappings", () => {
  const DOC_A = "dddddddd-dddd-4ddd-8ddd-dddddddddda";
  const DOC_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddb";

  const setup = async () => {
    const h = make();
    const user = session();
    const version = await h.service.create(
      user,
      contracts.reportVersionCreate.parse({ company_id: COMPANY }),
    );
    h.mappings.seedDocument({ id: DOC_A, companyId: COMPANY, name: "P&L 2024.pdf", uploadId: null });
    h.mappings.seedDocument({ id: DOC_B, companyId: COMPANY, name: "BS Jan 24.pdf", uploadId: null });
    return { ...h, user, versionId: version.id };
  };

  it("groups by category, with every category present", async () => {
    // The page renders one drop zone per category by iterating these keys, so
    // an absent key is a missing drop zone rather than an empty one.
    const { service, user, versionId } = await setup();
    const grouped = await service.listMappings(user, versionId);
    expect(Object.keys(grouped).sort()).toEqual([
      "balance_sheet",
      "bank_statement",
      "general_ledger",
      "profit_loss",
      "tax_return",
    ]);
    expect(grouped.profit_loss).toEqual([]);
  });

  it("links a document and reads back the year from its name", async () => {
    const { service, user, versionId } = await setup();
    const [mapping] = await service.linkMappings(user, versionId, {
      reportCategory: "profit_loss",
      documentIds: [DOC_A],
    });
    expect(mapping!.fileName).toBe("P&L 2024.pdf");
    expect(mapping!.year).toBe(2024);

    const grouped = await service.listMappings(user, versionId);
    expect(grouped.profit_loss).toHaveLength(1);
  });

  it("holds the document in place so the Data Room will not delete it", async () => {
    const { service, mappings, user, versionId } = await setup();
    await service.linkMappings(user, versionId, {
      reportCategory: "profit_loss",
      documentIds: [DOC_A],
    });
    expect(mappings.fileReferences.has(`${versionId}:${DOC_A}`)).toBe(true);
  });

  it("links many at once", async () => {
    const { service, user, versionId } = await setup();
    const linked = await service.linkMappings(user, versionId, {
      reportCategory: "general_ledger",
      documentIds: [DOC_A, DOC_B],
    });
    expect(linked).toHaveLength(2);
  });

  it("is idempotent: re-linking the same file does not stack rows", async () => {
    // The SPA re-sends its whole selection whenever a checkbox changes.
    const { service, user, versionId } = await setup();
    await service.linkMappings(user, versionId, {
      reportCategory: "profit_loss",
      documentIds: [DOC_A],
    });
    await service.linkMappings(user, versionId, {
      reportCategory: "profit_loss",
      documentIds: [DOC_A],
    });
    const grouped = await service.listMappings(user, versionId);
    expect(grouped.profit_loss).toHaveLength(1);
  });

  it("releases the document only when the last mapping to it goes", async () => {
    // Unlinking a file from the P&L must not make it deletable while the
    // balance sheet still uses it.
    const { service, mappings, user, versionId } = await setup();
    await service.linkMappings(user, versionId, {
      reportCategory: "profit_loss",
      documentIds: [DOC_A],
    });
    const [second] = await service.linkMappings(user, versionId, {
      reportCategory: "balance_sheet",
      documentIds: [DOC_A],
    });
    const grouped = await service.listMappings(user, versionId);

    await service.deleteMapping(user, grouped.profit_loss![0]!.id);
    expect(mappings.fileReferences.has(`${versionId}:${DOC_A}`)).toBe(true);

    await service.deleteMapping(user, second!.id);
    expect(mappings.fileReferences.has(`${versionId}:${DOC_A}`)).toBe(false);
  });

  it("refuses a category that is not one of the five", async () => {
    const { service, user, versionId } = await setup();
    await expect(
      service.linkMappings(user, versionId, {
        reportCategory: "cashflow",
        documentIds: [DOC_A],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a link that names no document", async () => {
    const { service, user, versionId } = await setup();
    await expect(
      service.linkMappings(user, versionId, { reportCategory: "profit_loss", documentIds: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("404s a document that is not in the Data Room", async () => {
    // A mapping pointing at a file that is not there renders as a linked
    // document that cannot be opened, and fails the sync later and elsewhere.
    const { service, user, versionId } = await setup();
    await expect(
      service.linkMappings(user, versionId, {
        reportCategory: "profit_loss",
        documentIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddd0"],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to link another company's document into this version", async () => {
    const { service, mappings, user, versionId } = await setup();
    const foreign = "dddddddd-dddd-4ddd-8ddd-ddddddddddc";
    mappings.seedDocument({ id: foreign, companyId: OTHER, name: "Theirs.pdf", uploadId: null });
    await expect(
      service.linkMappings(user, versionId, {
        reportCategory: "profit_loss",
        documentIds: [foreign],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("checks access against the mapping's own company, not the caller's claim", async () => {
    const { service, user, versionId } = await setup();
    const [mapping] = await service.linkMappings(user, versionId, {
      reportCategory: "profit_loss",
      documentIds: [DOC_A],
    });
    await expect(
      service.deleteMapping(session({ role: "buyer", company_ids: [OTHER] }), mapping!.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s a mapping that is not there", async () => {
    const { service, user } = await setup();
    await expect(
      service.deleteMapping(user, "dddddddd-dddd-4ddd-8ddd-ddddddddd99"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to list mappings for a version the caller cannot reach", async () => {
    const { service, versionId } = await setup();
    await expect(
      service.listMappings(session({ role: "buyer", company_ids: [OTHER] }), versionId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
