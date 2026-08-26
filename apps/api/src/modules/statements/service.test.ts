import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";
import { StatementsService, isStatementType } from "./service.js";

/**
 * Statements read out of uploaded documents.
 *
 * The rung that matters is the middle one in `resolve`: a key-report version
 * must show the statement IT was built from, not whatever was uploaded most
 * recently. Without that, opening a six-month-old version shows last week's
 * numbers under a heading that says otherwise.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION = "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv";
const OLD_DOC = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const NEW_DOC = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";

const make = () => {
  const repo = new InMemoryStatementsRepository();
  repo.seedDocument(OLD_DOC, "BS 2023.pdf", "Financials");
  repo.seedDocument(NEW_DOC, "BS 2024.pdf", "Financials");
  return { repo, service: new StatementsService({ repo }) };
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

const save = (
  service: StatementsService,
  user: SessionUser,
  documentId: string,
  over: Record<string, unknown> = {},
) =>
  service.save(user, COMPANY, {
    provenance: { from: "document", documentId },
    statementType: "balance_sheet",
    payload: { rows: [{ name: "Cash", amount: 100 }] },
    asOfDate: "2024-12-31",
    ...over,
  });

describe("recognising a statement type", () => {
  it("knows the five", () => {
    for (const type of [
      "balance_sheet",
      "profit_and_loss",
      "cash_flow",
      "bank_reconciliation",
      "tax_return",
    ]) {
      expect(isStatementType(type)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const type of ["", "profit_loss", "balancesheet", "P&L"]) {
      expect(isStatementType(type)).toBe(false);
    }
  });

  it("refuses one at the boundary, naming what it accepts", async () => {
    const { service } = make();
    let message = "";
    try {
      await service.list(session(), COMPANY, "profit_loss");
    } catch (err) {
      message = (err as Error).message;
    }
    // `profit_loss` is the CATEGORY spelling; the statement type is
    // `profit_and_loss`, and confusing the two is the likeliest mistake here.
    expect(message).toContain("profit_loss");
    expect(message).toContain("profit_and_loss");
  });
});

describe("recording an extract", () => {
  it("keeps the payload and names the document it came from", async () => {
    const { service } = make();
    const user = session();
    const saved = await save(service, user, NEW_DOC);

    expect(saved.documentName).toBe("BS 2024.pdf");
    expect(saved.payload).toEqual({ rows: [{ name: "Cash", amount: 100 }] });
  });

  it("replaces rather than accumulates when the same file is re-extracted", async () => {
    // Otherwise "latest" becomes whichever extraction ran last, which is not a
    // fact about the company's finances.
    const { service } = make();
    const user = session();
    await save(service, user, NEW_DOC, { payload: { rows: [] } });
    await save(service, user, NEW_DOC, { payload: { rows: [{ name: "Cash", amount: 250 }] } });

    const all = await service.list(user, COMPANY, "balance_sheet");
    expect(all).toHaveLength(1);
    expect(all[0]!.payload).toEqual({ rows: [{ name: "Cash", amount: 250 }] });
  });

  it("keeps two statement types read from one file as two extracts", async () => {
    // A single PDF often carries both.
    const { service } = make();
    const user = session();
    await save(service, user, NEW_DOC);
    await save(service, user, NEW_DOC, { statementType: "profit_and_loss" });

    expect(await service.list(user, COMPANY, "balance_sheet")).toHaveLength(1);
    expect(await service.list(user, COMPANY, "profit_and_loss")).toHaveLength(1);
  });

  it("takes the fiscal year from the period end, not the start", async () => {
    // A statement's year is the year it closes in. A December-to-January span
    // filed under the opening year sorts a whole year out of place.
    const { service } = make();
    const saved = await save(service, session(), NEW_DOC, {
      statementType: "profit_and_loss",
      periodStart: "2023-12-01",
      periodEnd: "2024-11-30",
      asOfDate: null,
    });
    expect(saved.fiscalYear).toBe(2024);
  });

  it("falls back to the as-of date when there is no period end", async () => {
    const { service } = make();
    const saved = await save(service, session(), NEW_DOC, { asOfDate: "2022-06-30" });
    expect(saved.fiscalYear).toBe(2022);
  });

  it("prefers an explicit fiscal year over either date", async () => {
    const { service } = make();
    const saved = await save(service, session(), NEW_DOC, { fiscalYear: 2021 });
    expect(saved.fiscalYear).toBe(2021);
  });

  it("leaves the year null rather than inventing one", async () => {
    const { service } = make();
    const saved = await save(service, session(), NEW_DOC, { asOfDate: null, periodEnd: null });
    expect(saved.fiscalYear).toBeNull();
  });

  it("refuses an extract that names no document", async () => {
    const { service } = make();
    await expect(
      service.save(session(), COMPANY, {
        provenance: { from: "document", documentId: "" },
        statementType: "balance_sheet",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("resolving which statement was meant", () => {
  it("takes the most recent when nothing narrows it", async () => {
    const { service } = make();
    const user = session();
    await save(service, user, OLD_DOC, { asOfDate: "2023-12-31" });
    await save(service, user, NEW_DOC, { asOfDate: "2024-12-31" });

    const resolved = await service.resolve(user, COMPANY, "balance_sheet");
    expect(resolved.documentId).toBe(NEW_DOC);
  });

  it("takes the exact one when the caller picked it from the list", async () => {
    const { service } = make();
    const user = session();
    const old = await save(service, user, OLD_DOC, { asOfDate: "2023-12-31" });
    await save(service, user, NEW_DOC);

    const resolved = await service.resolve(user, COMPANY, "balance_sheet", {
      extractId: old.id,
    });
    expect(resolved.documentId).toBe(OLD_DOC);
  });

  it("takes the version's own document over whatever is newest", async () => {
    // The whole point. A version signed off against the 2023 balance sheet
    // must not silently start showing the 2024 one somebody uploaded since.
    const { repo, service } = make();
    const user = session();
    await save(service, user, OLD_DOC, { asOfDate: "2023-12-31" });
    await save(service, user, NEW_DOC, { asOfDate: "2024-12-31" });
    repo.seedVersionDocuments(VERSION, "balance_sheet", [OLD_DOC]);

    const resolved = await service.resolve(user, COMPANY, "balance_sheet", {
      keyReportVersionId: VERSION,
    });
    expect(resolved.documentId).toBe(OLD_DOC);
  });

  it("translates the statement type into the category a version files under", async () => {
    // `profit_and_loss` the statement is `profit_loss` the category — a legacy
    // accident, not a distinction, and neither side should have to know.
    const { repo, service } = make();
    const user = session();
    await save(service, user, OLD_DOC, { statementType: "profit_and_loss" });
    await save(service, user, NEW_DOC, { statementType: "profit_and_loss" });
    repo.seedVersionDocuments(VERSION, "profit_loss", [OLD_DOC]);

    const resolved = await service.resolve(user, COMPANY, "profit_and_loss", {
      keyReportVersionId: VERSION,
    });
    expect(resolved.documentId).toBe(OLD_DOC);
  });

  it("skips a linked document nothing was extracted from", async () => {
    // A file can be linked and not yet parsed; the next one down still answers.
    const { repo, service } = make();
    const user = session();
    await save(service, user, OLD_DOC);
    repo.seedVersionDocuments(VERSION, "balance_sheet", [NEW_DOC, OLD_DOC]);

    const resolved = await service.resolve(user, COMPANY, "balance_sheet", {
      keyReportVersionId: VERSION,
    });
    expect(resolved.documentId).toBe(OLD_DOC);
  });

  it("falls back to the latest when a version has nothing linked", async () => {
    const { service } = make();
    const user = session();
    await save(service, user, NEW_DOC);

    const resolved = await service.resolve(user, COMPANY, "balance_sheet", {
      keyReportVersionId: VERSION,
    });
    expect(resolved.documentId).toBe(NEW_DOC);
  });

  it("refuses an id that turns out to be a different statement", async () => {
    // Quietly returning the P&L when a balance sheet was asked for would hide
    // a caller bug behind plausible numbers.
    const { service } = make();
    const user = session();
    const pl = await save(service, user, NEW_DOC, { statementType: "profit_and_loss" });
    await expect(
      service.resolve(user, COMPANY, "balance_sheet", { extractId: pl.id }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("404s an id that is not there", async () => {
    const { service } = make();
    await expect(
      service.resolve(session(), COMPANY, "balance_sheet", { extractId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a company with nothing extracted at all", async () => {
    const { service } = make();
    await expect(service.resolve(session(), COMPANY, "balance_sheet")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("keeps one source's statements off another's page", async () => {
    const { service } = make();
    const user = session();
    await save(service, user, NEW_DOC, { sourceKey: "quickbooks_online" });

    await expect(
      service.resolve(user, COMPANY, "balance_sheet", {
        sourceKey: "manual_upload_excel_pdf",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listing and the source tree", () => {
  it("lists newest first", async () => {
    const { service } = make();
    const user = session();
    await save(service, user, OLD_DOC);
    await save(service, user, NEW_DOC);

    const all = await service.list(user, COMPANY, "balance_sheet");
    expect(all.map((e) => e.documentId)).toEqual([NEW_DOC, OLD_DOC]);
  });

  it("narrows a listing to one fiscal year", async () => {
    const { service } = make();
    const user = session();
    await save(service, user, OLD_DOC, { asOfDate: "2023-12-31" });
    await save(service, user, NEW_DOC, { asOfDate: "2024-12-31" });

    const only2023 = await service.list(user, COMPANY, "balance_sheet", { fiscalYear: 2023 });
    expect(only2023.map((e) => e.documentId)).toEqual([OLD_DOC]);
  });

  it("groups the tree by document, with every statement read from each", async () => {
    const { service } = make();
    const user = session();
    await save(service, user, NEW_DOC);
    await save(service, user, NEW_DOC, { statementType: "profit_and_loss" });
    await save(service, user, OLD_DOC);

    const tree = await service.sourceTree(user, COMPANY);
    expect(tree).toHaveLength(2);
    const newDoc = tree.find((t) => t.documentId === NEW_DOC)!;
    expect(newDoc.documentName).toBe("BS 2024.pdf");
    expect(newDoc.statements.map((s) => s.statementType).sort()).toEqual([
      "balance_sheet",
      "profit_and_loss",
    ]);
  });
});

describe("deleting", () => {
  it("removes one", async () => {
    const { service } = make();
    const user = session();
    const saved = await save(service, user, NEW_DOC);
    await service.delete(user, COMPANY, saved.id);
    expect(await service.list(user, COMPANY, "balance_sheet")).toEqual([]);
  });

  it("404s one that is not there", async () => {
    const { service } = make();
    await expect(
      service.delete(session(), COMPANY, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("access", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service } = make();
    const stranger = session({ role: "buyer", company_ids: [OTHER] });
    await expect(service.list(stranger, COMPANY, "balance_sheet")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.resolve(stranger, COMPANY, "balance_sheet")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.sourceTree(stranger, COMPANY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = make();
    await expect(service.list(session(), "", "balance_sheet")).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});
