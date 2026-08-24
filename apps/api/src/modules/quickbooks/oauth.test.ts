import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { QuickBooksAuthError, type QueryEntityInput, type ReportFetcher } from "./reports/client.js";
import type { OAuthCredentials, OAuthTokenExchange, OAuthTokens } from "./oauth-client.js";
import { signOAuthState } from "./oauth-state.js";
import { QuickBooksOAuthService, RealmAlreadyLinkedError } from "./oauth.js";
import { InMemoryQuickBooksRepository } from "./repository.memory.js";

/**
 * Connecting a company to its QuickBooks.
 *
 * The property under test throughout is which company a realm ends up
 * attached to. The callback cannot be authenticated — Intuit redirects a
 * browser to it with no session — so that decision rests entirely on the
 * signed state, and the tests that matter here are the ones where somebody
 * tries to decide it some other way.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();
const SECRET = "an-application-secret-long-enough";
const REALM = "4620816365000000000";
const NOW = new Date("2026-08-24T12:00:00.000Z");

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const CONFIG = {
  clientId: "qb-client-id",
  clientSecret: "qb-client-secret",
  redirectUri: "https://app.test/api/auth/callback",
  secret: SECRET,
  environment: "production",
};

function exchange(over: { tokens?: Partial<OAuthTokens>; fail?: Error } = {}) {
  const calls: Array<{ kind: string; value: string }> = [];
  const tokens: OAuthTokens = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    ...over.tokens,
  };
  const impl: OAuthTokenExchange = {
    exchangeCode: (_c: OAuthCredentials, code: string) => {
      calls.push({ kind: "exchange", value: code });
      return over.fail ? Promise.reject(over.fail) : Promise.resolve(tokens);
    },
    refresh: (_c: OAuthCredentials, token: string) => {
      calls.push({ kind: "refresh", value: token });
      return over.fail ? Promise.reject(over.fail) : Promise.resolve(tokens);
    },
  };
  return { impl, calls, tokens };
}

function fetcher(name: string | null = "Acme Books", fail = false): ReportFetcher {
  return {
    fetchReport: () => Promise.reject(new Error("not used")),
    queryEntity: (_input: QueryEntityInput) =>
      fail
        ? Promise.reject(new Error("Intuit is down"))
        : Promise.resolve({
            payload: {
              QueryResponse: name === null ? {} : { CompanyInfo: [{ CompanyName: name }] },
            },
            params: {},
          }),
  } as unknown as ReportFetcher;
}

function build(
  over: {
    config?: Partial<typeof CONFIG>;
    exchange?: ReturnType<typeof exchange>;
    fetcher?: ReportFetcher;
  } = {},
) {
  const connections = new InMemoryQuickBooksRepository();
  const ex = over.exchange ?? exchange();
  return {
    connections,
    exchange: ex,
    service: new QuickBooksOAuthService({
      connections,
      exchange: ex.impl,
      fetcher: over.fetcher ?? fetcher(),
      config: { ...CONFIG, ...over.config },
    }),
  };
}

const connect = (connections: InMemoryQuickBooksRepository, companyId: string, realmId = REALM) =>
  connections.save({
    companyId,
    realmId,
    realmCompanyName: "Existing Books",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    environment: "production",
    oauthClientId: "qb-client-id",
    redirectUri: CONFIG.redirectUri,
    connectedBy: USER.id,
  });

describe("starting an authorization", () => {
  it("decides the company here, while there is a session to check it against", () => {
    // Deciding it at the callback means deciding it from a query parameter
    // with no session at all, which is what the version this replaces did.
    const { service } = build();
    const { authorizeUrl } = service.startAuthorization(USER, COMPANY, {}, NOW);
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state).toContain(".");
  });

  it("refuses a company the caller cannot reach", () => {
    const { service } = build();
    expect(() => service.startAuthorization(USER, OTHER, {}, NOW)).toThrow(ForbiddenError);
  });

  it("refuses a request naming no company", () => {
    const { service } = build();
    expect(() => service.startAuthorization(USER, "", {}, NOW)).toThrow(BadRequestError);
  });

  it("sends the browser back to the connections page by default", async () => {
    const { service } = build();
    const url = service.startAuthorization(USER, COMPANY, {}, NOW).authorizeUrl;
    const state = new URL(url).searchParams.get("state")!;
    const done = await service.completeCallback({ code: "c", realmId: REALM, state }, NOW);
    expect(done.redirect).toBe(`/broker/client/${COMPANY}/dataroom/connections`);
  });

  it("refuses to send it anywhere off the site", async () => {
    const { service } = build();
    const url = service.startAuthorization(
      USER,
      COMPANY,
      { redirect: "https://elsewhere.test" },
      NOW,
    ).authorizeUrl;
    const state = new URL(url).searchParams.get("state")!;
    const done = await service.completeCallback({ code: "c", realmId: REALM, state }, NOW);
    expect(done.redirect).toBe("/broker/companies");
  });

  it("says so when this server has no OAuth credentials", () => {
    // A 503 naming the variables, not a redirect to Intuit with an empty
    // client id — which Intuit answers with its own error page and no way back.
    const { service } = build({ config: { clientId: "" } });
    expect(() => service.startAuthorization(USER, COMPANY, {}, NOW)).toThrow(
      /not configured/i,
    );
  });
});

describe("finishing one", () => {
  const started = (service: QuickBooksOAuthService, companyId = COMPANY) =>
    new URL(service.startAuthorization(USER, companyId, {}, NOW).authorizeUrl).searchParams.get(
      "state",
    )!;

  it("exchanges the code and stores a sealed connection", async () => {
    const { service, connections, exchange: ex } = build();
    const state = started(service);
    const done = await service.completeCallback({ code: "the-code", realmId: REALM, state }, NOW);

    expect(done).toMatchObject({ companyId: COMPANY, realmId: REALM, realmCompanyName: "Acme Books" });
    expect(ex.calls).toEqual([{ kind: "exchange", value: "the-code" }]);
    expect(await connections.tokens(COMPANY)).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("records who started it, from the state rather than the request", async () => {
    // The callback has no session. Taking the user from the URL — as legacy
    // did — means the connection is attributed to whoever the URL says.
    const { service, connections } = build();
    await service.completeCallback({ code: "c", realmId: REALM, state: started(service) }, NOW);
    expect((await connections.get(COMPANY))?.connectedBy).toBe(USER.id);
  });

  it("refuses a state it did not sign", async () => {
    const { service, connections, exchange: ex } = build();
    const forged = signOAuthState(
      { redirect: "/", companyId: OTHER, userId: "somebody" },
      "a-different-secret",
      NOW,
    );

    await expect(
      service.completeCallback({ code: "c", realmId: REALM, state: forged }, NOW),
    ).rejects.toBeInstanceOf(BadRequestError);
    // Nothing exchanged and nothing stored: the refusal happens first.
    expect(ex.calls).toEqual([]);
    expect(await connections.get(OTHER)).toBeNull();
  });

  it("refuses a state that has expired", async () => {
    const { service } = build();
    const state = started(service);
    const muchLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    await expect(
      service.completeCallback({ code: "c", realmId: REALM, state }, muchLater),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("refuses a callback with no code or no realm", async () => {
    const { service } = build();
    for (const input of [
      { code: "", realmId: REALM },
      { code: "c", realmId: "" },
    ]) {
      await expect(
        service.completeCallback({ ...input, state: started(service) }, NOW),
      ).rejects.toThrow(/usable authorization/i);
    }
  });

  it("refuses a signed state that names no company", async () => {
    const { service } = build();
    const state = signOAuthState(
      { redirect: "/", companyId: null, userId: USER.id },
      SECRET,
      NOW,
    );
    await expect(
      service.completeCallback({ code: "c", realmId: REALM, state }, NOW),
    ).rejects.toThrow(/did not name a company/i);
  });

  it("stores the connection with no name rather than losing the tokens", async () => {
    // A connection with no realm name is usable; one that failed to store
    // because the name lookup failed is not.
    const { service, connections } = build({ fetcher: fetcher(null, true) });
    await service.completeCallback({ code: "c", realmId: REALM, state: started(service) }, NOW);
    expect((await connections.get(COMPANY))?.realmCompanyName).toBeNull();
  });

  it("passes an authorization Intuit refused straight back", async () => {
    const { service } = build({
      exchange: exchange({ fail: new QuickBooksAuthError("refused") }),
    });
    await expect(
      service.completeCallback({ code: "spent", realmId: REALM, state: started(service) }, NOW),
    ).rejects.toBeInstanceOf(QuickBooksAuthError);
  });
});

describe("a realm already attached somewhere else", () => {
  const started = (service: QuickBooksOAuthService) =>
    new URL(service.startAuthorization(USER, COMPANY, {}, NOW).authorizeUrl).searchParams.get(
      "state",
    )!;

  it("is refused rather than quietly attached twice", async () => {
    // Two companies reading one realm is two clients' figures coming from one
    // set of books, and nothing on either page says so.
    const { service, connections } = build();
    await connect(connections, OTHER);

    const error = await service
      .completeCallback({ code: "c", realmId: REALM, state: started(service) }, NOW)
      .then(() => null)
      .catch((e: unknown) => e as RealmAlreadyLinkedError);

    expect(error).toBeInstanceOf(RealmAlreadyLinkedError);
    expect(error?.linkedCompanyId).toBe(OTHER);
    expect(error?.status).toBe(409);
  });

  it("moves once the transfer is confirmed", async () => {
    const { service, connections } = build();
    await connect(connections, OTHER);

    await service.completeCallback(
      { code: "c", realmId: REALM, state: started(service), confirmTransfer: true },
      NOW,
    );

    expect((await connections.get(OTHER))?.isConnected).toBe(false);
    expect((await connections.get(COMPANY))?.isConnected).toBe(true);
  });

  it("reconnecting the same company is not a transfer", async () => {
    const { service, connections } = build();
    await connect(connections, COMPANY);
    await expect(
      service.completeCallback({ code: "c", realmId: REALM, state: started(service) }, NOW),
    ).resolves.toMatchObject({ companyId: COMPANY });
  });
});

describe("refreshing a connection", () => {
  it("rotates the refresh token as well as the access token", async () => {
    // Intuit issues a new refresh token on every refresh. Storing only the
    // access token leaves the old one in place, which works until Intuit
    // expires it — and then the connection dies with no way to renew it.
    const { service, connections } = build({
      exchange: exchange({
        tokens: { accessToken: "new-access", refreshToken: "new-refresh" },
      }),
    });
    await connect(connections, COMPANY);

    await service.refresh(USER, COMPANY);
    expect(await connections.tokens(COMPANY)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });

  it("keeps the realm and its name", async () => {
    const { service, connections } = build();
    await connect(connections, COMPANY);
    await service.refresh(USER, COMPANY);

    expect(await connections.get(COMPANY)).toMatchObject({
      realmId: REALM,
      realmCompanyName: "Existing Books",
    });
  });

  it("404s a company that is not connected", async () => {
    const { service } = build();
    await expect(service.refresh(USER, COMPANY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a connection whose refresh token cannot be read", async () => {
    // A sealed column that will not open reads as no token, and the fix is to
    // reconnect rather than to retry.
    const { service, connections } = build();
    await connections.save({
      companyId: COMPANY,
      realmId: REALM,
      realmCompanyName: null,
      accessToken: "a",
      refreshToken: null,
      tokenExpiresAt: null,
      environment: "production",
      oauthClientId: null,
      redirectUri: null,
      connectedBy: null,
    });
    await expect(service.refresh(USER, COMPANY)).rejects.toThrow(/no refresh token/i);
  });

  it("refuses a company the caller cannot reach, and one named nowhere", async () => {
    const { service } = build();
    await expect(service.refresh(USER, OTHER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.refresh(USER, "")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("says so when this server has no OAuth credentials", async () => {
    const { service } = build({ config: { clientSecret: "" } });
    await expect(service.refresh(USER, COMPANY)).rejects.toBeInstanceOf(HttpError);
  });
});

describe("transferring a realm", () => {
  const bothCompanies: SessionUser = { ...USER, company_ids: [COMPANY, OTHER] };

  it("disconnects it from where it was", async () => {
    // Disconnect rather than repoint: the tokens belong to the old connection,
    // and clearing them is what stops the old company reading books it no
    // longer owns.
    const { service, connections } = build();
    await connect(connections, OTHER);

    expect(await service.transfer(bothCompanies, COMPANY, REALM)).toEqual({ movedFrom: OTHER });
    expect((await connections.get(OTHER))?.isConnected).toBe(false);
    expect(await connections.tokens(OTHER)).toMatchObject({ accessToken: null });
  });

  it("is a no-op when it is already this company's", async () => {
    const { service, connections } = build();
    await connect(connections, COMPANY);
    expect(await service.transfer(USER, COMPANY, REALM)).toEqual({ movedFrom: null });
    expect((await connections.get(COMPANY))?.isConnected).toBe(true);
  });

  it("refuses when the caller cannot reach the company it is moving FROM", async () => {
    // Requiring only the destination would let somebody move a realm away from
    // a client they have no business touching.
    const { service, connections } = build();
    await connect(connections, OTHER);
    await expect(service.transfer(USER, COMPANY, REALM)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await connections.get(OTHER))?.isConnected).toBe(true);
  });

  it("refuses when the caller cannot reach the destination", async () => {
    const { service } = build();
    await expect(service.transfer(USER, OTHER, REALM)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s a realm nothing is connected to", async () => {
    const { service } = build();
    await expect(service.transfer(USER, COMPANY, REALM)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a request naming no company or no realm", async () => {
    const { service } = build();
    await expect(service.transfer(USER, "", REALM)).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.transfer(USER, COMPANY, "")).rejects.toBeInstanceOf(BadRequestError);
  });
});
