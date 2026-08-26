import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { QuickBooksRepository, SaveConnectionInput } from "./ports.js";
import { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
import { InMemoryQuickBooksRepository } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * The in-memory repository exists so tests elsewhere need no database. That
 * only holds while it behaves like the real one, and a fake drifts silently:
 * the tests that use it keep passing while the thing they stand in for has
 * changed underneath them. Running the same assertions against both is the
 * only way that drift shows up as a failure rather than as a surprise in
 * production.
 *
 * The deliberate differences are stated where they arise: the fake holds
 * tokens as given rather than sealing them, and its clock is fixed.
 */

const SECRET = "a-test-secret-that-is-long-enough";
const ACCESS = "access-token-value";
const REFRESH = "refresh-token-value";

interface Store {
  repo: QuickBooksRepository;
  companyId: string;
  otherCompanyId: string;
  close(): Promise<void>;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "" },
    { id: otherCompanyId, name: "Beta", industry: "" },
  ]);

  return {
    repo: new DrizzleQuickBooksRepository(db, SECRET),
    companyId,
    otherCompanyId,
    close: () => client.close(),
  };
}

function memoryStore(): Promise<Store> {
  return Promise.resolve({
    repo: new InMemoryQuickBooksRepository(),
    companyId: randomUUID(),
    otherCompanyId: randomUUID(),
    close: () => Promise.resolve(),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("a QuickBooks connection (%s)", (_name, open) => {
  const input = (companyId: string, over: Partial<SaveConnectionInput> = {}) => ({
    companyId,
    realmId: "4620816365000000000",
    realmCompanyName: "Acme Books",
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    environment: "production",
    oauthClientId: "client-id",
    redirectUri: "https://example.test/callback",
    connectedBy: null,
    ...over,
  });

  it("has nothing to report for a company that never connected", async () => {
    const { repo, companyId } = await open();
    expect(await repo.get(companyId)).toBeNull();
    expect(await repo.tokens(companyId)).toBeNull();
    expect(await repo.getByRealm("4620816365000000000")).toBeNull();
  });

  it("records a connection and answers with it", async () => {
    const { repo, companyId } = await open();
    const saved = await repo.save(input(companyId));

    expect(saved).toMatchObject({
      companyId,
      realmId: "4620816365000000000",
      realmCompanyName: "Acme Books",
      environment: "production",
      isConnected: true,
      disconnectedAt: null,
      lastSyncedAt: null,
      tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(saved.connectedAt).toBeTruthy();
    expect(await repo.get(companyId)).toEqual(saved);
  });

  it("never hands a token back with the record", async () => {
    // `ConnectionRecord` has no token field, so there is nowhere for one to go
    // even by accident — but a store that added one would still be handing it
    // to every caller that reads a connection's state.
    const { repo, companyId } = await open();
    const saved = await repo.save(input(companyId));
    expect(Object.keys(saved).sort()).toEqual([
      "companyId",
      "connectedAt",
      "connectedBy",
      "disconnectedAt",
      "environment",
      "id",
      "isConnected",
      "lastSyncedAt",
      "realmCompanyName",
      "realmId",
      "tokenExpiresAt",
    ]);
    expect(JSON.stringify(saved)).not.toContain(ACCESS);
    expect(JSON.stringify(saved)).not.toContain(REFRESH);
  });

  it("gives the tokens to the one caller that asks for them", async () => {
    const { repo, companyId } = await open();
    await repo.save(input(companyId));
    expect(await repo.tokens(companyId)).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("keeps one connection per company, however often it is saved", async () => {
    // Every read asks for "the" connection. Two rows would make that question
    // meaningless.
    const { repo, companyId } = await open();
    const first = await repo.save(input(companyId));
    const second = await repo.save(input(companyId, { realmCompanyName: "Acme Renamed" }));

    expect(second.id).toBe(first.id);
    expect((await repo.get(companyId))?.realmCompanyName).toBe("Acme Renamed");
  });

  it("finds a live connection by its realm", async () => {
    const { repo, companyId } = await open();
    await repo.save(input(companyId));
    expect((await repo.getByRealm("4620816365000000000"))?.companyId).toBe(companyId);
    expect(await repo.getByRealm("some-other-realm")).toBeNull();
  });

  it("stops finding a realm once it is disconnected", async () => {
    // A realm may legitimately be reconnected to a DIFFERENT company after a
    // disconnect, so a stale row must not answer for it.
    const { repo, companyId } = await open();
    await repo.save(input(companyId));
    await repo.disconnect(companyId);
    expect(await repo.getByRealm("4620816365000000000")).toBeNull();
  });

  it("lets a realm move to another company after a disconnect", async () => {
    const { repo, companyId, otherCompanyId } = await open();
    await repo.save(input(companyId));
    await repo.disconnect(companyId);
    await repo.save(input(otherCompanyId));

    expect((await repo.getByRealm("4620816365000000000"))?.companyId).toBe(otherCompanyId);
    expect((await repo.get(companyId))?.isConnected).toBe(false);
  });

  it("clears the tokens on disconnect, not just the flag", async () => {
    // A disconnected connection holding a live refresh token is a credential
    // nobody is watching any more, and reconnecting issues new ones anyway.
    const { repo, companyId } = await open();
    await repo.save(input(companyId));
    expect(await repo.disconnect(companyId)).toBe(true);

    const record = await repo.get(companyId);
    expect(record?.isConnected).toBe(false);
    expect(record?.disconnectedAt).toBeTruthy();
    expect(record?.tokenExpiresAt).toBeNull();
    expect(await repo.tokens(companyId)).toEqual({
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
    });
  });

  it("reports nothing to disconnect twice over", async () => {
    const { repo, companyId } = await open();
    expect(await repo.disconnect(companyId)).toBe(false);
    await repo.save(input(companyId));
    expect(await repo.disconnect(companyId)).toBe(true);
    expect(await repo.disconnect(companyId)).toBe(false);
  });

  it("clears the disconnect when the company reconnects", async () => {
    // Otherwise a reconnected company keeps reading as one that was
    // disconnected at some point in the past.
    const { repo, companyId } = await open();
    await repo.save(input(companyId));
    await repo.disconnect(companyId);
    const again = await repo.save(input(companyId));

    expect(again.isConnected).toBe(true);
    expect(again.disconnectedAt).toBeNull();
    expect(await repo.tokens(companyId)).toMatchObject({ accessToken: ACCESS });
  });

  it("records when a sync last ran, and keeps it across a reconnect", async () => {
    // The page shows "last synced" against a connection. Reconnecting does not
    // undo the sync that already happened.
    const { repo, companyId } = await open();
    await repo.save(input(companyId));
    await repo.recordSync(companyId, new Date("2026-03-04T05:06:07.000Z"));
    expect((await repo.get(companyId))?.lastSyncedAt).toBe("2026-03-04T05:06:07.000Z");

    await repo.save(input(companyId));
    expect((await repo.get(companyId))?.lastSyncedAt).toBe("2026-03-04T05:06:07.000Z");
  });

  it("shrugs off a sync recorded against a company with no connection", async () => {
    const { repo, companyId } = await open();
    await expect(repo.recordSync(companyId, new Date())).resolves.toBeUndefined();
  });

  it("saves a connection with no tokens at all", async () => {
    // The OAuth callback records the realm before it has exchanged the code.
    const { repo, companyId } = await open();
    await repo.save(
      input(companyId, { accessToken: null, refreshToken: null, tokenExpiresAt: null }),
    );
    expect(await repo.tokens(companyId)).toEqual({
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
    });
  });

  it("keeps one company's connection out of another's", async () => {
    const { repo, companyId, otherCompanyId } = await open();
    await repo.save(input(companyId));
    expect(await repo.get(otherCompanyId)).toBeNull();
    expect(await repo.tokens(otherCompanyId)).toBeNull();
  });
});
