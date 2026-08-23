import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { open, seal } from "../../shared/secret-box.js";
import type {
  ConnectionRecord,
  ConnectionTokens,
  QuickBooksRepository,
  SaveConnectionInput,
} from "./ports.js";

const { quickbooksConnections } = schema;

/** Purpose labels, so an access token cannot be opened as a refresh token. */
const ACCESS_PURPOSE = "quickbooks/access-token";
const REFRESH_PURPOSE = "quickbooks/refresh-token";

type Row = typeof quickbooksConnections.$inferSelect;

function toRecord(row: Row): ConnectionRecord {
  // Note what is NOT here: the sealed columns. `ConnectionRecord` has no token
  // field, so there is nowhere for one to go even by accident.
  return {
    id: row.id,
    companyId: row.companyId,
    realmId: row.realmId,
    realmCompanyName: row.realmCompanyName ?? null,
    environment: row.environment,
    isConnected: row.isConnected,
    connectedAt: row.connectedAt ? row.connectedAt.toISOString() : null,
    disconnectedAt: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
    connectedBy: row.connectedBy ?? null,
  };
}

export class DrizzleQuickBooksRepository implements QuickBooksRepository {
  constructor(
    private readonly db: Db,
    /** The application secret. Sealing keys are derived from it per purpose. */
    private readonly secret: string,
  ) {}

  async get(companyId: string): Promise<ConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(quickbooksConnections)
      .where(eq(quickbooksConnections.companyId, companyId))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async getByRealm(realmId: string): Promise<ConnectionRecord | null> {
    // Live only: a realm may legitimately be reconnected to a different
    // company after a disconnect, and the partial unique index says so.
    const [row] = await this.db
      .select()
      .from(quickbooksConnections)
      .where(
        and(eq(quickbooksConnections.realmId, realmId), eq(quickbooksConnections.isConnected, true)),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async save(input: SaveConnectionInput): Promise<ConnectionRecord> {
    const sealed = {
      accessTokenSealed:
        input.accessToken === null ? null : seal(input.accessToken, this.secret, ACCESS_PURPOSE),
      refreshTokenSealed:
        input.refreshToken === null ? null : seal(input.refreshToken, this.secret, REFRESH_PURPOSE),
    };
    const now = new Date();

    // One connection per company, so reconnecting replaces rather than
    // accumulating — every read asks for "the" connection, and two would make
    // that question meaningless.
    const [row] = await this.db
      .insert(quickbooksConnections)
      .values({
        companyId: input.companyId,
        realmId: input.realmId,
        realmCompanyName: input.realmCompanyName,
        ...sealed,
        tokenExpiresAt: input.tokenExpiresAt,
        environment: input.environment,
        oauthClientId: input.oauthClientId,
        redirectUri: input.redirectUri,
        isConnected: true,
        connectedAt: now,
        disconnectedAt: null,
        connectedBy: input.connectedBy,
      })
      .onConflictDoUpdate({
        target: [quickbooksConnections.companyId],
        set: {
          realmId: input.realmId,
          realmCompanyName: input.realmCompanyName,
          ...sealed,
          tokenExpiresAt: input.tokenExpiresAt,
          environment: input.environment,
          oauthClientId: input.oauthClientId,
          redirectUri: input.redirectUri,
          isConnected: true,
          connectedAt: now,
          // Cleared, or a reconnected company keeps reading as one that was
          // disconnected at some point in the past.
          disconnectedAt: null,
          connectedBy: input.connectedBy,
          updatedAt: now,
        },
      })
      .returning();
    return toRecord(row!);
  }

  async disconnect(companyId: string): Promise<boolean> {
    // The tokens are cleared, not just the flag. A disconnected connection
    // holding a live refresh token is a credential nobody is watching any more,
    // and reconnecting issues new ones anyway.
    const rows = await this.db
      .update(quickbooksConnections)
      .set({
        isConnected: false,
        disconnectedAt: new Date(),
        accessTokenSealed: null,
        refreshTokenSealed: null,
        tokenExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(quickbooksConnections.companyId, companyId),
          eq(quickbooksConnections.isConnected, true),
        ),
      )
      .returning({ id: quickbooksConnections.id });
    return rows.length > 0;
  }

  async recordSync(companyId: string, at: Date): Promise<void> {
    await this.db
      .update(quickbooksConnections)
      .set({ lastSyncedAt: at, updatedAt: new Date() })
      .where(eq(quickbooksConnections.companyId, companyId));
  }

  async tokens(companyId: string): Promise<ConnectionTokens | null> {
    const [row] = await this.db
      .select({
        accessTokenSealed: quickbooksConnections.accessTokenSealed,
        refreshTokenSealed: quickbooksConnections.refreshTokenSealed,
        tokenExpiresAt: quickbooksConnections.tokenExpiresAt,
      })
      .from(quickbooksConnections)
      .where(eq(quickbooksConnections.companyId, companyId))
      .limit(1);
    if (!row) return null;

    // A column that will not open yields null rather than throwing: the caller
    // treats "no token" and "unreadable token" the same way — reconnect — and
    // an exception here would take out a page that only wanted to say so.
    return {
      accessToken: row.accessTokenSealed
        ? open(row.accessTokenSealed, this.secret, ACCESS_PURPOSE)
        : null,
      refreshToken: row.refreshTokenSealed
        ? open(row.refreshTokenSealed, this.secret, REFRESH_PURPOSE)
        : null,
      tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
    };
  }
}
