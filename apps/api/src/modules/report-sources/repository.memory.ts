import {
  REPORT_SOURCE_LABELS,
  type CompanySourceState,
  type ReportSourceKey,
  type ReportSourcesRepository,
  type SourceAvailability,
  type SourceRecord,
} from "./ports.js";

/**
 * The same store, in memory.
 *
 * `select` clears every record before setting one, exactly as the real one
 * does — a fake that allowed two selected rows would let a test pass on
 * behaviour the database forbids.
 */
export class InMemoryReportSourcesRepository implements ReportSourcesRepository {
  private readonly records = new Map<string, SourceRecord & { companyId: string }>();
  private company: CompanySourceState | null = {
    dataSourceType: null,
    quickbooksConnected: false,
    lastSourceSwitchAt: null,
  };
  private data: SourceAvailability = { hasGeneralLedger: false, hasLinkedDocuments: false };

  seedCompany(state: CompanySourceState | null): void {
    this.company = state;
  }

  seedAvailability(data: Partial<SourceAvailability>): void {
    this.data = { ...this.data, ...data };
  }

  getCompanyState(): Promise<CompanySourceState | null> {
    return Promise.resolve(this.company);
  }

  availability(): Promise<SourceAvailability> {
    return Promise.resolve(this.data);
  }

  listRecords(companyId: string): Promise<SourceRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((r) => r.companyId === companyId)
        .sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel))
        .map(({ companyId: _companyId, ...rest }) => rest),
    );
  }

  ensureRecords(companyId: string, keys: readonly string[]): Promise<void> {
    for (const sourceKey of keys) {
      const id = `${companyId}:${sourceKey}`;
      if (this.records.has(id)) continue;
      this.records.set(id, {
        companyId,
        sourceKey,
        sourceLabel: REPORT_SOURCE_LABELS[sourceKey as ReportSourceKey] ?? sourceKey,
        isSelected: false,
        isAvailable: false,
        isConnected: false,
        lastConnectedAt: null,
        lastSyncedAt: null,
        metadata: {},
      });
    }
    return Promise.resolve();
  }

  updateRecord(
    companyId: string,
    sourceKey: string,
    patch: { isAvailable: boolean; isConnected: boolean },
  ): Promise<void> {
    const record = this.records.get(`${companyId}:${sourceKey}`);
    if (record) Object.assign(record, patch);
    return Promise.resolve();
  }

  select(companyId: string, sourceKey: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.companyId === companyId) record.isSelected = false;
    }
    const chosen = this.records.get(`${companyId}:${sourceKey}`);
    if (chosen) chosen.isSelected = true;
    if (this.company) {
      this.company = {
        ...this.company,
        dataSourceType: sourceKey,
        lastSourceSwitchAt: "2024-01-01T00:00:00.000Z",
      };
    }
    return Promise.resolve();
  }
}
