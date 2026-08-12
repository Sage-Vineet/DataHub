// Frontend session-message classification — the user-facing half of the fix.
//
// Run: node --test src/lib/authSessionCodes.test.js
//
// CONFIRMED ROOT CAUSE these lock down, in two layers:
//
//  1. AuthContext's message table had
//       revoked: 'You were signed out because your account was signed in on
//                 another device.'
//     and api.js funnelled EVERY non-timeout invalidation into 'revoked'.
//
//  2. api.js's refresh catch was `} catch { triggerSessionExpired('revoked') }`
//     — untyped and unconditional — so a dropped connection, an API restart, a
//     502 from the proxy, a 503 from an unreachable session store, or a CORS
//     failure all produced that same sentence about another device.
//
// The two invariants asserted here: only SESSION_SUPERSEDED may mention another
// device, and no transient failure may be classed as an invalidation.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_MESSAGE,
  REFRESHABLE_CODES,
  SESSION_INVALIDATION_CODES,
  SESSION_MESSAGES,
  TRANSIENT_CODES,
  isSessionInvalidationCode,
  isTransientCode,
  messageForSessionCode,
} from './authSessionCodes.js';

const mentionsAnotherDevice = (text) => /another device/i.test(String(text));

describe("only SESSION_SUPERSEDED may say 'another device'", () => {
  test('SESSION_SUPERSEDED does say it — that is the one true case', () => {
    assert.ok(mentionsAnotherDevice(messageForSessionCode('SESSION_SUPERSEDED')));
  });

  test('no other code in the whole table says it', () => {
    const offenders = Object.entries(SESSION_MESSAGES)
      .filter(([code, msg]) => code !== 'SESSION_SUPERSEDED' && mentionsAnotherDevice(msg))
      .map(([code]) => code);
    assert.deepEqual(offenders, []);
  });

  test('the specific conditions from the bug report do NOT say it', () => {
    // Each of these used to render the "another device" sentence.
    for (const code of [
      'SESSION_INVALID',          // session row not found
      'SESSION_LOGGED_OUT',       // logout / logout-all
      'SESSION_PASSWORD_CHANGED',
      'SESSION_REVOKED_BY_ADMIN',
      'ACCOUNT_DISABLED',
      'SESSION_IDLE_TIMEOUT',
      'SESSION_ABSOLUTE_TIMEOUT',
      'SESSION_REVOKED',          // legacy code from a pre-fix server
      'SESSION_EXPIRED',
    ]) {
      assert.ok(!mentionsAnotherDevice(messageForSessionCode(code)), code);
    }
  });

  test('refresh-token reuse is indistinguishable from any other invalid session', () => {
    // The server deliberately reports reuse as SESSION_INVALID, so the user sees
    // the neutral message and an attacker learns nothing about theft detection.
    assert.equal(messageForSessionCode('SESSION_INVALID'), DEFAULT_SESSION_MESSAGE);
    assert.ok(!mentionsAnotherDevice(DEFAULT_SESSION_MESSAGE));
    assert.match(DEFAULT_SESSION_MESSAGE, /no longer valid/i);
  });

  test('an unknown or missing code falls back to the neutral message', () => {
    for (const code of [undefined, null, '', 'WAT', 'SESSION_SOMETHING_NEW', 123]) {
      assert.equal(messageForSessionCode(code), DEFAULT_SESSION_MESSAGE, String(code));
      assert.ok(!mentionsAnotherDevice(messageForSessionCode(code)));
    }
  });

  test('a lowercase server code still resolves (defensive, not relied upon)', () => {
    assert.equal(
      messageForSessionCode('session_superseded'),
      SESSION_MESSAGES.SESSION_SUPERSEDED,
    );
  });
});

describe('each condition gets its own accurate wording', () => {
  test('idle vs absolute timeout are worded differently', () => {
    const idle = messageForSessionCode('SESSION_IDLE_TIMEOUT');
    const absolute = messageForSessionCode('SESSION_ABSOLUTE_TIMEOUT');
    assert.notEqual(idle, absolute);
    assert.match(idle, /inactivity/i);
    assert.ok(!/inactivity/i.test(absolute), 'an absolute timeout is not inactivity');
  });

  test('account disabled says so', () => {
    assert.match(messageForSessionCode('ACCOUNT_DISABLED'), /no longer active/i);
  });

  test('logout-all says so', () => {
    assert.match(messageForSessionCode('SESSION_LOGGED_OUT'), /signed out/i);
  });

  test('password change says so', () => {
    assert.match(messageForSessionCode('SESSION_PASSWORD_CHANGED'), /password/i);
  });

  test('local clock reasons still work (idle / absolute / expired)', () => {
    assert.match(messageForSessionCode('idle'), /inactivity/i);
    assert.match(messageForSessionCode('absolute'), /maximum length/i);
    assert.match(messageForSessionCode('expired'), /expired/i);
    for (const r of ['idle', 'absolute', 'expired']) {
      assert.ok(!mentionsAnotherDevice(messageForSessionCode(r)), r);
    }
  });

  test('no message exposes a raw internal reason name', () => {
    const internal = ['superseded', 'not_found', 'reuse_detected', 'logout_all',
      'password_change', 'admin_revoked', 'account_disabled', 'idle_timeout',
      'absolute_timeout'];
    for (const [, msg] of Object.entries(SESSION_MESSAGES)) {
      for (const name of internal) {
        assert.ok(!msg.includes(name), `"${msg}" leaks the internal reason ${name}`);
      }
    }
  });
});

describe('invalidation vs transient classification', () => {
  test('every invalidation code is recognised', () => {
    for (const code of SESSION_INVALIDATION_CODES) {
      assert.equal(isSessionInvalidationCode(code), true, code);
    }
  });

  test('transient codes are NOT invalidation', () => {
    for (const code of TRANSIENT_CODES) {
      assert.equal(isSessionInvalidationCode(code), false, code);
      assert.equal(isTransientCode(code), true, code);
    }
  });

  test('refreshable codes are neither invalidation nor transient', () => {
    // TOKEN_EXPIRED means "renew and retry", not "sign out" and not "server down".
    for (const code of REFRESHABLE_CODES) {
      assert.equal(isSessionInvalidationCode(code), false, code);
      assert.equal(isTransientCode(code), false, code);
    }
  });

  test('an unknown code is not treated as an invalidation', () => {
    // A code the client does not recognise must not tear down the session — the
    // fallback path is "leave auth state alone", not "log the user out".
    for (const code of [undefined, null, '', 'SOMETHING_NEW', 'NETWORK_ERROR', 'MALFORMED_REFRESH_RESPONSE']) {
      assert.equal(isSessionInvalidationCode(code), false, String(code));
    }
  });

  test('the legacy pre-fix codes are accepted but worded neutrally', () => {
    // A tab on the old build, or an API instance not yet rolled forward, can still
    // send SESSION_REVOKED. It must sign the user out (it IS an invalidation) but
    // must NOT resurrect the false claim.
    assert.equal(isSessionInvalidationCode('SESSION_REVOKED'), true);
    assert.ok(!mentionsAnotherDevice(messageForSessionCode('SESSION_REVOKED')));
  });
});
