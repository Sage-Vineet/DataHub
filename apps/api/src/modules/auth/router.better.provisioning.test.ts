import request from "supertest";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@datahub/db";
import { makeHarness, type Harness } from "./better-test-harness.js";

/**
 * What happens around a login, rather than the login itself.
 *
 * A client signing in for the first time is matched to their company by contact
 * email and given the default folders — the whole reason they can see anything.
 * That path only runs for a buyer, so a suite that signs in as a broker never
 * touches it.
 *
 * The rest here is the failure side of the same surface: a reset that is not
 * enumeration-safe tells a stranger which addresses have accounts, and a logout
 * that throws leaves the client believing it still has a session.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUYER = "11111111-1111-4111-8111-111111111111";
const BROKER = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "correct1horse";

let h: Harness;

afterEach(async () => {
  await h.close();
});

describe("a client's first sign-in", () => {
  beforeEach(async () => {
    h = await makeHarness({
      companies: [{ id: COMPANY, name: "Acme", contactEmail: "client@example.test" }],
      users: [
        { id: BUYER, email: "client@example.test", password: PASSWORD, role: "buyer", companyId: null },
      ],
    });
  });

  it("matches them to their company by contact email and links them", async () => {
    // Their `users.company_id` is null until they log in; the company is found
    // by its contact address. Without this they authenticate into an empty app.
    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "client@example.test", password: PASSWORD })
      .expect(200);

    expect(res.body.user.company_ids).toContain(COMPANY);

    const [row] = await h.db.select().from(schema.users).where(eq(schema.users.id, BUYER));
    expect(row!.companyId).toBe(COMPANY);
  });

  it("provisions the company's default folders once", async () => {
    await request(h.app)
      .post("/auth/login")
      .send({ email: "client@example.test", password: PASSWORD })
      .expect(200);
    const afterFirst = await h.db
      .select()
      .from(schema.folders)
      .where(eq(schema.folders.companyId, COMPANY));
    expect(afterFirst.length).toBeGreaterThan(0);

    await request(h.app)
      .post("/auth/login")
      .send({ email: "client@example.test", password: PASSWORD })
      .expect(200);
    const afterSecond = await h.db
      .select()
      .from(schema.folders)
      .where(eq(schema.folders.companyId, COMPANY));

    // A second sign-in must not deal a second set.
    expect(afterSecond).toHaveLength(afterFirst.length);
  });
});

describe("a client whose email matches no company", () => {
  beforeEach(async () => {
    h = await makeHarness({
      users: [
        { id: BUYER, email: "orphan@example.test", password: PASSWORD, role: "buyer", companyId: null },
      ],
    });
  });

  it("still signs in, with no companies", async () => {
    // Being unmatched is not a failed login — it is an account waiting to be
    // associated, and refusing it would look like a wrong password.
    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "orphan@example.test", password: PASSWORD })
      .expect(200);
    expect(res.body.user.company_ids).toEqual([]);
  });
});

describe("the failure side", () => {
  beforeEach(async () => {
    h = await makeHarness({
      users: [
        { id: BROKER, email: "broker@example.test", password: PASSWORD, role: "broker", companyId: null },
      ],
    });
  });

  it("answers a password reset identically whether or not the account exists", async () => {
    // Otherwise the endpoint enumerates accounts.
    const known = await request(h.app)
      .post("/auth/forgot-password")
      .send({ email: "broker@example.test" })
      .expect(200);
    const unknown = await request(h.app)
      .post("/auth/forgot-password")
      .send({ email: "nobody@example.test" })
      .expect(200);

    expect(known.body).toEqual(unknown.body);
  });

  it("400s a reset request that is not an email at all", async () => {
    await request(h.app).post("/auth/forgot-password").send({ email: "not-an-email" }).expect(400);
  });

  it("clears client state on logout even with no session to end", async () => {
    // A logout that failed would leave the client believing it is still signed
    // in, which is the worse half of the two outcomes.
    await request(h.app).post("/auth/logout").expect(204);
  });

  it("refuses a reset with the wrong code, and does not change the password", async () => {
    await request(h.app).post("/auth/forgot-password").send({ email: "broker@example.test" }).expect(200);

    const res = await request(h.app)
      .post("/auth/reset-password")
      .send({ email: "broker@example.test", otp: "000000", new_password: "different1horse" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The original password still works.
    await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.test", password: PASSWORD })
      .expect(200);
  });

  it("400s a reset whose new password is too weak to accept", async () => {
    await request(h.app)
      .post("/auth/reset-password")
      .send({ email: "broker@example.test", otp: "123456", new_password: "short" })
      .expect(400);
  });

  it("refuses a verification code that was never issued", async () => {
    const res = await request(h.app)
      .post("/auth/verify-verification-otp")
      .send({ email: "broker@example.test", otp: "123456" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.verificationToken).toBeUndefined();
  });

  it("401s a login with the wrong password, without saying which part was wrong", async () => {
    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.test", password: "wrong1password" })
      .expect(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });

  it("401s a login for an address with no account, identically", async () => {
    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "nobody@example.test", password: PASSWORD })
      .expect(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });
});

describe("when provisioning cannot complete", () => {
  beforeEach(async () => {
    h = await makeHarness({
      companies: [{ id: COMPANY, name: "Acme", contactEmail: "client@example.test" }],
      users: [
        { id: BUYER, email: "client@example.test", password: PASSWORD, role: "buyer", companyId: null },
      ],
    });
  });

  it("still signs the client in, rather than calling a correct password invalid", async () => {
    // Provisioning used to run inside the login's try/catch, so any failure
    // there — a missing column, a constraint, a transient error — answered 401
    // "Invalid credentials" and sent the client to reset a password that was
    // never wrong. Dropping the folders table reproduces that class of failure.
    await h.db.execute?.("DROP TABLE IF EXISTS folders CASCADE");

    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "client@example.test", password: PASSWORD })
      .expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe("client@example.test");
  });
});
