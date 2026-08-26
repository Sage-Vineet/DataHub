import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { InMemoryQuickBooksRepository } from "./repository.memory.js";
import { QuickBooksService } from "./service.js";

/**
 * The connection's state, as the Connections page reads it.
 *
 * Over the in-memory store, which `repository.contract.test.ts` holds to the
 * same behaviour as the real one — so what passes here would pass over
 * Postgres.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const NOW = new Date("2026-06-01T00:00:00.000Z");

function build() {
  const repo = new InMemoryQuickBooksRepository();
  return { repo, service: new QuickBooksService({ repo }) };
}

const connect = (repo: InMemoryQuickBooksRepository, over: Record<string, unknown> = {}) =>
  repo.save({
    companyId: COMPANY,
    realmId: "4620816365000000000",
    realmCompanyName: "Acme Books",
    accessToken: "access",
    refreshToken: "refresh",
    tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    environment: "production",
    oauthClientId: "client-id",
    redirectUri: "https://example.test/callback",
    connectedBy: USER.id,
    ...over,
  });

describe("reading the state", () => {
  it("answers for a company that never connected", async () => {
    const { service } = build();
    expect(await service.status(USER, COMPANY, NOW)).toEqual({
      connected: false,
      realmId: null,
      realmCompanyName: null,
      environment: null,
      connectedAt: null,
      lastSyncedAt: null,
      tokenExpired: false,
    });
  });

  it("reports the realm and the dates", async () => {
    const { service, repo } = build();
    await connect(repo);
    expect(await service.status(USER, COMPANY, NOW)).toMatchObject({
      connected: true,
      realmCompanyName: "Acme Books",
      environment: "production",
      tokenExpired: false,
    });
  });

  it("says when the token has passed its expiry", async () => {
    const { service, repo } = build();
    await connect(repo, { tokenExpiresAt: new Date("2026-01-01T00:00:00.000Z") });
    expect((await service.status(USER, COMPANY, NOW)).tokenExpired).toBe(true);
  });

  it("does not call a disconnected connection's token expired", async () => {
    // It has no token. Reporting it as expired would suggest refreshing it,
    // and the fix is to connect again.
    const { service, repo } = build();
    await connect(repo, { tokenExpiresAt: new Date("2026-01-01T00:00:00.000Z") });
    await service.disconnect(USER, COMPANY);
    expect((await service.status(USER, COMPANY, NOW)).tokenExpired).toBe(false);
  });

  it("keeps the realm after a disconnect", async () => {
    // So "you were connected to Acme Books until March" is still answerable.
    const { service, repo } = build();
    await connect(repo);
    const after = await service.disconnect(USER, COMPANY);
    expect(after).toMatchObject({ connected: false, realmCompanyName: "Acme Books" });
  });
});

describe("the connection record", () => {
  it("hands back the realm for a caller that needs it", async () => {
    const { service, repo } = build();
    await connect(repo);
    expect((await service.get(USER, COMPANY))?.realmId).toBe("4620816365000000000");
  });

  it("is null for a company that never connected", async () => {
    const { service } = build();
    expect(await service.get(USER, COMPANY)).toBeNull();
  });

  it("checks the company before reading it", async () => {
    const { service } = build();
    await expect(service.get(USER, OTHER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("recording a sync", () => {
  it("stamps the connection", async () => {
    const { service, repo } = build();
    await connect(repo);
    await service.recordSync(USER, COMPANY, new Date("2026-03-04T05:06:07.000Z"));
    expect((await service.status(USER, COMPANY, NOW)).lastSyncedAt).toBe(
      "2026-03-04T05:06:07.000Z",
    );
  });

  it("defaults to now", async () => {
    const { service, repo } = build();
    await connect(repo);
    await service.recordSync(USER, COMPANY);
    expect((await service.status(USER, COMPANY, NOW)).lastSyncedAt).toBeTruthy();
  });

  it("404s a company with no connection to stamp", async () => {
    // A sync that recorded itself against nothing would leave the page saying
    // a company had synced when it has never been connected.
    const { service } = build();
    await expect(service.recordSync(USER, COMPANY, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("checks the company", async () => {
    const { service } = build();
    await expect(service.recordSync(USER, OTHER, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("disconnecting", () => {
  it("is not an error the second time", async () => {
    // The button is the same whether or not the connection is already gone.
    const { service, repo } = build();
    await connect(repo);
    await service.disconnect(USER, COMPANY);
    expect(await service.disconnect(USER, COMPANY)).toMatchObject({ connected: false });
  });

  it("404s a company that was never connected", async () => {
    const { service } = build();
    await expect(service.disconnect(USER, COMPANY)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("naming a company", () => {
  it("refuses a request naming none", async () => {
    const { service } = build();
    await expect(service.status(USER, "", NOW)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("refuses one the caller cannot reach", async () => {
    const { service } = build();
    await expect(service.status(USER, OTHER, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
