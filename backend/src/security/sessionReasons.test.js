"use strict";

/**
 * Session-reason classification — the backend half of the "another device" fix.
 *
 * Run: node --test backend/src/security/sessionReasons.test.js
 *
 * CONFIRMED ROOT CAUSE these lock down. requireAuth used to end with:
 *
 *   const expiryReasons = new Set(["idle_timeout", "absolute_timeout"]);
 *   return unauthorized(res, expiryReasons.has(session.reason)
 *     ? "SESSION_EXPIRED" : "SESSION_REVOKED");
 *
 * so not_found, reuse_detected, logout, logout_all, password_change,
 * admin_revoked, account_disabled AND superseded all left the server as one
 * code, which the client rendered as "your account was signed in on another
 * device". The server knew the real reason and discarded it one line before
 * responding.
 *
 * The invariant asserted here: exactly ONE internal reason may produce
 * SESSION_SUPERSEDED, and no unknown reason may ever reach it.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  REASON_MAP,
  TRANSIENT,
  describeReason,
  describeSessionError,
  clientCodeForReason,
  isTransientCode,
  isInvalidationCode,
} = require("./sessionReasons");

// Every reason string written by a revokeSession/revokeAllUserSessions call site
// anywhere in the backend, plus the two synthetic ones validateSession returns.
const ALL_INTERNAL_REASONS = [
  "superseded",        // sessionService.createSession (SINGLE_DEVICE_LOGIN)
  "logout",            // controllers/auth logout
  "logout_all",        // controllers/auth logoutAll
  "password_change",   // services/authService (x2)
  "admin_revoked",     // routes/security revoke-sessions
  "account_disabled",  // middleware/auth + rotateRefreshToken
  "reuse_detected",    // middleware/auth + rotateRefreshToken
  "idle_timeout",      // validateSession + rotateRefreshToken
  "absolute_timeout",  // validateSession + rotateRefreshToken
  "not_found",         // validateSession
  "revoked",           // validateSession fallback for a null revoked_reason
];

describe("only a genuine supersede may say 'another device'", () => {
  test("exactly one internal reason maps to SESSION_SUPERSEDED", () => {
    const producing = ALL_INTERNAL_REASONS.filter(
      (r) => describeReason(r).code === "SESSION_SUPERSEDED",
    );
    assert.deepEqual(producing, ["superseded"]);
  });

  test("no other reason can produce it, including unknown and empty values", () => {
    const others = [
      "not_found", "reuse_detected", "logout", "logout_all", "password_change",
      "admin_revoked", "account_disabled", "idle_timeout", "absolute_timeout",
      "revoked", "", null, undefined, "a_reason_added_next_year", "SUPERSEDED_BY_SOMETHING",
    ];
    for (const reason of others) {
      assert.notEqual(describeReason(reason).code, "SESSION_SUPERSEDED", String(reason));
    }
  });

  test("an unrecognised reason degrades to the neutral code, not a specific one", () => {
    for (const reason of ["", null, undefined, "wat", 42, {}]) {
      assert.equal(describeReason(reason).code, "SESSION_INVALID", String(reason));
    }
  });
});

describe("each reason keeps its own identity", () => {
  const expected = {
    superseded: "SESSION_SUPERSEDED",
    idle_timeout: "SESSION_IDLE_TIMEOUT",
    absolute_timeout: "SESSION_ABSOLUTE_TIMEOUT",
    logout: "SESSION_LOGGED_OUT",
    logout_all: "SESSION_LOGGED_OUT",
    password_change: "SESSION_PASSWORD_CHANGED",
    admin_revoked: "SESSION_REVOKED_BY_ADMIN",
    account_disabled: "ACCOUNT_DISABLED",
  };

  for (const [reason, code] of Object.entries(expected)) {
    test(`${reason} → ${code}`, () => {
      assert.equal(clientCodeForReason(reason), code);
    });
  }

  test("the two timeouts are distinguishable from each other", () => {
    // Previously BOTH became SESSION_EXPIRED and the client hardcoded 'idle',
    // so an absolute timeout was reported as inactivity.
    assert.notEqual(
      clientCodeForReason("idle_timeout"),
      clientCodeForReason("absolute_timeout"),
    );
  });

  test("reason matching is case- and whitespace-insensitive", () => {
    assert.equal(clientCodeForReason("  SUPERSEDED "), "SESSION_SUPERSEDED");
    assert.equal(clientCodeForReason("Logout_All"), "SESSION_LOGGED_OUT");
  });
});

describe("security-sensitive reasons stay generic to the client", () => {
  test("reuse_detected is indistinguishable from an ordinary invalid session", () => {
    // Telling a caller "we detected token replay" is a probe oracle for the
    // theft-detection logic. The reason is still logged server-side in full.
    assert.equal(clientCodeForReason("reuse_detected"), "SESSION_INVALID");
    assert.equal(clientCodeForReason("not_found"), "SESSION_INVALID");
    assert.equal(
      clientCodeForReason("reuse_detected"),
      clientCodeForReason("not_found"),
      "the two must not be tellable apart from the client's side",
    );
  });

  test("the sensitive flag marks it for callers that log", () => {
    assert.equal(REASON_MAP.reuse_detected.sensitive, true);
  });

  test("no client code leaks an internal reason name", () => {
    for (const reason of ALL_INTERNAL_REASONS) {
      const code = clientCodeForReason(reason);
      if (reason === "reuse_detected" || reason === "not_found") {
        assert.ok(!code.toLowerCase().includes("reuse"));
        assert.ok(!code.toLowerCase().includes("not_found"));
      }
    }
  });
});

describe("availability failures are not invalidation", () => {
  test("STORE_UNAVAILABLE is 503 and transient", () => {
    assert.equal(TRANSIENT.STORE_UNAVAILABLE.status, 503);
    assert.equal(TRANSIENT.STORE_UNAVAILABLE.category, "transient");
    assert.equal(isTransientCode("STORE_UNAVAILABLE"), true);
    assert.equal(isTransientCode("STORE_DOWN"), true);
  });

  test("no invalidation code is ever classed transient", () => {
    for (const reason of ALL_INTERNAL_REASONS) {
      assert.equal(isTransientCode(clientCodeForReason(reason)), false, reason);
    }
  });

  test("every session-ending code is recognised as invalidation", () => {
    for (const reason of ALL_INTERNAL_REASONS) {
      assert.equal(isInvalidationCode(clientCodeForReason(reason)), true, reason);
    }
    assert.equal(isInvalidationCode("STORE_UNAVAILABLE"), false);
    assert.equal(isInvalidationCode("TOKEN_EXPIRED"), false);
  });
});

describe("describeSessionError — what /auth/refresh answers with", () => {
  const sessionError = (code, status, reason) =>
    Object.assign(new Error("x"), { name: "SessionError", code, status, reason });

  test("the row's own reason wins over the coarse error code", () => {
    // rotateRefreshToken throws code "REVOKED" for any revoked row; the reason is
    // what distinguishes a supersede from a logout-all. Without this the client
    // could never learn that a supersede had happened.
    const err = sessionError("REVOKED", 401, "superseded");
    assert.equal(describeSessionError(err).code, "SESSION_SUPERSEDED");

    const logoutAll = sessionError("REVOKED", 401, "logout_all");
    assert.equal(describeSessionError(logoutAll).code, "SESSION_LOGGED_OUT");
  });

  test("token-layer codes map without a reason present", () => {
    const cases = {
      IDLE_TIMEOUT: "SESSION_IDLE_TIMEOUT",
      ABSOLUTE_TIMEOUT: "SESSION_ABSOLUTE_TIMEOUT",
      REFRESH_EXPIRED: "SESSION_ABSOLUTE_TIMEOUT",
      ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
      REUSE_DETECTED: "SESSION_INVALID",
      NOT_FOUND: "SESSION_INVALID",
      INVALID: "SESSION_INVALID",
      EXPIRED: "SESSION_ABSOLUTE_TIMEOUT",
    };
    for (const [code, expected] of Object.entries(cases)) {
      assert.equal(describeSessionError(sessionError(code, 401)).code, expected, code);
    }
  });

  test("STORE_UNAVAILABLE stays transient through the error path", () => {
    const err = sessionError("STORE_UNAVAILABLE", 503);
    const described = describeSessionError(err);
    assert.equal(described.category, "transient");
    assert.equal(described.status, 503);
  });

  test("any 503 is treated as availability even with an unknown code", () => {
    const err = sessionError("SOMETHING_ELSE", 503);
    assert.equal(describeSessionError(err).category, "transient");
  });

  test("an unknown error is invalidated-but-neutral, never 'another device'", () => {
    assert.equal(describeSessionError(new Error("boom")).code, "SESSION_INVALID");
    assert.equal(describeSessionError(undefined).code, "SESSION_INVALID");
    assert.equal(describeSessionError({}).code, "SESSION_INVALID");
  });

  test("a bogus reason on the error does not smuggle in SESSION_SUPERSEDED", () => {
    const err = sessionError("REVOKED", 401, "not_a_real_reason");
    assert.equal(describeSessionError(err).code, "SESSION_INVALID");
  });
});

describe("wiring: the collapse points are gone", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  // Comments necessarily quote the OLD code they replaced, so strip them.
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

  test("requireAuth no longer uses the two-reason expiry set", () => {
    const src = strip(read("middleware/auth.js"));
    assert.ok(!/expiryReasons/.test(src),
      "the idle/absolute-only Set was the collapse point and must not return");
    assert.ok(!/"SESSION_REVOKED"/.test(src),
      "SESSION_REVOKED must no longer be emitted as a catch-all");
    assert.ok(/describeReason\(session\.reason\)/.test(src),
      "the real reason must be mapped, not discarded");
  });

  test("requireAuth can answer 503 rather than dressing it as 401", () => {
    const src = strip(read("middleware/auth.js"));
    assert.ok(/function unauthorized\(res, code = "UNAUTHENTICATED", status = 401\)/.test(src));
    assert.ok(/res\.status\(status\)/.test(src));
  });

  test("the refresh endpoint clears the cookie ONLY on genuine invalidation", () => {
    const src = strip(read("controllers/auth.js"));
    assert.ok(/if \(!isTransient\) clearRefreshCookie\(res\)/.test(src),
      "an unconditional clearRefreshCookie turned a transient outage into a hard logout");
    // And it must publish the retryable flag so the client need not infer it.
    assert.ok(/retryable: isTransient/.test(src));
  });

  test("SessionError carries the canonical reason", () => {
    const src = strip(read("services/sessionService.js"));
    assert.ok(/constructor\(message, code, status = 401, reason = null\)/.test(src));
    assert.ok(/this\.reason = reason/.test(src));
    // The revoked-row throw must pass the row's reason through.
    assert.ok(/new SessionError\("Session revoked", "REVOKED", 401, reason\)/.test(src));
    // And reuse detection must be tagged as such for the server-side log.
    assert.ok(/"REUSE_DETECTED", 401, "reuse_detected"/.test(src));
  });

  test("rotation, reuse detection and family revocation are all still in place", () => {
    const src = strip(read("services/sessionService.js"));
    // Nothing in this fix may weaken the security controls.
    assert.ok(/revokeFamily\(session\.family_id, "reuse_detected"\)/.test(src),
      "family revocation on replay must remain");
    assert.ok(/\.eq\("refresh_jti_hash", presentedHash\)/.test(src),
      "the conditional update that makes rotation single-use must remain");
    assert.ok(/signRefreshToken\(/.test(src), "rotation must still issue a new refresh token");
  });

  test("no secret material is written to the session logs", () => {
    for (const file of ["middleware/auth.js", "controllers/auth.js", "services/sessionService.js"]) {
      const src = strip(read(file));
      // Logger calls must not include token/cookie/password values.
      const logCalls = src.match(/logger\.(info|warn|error)\([^;]*\);/g) || [];
      for (const call of logCalls) {
        for (const banned of ["accessToken", "refreshToken", "rawRefreshToken", "password", "cookie", "Authorization"]) {
          assert.ok(!call.includes(banned), `${file}: log must not include ${banned} — ${call.slice(0, 90)}`);
        }
      }
    }
  });
});
