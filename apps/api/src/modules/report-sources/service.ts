import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import {
  ALL_SOURCE_KEYS,
  MANUAL_SOURCE_KEYS,
  REPORT_SOURCE_KEYS,
  type ReportSourceKey,
  type ReportSourcesRepository,
  type SourceAvailability,
  type SourceRecord,
} from "./ports.js";

export interface ReportSourcesServiceDeps {
  repo: ReportSourcesRepository;
}

export interface ReportSourcesState {
  sources: SourceRecord[];
  selectedSource: string;
  activeSource: string | null;
  quickbooksConnected: boolean;
  manualUploadActive: boolean;
  lastSourceSwitchAt: string | null;
}

/** Is this one of the four? */
export function isReportSourceKey(value: string): value is ReportSourceKey {
  return (ALL_SOURCE_KEYS as readonly string[]).includes(value);
}

/**
 * Whether a source has anything behind it.
 *
 * Pure, so the rule can be read and tested without a database. See `ports.ts`
 * for why availability is defined this way rather than legacy's.
 */
export function availabilityOf(
  sourceKey: ReportSourceKey,
  company: { quickbooksConnected: boolean },
  data: SourceAvailability,
): { isAvailable: boolean; isConnected: boolean } {
  switch (sourceKey) {
    case REPORT_SOURCE_KEYS.QUICKBOOKS:
      // The only source with a connection to be in; available because it is
      // connected, not because anything has synced yet.
      return { isAvailable: company.quickbooksConnected, isConnected: company.quickbooksConnected };
    case REPORT_SOURCE_KEYS.MANUAL_GL:
      return { isAvailable: data.hasGeneralLedger, isConnected: false };
    case REPORT_SOURCE_KEYS.MANUAL_UPLOAD:
      return { isAvailable: data.hasLinkedDocuments, isConnected: false };
    case REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL:
      // Nothing in the schema backs this one. Saying so beats implying it is
      // merely empty.
      return { isAvailable: false, isConnected: false };
  }
}

export class ReportSourcesService {
  constructor(private readonly deps: ReportSourcesServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /**
   * The whole state the selector renders.
   *
   * Availability is recomputed and written back on every read rather than
   * cached, because it is derived from tables that change constantly — a stored
   * flag would be stale the moment a ledger was uploaded, and the page would
   * offer a source it had just been given data for.
   */
  async getState(user: SessionUser, companyId: string): Promise<ReportSourcesState> {
    this.requireCompany(user, companyId);

    await this.deps.repo.ensureRecords(companyId, ALL_SOURCE_KEYS);
    const company = (await this.deps.repo.getCompanyState(companyId)) ?? {
      dataSourceType: null,
      quickbooksConnected: false,
      lastSourceSwitchAt: null,
    };
    const data = await this.deps.repo.availability(companyId);

    for (const key of ALL_SOURCE_KEYS) {
      await this.deps.repo.updateRecord(companyId, key, availabilityOf(key, company, data));
    }

    let sources = await this.deps.repo.listRecords(companyId);
    let selected = sources.find((s) => s.isSelected)?.sourceKey ?? null;

    // The records are authoritative for the current selection; the company's
    // `data_source_type` is a denormalized cache. When the records have no
    // selection yet, seed them from the cache rather than silently defaulting —
    // otherwise a company that switched before this module existed reverts.
    if (!selected) {
      const fromCompany = company.dataSourceType;
      const seed =
        fromCompany && isReportSourceKey(fromCompany) ? fromCompany : REPORT_SOURCE_KEYS.QUICKBOOKS;
      await this.deps.repo.select(companyId, seed);
      sources = await this.deps.repo.listRecords(companyId);
      selected = seed;
    }

    return {
      sources,
      selectedSource: selected,
      activeSource: selected,
      quickbooksConnected: company.quickbooksConnected,
      manualUploadActive: (MANUAL_SOURCE_KEYS as readonly string[]).includes(selected),
      lastSourceSwitchAt: company.lastSourceSwitchAt,
    };
  }

  /**
   * Switch the selection.
   *
   * Never blocked on availability: switching to an empty source is exactly what
   * a user does before uploading anything into it, and refusing would make the
   * page impossible to start from.
   */
  async select(
    user: SessionUser,
    companyId: string,
    sourceKey: string,
  ): Promise<ReportSourcesState> {
    this.requireCompany(user, companyId);
    if (!sourceKey) throw new BadRequestError("Missing sourceKey.");
    if (!isReportSourceKey(sourceKey)) {
      throw new BadRequestError(
        `Unknown report source: ${sourceKey}. Expected one of ${ALL_SOURCE_KEYS.join(", ")}.`,
      );
    }

    await this.deps.repo.ensureRecords(companyId, ALL_SOURCE_KEYS);
    await this.deps.repo.select(companyId, sourceKey);
    return this.getState(user, companyId);
  }
}
