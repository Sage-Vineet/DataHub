import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@datahub/db";
import { canAccessCompany } from "./service.js";
import {
  CaptureEmailer,
  FailingEmailer,
  makeHarness,
  sessionCookie,
  type Harness,
} from "./better-test-harness.js";

const COMPANY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BROKER = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness({
    companies: [
      { id: COMPANY_A, name: "Acme", contactEmail: "client@example.com" },
      { id: COMPANY_B, name: "Globex" },
    ],
    users: [
      { id: BROKER, email: "broker@example.com", password: "correct1horse", role: "broker" },
      { id: CLIENT, email: "client@example.com", password: "correct1horse", role: "buyer", companyId: COMPANY_A },
    ],
    memberships: [{ userId: BROKER, companyId: COMPANY_A }],
  });
});

afterEach(async () => {
  await h.close();
});

describe("Better Auth module — credential login parity (D3)", () => {
  it("logs in a migrated user with their existing bcrypt hash and no reset", async () => {
    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "correct1horse" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("broker@example.com");
    expect(res.body.user.role).toBe("broker");
    expect(res.body.user.passwordHash).toBeUndefined();
    // A session cookie is issued (M2/M3) …
    expect(sessionCookie(res.headers["set-cookie"])).toMatch(/session_token=/);
    // … and a bearer token is returned for non-cookie clients.
    expect(res.body.token).toBeTruthy();
  });

  it("persists the session as a DB row (revocable, not a stateless JWT)", async () => {
    await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "correct1horse" })
      .expect(200);
    const rows = await h.db.select().from(schema.session);
    expect(rows.length).toBe(1);
  });

  it("returns 401 for a wrong password and 400 for a malformed body", async () => {
    expect(
      (await request(h.app).post("/auth/login").send({ email: "broker@example.com", password: "nope" })).status,
    ).toBe(401);
    expect(
      (await request(h.app).post("/auth/login").send({ email: "broker@example.com" })).status,
    ).toBe(400);
  });

  it("rate-limits repeated failed logins with 429", async () => {
    for (let i = 0; i < 5; i++) {
      await request(h.app).post("/auth/login").send({ email: "broker@example.com", password: "wrong" });
    }
    const blocked = await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "wrong" });
    expect(blocked.status).toBe(429);
  });
});

describe("Better Auth module — session lookup (/me, D6)", () => {
  async function login() {
    const res = await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "correct1horse" });
    return { cookie: sessionCookie(res.headers["set-cookie"]), token: res.body.token as string };
  }

  it("resolves the session user via the cookie, 401 without", async () => {
    const { cookie } = await login();
    const me = await request(h.app).get("/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("broker@example.com");
    expect((await request(h.app).get("/auth/me")).status).toBe(401);
  });

  it("also resolves the session via a Bearer token (bearer plugin)", async () => {
    const { token } = await login();
    const me = await request(h.app).get("/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("broker@example.com");
  });
});

describe("Better Auth module — revocation (audit M1)", () => {
  it("invalidates the session on logout so the next request is 401", async () => {
    const login = await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "correct1horse" });
    const cookie = sessionCookie(login.headers["set-cookie"]);

    expect((await request(h.app).get("/auth/me").set("Cookie", cookie)).status).toBe(200);

    await request(h.app).post("/auth/logout").set("Cookie", cookie).expect(204);

    expect((await request(h.app).get("/auth/me").set("Cookie", cookie)).status).toBe(401);
    const rows = await h.db.select().from(schema.session);
    expect(rows.length).toBe(0);
  });
});

describe("Better Auth module — password reset via email-otp (D5)", () => {
  it("runs forgot → (emailed OTP) → reset → login with the new password", async () => {
    await request(h.app)
      .post("/auth/forgot-password")
      .send({ email: "broker@example.com" })
      .expect(200);
    const otp = (h.emailer as CaptureEmailer).last?.otp ?? "";
    expect(otp).toMatch(/^\d{6}$/);

    await request(h.app)
      .post("/auth/reset-password")
      .send({ email: "broker@example.com", otp, new_password: "brandNew9" })
      .expect(200);

    // Old password no longer works; new one does.
    expect(
      (await request(h.app).post("/auth/login").send({ email: "broker@example.com", password: "correct1horse" })).status,
    ).toBe(401);
    await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "brandNew9" })
      .expect(200);
  });

  it("forgot-password is enumeration-safe (identical response for known and unknown emails)", async () => {
    const known = await request(h.app).post("/auth/forgot-password").send({ email: "broker@example.com" });
    const unknown = await request(h.app).post("/auth/forgot-password").send({ email: "ghost@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("rejects a weak reset password with 400 before touching the OTP", async () => {
    await request(h.app).post("/auth/forgot-password").send({ email: "broker@example.com" });
    const otp = (h.emailer as CaptureEmailer).last?.otp ?? "";
    const res = await request(h.app)
      .post("/auth/reset-password")
      .send({ email: "broker@example.com", otp, new_password: "weak" });
    expect(res.status).toBe(400);
  });
});

describe("Better Auth module — OTP verification endpoints", () => {
  it("sends a verification OTP and verifies it", async () => {
    await request(h.app).post("/auth/send-otp").send({ email: "broker@example.com" }).expect(200);
    const otp = (h.emailer as CaptureEmailer).last?.otp ?? "";
    expect(otp).toMatch(/^\d{6}$/);
    const verify = await request(h.app)
      .post("/auth/verify-otp")
      .send({ email: "broker@example.com", otp });
    expect(verify.status).toBe(200);
    expect(verify.body.verified).toBe(true);
  });

  it("rejects a malformed OTP body with 400 and a wrong code without 200", async () => {
    expect((await request(h.app).post("/auth/send-otp").send({})).status).toBe(400);
    await request(h.app).post("/auth/send-otp").send({ email: "broker@example.com" });
    const bad = await request(h.app)
      .post("/auth/verify-otp")
      .send({ email: "broker@example.com", otp: "000000" });
    expect(bad.status).not.toBe(200);
  });
});

describe("Better Auth module — multi-tenant boundary parity (D6)", () => {
  it("surfaces company memberships and enforces canAccessCompany", async () => {
    const login = await request(h.app)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "correct1horse" });
    const me = await request(h.app)
      .get("/auth/me")
      .set("Cookie", sessionCookie(login.headers["set-cookie"]));
    const user = me.body.user;

    // Broker is a member of company A only.
    expect(user.company_ids).toContain(COMPANY_A);
    expect(user.company_ids).not.toContain(COMPANY_B);

    // Membership is what grants access — for brokers too. A broker who is not a
    // member of company B must not reach it (parity with legacy; only admins are
    // unscoped).
    expect(canAccessCompany(user, COMPANY_A)).toBe(true);
    expect(canAccessCompany(user, COMPANY_B)).toBe(false);
    expect(canAccessCompany({ ...user, role: "admin" }, COMPANY_B)).toBe(true);

    const client = { ...user, role: "buyer", company_id: COMPANY_A, company_ids: [COMPANY_A] };
    expect(canAccessCompany(client, COMPANY_A)).toBe(true);
    expect(canAccessCompany(client, COMPANY_B)).toBe(false);
  });
});

describe("Better Auth module — when the mail server refuses", () => {
  /**
   * Mail failing is ordinary, and the two endpoints that send it answer
   * differently on purpose.
   *
   * `forgot-password` must not change its answer, because changing it is how a
   * stranger learns which addresses are registered — the whole point of the
   * generic response. `send-otp` may, because the caller is asking for a code
   * they are waiting on, and a silent success leaves them staring at a form
   * for a message that is never coming.
   */
  let failing: Harness;

  beforeEach(async () => {
    failing = await makeHarness({
      users: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          email: "broker@example.com",
          password: "correct1horse",
          role: "broker",
        },
      ],
      emailer: new FailingEmailer(),
    });
  });

  afterEach(async () => {
    await failing.close();
  });

  it("still answers forgot-password generically", async () => {
    const res = await request(failing.app)
      .post("/auth/forgot-password")
      .send({ email: "broker@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBeTruthy();
  });

  it("tells a caller waiting on a verification code that it did not send", async () => {
    const res = await request(failing.app)
      .post("/auth/send-verification-otp")
      .send({ email: "broker@example.com" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe("Better Auth module — logging out when there is nothing to log out of", () => {
  it("clears client state and answers 204 rather than failing", async () => {
    // A browser with a stale cookie, or a second tab that logged out first.
    // Anything but 204 leaves the SPA believing it still has a session.
    await request(h.app).post("/auth/logout").expect(204);
    await request(h.app).post("/auth/logout").set("Cookie", "session_token=nonsense").expect(204);
  });
});
