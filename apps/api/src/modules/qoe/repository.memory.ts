import { randomUUID } from "node:crypto";
import type { EbitdaRole } from "@datahub/contracts";
import type {
  AddbackRecord,
  CreateAddbackInput,
  EngagementData,
  QoeRepository,
} from "./ports.js";

/**
 * In-memory repository. Used by the service tests and by the demo seed, which
 * loads the anonymized engagement fixture so the bridge can be exercised
 * end-to-end without a database.
 */
export class InMemoryQoeRepository implements QoeRepository {
  private readonly engagements = new Map<string, EngagementData>();
  private readonly addbacks = new Map<string, AddbackRecord>();

  constructor(engagements: Record<string, EngagementData> = {}) {
    for (const [versionId, data] of Object.entries(engagements)) {
      this.engagements.set(versionId, data);
    }
  }

  seedEngagement(versionId: string, data: EngagementData): void {
    this.engagements.set(versionId, data);
  }

  async loadEngagement(versionId: string): Promise<EngagementData | null> {
    return this.engagements.get(versionId) ?? null;
  }

  async listAddbacks(versionId: string): Promise<AddbackRecord[]> {
    return [...this.addbacks.values()].filter((a) => a.versionId === versionId);
  }

  async createAddback(input: CreateAddbackInput): Promise<AddbackRecord> {
    const record: AddbackRecord = { ...input, id: randomUUID() };
    this.addbacks.set(record.id, record);
    return record;
  }

  async getAddback(id: string): Promise<AddbackRecord | null> {
    return this.addbacks.get(id) ?? null;
  }

  async deleteAddback(id: string): Promise<void> {
    this.addbacks.delete(id);
  }

  async updateCommentary(id: string, commentary: string): Promise<AddbackRecord | null> {
    const record = this.addbacks.get(id);
    if (!record) return null;
    const updated = { ...record, commentary };
    this.addbacks.set(id, updated);
    return updated;
  }

  async setAccountClassification(
    versionId: string,
    accountId: string,
    accountType: string,
  ): Promise<void> {
    const data = this.engagements.get(versionId);
    if (!data) return;
    const statementType =
      accountType === "income" || accountType === "cogs" || accountType === "expense"
        ? "profit_loss"
        : "balance_sheet";
    this.engagements.set(versionId, {
      ...data,
      accounts: data.accounts.map((a) =>
        a.id === accountId
          ? { ...a, accountType: accountType as typeof a.accountType, statementType }
          : a,
      ),
    });
  }

  async setAccountRole(
    versionId: string,
    accountId: string,
    role: EbitdaRole | null,
  ): Promise<void> {
    await this.setAccountRoles(versionId, [{ accountId, role }]);
  }

  async setAccountRoles(
    versionId: string,
    updates: Array<{ accountId: string; role: EbitdaRole | null }>,
  ): Promise<void> {
    const data = this.engagements.get(versionId);
    if (!data) return;
    const byId = new Map(updates.map((u) => [u.accountId, u.role]));
    this.engagements.set(versionId, {
      ...data,
      accounts: data.accounts.map((a) =>
        byId.has(a.id) ? { ...a, ebitdaRole: byId.get(a.id)! } : a,
      ),
    });
  }
}
