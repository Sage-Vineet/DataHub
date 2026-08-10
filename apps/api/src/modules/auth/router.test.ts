import bcrypt from "bcryptjs";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuthModule } from "./index.js";
import { InMemoryAuthRepository } from "./repository.memory.js";
import type { Emailer } from "./ports.js";

const SECRET = "router-test-secret-value";

class CaptureEmailer implements Emailer {
  last: { email: string; otp: string } | null = null;
  async sendOtp(email: string, otp: string) {
    this.last = { email, otp };
    return { sent: true };
  }
}

async function makeApp(env: NodeJS.ProcessEnv = {}) {
  const repo = new InMemoryAuthRepository();
  const emailer = new CaptureEmailer();
  const mod = createAuthModule({
    repo,
    emailer,
    env: { JWT_SECRET: SECRET, AUTH_LOGIN_RATE_MAX: "3", ...env },
  });
  const app = express();
  app.use("/api/auth", mod.router);

  await repo.addUser({
    id: "11111111-1111-1111-1111-111111111111",
    name: "Broker",
    email: "user@example.com",
    role: "broker",
    companyId: null,
    status: "active",
    passwordHash: await bcrypt.hash("correct1horse", 4),
  });
  return { app, repo, emailer };
}

describe("auth router", () => {
  it("logs in with valid credentials", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/auth/login").send({
      email: "user@example.com",
      password: "correct1horse",
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe("user@example.com");
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it("returns 401 for a wrong password and 400 for a malformed body", async () => {
    const { app } = await makeApp();
    expect((await request(app).post("/api/auth/login").send({ email: "user@example.com", password: "no" })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: "user@example.com" })).status).toBe(400);
  });

  it("rate-limits repeated failed logins with 429", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/auth/login").send({ email: "user@example.com", password: "wrong" });
    }
    const blocked = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@example.com", password: "wrong" });
    expect(blocked.status).toBe(429);
  });

  it("forgot-password returns an identical generic response for known and unknown emails", async () => {
    const { app } = await makeApp();
    const known = await request(app).post("/api/auth/forgot-password").send({ email: "user@example.com" });
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "ghost@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("verifies an OTP and returns a verification token", async () => {
    const { app, emailer } = await makeApp();
    await request(app).post("/api/auth/send-otp").send({ email: "user@example.com" }).expect(200);
    const verify = await request(app)
      .post("/api/auth/verify-otp")
      .send({ email: "user@example.com", otp: emailer.last?.otp ?? "" });
    expect(verify.status).toBe(200);
    expect(verify.body.verified).toBe(true);
    expect(verify.body.verificationToken).toBeTruthy();
  });

  it("runs the send-otp → reset → login flow", async () => {
    const { app, emailer } = await makeApp();
    await request(app).post("/api/auth/send-otp").send({ email: "user@example.com" }).expect(200);
    const otp = emailer.last?.otp ?? "";

    await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "user@example.com", otp, new_password: "brandNew9" })
      .expect(200);

    await request(app)
      .post("/api/auth/login")
      .send({ email: "user@example.com", password: "brandNew9" })
      .expect(200);
  });

  it("rejects a weak reset password with 400", async () => {
    const { app, emailer } = await makeApp();
    await request(app).post("/api/auth/send-otp").send({ email: "user@example.com" });
    const otp = emailer.last?.otp ?? "";
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "user@example.com", otp, new_password: "weak" });
    expect(res.status).toBe(400);
  });

  it("returns the session user for /me with a valid token, 401 without", async () => {
    const { app } = await makeApp();
    const login = await request(app).post("/api/auth/login").send({
      email: "user@example.com",
      password: "correct1horse",
    });
    const token = login.body.token as string;
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("user@example.com");
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });
});
