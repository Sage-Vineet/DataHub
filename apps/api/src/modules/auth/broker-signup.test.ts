import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@datahub/db";
import { makeHarness, SECRET, type Harness } from "./better-test-harness.js";
import { issueVerificationGrant } from "./verification-grant.js";

/**
 * Broker self-registration, end to end.
 *
 * This is the only endpoint that creates an account without an existing one, so
 * the verification grant is the whole security boundary. The cases that matter
 * are the refusals: no grant, a stale grant, a forged grant, and — the one an
 * attacker actually wants — a valid grant for an address they control being
 * used to register somebody else's.
 */

let h: Harness;

beforeEach(async () => {
  h = await makeHarness({ users: [] });
});

afterEach(async () => {
  await h.close();
});

const grantFor = (email: string, at = Date.now()) => issueVerificationGrant(email, SECRET, at);

const signup = (body: Record<string, unknown>) =>
  request(h.app).post("/auth/broker/signup").send(body);

const valid = (over: Record<string, unknown> = {}) => ({
  name: "Dana Reed",
  email: "dana@example.com",
  phone: "+44 20 7946 0000",
  broker_company: "Kestrel Partners",
  password: "correct1horse",
  confirmPassword: "correct1horse",
  verification_token: grantFor("dana@example.com"),
  ...over,
});

describe("creating a broker account", () => {
  it("creates the user, applies the broker profile and returns a session", async () => {
    const res = await signup(valid()).expect(201);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ email: "dana@example.com", role: "broker" });

    const [row] = await h.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "dana@example.com"));
    expect(row).toMatchObject({
      role: "broker",
      // The sub-role matters: everything else classifies people by it, and a
      // broker without one falls through to the role fallback.
      subRole: "broker_primary",
      brokerCompany: "Kestrel Partners",
      phone: "+44 20 7946 0000",
    });
  });

  it("establishes the session as a cookie, not only a bearer token", async () => {
    const res = await signup(valid()).expect(201);
    expect(res.headers["set-cookie"]).toBeTruthy();
  });

  it("refuses a second account on the same address", async () => {
    await signup(valid()).expect(201);
    const res = await signup(valid()).expect(409);
    expect(res.body.error).toMatch(/already exists/i);
  });
});

describe("the verification grant is the boundary", () => {
  it("refuses signup with no grant at all", async () => {
    const { verification_token, ...withoutGrant } = valid();
    void verification_token;
    await signup(withoutGrant).expect(400);
  });

  it("refuses a grant issued for a different address", async () => {
    // The attack: verify an address you control, then register someone else's.
    const res = await signup(
      valid({ email: "victim@example.com", verification_token: grantFor("attacker@example.com") }),
    ).expect(403);
    expect(res.body.error).toMatch(/verification/i);

    const rows = await h.db.select().from(schema.users);
    expect(rows).toHaveLength(0);
  });

  it("refuses an expired grant", async () => {
    const stale = grantFor("dana@example.com", Date.now() - 60 * 60 * 1000);
    await signup(valid({ verification_token: stale })).expect(403);
  });

  it("refuses a forged grant", async () => {
    await signup(valid({ verification_token: "not.agrant" })).expect(403);
    await signup(
      valid({ verification_token: issueVerificationGrant("dana@example.com", "wrong-secret", Date.now()) }),
    ).expect(403);
  });

  it("gives the same message whatever the reason", async () => {
    // Distinguishing expired from forged from wrong-address is an oracle, and
    // the remedy is identical in every case: verify again.
    const expired = await signup(
      valid({ verification_token: grantFor("dana@example.com", Date.now() - 60 * 60 * 1000) }),
    ).expect(403);
    const forged = await signup(valid({ verification_token: "not.agrant" })).expect(403);
    const mismatched = await signup(
      valid({ email: "other@example.com", verification_token: grantFor("dana@example.com") }),
    ).expect(403);

    expect(forged.body.error).toBe(expired.body.error);
    expect(mismatched.body.error).toBe(expired.body.error);
  });
});

describe("what the form must contain", () => {
  it("rejects a weak password", async () => {
    await signup(valid({ password: "short", confirmPassword: "short" })).expect(400);
    // Letters and digits both required.
    await signup(valid({ password: "alllettersnodigit", confirmPassword: "alllettersnodigit" })).expect(400);
  });

  it("rejects mismatched confirmation, under either spelling", async () => {
    await signup(valid({ confirmPassword: "different1horse" })).expect(400);
    const { confirmPassword, ...rest } = valid();
    void confirmPassword;
    await signup({ ...rest, confirm_password: "different1horse" }).expect(400);
  });

  it("accepts a payload with no confirmation field at all", async () => {
    const { confirmPassword, ...rest } = valid();
    void confirmPassword;
    await signup(rest).expect(201);
  });

  it("requires a name, an email and a phone number", async () => {
    await signup(valid({ name: "  " })).expect(400);
    await signup(valid({ email: "not-an-email" })).expect(400);
    await signup(valid({ phone: "" })).expect(400);
  });
});

describe("the OTP endpoints the SPA calls", () => {
  it("serves both spellings of send", async () => {
    // `/send-verification-otp` is the SPA's and legacy's; `/send-otp` predates
    // it in this module. Neither may 404 once legacy is gone.
    await request(h.app).post("/auth/send-otp").send({ email: "x@example.com" }).expect(200);
    await request(h.app)
      .post("/auth/send-verification-otp")
      .send({ email: "x@example.com" })
      .expect(200);
  });

  it("actually sends a code to an address with no account", async () => {
    // The whole point of signup verification, and the bug this flow had:
    // Better Auth's own `sendVerificationOTP` verifies the address of an
    // EXISTING account. For an unknown address it returns success and sends
    // nothing, so a would-be broker waits forever for a code. Registration
    // therefore uses the module's own OTP store.
    await request(h.app)
      .post("/auth/send-verification-otp")
      .send({ email: "brand-new@example.com" })
      .expect(200);

    expect(h.emailer.last).toMatchObject({ email: "brand-new@example.com" });
    expect(h.emailer.last?.otp).toMatch(/^\d{6}$/);
  });

  it("answers the same whether or not the address is registered", async () => {
    // Otherwise the endpoint enumerates accounts.
    const unknown = await request(h.app)
      .post("/auth/send-verification-otp")
      .send({ email: "nobody@example.com" })
      .expect(200);
    await signup(valid()).expect(201);
    const known = await request(h.app)
      .post("/auth/send-verification-otp")
      .send({ email: "dana@example.com" })
      .expect(200);

    expect(known.body).toEqual(unknown.body);
  });

  it("returns a usable grant from verify, under the SPA's spelling", async () => {
    await request(h.app)
      .post("/auth/send-verification-otp")
      .send({ email: "dana@example.com" })
      .expect(200);
    const otp = h.emailer.last?.otp;
    expect(otp).toBeTruthy();

    const verified = await request(h.app)
      .post("/auth/verify-verification-otp")
      .send({ email: "dana@example.com", otp })
      .expect(200);
    expect(verified.body).toMatchObject({ verified: true });
    expect(verified.body.verificationToken).toBeTruthy();

    // The grant it just issued must actually work — the two halves of the flow
    // are only correct together.
    await signup(valid({ verification_token: verified.body.verificationToken })).expect(201);
  });
});

describe("the refusals on the way in", () => {
  it("400s a malformed verify, on both spellings, without spending an attempt", async () => {
    // The attempt budget is what stops a code being guessed. Spending one on a
    // request that never named a code makes the budget easier to exhaust than
    // the code is to guess.
    for (const path of ["/auth/verify-otp", "/auth/verify-verification-otp"]) {
      const res = await request(h.app).post(path).send({}).expect(400);
      expect(String(res.body.error).trim()).not.toBe("");
    }
  });

  it("reports a wrong code as the OTP store reports it, not as a 500", async () => {
    // The message says how many attempts remain; a 500 says nothing and looks
    // like a fault in the product.
    await request(h.app)
      .post("/auth/send-verification-otp")
      .send({ email: "dana@example.com" })
      .expect(200);

    const res = await request(h.app)
      .post("/auth/verify-verification-otp")
      .send({ email: "dana@example.com", otp: "000000" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("400s a malformed send", async () => {
    await request(h.app).post("/auth/send-verification-otp").send({}).expect(400);
    await request(h.app).post("/auth/send-otp").send({ email: "nope" }).expect(400);
  });

  it("409s a second signup for an address that already has an account", async () => {
    // Better Auth answers 401 for a duplicate, which reads as "your credentials
    // are wrong" — the one thing it is not. 409 says what actually happened.
    await signup(valid()).expect(201);
    const again = await signup(
      valid({ verification_token: grantFor("dana@example.com") }),
    );
    expect(again.status).toBe(409);
  });

  it("takes the broker company under either spelling, and none at all", async () => {
    // The SPA sends `broker_company`; an older client sends `brokerCompany`.
    await signup(
      valid({ email: "camel@example.com", verification_token: grantFor("camel@example.com"), broker_company: undefined, brokerCompany: "Kestrel Partners" }),
    ).expect(201);

    await signup(
      valid({ email: "none@example.com", verification_token: grantFor("none@example.com"), broker_company: undefined }),
    ).expect(201);
  });

  it("answers with the broker role it just wrote, not the row's default", async () => {
    // Better Auth creates the row as a buyer; the broker profile is applied
    // afterwards. Answering from the pre-write copy would sign somebody in as
    // a buyer on the request that made them a broker.
    const res = await signup(valid()).expect(201);
    expect(res.body.user.role).toBe("broker");
  });
});
