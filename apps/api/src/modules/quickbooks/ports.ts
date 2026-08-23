/**
 * A company's QuickBooks connection.
 *
 * WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT
 * -------------------------------------------
 * It owns the connection's STATE: whether a company is connected, to which
 * realm, since when, when it last synced, and disconnecting. Those are
 * answerable here and testable without Intuit.
 *
 * It does NOT own the OAuth dance — `/api/auth/quickbooks`, `/api/auth/callback`
 * and `/refresh-token`. Those need real Intuit credentials and a browser
 * redirect to exercise, and a port with no way to test it against the thing it
 * talks to is how a migration ships a subtly broken auth flow. They stay on
 * legacy until they can be exercised against a sandbox realm.
 *
 * TOKENS NEVER LEAVE THIS LAYER
 * -----------------------------
 * `ConnectionRecord` deliberately has no token field. Nothing above the
 * repository has a use for one — the sync client asks for a token when it is
 * about to make a call — so the type makes leaking one into a response or a
 * log impossible rather than merely unlikely.
 */

export interface ConnectionRecord {
  id: string;
  companyId: string;
  realmId: string;
  realmCompanyName: string | null;
  environment: string;
  isConnected: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  connectedBy: string | null;
}

/** What a caller must supply to record a connection. */
export interface SaveConnectionInput {
  companyId: string;
  realmId: string;
  realmCompanyName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  environment: string;
  oauthClientId: string | null;
  redirectUri: string | null;
  connectedBy: string | null;
}

/** The tokens, for the one caller that needs them. */
export interface ConnectionTokens {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

export interface QuickBooksRepository {
  get(companyId: string): Promise<ConnectionRecord | null>;
  /** Live connection for a realm, for the OAuth callback's benefit. */
  getByRealm(realmId: string): Promise<ConnectionRecord | null>;
  save(input: SaveConnectionInput): Promise<ConnectionRecord>;
  /** Mark disconnected and clear the tokens. Returns false if nothing matched. */
  disconnect(companyId: string): Promise<boolean>;
  recordSync(companyId: string, at: Date): Promise<void>;
  /**
   * Decrypted tokens, or null where a column could not be opened.
   *
   * Separate from `get` so that reading a connection's state — which every
   * page does — never decrypts anything.
   */
  tokens(companyId: string): Promise<ConnectionTokens | null>;
}
