import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { ConnectionRecord, QuickBooksRepository } from "./ports.js";

export interface QuickBooksServiceDeps {
  repo: QuickBooksRepository;
}

/** What the Connections page renders. */
export interface ConnectionStatus {
  connected: boolean;
  realmId: string | null;
  realmCompanyName: string | null;
  environment: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  /** True when there is a connection but its token has passed its expiry. */
  tokenExpired: boolean;
}

export class QuickBooksService {
  constructor(private readonly deps: QuickBooksServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /**
   * Whether this company is connected, and how healthily.
   *
   * A company that has never connected and one that disconnected both report
   * `connected: false` — the page offers the same button either way — but the
   * realm and the dates survive a disconnect, so "you were connected to Acme
   * Books until March" is still answerable.
   */
  async status(user: SessionUser, companyId: string, now = new Date()): Promise<ConnectionStatus> {
    this.requireCompany(user, companyId);
    const connection = await this.deps.repo.get(companyId);

    if (!connection) {
      return {
        connected: false,
        realmId: null,
        realmCompanyName: null,
        environment: null,
        connectedAt: null,
        lastSyncedAt: null,
        tokenExpired: false,
      };
    }

    return {
      connected: connection.isConnected,
      realmId: connection.realmId,
      realmCompanyName: connection.realmCompanyName,
      environment: connection.environment,
      connectedAt: connection.connectedAt,
      lastSyncedAt: connection.lastSyncedAt,
      // Only meaningful while connected: a disconnected connection has no
      // token, and reporting it as "expired" would suggest refreshing it.
      tokenExpired:
        connection.isConnected &&
        connection.tokenExpiresAt !== null &&
        new Date(connection.tokenExpiresAt).getTime() <= now.getTime(),
    };
  }

  /**
   * Disconnect.
   *
   * Idempotent by design: the button is the same whether or not the connection
   * is already gone, and a second click must not be an error. A company that
   * was never connected is a 404 — that is a different situation from one that
   * is already disconnected, and worth saying.
   */
  async disconnect(user: SessionUser, companyId: string): Promise<ConnectionStatus> {
    this.requireCompany(user, companyId);
    const existing = await this.deps.repo.get(companyId);
    if (!existing) throw new NotFoundError("This company is not connected to QuickBooks.");

    await this.deps.repo.disconnect(companyId);
    return this.status(user, companyId);
  }

  /** The connection record, for callers that need the realm. */
  async get(user: SessionUser, companyId: string): Promise<ConnectionRecord | null> {
    this.requireCompany(user, companyId);
    return this.deps.repo.get(companyId);
  }

  async recordSync(user: SessionUser, companyId: string, at = new Date()): Promise<void> {
    this.requireCompany(user, companyId);
    const existing = await this.deps.repo.get(companyId);
    if (!existing) throw new NotFoundError("This company is not connected to QuickBooks.");
    await this.deps.repo.recordSync(companyId, at);
  }
}
