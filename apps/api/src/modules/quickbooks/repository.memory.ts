import { randomUUID } from "node:crypto";
import type {
  ConnectionRecord,
  ConnectionTokens,
  QuickBooksRepository,
  SaveConnectionInput,
} from "./ports.js";

/**
 * The same store, in memory.
 *
 * Tokens are held as given rather than encrypted — this stands in for the
 * database, and the sealing is the Drizzle repository's job and has its own
 * tests. What IS reproduced is that `disconnect` clears them, because a test
 * proving that must not pass on a fake that merely flips a flag.
 */
export class InMemoryQuickBooksRepository implements QuickBooksRepository {
  private readonly byCompany = new Map<
    string,
    ConnectionRecord & { accessToken: string | null; refreshToken: string | null }
  >();

  get(companyId: string): Promise<ConnectionRecord | null> {
    const row = this.byCompany.get(companyId);
    if (!row) return Promise.resolve(null);
    const { accessToken: _a, refreshToken: _r, ...record } = row;
    return Promise.resolve(record);
  }

  getByRealm(realmId: string): Promise<ConnectionRecord | null> {
    for (const row of this.byCompany.values()) {
      if (row.realmId === realmId && row.isConnected) {
        const { accessToken: _a, refreshToken: _r, ...record } = row;
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(null);
  }

  save(input: SaveConnectionInput): Promise<ConnectionRecord> {
    const existing = this.byCompany.get(input.companyId);
    const row = {
      id: existing?.id ?? randomUUID(),
      companyId: input.companyId,
      realmId: input.realmId,
      realmCompanyName: input.realmCompanyName,
      environment: input.environment,
      isConnected: true,
      connectedAt: "2024-01-01T00:00:00.000Z",
      disconnectedAt: null,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      tokenExpiresAt: input.tokenExpiresAt ? input.tokenExpiresAt.toISOString() : null,
      connectedBy: input.connectedBy,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
    };
    this.byCompany.set(input.companyId, row);
    const { accessToken: _a, refreshToken: _r, ...record } = row;
    return Promise.resolve(record);
  }

  disconnect(companyId: string): Promise<boolean> {
    const row = this.byCompany.get(companyId);
    if (!row || !row.isConnected) return Promise.resolve(false);
    row.isConnected = false;
    row.disconnectedAt = "2024-06-01T00:00:00.000Z";
    row.accessToken = null;
    row.refreshToken = null;
    row.tokenExpiresAt = null;
    return Promise.resolve(true);
  }

  recordSync(companyId: string, at: Date): Promise<void> {
    const row = this.byCompany.get(companyId);
    if (row) row.lastSyncedAt = at.toISOString();
    return Promise.resolve();
  }

  tokens(companyId: string): Promise<ConnectionTokens | null> {
    const row = this.byCompany.get(companyId);
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      tokenExpiresAt: row.tokenExpiresAt,
    });
  }
}
