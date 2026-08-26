// ADR-0007 spike — Better Auth over Drizzle + Postgres (PGlite), proving:
//   1. PARITY   — a user whose password is an EXISTING legacy bcrypt hash logs
//                 in unchanged (no forced reset), via a custom bcrypt verify.
//   2. SESSIONS — sign-in issues an httpOnly cookie AND a DB-backed session row
//                 (not a stateless JWT).
//   3. REVOCABLE (audit M1) — revoking the session invalidates it server-side;
//                 the next getSession returns null. This is the gap the bespoke
//                 module cannot close.
//   4. DRIZZLE  — all of the above run through @better-auth/drizzle-adapter on
//                 our own Postgres schema (no vendor identity store).
//
// Throwaway: PGlite in-memory, deleted on exit. NOT production code.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { DDL, schema } from "./schema.mjs";

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A password + its bcrypt hash, standing in for a row migrated from the legacy
// `users.password_hash` column (cost 10, same as legacy authService).
const EMAIL = "broker@example.com";
const PLAINTEXT = "S3cure-Legacy-Pass!";
const LEGACY_BCRYPT_HASH = bcrypt.hashSync(PLAINTEXT, 10);

async function main() {
  // --- Real Postgres engine (embedded) + Drizzle client with relational schema
  const client = new PGlite();
  await client.exec(DDL);
  const db = drizzle(client, { schema });

  // --- Better Auth on the Drizzle adapter, with bcrypt as the password verifier
  const auth = betterAuth({
    secret: "spike-only-secret-not-for-prod-xxxxxxxxxxxxxxxx",
    baseURL: "http://localhost:3000",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      // The crux of the migration: reuse existing bcrypt hashes verbatim.
      password: {
        hash: async (p) => bcrypt.hash(p, 10),
        verify: async ({ password, hash }) => bcrypt.compare(password, hash),
      },
    },
  });

  check("drizzle adapter wired (better-auth constructed)", typeof auth.api?.signInEmail === "function");

  // --- Seed a "migrated" user: user row + credential account holding the
  //     EXISTING legacy bcrypt hash (exactly what a backfill would insert).
  const userId = "usr_migrated_1";
  await db.insert(schema.user).values({
    id: userId,
    name: "Test Broker",
    email: EMAIL,
    emailVerified: true,
  });
  await db.insert(schema.account).values({
    id: "acc_migrated_1",
    accountId: userId,
    providerId: "credential",
    userId,
    password: LEGACY_BCRYPT_HASH, // <-- untouched legacy hash
  });

  // --- 1 + 2: sign in with the ORIGINAL plaintext; expect a Set-Cookie session.
  const signInRes = await auth.api.signInEmail({
    body: { email: EMAIL, password: PLAINTEXT },
    asResponse: true,
  });
  check("login with existing bcrypt hash succeeds (PARITY)", signInRes.status === 200,
    `status ${signInRes.status}`);

  const setCookie = signInRes.headers.get("set-cookie") || "";
  check("session delivered as httpOnly cookie (M2/M3)",
    /better-auth\.session_token=/.test(setCookie) && /HttpOnly/i.test(setCookie),
    setCookie.split(";")[0]);

  // Reconstruct a Cookie header from the Set-Cookie for subsequent calls.
  const cookie = setCookie.split(";")[0];
  const authedHeaders = new Headers({ cookie });

  // --- Wrong password must be rejected.
  const badRes = await auth.api.signInEmail({
    body: { email: EMAIL, password: "wrong-password" },
    asResponse: true,
  }).catch((e) => ({ status: e?.status || e?.statusCode || 401 }));
  check("wrong password rejected", badRes.status === 401 || badRes.status === 403,
    `status ${badRes.status}`);

  // --- 2 (persistence): the session is a real row in OUR Postgres.
  const sessionRows = await db.select().from(schema.session);
  check("session persisted in Postgres (DB-backed, not stateless JWT)",
    sessionRows.length === 1, `${sessionRows.length} row(s)`);

  // --- getSession via the cookie resolves the user.
  const live = await auth.api.getSession({ headers: authedHeaders });
  check("getSession resolves the live session", live?.user?.email === EMAIL,
    live?.user?.email ?? "null");

  // --- 3: REVOCATION (audit M1). Revoke, then prove it is dead server-side.
  const sessionToken = sessionRows[0].token;
  await auth.api.revokeSession({ body: { token: sessionToken }, headers: authedHeaders });

  const afterRevoke = await auth.api.getSession({ headers: authedHeaders });
  const rowsAfter = await db.select().from(schema.session);
  check("revoked session is invalid server-side (M1 CLOSED)",
    afterRevoke === null || afterRevoke?.user == null,
    `getSession -> ${afterRevoke?.user?.email ?? "null"}`);
  check("revoked session removed from Postgres", rowsAfter.length === 0,
    `${rowsAfter.length} row(s)`);

  await client.close();

  // --- Summary
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
  console.log("SPIKE RESULT: Better Auth on Drizzle+Postgres closes M1/M2/M3 with bcrypt parity.");
}

main().catch((err) => {
  console.error("SPIKE ERROR:", err);
  process.exit(1);
});
