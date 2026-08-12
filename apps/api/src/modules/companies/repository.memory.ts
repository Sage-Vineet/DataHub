import { randomUUID } from "node:crypto";
import type {
  CompaniesRepository,
  CompanyCreateInput,
  CompanyRecord,
  CompanyUpdatePatch,
} from "./ports.js";

/**
 * In-memory `CompaniesRepository` for tests — same interface as the Drizzle
 * adapter, no database. `cascadeDelete` just drops the company; the transactional
 * multi-table cascade is covered against a real Postgres in the Drizzle test.
 */
export class InMemoryCompaniesRepository implements CompaniesRepository {
  private readonly companies = new Map<string, CompanyRecord>();
  /** `${userId}:${companyId}` links, exposed for assertions. */
  readonly links = new Set<string>();

  /** Seed a fully-formed company (tests). */
  seed(record: CompanyRecord): CompanyRecord {
    this.companies.set(record.id, record);
    return record;
  }

  async getById(id: string): Promise<CompanyRecord | null> {
    return this.companies.get(id) ?? null;
  }

  async listAll(): Promise<CompanyRecord[]> {
    return [...this.companies.values()];
  }

  async listByIds(ids: readonly string[]): Promise<CompanyRecord[]> {
    return ids.map((id) => this.companies.get(id)).filter((c): c is CompanyRecord => c != null);
  }

  async create(input: CompanyCreateInput): Promise<CompanyRecord> {
    const record: CompanyRecord = {
      id: randomUUID(),
      ...input,
      dataSourceType: null,
      quickbooksConnected: false,
      manualUploadActive: false,
    };
    this.companies.set(record.id, record);
    return record;
  }

  async updateSafeFields(id: string, patch: CompanyUpdatePatch): Promise<CompanyRecord | null> {
    const existing = this.companies.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.companies.set(id, updated);
    return updated;
  }

  async linkUserCompany(userId: string, companyId: string): Promise<void> {
    this.links.add(`${userId}:${companyId}`);
  }

  async cascadeDelete(id: string): Promise<void> {
    this.companies.delete(id);
    for (const key of this.links) {
      if (key.endsWith(`:${id}`)) this.links.delete(key);
    }
  }
}
