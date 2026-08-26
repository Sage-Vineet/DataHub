import { randomUUID } from "node:crypto";
import type {
  CreateVersionInput,
  LedgerTransaction,
  LinkDocumentInput,
  LinkedDocument,
  MappingRecord,
  ReportsRepository,
  SyncLogRecord,
  UpdateVersionPatch,
  VersionRecord,
} from "./ports.js";

export class InMemoryReportsRepository implements ReportsRepository {
  private readonly versions = new Map<string, VersionRecord>();

  private byCompany(companyId: string): VersionRecord[] {
    return [...this.versions.values()].filter((v) => v.companyId === companyId);
  }

  async listByCompany(companyId: string): Promise<VersionRecord[]> {
    return this.byCompany(companyId).sort((a, b) => a.versionNumber - b.versionNumber);
  }
  async getById(id: string): Promise<VersionRecord | null> {
    return this.versions.get(id) ?? null;
  }
  async create(input: CreateVersionInput): Promise<VersionRecord> {
    const nextNumber = Math.max(0, ...this.byCompany(input.companyId).map((v) => v.versionNumber)) + 1;
    const record: VersionRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      versionNumber: nextNumber,
      versionName: input.versionName,
      status: "draft",
      isActive: false,
      resolvedBatchId: null,
      lastSyncedAt: null,
      metadata: input.metadata,
      createdBy: input.createdBy,
    };
    this.versions.set(record.id, record);
    return record;
  }
  async update(id: string, patch: UpdateVersionPatch): Promise<VersionRecord | null> {
    const v = this.versions.get(id);
    if (!v) return null;
    const u = {
      ...v,
      ...(patch.versionName !== undefined ? { versionName: patch.versionName } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    };
    this.versions.set(id, u);
    return u;
  }
  async delete(id: string): Promise<void> {
    this.versions.delete(id);
  }
  async duplicate(id: string, createdBy: string): Promise<VersionRecord | null> {
    const source = this.versions.get(id);
    if (!source) return null;
    return this.create({ companyId: source.companyId, versionName: source.versionName, metadata: source.metadata, createdBy });
  }
  async activate(id: string): Promise<VersionRecord | null> {
    const target = this.versions.get(id);
    if (!target) return null;
    for (const v of this.byCompany(target.companyId)) this.versions.set(v.id, { ...v, isActive: false });
    const activated = { ...this.versions.get(id)!, isActive: true };
    this.versions.set(id, activated);
    return activated;
  }
}

/**
 * A stubbed engagement source for service tests.
 *
 * The statement arithmetic is tested directly against `buildStatements`; this
 * only needs to prove the service asks for the right version and handles an
 * absent one.
 */
export class InMemoryEngagementPort {
  lastVersionId: string | null = null;

  constructor(private readonly engagements = new Map<string, unknown>()) {}

  seed(versionId: string, engagement: unknown): void {
    this.engagements.set(versionId, engagement);
  }

  load(versionId: string): Promise<never> {
    this.lastVersionId = versionId;
    return Promise.resolve((this.engagements.get(versionId) ?? null) as never);
  }
}

/** The posted ledger, held in memory, for tests that need the drill-down. */
export class InMemoryLedgerDetailPort {
  lastVersionId: string | null = null;

  constructor(private readonly ledgers = new Map<string, LedgerTransaction[]>()) {}

  seed(versionId: string, transactions: LedgerTransaction[]): void {
    // Copied on the way in, so a test mutating its fixture afterwards cannot
    // change what the port already holds.
    this.ledgers.set(versionId, [...transactions]);
  }

  list(versionId: string): Promise<LedgerTransaction[]> {
    this.lastVersionId = versionId;
    // Copied on the way out too, for the same reason in reverse.
    return Promise.resolve([...(this.ledgers.get(versionId) ?? [])]);
  }
}

/** Mappings, documents and file references in memory, for the service tests. */
export class InMemoryMappingsRepository {
  private readonly mappings = new Map<string, MappingRecord>();
  private readonly documents = new Map<string, LinkedDocument>();
  readonly fileReferences = new Set<string>();

  seedDocument(document: LinkedDocument): void {
    this.documents.set(document.id, document);
  }

  listByVersion(versionId: string): Promise<MappingRecord[]> {
    return Promise.resolve(
      [...this.mappings.values()]
        .filter((m) => m.versionId === versionId)
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    );
  }

  getById(mappingId: string): Promise<MappingRecord | null> {
    return Promise.resolve(this.mappings.get(mappingId) ?? null);
  }

  link(input: LinkDocumentInput): Promise<MappingRecord> {
    // The real table's unique index is on this triple, and the fake has to
    // agree or a test proves an idempotence the database does not provide.
    const existing = [...this.mappings.values()].find(
      (m) =>
        m.versionId === input.versionId &&
        m.reportCategory === input.reportCategory &&
        m.documentId === input.documentId,
    );
    if (existing) return Promise.resolve(existing);

    const record: MappingRecord = {
      id: randomUUID(),
      versionId: input.versionId,
      companyId: input.companyId,
      reportCategory: input.reportCategory,
      documentId: input.documentId,
      uploadId: input.uploadId,
      fileName: input.fileName,
      year: input.year,
      status: "linked",
      linkedBy: input.linkedBy,
      metadata: {},
      // Ordered by insertion, which is what `created_at ASC` gives in practice.
      createdAt: String(this.mappings.size).padStart(6, "0"),
    };
    this.mappings.set(record.id, record);
    return Promise.resolve(record);
  }

  delete(mappingId: string): Promise<void> {
    this.mappings.delete(mappingId);
    return Promise.resolve();
  }

  countForDocument(versionId: string, documentId: string): Promise<number> {
    return Promise.resolve(
      [...this.mappings.values()].filter(
        (m) => m.versionId === versionId && m.documentId === documentId,
      ).length,
    );
  }

  getDocument(documentId: string): Promise<LinkedDocument | null> {
    return Promise.resolve(this.documents.get(documentId) ?? null);
  }

  addFileReference(input: { documentId: string; linkedEntityId: string }): Promise<void> {
    this.fileReferences.add(`${input.linkedEntityId}:${input.documentId}`);
    return Promise.resolve();
  }

  removeFileReference(documentId: string, linkedEntityId: string): Promise<void> {
    this.fileReferences.delete(`${linkedEntityId}:${documentId}`);
    return Promise.resolve();
  }
}

/** Sync attempts in memory. */
export class InMemorySyncLogsRepository {
  private readonly logs: SyncLogRecord[] = [];

  seed(log: SyncLogRecord): void {
    this.logs.push(log);
  }

  listByVersion(versionId: string, limit: number): Promise<SyncLogRecord[]> {
    return Promise.resolve(
      this.logs
        .filter((l) => l.versionId === versionId)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .slice(0, limit),
    );
  }
}

/** Per-user settings in memory. */
export class InMemoryPreferencesRepository {
  private readonly values = new Map<string, Record<string, unknown>>();

  get(userId: string, key: string): Promise<Record<string, unknown> | null> {
    return Promise.resolve(this.values.get(`${userId}:${key}`) ?? null);
  }

  set(userId: string, key: string, value: Record<string, unknown>): Promise<void> {
    // Keyed on the pair, so a second write replaces rather than accumulates —
    // the same thing the unique index does in the database.
    this.values.set(`${userId}:${key}`, value);
    return Promise.resolve();
  }
}
