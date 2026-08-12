"use strict";

/**
 * Session lifecycle — end-to-end through the real /auth/refresh handler.
 *
 * Run: node --test backend/test/session.lifecycle.test.js
 *
 * This exercises the ACTUAL controller against a stubbed sessionService, so it
 * verifies the two behaviours the reason-mapping unit tests cannot:
 *
 *   1. WHICH CODE each condition produces on the wire.
 *   2. WHETHER THE REFRESH COOKIE IS CLEARED. That is the difference between a
 *      recoverable blip and a permanent logout, and it was the most damaging half
 *      of the bug: the old handler called clearRefreshCookie(res) unconditionally,
 *      so a 503 from an unreachable session store destroyed the user's only
 *      long-lived credential and no client-side retry could ever recover.
 */

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const CONTROLLER = path.join(__dirname, "..", "src", "controllers", "auth.js");
const SESSION_SERVICE = path.join(__dirname, "..", "src", "services", "sessionService.js");

/** Minimal Express res double capturing status, body and cookie operations. */
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    cookiesSet: [],
    cookiesCleared: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    cookie(name, value, options) { this.cookiesSet.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.cookiesCleared.push({ name, options }); return this; },
    set() { return this; },
    setHeader() { return this; },
  };
}

const makeReq = (refreshToken = "rt-cookie-value") => ({
  cookies: refreshToken ? { dh_rt: refreshToken } : {},
  body: {},
  headers: { "user-agent": "node-test" },
  ip: "127.0.0.1",
  get() { return "node-test"; },
});

/** A SessionError shaped exactly as sessionService throws one. */
function sessionError(message, code, status, reason) {
  const err = new Error(message);
  err.name = "SessionError";
  err.code = code;
  err.status = status;
  if (reason) err.reason = reason;
  return err;
}

let controller;
let sessionService;
let originalRotate;

beforeEach(() => {
  controller = require(CONTROLLER);
  sessionService = require(SESSION_SERVICE);
  originalRotate = sessionService.rotateRefreshToken;
});

afterEach(() => {
  sessionService.rotateRefreshToken = originalRotate;
});

/** Invoke the real refresh handler with rotateRefreshToken stubbed. */
async function callRefresh(stub, { refreshToken } = {}) {
  sessionService.rotateRefreshToken = stub;
  const res = makeRes();
  await controller.refresh(makeReq(refreshToken === undefined ? "rt" : refreshToken), res, (err) => {
    if (err) throw err;
  });
  return res;
}

describe("a successful refresh", () => {
  test("returns a new access token and sets a rotated refresh cookie", async () => {
    const res = await callRefresh(async () => ({
      user: { id: "u1", email: "a@b.c", role: "broker", status: "active" },
      sessionId: "s1",
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accessTokenExpiresIn: 900,
    }));

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.accessToken, "new-access");
    assert.equal(res.cookiesCleared.length, 0, "a successful refresh must not clear the cookie");
    assert.equal(res.cookiesSet.length, 1, "rotation must set the NEW refresh cookie");
    assert.equal(res.cookiesSet[0].name, "dh_rt");
    assert.equal(res.cookiesSet[0].options.httpOnly, true,
      "the refresh token must stay unreadable from JavaScript");
    // The refresh token must never appear in the JSON body (it is cookie-only).
    assert.equal(res.body.refreshToken, undefined);
    assert.equal(res.body.refresh_token, undefined);
  });
});

describe("no refresh token presented", () => {
  test("401 NO_REFRESH_TOKEN without touching rotation", async () => {
    let called = false;
    const res = await callRefresh(async () => { called = true; }, { refreshToken: null });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, "NO_REFRESH_TOKEN");
    assert.equal(called, false);
  });
});

describe("genuine invalidation — cookie cleared, precise code", () => {
  const cases = [
    ["single-device replacement", sessionError("Session revoked", "REVOKED", 401, "superseded"), "SESSION_SUPERSEDED"],
    ["logout-all", sessionError("Session revoked", "REVOKED", 401, "logout_all"), "SESSION_LOGGED_OUT"],
    ["password change", sessionError("Session revoked", "REVOKED", 401, "password_change"), "SESSION_PASSWORD_CHANGED"],
    ["admin revocation", sessionError("Session revoked", "REVOKED", 401, "admin_revoked"), "SESSION_REVOKED_BY_ADMIN"],
    ["account disabled", sessionError("Session revoked", "ACCOUNT_DISABLED", 401, "account_disabled"), "ACCOUNT_DISABLED"],
    ["idle timeout", sessionError("Session expired", "IDLE_TIMEOUT", 401, "idle_timeout"), "SESSION_IDLE_TIMEOUT"],
    ["absolute timeout", sessionError("Session expired", "ABSOLUTE_TIMEOUT", 401, "absolute_timeout"), "SESSION_ABSOLUTE_TIMEOUT"],
    ["refresh window expired", sessionError("Session expired", "REFRESH_EXPIRED", 401, "absolute_timeout"), "SESSION_ABSOLUTE_TIMEOUT"],
    ["session not found", sessionError("Invalid session", "NOT_FOUND", 401, "not_found"), "SESSION_INVALID"],
    ["refresh-token reuse", sessionError("Session revoked", "REUSE_DETECTED", 401, "reuse_detected"), "SESSION_INVALID"],
    ["unverifiable token", sessionError("Invalid session", "INVALID", 401), "SESSION_INVALID"],
  ];

  for (const [label, error, expectedCode] of cases) {
    test(`${label} → ${expectedCode}, cookie cleared`, async () => {
      const res = await callRefresh(async () => { throw error; });
      assert.equal(res.statusCode, 401, label);
      assert.equal(res.body.code, expectedCode, label);
      assert.equal(res.body.retryable, false, "an invalidation is not retryable");
      assert.equal(res.cookiesCleared.length, 1,
        "a genuinely dead session must have its refresh cookie cleared");
    });
  }

  test("only the supersede case is distinguishable as such", () => {
    const superseded = cases.filter(([, , code]) => code === "SESSION_SUPERSEDED");
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0][0], "single-device replacement");
  });

  test("reuse detection is not distinguishable from not-found on the wire", async () => {
    const reuse = await callRefresh(async () => {
      throw sessionError("Session revoked", "REUSE_DETECTED", 401, "reuse_detected");
    });
    const notFound = await callRefresh(async () => {
      throw sessionError("Invalid session", "NOT_FOUND", 401, "not_found");
    });
    assert.equal(reuse.body.code, notFound.body.code);
    assert.equal(reuse.body.error, notFound.body.error);
    // No internal reason name may reach the client.
    for (const res of [reuse, notFound]) {
      const serialised = JSON.stringify(res.body);
      for (const leak of ["reuse_detected", "not_found", "family", "jti"]) {
        assert.ok(!serialised.includes(leak), `body leaks ${leak}: ${serialised}`);
      }
    }
  });

  test("the human-facing message never mentions another device", async () => {
    for (const [label, error] of cases) {
      const res = await callRefresh(async () => { throw error; });
      assert.ok(!/another device/i.test(res.body.error), `${label}: ${res.body.error}`);
    }
  });
});

describe("transient failure — cookie PRESERVED, retryable", () => {
  const cases = [
    ["session store unreachable", sessionError("Session store unavailable", "STORE_UNAVAILABLE", 503)],
    ["any 503", sessionError("Nope", "SOMETHING", 503)],
  ];

  for (const [label, error] of cases) {
    test(`${label} → 503 retryable, cookie kept`, async () => {
      const res = await callRefresh(async () => { throw error; });
      assert.equal(res.statusCode, 503, label);
      assert.equal(res.body.code, "STORE_UNAVAILABLE");
      assert.equal(res.body.retryable, true);
      assert.equal(res.cookiesCleared.length, 0,
        "THE regression: clearing the cookie on an outage made a blip permanent");
      assert.match(res.body.error, /temporarily unavailable/i);
    });
  }

  test("a transient failure is never described as a session problem", async () => {
    const res = await callRefresh(async () => {
      throw sessionError("Session store unavailable", "STORE_UNAVAILABLE", 503);
    });
    assert.ok(!/no longer valid/i.test(res.body.error));
    assert.ok(!/another device/i.test(res.body.error));
  });
});

describe("requireAuth reports the real validation reason", () => {
  // The other collapse point: requireAuth mapped only the two timeouts and sent
  // everything else as SESSION_REVOKED. Exercised functionally here, with the
  // session store and the token verifier stubbed.
  const AUTH_MW = path.join(__dirname, "..", "src", "middleware", "auth.js");
  const TOKENS = path.join(__dirname, "..", "src", "security", "tokens.js");
  const USER_SERVICE = path.join(__dirname, "..", "src", "services", "userService.js");

  let mw;
  let tokens;
  let userService;
  let saved;

  beforeEach(() => {
    mw = require(AUTH_MW);
    tokens = require(TOKENS);
    userService = require(USER_SERVICE);
    saved = {
      verifyAccessToken: tokens.verifyAccessToken,
      extractBearerToken: tokens.extractBearerToken,
      validateSession: sessionService.validateSession,
      getUserById: userService.getUserById,
    };
  });

  afterEach(() => {
    tokens.verifyAccessToken = saved.verifyAccessToken;
    tokens.extractBearerToken = saved.extractBearerToken;
    sessionService.validateSession = saved.validateSession;
    userService.getUserById = saved.getUserById;
  });

  async function callRequireAuth(validateResult) {
    // requireAuth destructures its token helpers at module load, so the stub must
    // be installed on the module object BEFORE requiring it. It already is (the
    // module is cached), so instead drive it through a request carrying a token
    // this process can genuinely sign.
    const { signAccessToken } = tokens;
    const token = signAccessToken({
      userId: "11111111-1111-1111-1111-111111111111",
      sessionId: "22222222-2222-2222-2222-222222222222",
      role: "broker",
      tokenVersion: 0,
    });
    sessionService.validateSession = async () => validateResult;
    const req = { headers: { authorization: `Bearer ${token}` }, ip: "127.0.0.1", get() { return "t"; } };
    const res = makeRes();
    let nextCalled = false;
    await mw.requireAuth(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
  }

  const expectations = [
    ["superseded", "SESSION_SUPERSEDED"],
    ["logout", "SESSION_LOGGED_OUT"],
    ["logout_all", "SESSION_LOGGED_OUT"],
    ["password_change", "SESSION_PASSWORD_CHANGED"],
    ["admin_revoked", "SESSION_REVOKED_BY_ADMIN"],
    ["account_disabled", "ACCOUNT_DISABLED"],
    ["idle_timeout", "SESSION_IDLE_TIMEOUT"],
    ["absolute_timeout", "SESSION_ABSOLUTE_TIMEOUT"],
    ["not_found", "SESSION_INVALID"],
    ["reuse_detected", "SESSION_INVALID"],
    ["revoked", "SESSION_INVALID"],
    ["a_brand_new_reason", "SESSION_INVALID"],
  ];

  for (const [reason, expectedCode] of expectations) {
    test(`validateSession reason "${reason}" → ${expectedCode}`, async () => {
      const { res, nextCalled } = await callRequireAuth({ valid: false, reason });
      assert.equal(nextCalled, false, "an invalid session must never reach the route");
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, expectedCode);
      // The generic body text must not narrate a cause.
      assert.ok(!/another device/i.test(JSON.stringify(res.body)));
      assert.ok(!JSON.stringify(res.body).includes(reason),
        "the internal reason must not be echoed to the client");
    });
  }

  test("SESSION_REVOKED is no longer emitted for any reason", async () => {
    for (const [reason] of expectations) {
      const { res } = await callRequireAuth({ valid: false, reason });
      assert.notEqual(res.body.code, "SESSION_REVOKED", reason);
    }
  });

  test("exactly one reason yields SESSION_SUPERSEDED", async () => {
    const produced = [];
    for (const [reason] of expectations) {
      const { res } = await callRequireAuth({ valid: false, reason });
      if (res.body.code === "SESSION_SUPERSEDED") produced.push(reason);
    }
    assert.deepEqual(produced, ["superseded"]);
  });
});

describe("security controls are intact", () => {
  const fs = require("fs");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  const svc = strip(fs.readFileSync(SESSION_SERVICE, "utf8"));

  test("rotation still issues a new refresh token on every use", () => {
    assert.ok(/signRefreshToken\(\{[\s\S]{0,200}?familyId: session\.family_id/.test(svc));
  });

  test("the single-use conditional update is unchanged", () => {
    assert.ok(/\.eq\("refresh_jti_hash", presentedHash\)/.test(svc));
    assert.ok(/\.is\("revoked_at", null\)/.test(svc));
  });

  test("reuse detection still revokes the whole family", () => {
    const occurrences = svc.match(/revokeFamily\(session\.family_id, "reuse_detected"\)/g) || [];
    assert.ok(occurrences.length >= 2,
      "both the hash-mismatch and lost-race paths must still revoke the family");
  });

  test("the store still fails closed rather than assuming validity", () => {
    assert.ok(/throw new SessionError\("Session store unavailable", "STORE_UNAVAILABLE", 503\)/.test(svc));
    const mw = strip(fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "auth.js"), "utf8"));
    assert.ok(/STORE_DOWN/.test(mw), "requireAuth must still 503 rather than trust the bearer token");
  });

  test("single-device replacement is still committed before the new session", () => {
    assert.ok(/if \(config\.SINGLE_DEVICE_LOGIN\) \{\s*await revokeAllUserSessions\(user\.id, "superseded"\)/.test(svc));
  });

  test("token_version is still checked on every request", () => {
    const mw = strip(fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "auth.js"), "utf8"));
    assert.ok(/user\.token_version \?\? 0\) !== \(payload\.ver \?\? 0\)/.test(mw));
    assert.ok(/TOKEN_STALE/.test(mw));
  });

  test("no token value is written to any log call", () => {
    for (const file of ["controllers/auth.js", "services/sessionService.js", "middleware/auth.js"]) {
      const src = strip(fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8"));
      const banned = ["accessToken", "refreshToken", "rawRefreshToken", "presentedHash", "jtiHash", "password"];
      for (const call of src.match(/logger\.\w+\([^;]*\);/g) || []) {
        for (const b of banned) {
          assert.ok(!call.includes(b), `${file}: ${b} in ${call.slice(0, 80)}`);
        }
      }
    }
  });
});
