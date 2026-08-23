import { randomUUID } from "node:crypto";
import type {
  CreateVersionInput,
  LedgerTransaction,
  ReportsRepository,
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
