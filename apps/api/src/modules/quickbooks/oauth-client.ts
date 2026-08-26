import { QuickBooksAuthError, QuickBooksRequestError } from "./reports/client.js";

/**
 * Intuit's OAuth endpoints.
 *
 * Separate from `QuickBooksReportClient` because they are a different API with
 * different credentials: the report client authenticates with an access token
 * and talks to a realm, while this authenticates with the application's own
 * client id and secret and has no realm yet.
 */

/** Where Intuit exchanges and refreshes tokens. */
export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working. */
  expiresAt: Date;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface QuickBooksOAuthClientOptions {
  tokenUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** What the OAuth flow needs from Intuit. A port, so tests need no network. */
export interface OAuthTokenExchange {
  exchangeCode(credentials: OAuthCredentials, code: string): Promise<OAuthTokens>;
  refresh(credentials: OAuthCredentials, refreshToken: string): Promise<OAuthTokens>;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/**
 * How long an access token lasts when Intuit does not say.
 *
 * An hour, which is Intuit's documented default. Assuming longer would let a
 * dead token sit in the database looking live, and every read through it fails
 * with a 401 that reads as "reconnect QuickBooks" when nothing was wrong with
 * the connection.
 */
const DEFAULT_EXPIRY_SECONDS = 3600;

export class QuickBooksOAuthClient implements OAuthTokenExchange {
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QuickBooksOAuthClientOptions = {}) {
    this.tokenUrl = options.tokenUrl ?? INTUIT_TOKEN_URL;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  exchangeCode(credentials: OAuthCredentials, code: string): Promise<OAuthTokens> {
    return this.post(credentials, {
      grant_type: "authorization_code",
      code,
      // Intuit checks this against the one the authorize call carried. A
      // mismatch is refused, which is what stops a code being redeemed by
      // somebody who intercepted it and has their own redirect.
      redirect_uri: credentials.redirectUri,
    });
  }

  refresh(credentials: OAuthCredentials, refreshToken: string): Promise<OAuthTokens> {
    return this.post(credentials, { grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async post(
    credentials: OAuthCredentials,
    body: Record<string, string>,
  ): Promise<OAuthTokens> {
    // Basic auth over the application's own credentials, which is how Intuit
    // authenticates the token endpoint — the access token does not exist yet.
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
      "base64",
    );

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(body).toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (response.status === 400 || response.status === 401) {
      // Intuit answers 400 for a spent or wrong code and 401 for bad
      // application credentials. Both mean "start again", and neither is worth
      // repeating the body of — it carries the code.
      throw new QuickBooksAuthError(
        "QuickBooks refused the authorization. Start the connection again.",
      );
    }
    if (!response.ok) {
      throw new QuickBooksRequestError(
        response.status,
        `QuickBooks answered ${response.status} exchanging tokens.`,
      );
    }

    let payload: TokenResponse;
    try {
      payload = JSON.parse(text) as TokenResponse;
    } catch {
      throw new QuickBooksRequestError(
        response.status,
        "QuickBooks answered the token endpoint with something that is not JSON.",
      );
    }

    return toTokens(payload);
  }
}

/**
 * The tokens out of Intuit's answer.
 *
 * Both are required. A response missing the refresh token would store a
 * connection that works for an hour and then cannot be renewed — and the
 * failure would arrive an hour later, in a different request, looking like
 * something else entirely.
 */
export function toTokens(payload: TokenResponse, now: Date = new Date()): OAuthTokens {
  const accessToken = String(payload.access_token ?? "");
  const refreshToken = String(payload.refresh_token ?? "");
  if (accessToken === "" || refreshToken === "") {
    throw new QuickBooksAuthError("QuickBooks did not return a usable token pair.");
  }

  const seconds = Number(payload.expires_in);
  const expiresIn = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_EXPIRY_SECONDS;
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
  };
}
