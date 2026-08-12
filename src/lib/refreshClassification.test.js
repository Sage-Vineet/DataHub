// The refresh decision table: does a failed /auth/refresh prove the session is
// gone, or was it merely unavailable?
//
// Run: node --test src/lib/refreshClassification.test.js
//
// CONFIRMED ROOT CAUSE this locks down. api.js's silent-refresh handler was:
//
//   try {
//     const refreshed = await refreshAccessToken();
//     ...
//   } catch {                              // ← untyped, catches everything
//     setStoredToken(null);
//     triggerSessionExpired('revoked');    // ← "signed in on another device"
//   }
//
// There was no classification at all: offline, DNS failure, TLS error, CORS
// preflight rejection, a 500 from the app, a 502 from the proxy, a 503 from an
// unreachable session store, a 429 from the auth rate-limiter, and a malformed
// 200 all destroyed the access token and told the user another device had signed
// in. Only a server-stated invalidation may do that, and only SESSION_SUPERSEDED
// may mention a device.
//
// Every numbered case from the refresh-endpoint audit is covered below.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRefreshFailure,
  isSessionInvalidationCode,
  messageForSessionCode,
} from './authSessionCodes.js';

const mentionsAnotherDevice = (t) => /another device/i.test(String(t));

/** What the user would actually be shown for a given classification. */
const userMessage = (result) =>
  result.transient ? null : messageForSessionCode(result.code);

describe('genuine invalidation — the session really is over', () => {
  const cases = [
    ['session superseded by a newer login', 401, { code: 'SESSION_SUPERSEDED' }, 'SESSION_SUPERSEDED'],
    ['idle timeout', 401, { code: 'SESSION_IDLE_TIMEOUT' }, 'SESSION_IDLE_TIMEOUT'],
    ['absolute timeout', 401, { code: 'SESSION_ABSOLUTE_TIMEOUT' }, 'SESSION_ABSOLUTE_TIMEOUT'],
    ['logout / logout-all', 401, { code: 'SESSION_LOGGED_OUT' }, 'SESSION_LOGGED_OUT'],
    ['password change', 401, { code: 'SESSION_PASSWORD_CHANGED' }, 'SESSION_PASSWORD_CHANGED'],
    ['admin revocation', 401, { code: 'SESSION_REVOKED_BY_ADMIN' }, 'SESSION_REVOKED_BY_ADMIN'],
    ['account disabled', 401, { code: 'ACCOUNT_DISABLED' }, 'ACCOUNT_DISABLED'],
    ['session not found', 401, { code: 'SESSION_INVALID' }, 'SESSION_INVALID'],
    ['refresh-token reuse (reported generically)', 401, { code: 'SESSION_INVALID' }, 'SESSION_INVALID'],
    ['no refresh cookie presented', 401, { code: 'NO_REFRESH_TOKEN' }, 'SESSION_INVALID'],
    ['invalid/forged refresh token', 401, { code: 'SESSION_INVALID' }, 'SESSION_INVALID'],
    ['403 forbidden', 403, { code: 'FORBIDDEN' }, 'SESSION_INVALID'],
  ];

  for (const [label, status, body, expectedCode] of cases) {
    test(`${label} → sign out with ${expectedCode}`, () => {
      const result = classifyRefreshFailure({ status, body });
      assert.equal(result.transient, false, 'must be treated as invalidation');
      assert.equal(result.code, expectedCode);
      assert.equal(isSessionInvalidationCode(result.code), true);
    });
  }

  test('only the supersede case mentions another device', () => {
    for (const [label, status, body] of cases) {
      const result = classifyRefreshFailure({ status, body });
      const msg = userMessage(result);
      if (result.code === 'SESSION_SUPERSEDED') {
        assert.ok(mentionsAnotherDevice(msg), label);
      } else {
        assert.ok(!mentionsAnotherDevice(msg), `${label} must NOT claim another device`);
      }
    }
  });

  test('an unrecognised 4xx code degrades to the neutral message', () => {
    const result = classifyRefreshFailure({ status: 401, body: { code: 'SOME_NEW_CODE' } });
    assert.equal(result.transient, false);
    assert.equal(result.code, 'SESSION_INVALID');
    assert.ok(!mentionsAnotherDevice(userMessage(result)));
  });

  test('a 401 with no body at all still signs out, neutrally', () => {
    const result = classifyRefreshFailure({ status: 401, body: null });
    assert.equal(result.transient, false);
    assert.equal(result.code, 'SESSION_INVALID');
  });
});

describe('temporary failures — the session must NOT be torn down', () => {
  const cases = [
    ['network failure (offline / DNS / TLS / CORS / abort)', { networkError: true }],
    ['no status at all', { status: 0, body: null }],
    ['HTTP 500 internal server error', { status: 500, body: { error: 'boom' } }],
    ['HTTP 502 bad gateway', { status: 502, body: null }],
    ['HTTP 503 service unavailable', { status: 503, body: { code: 'STORE_UNAVAILABLE', retryable: true } }],
    ['HTTP 503 without a body', { status: 503, body: null }],
    ['HTTP 504 gateway timeout', { status: 504, body: null }],
    ['session store unreachable (STORE_UNAVAILABLE on any status)', { status: 401, body: { code: 'STORE_UNAVAILABLE' } }],
    ['legacy STORE_DOWN code', { status: 503, body: { code: 'STORE_DOWN' } }],
    ['HTTP 429 from the auth rate-limiter', { status: 429, body: null }],
    ['HTTP 408 request timeout', { status: 408, body: null }],
    ['server says retryable explicitly', { status: 401, body: { retryable: true, code: 'WHATEVER' } }],
  ];

  for (const [label, input] of cases) {
    test(`${label} → keep the session, allow retry`, () => {
      const result = classifyRefreshFailure(input);
      assert.equal(result.transient, true, `${label} must be transient`);
      assert.equal(userMessage(result), null, 'no sign-out message may be shown');
      assert.equal(isSessionInvalidationCode(result.code), false);
    });
  }

  test('429 specifically — being rate-limited must never sign a user out', () => {
    // /auth/refresh sits behind authLimiter. Treating its 429 as invalidation
    // would punish the user for the limiter doing its job.
    const result = classifyRefreshFailure({ status: 429, body: { error: 'Too many requests' } });
    assert.equal(result.transient, true);
    assert.equal(result.code, 'REFRESH_THROTTLED');
  });

  test('a 5xx that also carries an invalidation-looking code stays transient', () => {
    // A proxy or error page can echo an arbitrary body. A server fault is never a
    // statement about this session.
    const result = classifyRefreshFailure({ status: 500, body: { code: 'SESSION_INVALID' } });
    assert.equal(result.transient, true);
  });

  test('no transient outcome is ever describable as another device', () => {
    for (const [, input] of cases) {
      const result = classifyRefreshFailure(input);
      assert.equal(result.transient, true);
      // Even if a caller wrongly rendered the code, it must not be the supersede one.
      assert.notEqual(result.code, 'SESSION_SUPERSEDED');
    }
  });
});

describe('the boundary between the two categories is total', () => {
  test('every outcome is exactly one of transient or invalidation', () => {
    const inputs = [
      { networkError: true },
      { status: 0 }, { status: 401 }, { status: 403 }, { status: 408 },
      { status: 429 }, { status: 500 }, { status: 502 }, { status: 503 }, { status: 504 },
      { status: 401, body: { code: 'SESSION_SUPERSEDED' } },
      { status: 401, body: { code: 'STORE_UNAVAILABLE' } },
      {},
    ];
    for (const input of inputs) {
      const r = classifyRefreshFailure(input);
      assert.equal(typeof r.transient, 'boolean', JSON.stringify(input));
      assert.equal(typeof r.code, 'string');
      assert.ok(r.code.length > 0);
      // Mutually exclusive by construction.
      assert.notEqual(r.transient, isSessionInvalidationCode(r.code));
    }
  });

  test('called with no arguments it does not throw and is transient', () => {
    // Defensive: an unexpected shape must fail SAFE (keep the session), because
    // the alternative is signing a user out on a bug in our own error handling.
    const r = classifyRefreshFailure();
    assert.equal(r.transient, true);
  });

  test('a malformed 200 (no token) is transient, not an invalidation', () => {
    // api.js raises MALFORMED_REFRESH_RESPONSE for a 200 carrying no token. A
    // proxy or cache anomaly is not proof the session ended.
    assert.equal(isSessionInvalidationCode('MALFORMED_REFRESH_RESPONSE'), false);
  });
});
