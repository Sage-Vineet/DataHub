import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import type { QuickBooksRepository } from "./ports.js";
import type { ReportFetcher } from "./reports/client.js";
import type { OAuthCredentials, OAuthTokenExchange } from "./oauth-client.js";
import {
  buildAuthorizeUrl,
  readOAuthState,
  safeRedirect,
  signOAuthState,
  type OAuthState,
} from "./oauth-state.js";

/**
 * Connecting a company to its QuickBooks, and keeping the connection alive.
 *
 * Three steps and a repair. The browser is sent to Intuit; Intuit sends it
 * back with a code; the code is exchanged for a token pair which is sealed
 * into `quickbooks_connections`. `refresh` is the repair, and `transfer` moves
 * a realm that was attached to the wrong company.
 *
 * The security of the whole thing rests on `oauth-state.ts`: the callback
 * cannot be authenticated, so which company gets the connection is decided by
 * a signature rather than by a query parameter. See the note there for what
 * that replaces.
 */

export interface QuickBooksOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Where Intuit sends the browser back. Must match what Intuit has on file. */
  redirectUri: string;
  /** Signs the state. The application secret, as everything else here uses. */
  secret: string;
  /** Intuit's authorize host. Injected so a sandbox realm can be used. */
  authorizeUrl?: string;
  environment?: string;
}

export interface QuickBooksOAuthDeps {
  connections: QuickBooksRepository;
  exchange: OAuthTokenExchange;
  /** Reads the realm's own name, so the page can say WHICH books are attached. */
  fetcher: ReportFetcher;
  config: QuickBooksOAuthConfig;
}

export interface StartedAuthorization {
  authorizeUrl: string;
}

export interface CompletedCallback {
  /** Where in the SPA to send the browser, always a path within this app. */
  redirect: string;
  companyId: string;
  realmId: string;
  realmCompanyName: string | null;
}

/** A realm already attached to a different company. */
export class RealmAlreadyLinkedError extends HttpError {
  constructor(
    readonly realmId: string,
    readonly linkedCompanyId: string,
  ) {
    super(
      409,
      "That QuickBooks company is already connected to another client. " +
        "Confirm the transfer to move it.",
    );
    this.name = "RealmAlreadyLinkedError";
  }
}

export class QuickBooksOAuthService {
  constructor(private readonly deps: QuickBooksOAuthDeps) {}

  private credentials(): OAuthCredentials {
    const { clientId, clientSecret, redirectUri } = this.deps.config;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new HttpError(
        503,
        "QuickBooks OAuth is not configured on this server. " +
          "Set QB_CLIENT_ID, QB_CLIENT_SECRET and QB_REDIRECT_URI.",
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  /**
   * Where to send the browser to start a connection.
   *
   * The company is decided HERE, while there is still a session to check it
   * against, and travels in a signed state. Deciding it at the callback — as
   * the version this replaces did — means deciding it from a query parameter
   * with no session at all.
   */
  startAuthorization(
    user: SessionUser,
    companyId: string,
    options: { redirect?: unknown } = {},
    now = new Date(),
  ): StartedAuthorization {
    const credentials = this.credentials();
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have permission to connect QuickBooks for this company.");
    }

    const state = signOAuthState(
      {
        redirect: safeRedirect(
          options.redirect ?? `/broker/client/${companyId}/dataroom/connections`,
        ),
        companyId,
        userId: user.id,
      },
      this.deps.config.secret,
      now,
    );

    return {
      authorizeUrl: buildAuthorizeUrl({
        clientId: credentials.clientId,
        redirectUri: credentials.redirectUri,
        state,
        ...(this.deps.config.authorizeUrl ? { authorizeUrl: this.deps.config.authorizeUrl } : {}),
      }),
    };
  }

  /**
   * Finish the round trip: exchange the code, store the connection.
   *
   * Unauthenticated by necessity — Intuit redirects a browser here with no
   * session — so the state's signature is the only thing saying which company
   * this is for. A state that does not verify gets nothing done and a generic
   * failure back.
   */
  async completeCallback(
    input: { code: unknown; realmId: unknown; state: unknown; confirmTransfer?: boolean },
    now = new Date(),
  ): Promise<CompletedCallback> {
    const credentials = this.credentials();

    const state = readOAuthState(input.state, this.deps.config.secret, now);
    if (!state) {
      throw new BadRequestError(
        "That connection attempt is no longer valid. Start connecting QuickBooks again.",
      );
    }

    const code = String(input.code ?? "");
    const realmId = String(input.realmId ?? "");
    if (code === "" || realmId === "") {
      throw new BadRequestError("QuickBooks did not return a usable authorization.");
    }

    const companyId = state.companyId;
    if (!companyId) {
      throw new BadRequestError("That connection attempt did not name a company.");
    }

    await this.assertRealmFree(realmId, companyId, input.confirmTransfer === true);

    const tokens = await this.deps.exchange.exchangeCode(credentials, code);
    const realmCompanyName = await this.realmName(realmId, tokens.accessToken);

    await this.deps.connections.save({
      companyId,
      realmId,
      realmCompanyName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      environment: this.deps.config.environment ?? "production",
      oauthClientId: credentials.clientId,
      redirectUri: credentials.redirectUri,
      connectedBy: state.userId,
    });

    return { redirect: state.redirect, companyId, realmId, realmCompanyName };
  }

  /**
   * Renew a company's access token.
   *
   * The refresh token is rotated too: Intuit issues a new one on every
   * refresh, and storing only the access token leaves the old refresh token in
   * place — which works until Intuit expires it, and then the connection dies
   * with no way to renew it short of reconnecting.
   */
  async refresh(user: SessionUser, companyId: string): Promise<{ expiresAt: string }> {
    const credentials = this.credentials();
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const connection = await this.deps.connections.get(companyId);
    if (!connection?.isConnected) {
      throw new NotFoundError("QuickBooks is not connected for this company.");
    }
    const stored = await this.deps.connections.tokens(companyId);
    if (!stored?.refreshToken) {
      throw new NotFoundError(
        "This connection has no refresh token stored. Reconnect QuickBooks.",
      );
    }

    const tokens = await this.deps.exchange.refresh(credentials, stored.refreshToken);
    await this.deps.connections.save({
      companyId,
      realmId: connection.realmId,
      realmCompanyName: connection.realmCompanyName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
      environment: connection.environment,
      oauthClientId: credentials.clientId,
      redirectUri: credentials.redirectUri,
      connectedBy: connection.connectedBy,
    });

    return { expiresAt: tokens.expiresAt.toISOString() };
  }

  /**
   * Move a realm to this company, disconnecting wherever it was.
   *
   * The caller must be able to reach BOTH companies. Requiring only the
   * destination would let somebody move a realm they cannot see away from a
   * client they have no business touching.
   */
  async transfer(
    user: SessionUser,
    companyId: string,
    realmId: string,
  ): Promise<{ movedFrom: string | null }> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!realmId) throw new BadRequestError("Missing realmId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const existing = await this.deps.connections.getByRealm(realmId);
    if (!existing) {
      throw new NotFoundError("That QuickBooks company is not connected to anything.");
    }
    if (existing.companyId === companyId) {
      return { movedFrom: null };
    }
    if (!canAccessCompany(user, existing.companyId)) {
      throw new ForbiddenError(
        "That QuickBooks company is connected to a client you do not have access to.",
      );
    }

    // Disconnect rather than repoint: the tokens belong to the old connection
    // and clearing them is what stops the old company reading the books it no
    // longer owns. Reconnecting is what attaches them to the new one.
    await this.deps.connections.disconnect(existing.companyId);
    return { movedFrom: existing.companyId };
  }

  /** Refuse a realm already attached elsewhere, unless the move was confirmed. */
  private async assertRealmFree(
    realmId: string,
    companyId: string,
    confirmed: boolean,
  ): Promise<void> {
    const existing = await this.deps.connections.getByRealm(realmId);
    if (!existing || existing.companyId === companyId) return;

    if (!confirmed) {
      // Two companies reading one realm is two clients' figures coming from
      // one set of books, and nothing on either page says so.
      throw new RealmAlreadyLinkedError(realmId, existing.companyId);
    }
    await this.deps.connections.disconnect(existing.companyId);
  }

  /**
   * The realm's own name.
   *
   * Best effort: a connection with no name is usable and one that failed to
   * store because the name lookup failed is not, so a failure here is swallowed
   * rather than losing the tokens that were just issued.
   */
  private async realmName(realmId: string, accessToken: string): Promise<string | null> {
    try {
      const answered = await this.deps.fetcher.queryEntity({
        realmId,
        accessToken,
        entityType: "company_info",
        maxResults: 1,
      });
      const response = answered.payload.QueryResponse;
      if (response === null || typeof response !== "object") return null;
      const rows = (response as Record<string, unknown>).CompanyInfo;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const name = (rows[0] as { CompanyName?: unknown }).CompanyName;
      const text = String(name ?? "").trim();
      return text === "" ? null : text;
    } catch {
      return null;
    }
  }
}

export type { OAuthState };
