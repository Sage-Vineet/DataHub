import { describe, expect, it } from "vitest";
import { QuickBooksAuthError, QuickBooksRequestError } from "./reports/client.js";
import { QuickBooksOAuthClient, toTokens } from "./oauth-client.js";

/**
 * Talking to Intuit's token endpoint.
 *
 * A different API from the reports client, with different credentials: this
 * one authenticates with the application's own id and secret, because the
 * access token it is fetching does not exist yet.
 */

const CREDENTIALS = {
  clientId: "qb-client-id",
  clientSecret: "qb-client-secret",
  redirectUri: "https://app.test/api/auth/callback",
};

const NOW = new Date("2026-08-24T12:00:00.000Z");

function client(answer: { status?: number; body?: string } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    });
    return Promise.resolve(
      new Response(
        answer.body ??
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
        { status: answer.status ?? 200 },
      ),
    );
  }) as unknown as typeof fetch;

  return { calls, client: new QuickBooksOAuthClient({ fetchImpl }) };
}

describe("exchanging an authorization code", () => {
  it("posts the code and the redirect it was issued against", async () => {
    // Intuit checks the redirect against the one the authorize call carried. A
    // mismatch is refused, which is what stops a code being redeemed by
    // somebody who intercepted it and has their own redirect.
    const { client: oauth, calls } = client();
    await oauth.exchangeCode(CREDENTIALS, "the-code");

    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe(CREDENTIALS.redirectUri);
  });

  it("authenticates with the application's own credentials", async () => {
    const { client: oauth, calls } = client();
    await oauth.exchangeCode(CREDENTIALS, "the-code");

    const expected = Buffer.from("qb-client-id:qb-client-secret").toString("base64");
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${expected}`);
  });

  it("answers the pair and when the access token dies", async () => {
    const { client: oauth } = client();
    const tokens = await oauth.exchangeCode(CREDENTIALS, "the-code");
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports a spent or wrong code as something to start again", async () => {
    // Intuit answers 400 for a spent code and 401 for bad application
    // credentials. Both mean the same thing to a caller.
    for (const status of [400, 401]) {
      const { client: oauth } = client({ status, body: JSON.stringify({ error: "invalid_grant" }) });
      await expect(oauth.exchangeCode(CREDENTIALS, "spent")).rejects.toBeInstanceOf(
        QuickBooksAuthError,
      );
    }
  });

  it("does not repeat Intuit's body, which carries the code", async () => {
    const { client: oauth } = client({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant", code: "the-secret-code" }),
    });
    const message = await oauth
      .exchangeCode(CREDENTIALS, "the-secret-code")
      .then(() => "")
      .catch((e: unknown) => (e as Error).message);
    expect(message).not.toContain("the-secret-code");
  });

  it("reports any other failure with its status", async () => {
    const { client: oauth } = client({ status: 503, body: "gateway down" });
    await expect(oauth.exchangeCode(CREDENTIALS, "c")).rejects.toBeInstanceOf(
      QuickBooksRequestError,
    );
  });

  it("reports an answer that is not JSON", async () => {
    const { client: oauth } = client({ body: "<html>maintenance</html>" });
    await expect(oauth.exchangeCode(CREDENTIALS, "c")).rejects.toThrow(/not JSON/);
  });
});

describe("refreshing", () => {
  it("posts the refresh token under its own grant", async () => {
    const { client: oauth, calls } = client();
    await oauth.refresh(CREDENTIALS, "the-refresh-token");

    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("the-refresh-token");
    // No redirect: there is no browser in a refresh.
    expect(body.get("redirect_uri")).toBeNull();
  });

  it("answers a fresh pair", async () => {
    const { client: oauth } = client({
      body: JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    });
    expect(await oauth.refresh(CREDENTIALS, "old")).toMatchObject({
      accessToken: "new-at",
      refreshToken: "new-rt",
    });
  });
});

describe("reading Intuit's token answer", () => {
  it("takes the pair and the expiry it stated", () => {
    const tokens = toTokens(
      { access_token: "at", refresh_token: "rt", expires_in: 1800 },
      NOW,
    );
    expect(tokens.expiresAt.toISOString()).toBe("2026-08-24T12:30:00.000Z");
  });

  it("assumes an hour when Intuit does not say", () => {
    // Assuming longer would let a dead token sit in the database looking live,
    // and every read through it fails with a 401 that reads as "reconnect
    // QuickBooks" when nothing was wrong with the connection.
    for (const expires_in of [undefined, 0, -1, "soon", Number.NaN]) {
      const tokens = toTokens({ access_token: "at", refresh_token: "rt", expires_in }, NOW);
      expect(tokens.expiresAt.toISOString()).toBe("2026-08-24T13:00:00.000Z");
    }
  });

  it("refuses a pair with no refresh token", () => {
    // Stored, it would work for an hour and then be unrenewable — and the
    // failure would arrive an hour later, in a different request, looking like
    // something else entirely.
    expect(() => toTokens({ access_token: "at" }, NOW)).toThrow(QuickBooksAuthError);
    expect(() => toTokens({ refresh_token: "rt" }, NOW)).toThrow(QuickBooksAuthError);
    expect(() => toTokens({}, NOW)).toThrow(QuickBooksAuthError);
  });
});
