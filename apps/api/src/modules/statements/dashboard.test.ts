import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { DashboardService, TaxComparisonService, latestPerYear, newest } from "./dashboard.js";
import type { StatementExtract } from "./ports.js";
import { InMemoryStatementsRepository } from "./repository.memory.js";

/**
 * The dashboard a source's landing page shows, and the tax comparison beside
 * it.
 *
 * Both answer "which statement do I mean for this year?", and both get it
 * wrong in the same way if they get it wrong: a superseded upload takes the
 * year's slot and every figure on the card is plausible.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();
const SOURCE = "manual_upload_excel_pdf";

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

const build = () => {
  const repo = new InMemoryStatementsRepository();
  return {
    repo,
    dashboard: new DashboardService({ repo }),
    taxComparison: new TaxComparisonService({ repo }),
  };
};

/** A statement, as extraction stores one. */
const save = (
  repo: InMemoryStatementsRepository,
  over: {
    documentId: string;
    statementType: "balance_sheet" | "profit_and_loss";
    fiscalYear?: number | null;
    rows?: unknown[];
    asOfDate?: string | null;
    documentName?: string;
  },
) => {
  repo.seedDocument(over.documentId, over.documentName ?? `${over.documentId}.pdf`);
  return repo.save({
    companyId: COMPANY,
    provenance: { from: "document", documentId: over.documentId },
    statementType: over.statementType,
    sourceKey: SOURCE,
    periodStart: null,
    periodEnd: null,
    asOfDate: over.asOfDate ?? null,
    fiscalYear: over.fiscalYear === undefined ? 2025 : over.fiscalYear,
    payload: { rows: over.rows ?? [{ name: "Total Assets", amount: 100 }] },
    extractedBy: null,
  });
};

describe("which extract a year means", () => {
  /**
   * Tested directly rather than through the dashboard.
   *
   * The repository hands these back newest-first, so going through it the
   * comparison never has to decide anything — the first one seen for a year
   * simply wins. That makes the rule true by accident of the query's ORDER BY,
   * and a repository that stopped sorting would silently change which figures
   * a card shows with every test still passing.
   */
  const extract = (over: Partial<StatementExtract>): StatementExtract =>
    ({
      id: "e-1",
      fiscalYear: 2025,
      extractedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    }) as StatementExtract;

  it("keeps the most recently extracted, whichever order they arrive in", () => {
    const older = extract({ id: "older", extractedAt: "2026-01-01T00:00:00.000Z" });
    const newer = extract({ id: "newer", extractedAt: "2026-06-01T00:00:00.000Z" });

    expect(latestPerYear([older, newer]).get(2025)?.id).toBe("newer");
    expect(latestPerYear([newer, older]).get(2025)?.id).toBe("newer");
  });

  it("does not let a re-extraction of an old file take a correction's place", () => {
    // The dangerous direction, and the one the ordering above hides: a backfill
    // re-reading last year's uploads must not displace this year's correction.
    const correction = extract({ id: "correction", extractedAt: "2026-06-01T00:00:00.000Z" });
    const backfilled = extract({ id: "backfilled", extractedAt: "2026-02-01T00:00:00.000Z" });

    expect(latestPerYear([correction, backfilled]).get(2025)?.id).toBe("correction");
  });

  it("keeps years apart", () => {
    const a = extract({ id: "a", fiscalYear: 2024 });
    const b = extract({ id: "b", fiscalYear: 2025 });
    expect([...latestPerYear([a, b]).keys()].sort()).toEqual([2024, 2025]);
  });

  it("files nothing under a year it does not have", () => {
    expect(latestPerYear([extract({ fiscalYear: null })]).size).toBe(0);
  });

  it("treats an extract with no time as the oldest there is", () => {
    // `extracted_at` is nullable, and a null sorting as newest would let a row
    // that never recorded when it was read win over one that did.
    const timed = extract({ id: "timed", extractedAt: "2026-01-01T00:00:00.000Z" });
    const untimed = extract({ id: "untimed", extractedAt: null });

    expect(latestPerYear([untimed, timed]).get(2025)?.id).toBe("timed");
    expect(latestPerYear([timed, untimed]).get(2025)?.id).toBe("timed");
  });

  it("answers nothing for nothing", () => {
    expect(newest([])).toBeNull();
    expect(latestPerYear([]).size).toBe(0);
  });

  it("picks the newest of several regardless of order", () => {
    const a = extract({ id: "a", extractedAt: "2026-01-01T00:00:00.000Z" });
    const b = extract({ id: "b", extractedAt: "2026-06-01T00:00:00.000Z" });
    expect(newest([a, b])?.id).toBe("b");
    expect(newest([b, a])?.id).toBe("b");
  });
});

describe("the dashboard's years", () => {
  it("opens on All Files, then each year newest first", async () => {
    const { repo, dashboard } = build();
    save(repo, { documentId: "bs-2024", statementType: "balance_sheet", fiscalYear: 2024 });
    save(repo, { documentId: "bs-2025", statementType: "balance_sheet", fiscalYear: 2025 });

    const result = await dashboard.build(USER, COMPANY, SOURCE);
    expect(result.years).toEqual(["All Files", "2025", "2024"]);
  });

  it("leaves out a statement filed under no year at all", async () => {
    // It cannot go on a card. Putting it on the newest one would attribute a
    // year's figures to a file that says nothing about which year it covers.
    const { repo, dashboard } = build();
    save(repo, { documentId: "bs-dated", statementType: "balance_sheet", fiscalYear: 2025 });
    save(repo, { documentId: "bs-undated", statementType: "balance_sheet", fiscalYear: null });

    const result = await dashboard.build(USER, COMPANY, SOURCE);
    expect(result.years).toEqual(["All Files", "2025"]);
  });

  it("names what a year is missing rather than counting it", async () => {
    // "Balance Sheet missing for 2025" tells somebody which file to upload.
    // "2 warnings" does not.
    const { repo, dashboard } = build();
    save(repo, { documentId: "pl-2025", statementType: "profit_and_loss", fiscalYear: 2025 });

    const result = await dashboard.build(USER, COMPANY, SOURCE);
    expect(result.reports["2025"]!.warnings).toEqual(["Balance Sheet missing for 2025"]);
  });

  it("says so for a company with nothing on file at all", async () => {
    const { dashboard } = build();
    const result = await dashboard.build(USER, COMPANY, SOURCE);
    expect(result.years).toEqual(["All Files"]);
    expect(result.allFiles.warnings).toEqual([
      "No Balance Sheet files found",
      "No Profit & Loss files found",
    ]);
  });

  it("lets a corrected re-upload beat the file it corrects", async () => {
    // Both cover the same year, so the period cannot order them. Extraction
    // time is the only ordering that says which is the correction.
    const { repo, dashboard } = build();
    save(repo, { documentId: "bs-first", statementType: "balance_sheet", fiscalYear: 2025 });
    save(repo, { documentId: "bs-corrected", statementType: "balance_sheet", fiscalYear: 2025 });

    const result = await dashboard.build(USER, COMPANY, SOURCE);
    expect(result.reports["2025"]!.balanceSheet?.fileName).toBe("bs-corrected.pdf");
  });

  it("names the file each figure came from, so a reader can check it", async () => {
    const { repo, dashboard } = build();
    save(repo, { documentId: "bs-2025", statementType: "balance_sheet", fiscalYear: 2025 });
    const ref = (await dashboard.build(USER, COMPANY, SOURCE)).reports["2025"]!.balanceSheet;
    expect(ref).toMatchObject({ fileName: "bs-2025.pdf" });
    expect(ref?.rowId).toBeTruthy();
  });

  it("refuses a request naming no company, or one out of reach", async () => {
    const { dashboard } = build();
    await expect(dashboard.build(USER, "", SOURCE)).rejects.toBeInstanceOf(BadRequestError);
    await expect(dashboard.build(USER, OTHER, SOURCE)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("the tax comparison's years", () => {
  it("reads one year per profit and loss", async () => {
    const { repo, taxComparison } = build();
    save(repo, {
      documentId: "pl-2025",
      statementType: "profit_and_loss",
      fiscalYear: 2025,
      rows: [{ name: "Total Revenue", amount: 500 }],
    });

    const result = await taxComparison.build(USER, COMPANY, SOURCE, NOW);
    expect(Object.keys(result.years)).toEqual(["2025"]);
    expect(result.source).toBe("parsed_rows");
  });

  it("leaves out a statement with no rows", async () => {
    // It carries no figures, and filing it under a year would hide whichever
    // statement for that year does have them.
    const { repo, taxComparison } = build();
    save(repo, { documentId: "pl-empty", statementType: "profit_and_loss", rows: [] });
    expect(await taxComparison.build(USER, COMPANY, SOURCE, NOW)).toMatchObject({ years: {} });
  });

  it("derives a year for a statement that states none", async () => {
    // From the statement's own dates, else its file name. A P&L with no year
    // at all would otherwise be dropped from a comparison it belongs in.
    const { repo, taxComparison } = build();
    save(repo, {
      documentId: "pl-undated",
      statementType: "profit_and_loss",
      fiscalYear: null,
      asOfDate: "2023-12-31",
      rows: [{ name: "Total Revenue", amount: 1 }],
    });

    expect(Object.keys(await taxComparison.build(USER, COMPANY, SOURCE, NOW).then((r) => r.years)))
      .toEqual(["2023"]);
  });

  it("lets a corrected re-upload beat the file it corrects", async () => {
    const { repo, taxComparison } = build();
    save(repo, {
      documentId: "pl-first",
      statementType: "profit_and_loss",
      fiscalYear: 2025,
      rows: [{ name: "Total Revenue", amount: 1 }],
    });
    save(repo, {
      documentId: "pl-corrected",
      statementType: "profit_and_loss",
      fiscalYear: 2025,
      rows: [{ name: "Total Revenue", amount: 2 }],
    });

    const result = await taxComparison.build(USER, COMPANY, SOURCE, NOW);
    expect(result.years["2025"]!.fileName).toBe("pl-corrected.pdf");
  });

  it("refuses a request naming no company, or one out of reach", async () => {
    const { taxComparison } = build();
    await expect(taxComparison.build(USER, "", SOURCE, NOW)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(taxComparison.build(USER, OTHER, SOURCE, NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
