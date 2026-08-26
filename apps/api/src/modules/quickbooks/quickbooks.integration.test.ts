import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { DrizzleQuickBooksRepository } from "./repository.drizzle.js";
import { createQuickBooksModule } from "./index.js";

/**
 * The QuickBooks connection against a real database.
 *
 * The assertion that matters most is the one about what is IN the table: a
 * refresh token is a standing key to a client's accounting system, and the
 * column must not contain it. That is only checkable against a real database,
 * by reading the raw column back and looking.
 */

const SECRET = "an-application-secret-for-tests";
const ACCESS = "AB11730000000accessTokenValue";
const REFRESH = "AB11730000000refreshTokenValue";

const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "B",
  email: "b@x.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
};

let client: PGlite;
let db: Db;
let app: express.Express;
let repo: DrizzleQuickBooksRepository;
let current: SessionUser;
let companyId: string;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  await db.insert(schema.users).values({
    id: BROKER.id,
    name: BROKER.name,
    email: `${BROKER.id}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  current = { ...BROKER, company_ids: [companyId] };

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createQuickBooksModule({ db, requireAuth, secret: SECRET }).router);
  repo = new DrizzleQuickBooksRepository(db, SECRET);
});

afterEach(async () => {
  await client.close();
});

const connect = (over: Record<string, unknown> = {}) =>
  repo.save({
    companyId,
    realmId: "4620816365000000000",
    realmCompanyName: "Acme Books",
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    environment: "production",
    oauthClientId: "client-id",
    redirectUri: "https://example.test/callback",
    connectedBy: BROKER.id,
    ...over,
  });

const rawRow = async () => {
  const [row] = await db
    .select()
    .from(schema.quickbooksConnections)
    .where(eq(schema.quickbooksConnections.companyId, companyId));
  return row!;
};

const status = () => request(app).get("/api/auth/status").set("X-Client-Id", companyId);

describe("what ends up in the table", () => {
  it("does not store the tokens", async () => {
    // The whole point of the migration. A dump that yields a refresh token is
    // ongoing access to the client's books.
    await connect();
    const row = await rawRow();

    expect(row.accessTokenSealed).not.toBe(ACCESS);
    expect(row.refreshTokenSealed).not.toBe(REFRESH);
    expect(row.accessTokenSealed).not.toContain(ACCESS);
    expect(row.refreshTokenSealed).not.toContain(REFRESH);
    expect(JSON.stringify(row)).not.toContain(REFRESH);
  });

  it("reads them back through the repository", async () => {
    await connect();
    const tokens = await repo.tokens(companyId);
    expect(tokens?.accessToken).toBe(ACCESS);
    expect(tokens?.refreshToken).toBe(REFRESH);
  });

  it("cannot read them with a different secret", async () => {
    await connect();
    const wrong = new DrizzleQuickBooksRepository(db, "a-different-secret");
    const tokens = await wrong.tokens(companyId);
    expect(tokens?.accessToken).toBeNull();
    expect(tokens?.refreshToken).toBeNull();
  });

  it("cannot open the access token as the refresh token", async () => {
    // Each is sealed under its own purpose label, so swapping the columns
    // yields nothing rather than the other token.
    await connect();
    const row = await rawRow();
    await db
      .update(schema.quickbooksConnections)
      .set({ refreshTokenSealed: row.accessTokenSealed })
      .where(eq(schema.quickbooksConnections.companyId, companyId));

    const tokens = await repo.tokens(companyId);
    expect(tokens?.refreshToken).toBeNull();
  });

  it("survives a column that holds a legacy plaintext token", async () => {
    // Rather than throwing and taking out the page that wanted to report it.
    await connect();
    await db
      .update(schema.quickbooksConnections)
      .set({ refreshTokenSealed: "a-legacy-plaintext-token" })
      .where(eq(schema.quickbooksConnections.companyId, companyId));

    const tokens = await repo.tokens(companyId);
    expect(tokens?.refreshToken).toBeNull();
    expect(tokens?.accessToken).toBe(ACCESS);
  });

  it("seals differently each time, so identical tokens do not look identical", async () => {
    await connect();
    const first = (await rawRow()).refreshTokenSealed;
    await connect();
    const second = (await rawRow()).refreshTokenSealed;
    expect(first).not.toBe(second);
  });
});

describe("connection state over HTTP", () => {
  it("reports a company that has never connected", async () => {
    const res = await status().expect(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.realmId).toBeNull();
    expect(res.body.tokenExpired).toBe(false);
  });

  it("reports a live connection with its realm", async () => {
    await connect();
    const res = await status().expect(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.realmId).toBe("4620816365000000000");
    expect(res.body.realmCompanyName).toBe("Acme Books");
    expect(res.body.environment).toBe("production");
  });

  it("flags an expired token while connected", async () => {
    await connect({ tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z") });
    const res = await status().expect(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.tokenExpired).toBe(true);
  });

  it("does not put a token on the wire, whatever the state", async () => {
    await connect();
    const res = await status().expect(200);
    expect(JSON.stringify(res.body)).not.toContain(ACCESS);
    expect(JSON.stringify(res.body)).not.toContain(REFRESH);
  });
});

describe("disconnecting", () => {
  it("clears the tokens, not just the flag", async () => {
    // A disconnected connection holding a live refresh token is a credential
    // nobody is watching any more.
    await connect();
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(200);

    const row = await rawRow();
    expect(row.isConnected).toBe(false);
    expect(row.accessTokenSealed).toBeNull();
    expect(row.refreshTokenSealed).toBeNull();
    expect(row.tokenExpiresAt).toBeNull();
  });

  it("keeps the history of having been connected", async () => {
    await connect();
    const res = await request(app)
      .get("/api/auth/disconnect")
      .set("X-Client-Id", companyId)
      .expect(200);

    expect(res.body.connected).toBe(false);
    // "You were connected to Acme Books until March" is still answerable.
    expect(res.body.realmId).toBe("4620816365000000000");
    expect(res.body.realmCompanyName).toBe("Acme Books");
  });

  it("is idempotent — a second click is not an error", async () => {
    await connect();
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(200);
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(200);
  });

  it("404s a company that was never connected", async () => {
    // Different from "already disconnected", and worth saying.
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(404);
  });

  it("stops reporting an expired token once disconnected", async () => {
    // There is no token to refresh, so saying it expired would suggest there is.
    await connect({ tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z") });
    const res = await request(app)
      .get("/api/auth/disconnect")
      .set("X-Client-Id", companyId)
      .expect(200);
    expect(res.body.tokenExpired).toBe(false);
  });
});

describe("reconnecting", () => {
  it("replaces rather than leaving two connections", async () => {
    await connect();
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(200);
    await connect({ realmId: "9999999999999999999", realmCompanyName: "Acme Books II" });

    const rows = await db.select().from(schema.quickbooksConnections);
    expect(rows).toHaveLength(1);

    const res = await status().expect(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.realmId).toBe("9999999999999999999");
  });

  it("clears the old disconnect stamp", async () => {
    // Otherwise a reconnected company keeps reading as one disconnected in the
    // past, and the page shows both states at once.
    await connect();
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(200);
    await connect();
    expect((await rawRow()).disconnectedAt).toBeNull();
  });

  it("finds a live connection by realm, and stops once disconnected", async () => {
    // The OAuth callback arrives knowing only the realm.
    await connect();
    expect(await repo.getByRealm("4620816365000000000")).not.toBeNull();

    await repo.disconnect(companyId);
    expect(await repo.getByRealm("4620816365000000000")).toBeNull();
  });

  it("lets a realm be reconnected to a different company after a disconnect", async () => {
    // The unique index over realms is partial for exactly this.
    await connect();
    await repo.disconnect(companyId);

    const other = randomUUID();
    await db.insert(schema.companies).values({ id: other, name: "Other", industry: "" });
    await repo.save({
      companyId: other,
      realmId: "4620816365000000000",
      realmCompanyName: "Acme Books",
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenExpiresAt: null,
      environment: "production",
      oauthClientId: null,
      redirectUri: null,
      connectedBy: BROKER.id,
    });

    expect((await repo.getByRealm("4620816365000000000"))?.companyId).toBe(other);
  });
});

describe("access", () => {
  it("403s a company the caller cannot reach", async () => {
    await connect();
    current = { ...BROKER, company_ids: [] };
    await status().expect(403);
    await request(app).get("/api/auth/disconnect").set("X-Client-Id", companyId).expect(403);
  });

  it("400s a request naming no company", async () => {
    await request(app).get("/api/auth/status").expect(400);
  });
});
