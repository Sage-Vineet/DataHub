import type { SessionUser } from "@datahub/contracts";
import {
  readStatementKpis,
  readTaxComparisonFigures,
  statementYear,
  toKpiTrend,
  type KpiTrendPoint,
  type StatementKpis,
  type StatementNode,
  type TaxComparisonFigures,
} from "@datahub/financial-engine";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { StatementExtract, StatementsRepository } from "./ports.js";

/**
 * The dashboard a source's landing page shows.
 *
 * One year per card: the balance sheet and the profit-and-loss for that year,
 * the figures read off them, and which files they came from. Plus a trend line
 * across every year on file.
 *
 * DERIVED, NOT CACHED
 * -------------------
 * Legacy kept this in a five-minute in-process map keyed by company. Three
 * problems with that, and only the first is about staleness: uploading a
 * corrected statement left the old figures on the dashboard for up to five
 * minutes with nothing to say why; the cache lived in one process, so two
 * gateway instances disagreed with each other; and it was never invalidated on
 * write, so the timer was the only thing that cleared it.
 *
 * The inputs are a handful of rows and the derivation is arithmetic. There is
 * nothing here worth caching.
 */

/** Which file a figure came from — so a reader can check it. */
export interface DashboardStatementRef {
  rowId: string;
  fileName: string | null;
  folderName: string | null;
  asOfDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  updatedAt: string | null;
}

export interface DashboardYear {
  year: string;
  balanceSheet: DashboardStatementRef | null;
  profitLoss: DashboardStatementRef | null;
  kpis: StatementKpis;
  /** What is missing for this year, named. Absent when nothing is. */
  warnings?: string[];
}

export interface SourceDashboard {
  /** `"All Files"` first, then every year, newest first — the picker's order. */
  years: string[];
  reports: Record<string, DashboardYear>;
  /** The figures across the most recent statement of each kind, whatever year. */
  allFiles: { kpis: StatementKpis; warnings?: string[] };
  trends: KpiTrendPoint[];
}

export interface DashboardServiceDeps {
  repo: StatementsRepository;
}

const rowsOf = (extract: StatementExtract | null | undefined): StatementNode[] => {
  const rows = (extract?.payload as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as StatementNode[]) : [];
};

const refOf = (extract: StatementExtract): DashboardStatementRef => ({
  // `rowId` is legacy's name for the extract id, and it is what the page sets
  // as the selected file. Renaming it empties the selection silently.
  rowId: extract.id,
  fileName: extract.documentName,
  folderName: extract.folderName,
  asOfDate: extract.asOfDate,
  periodStart: extract.periodStart,
  periodEnd: extract.periodEnd,
  updatedAt: extract.updatedAt,
});

/**
 * The statement to use for a year, where several were uploaded.
 *
 * The most recently EXTRACTED one. A corrected re-upload should win over the
 * file it corrects, and extraction time is the only ordering that says so —
 * the period is the same for both.
 */
export function latestPerYear(
  extracts: readonly StatementExtract[],
): Map<number, StatementExtract> {
  const byYear = new Map<number, StatementExtract>();
  for (const extract of extracts) {
    if (extract.fiscalYear === null) continue;
    const existing = byYear.get(extract.fiscalYear);
    if (!existing || (extract.extractedAt ?? "") > (existing.extractedAt ?? "")) {
      byYear.set(extract.fiscalYear, extract);
    }
  }
  return byYear;
}

export const newest = (extracts: readonly StatementExtract[]): StatementExtract | null =>
  [...extracts].sort((a, b) => (b.extractedAt ?? "").localeCompare(a.extractedAt ?? ""))[0] ?? null;

export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  async build(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
  ): Promise<SourceDashboard> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const [balanceSheets, profitLosses] = await Promise.all([
      this.deps.repo.list(companyId, { sourceKey, statementType: "balance_sheet" }),
      this.deps.repo.list(companyId, { sourceKey, statementType: "profit_and_loss" }),
    ]);

    const bsByYear = latestPerYear(balanceSheets);
    const plByYear = latestPerYear(profitLosses);
    const years = [...new Set([...bsByYear.keys(), ...plByYear.keys()])].sort((a, b) => b - a);

    const reports: Record<string, DashboardYear> = {};
    for (const year of years) {
      const bs = bsByYear.get(year) ?? null;
      const pl = plByYear.get(year) ?? null;

      // Named rather than counted. "Balance Sheet missing for 2023" tells
      // somebody which file to go and upload; "2 warnings" does not.
      const warnings: string[] = [];
      if (!bs) warnings.push(`Balance Sheet missing for ${year}`);
      if (!pl) warnings.push(`Profit & Loss missing for ${year}`);

      reports[String(year)] = {
        year: String(year),
        balanceSheet: bs ? refOf(bs) : null,
        profitLoss: pl ? refOf(pl) : null,
        kpis: readStatementKpis(rowsOf(bs), rowsOf(pl)),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const latestBs = newest(balanceSheets);
    const latestPl = newest(profitLosses);
    const allFilesWarnings: string[] = [];
    if (!latestBs) allFilesWarnings.push("No Balance Sheet files found");
    if (!latestPl) allFilesWarnings.push("No Profit & Loss files found");

    return {
      // "All Files" is the picker's first option and is not a year, which is
      // why the list is strings rather than numbers.
      years: ["All Files", ...years.map(String)],
      reports,
      allFiles: {
        kpis: readStatementKpis(rowsOf(latestBs), rowsOf(latestPl)),
        ...(allFilesWarnings.length > 0 ? { warnings: allFilesWarnings } : {}),
      },
      trends: toKpiTrend(years.map((year) => ({ year, kpis: reports[String(year)]!.kpis }))),
    };
  }
}

/**
 * The tax-comparison figures, per year, from a company's uploaded P&Ls.
 *
 * The other half of the Tax Reconciliation page: `/tax-data` reads the return,
 * this reads the books. Same nine figures, so the page can set them side by
 * side.
 *
 * Derived from what extraction already stored rather than re-read. Legacy had
 * three paths here — a stored `pl_for_tax` blob, the parsed rows, and a live
 * Gemini extraction — and they could disagree, because the first was written
 * by a sync that might have run against a different file from the one the
 * second reads. One path now: the parsed rows, which is the thing every other
 * page in the product already believes.
 */
export interface TaxComparisonYears {
  years: Record<string, TaxComparisonFigures & { fileName: string | null; extractId: string }>;
  source: "parsed_rows";
}

export class TaxComparisonService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  async build(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
    now = new Date(),
  ): Promise<TaxComparisonYears> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const extracts = await this.deps.repo.list(companyId, {
      sourceKey,
      statementType: "profit_and_loss",
    });

    const years: TaxComparisonYears["years"] = {};
    for (const extract of extracts) {
      const rows = rowsOf(extract);
      // A statement with no rows carries no figures, and filing it under a
      // year would hide whichever statement for that year does have them.
      if (rows.length === 0) continue;

      const year = extract.fiscalYear ?? statementYear(extract, extract.documentName, now.getFullYear());
      const existing = years[String(year)];
      // Newest extraction wins, so a corrected re-upload beats the file it
      // corrects — the same rule the dashboard uses.
      if (existing && existing.extractId !== extract.id) {
        const priorAt = extracts.find((e) => e.id === existing.extractId)?.extractedAt ?? "";
        if ((extract.extractedAt ?? "") <= priorAt) continue;
      }

      years[String(year)] = {
        ...readTaxComparisonFigures(rows, year),
        fileName: extract.documentName,
        extractId: extract.id,
      };
    }

    return { years, source: "parsed_rows" };
  }
}
