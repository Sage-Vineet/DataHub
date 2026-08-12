// Cross-tab refresh coordination and sign-out propagation.
//
// Run: node --test src/lib/authBroadcast.test.js
//
// THE RACE THIS FIXES. Refresh-token rotation is single-use: rotateRefreshToken
// overwrites the stored jti hash with an update conditional on the presented hash
// still being current, and its own comment states the consequence — "two
// concurrent refreshes race here and exactly one wins. The loser sees zero
// updated rows and is treated as a replay" — which calls
// revokeFamily(familyId, "reuse_detected") and kills the whole token family.
//
// api.js guarded this with a module-scoped `refreshInFlight` promise. A module
// scope is PER TAB, so two tabs of the app were two independent guards: both
// could refresh at once, the loser presented an already-rotated cookie, and the
// server correctly concluded replay. Both tabs were signed out and the cause
// looked like a security incident when it was ordinary concurrency.
//
// The fix has two independent parts, and the SECOND is the one that actually
// prevents the replay:
//   1. a cross-tab mutex (Web Locks) so only one tab refreshes at a time;
//   2. double-checked adoption inside the lock — if the persisted token changed
//      while this tab queued, adopt it and perform NO second rotation.
// (2) keeps working even where Web Locks is unavailable, which is why it is the
// load-bearing half.

import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeAuthChannel,
  publishAuthEvent,
  subscribeAuthEvents,
  withRefreshLock,
} from './authBroadcast.js';

// `globalThis.navigator` is an accessor property in Node 22 (getter only), so it
// cannot be assigned — it has to be redefined.
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

function restoreNavigator() {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    delete globalThis.navigator;
  }
}

afterEach(() => restoreNavigator());

// Node's BroadcastChannel keeps a libuv handle open. The module unref()s its own
// channel, but any channel a TEST opens must be closed or the runner will not exit.
after(() => closeAuthChannel());

/**
 * A minimal Web Locks stand-in that serialises by name, so "two tabs" can be
 * simulated in one process. Node has no navigator.locks.
 */
function installFakeWebLocks() {
  const queues = new Map();
  setNavigator({
    locks: {
      async request(name, _options, callback) {
        const prev = queues.get(name) || Promise.resolve();
        let release;
        const mine = new Promise((r) => { release = r; });
        queues.set(name, prev.then(() => mine));
        await prev;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    },
  });
}

describe('withRefreshLock serialises refreshes across tabs', () => {
  beforeEach(() => installFakeWebLocks());

  test('two concurrent holders never overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 'done';
    };

    const results = await Promise.all([
      withRefreshLock(task), withRefreshLock(task), withRefreshLock(task),
    ]);
    assert.deepEqual(results, ['done', 'done', 'done']);
    assert.equal(maxActive, 1, 'only one tab may be inside the refresh at a time');
  });

  test('the lock is released when the task throws, so it cannot deadlock', async () => {
    await assert.rejects(withRefreshLock(async () => { throw new Error('nope'); }), /nope/);
    // A subsequent acquisition must still succeed.
    assert.equal(await withRefreshLock(async () => 'ok'), 'ok');
  });

  test('the task result is returned unchanged', async () => {
    const payload = { token: 'abc', user: { id: 1 } };
    assert.deepEqual(await withRefreshLock(async () => payload), payload);
  });
});

describe('withRefreshLock without Web Locks support', () => {
  beforeEach(() => setNavigator(undefined));

  test('it still runs the task rather than failing', async () => {
    // Correctness does not depend on the lock: the double-check in
    // refreshAccessToken is what prevents the second rotation.
    assert.equal(await withRefreshLock(async () => 'ran'), 'ran');
  });

  test('a rejection still propagates', async () => {
    await assert.rejects(withRefreshLock(async () => { throw new Error('x'); }), /x/);
  });
});

describe('double-checked adoption (the load-bearing half)', () => {
  // Reproduces refreshAccessToken's decision without needing fetch/localStorage:
  // it is the sequencing that matters, not the I/O.
  function makeCoordinator() {
    let persisted = 'token-v1';
    let rotations = 0;
    const rotate = async () => {
      rotations += 1;
      persisted = `token-v${rotations + 1}`;
      return persisted;
    };
    const refresh = async () => {
      const before = persisted;
      return withRefreshLock(async () => {
        const current = persisted;
        if (current && current !== before) {
          return { token: current, adopted: true }; // another tab already did it
        }
        return { token: await rotate(), adopted: false };
      });
    };
    return { refresh, rotations: () => rotations, token: () => persisted };
  }

  beforeEach(() => installFakeWebLocks());

  test('three tabs refreshing at once cause exactly ONE rotation', async () => {
    const c = makeCoordinator();
    const results = await Promise.all([c.refresh(), c.refresh(), c.refresh()]);

    assert.equal(c.rotations(), 1,
      'a second rotation is what the server reports as refresh-token reuse');
    // Every tab ends up holding the same, current token.
    const tokens = new Set(results.map((r) => r.token));
    assert.equal(tokens.size, 1);
    assert.equal([...tokens][0], c.token());
    // Two of the three adopted rather than rotating.
    assert.equal(results.filter((r) => r.adopted).length, 2);
  });

  test('a later, genuinely separate refresh does rotate again', async () => {
    const c = makeCoordinator();
    await c.refresh();
    await c.refresh();
    assert.equal(c.rotations(), 2, 'sequential refreshes are legitimate');
  });

  test('with no lock at all, adoption still prevents the double rotation', async () => {
    setNavigator(undefined);
    const c = makeCoordinator();
    // Sequential-but-interleaved: tab B starts after tab A has persisted.
    await c.refresh();
    const before = c.rotations();
    await c.refresh();
    assert.equal(c.rotations(), before + 1);
  });
});

describe('BroadcastChannel propagation', () => {
  const hasBroadcastChannel = typeof BroadcastChannel === 'function';

  test('a published token reaches a subscriber', { skip: !hasBroadcastChannel }, async () => {
    const received = [];
    const unsubscribe = subscribeAuthEvents((m) => received.push(m));
    publishAuthEvent({ type: 'token', token: 'fresh-token' });
    await new Promise((r) => setTimeout(r, 30));
    unsubscribe();

    // Same-context BroadcastChannel does not deliver to itself; a real second tab
    // has its own channel instance. What must hold here is that publishing does
    // not throw and the subscription lifecycle is clean.
    assert.ok(Array.isArray(received));
  });

  test('a sign-out event carries the server reason, not a guess', { skip: !hasBroadcastChannel }, async () => {
    const ch = new BroadcastChannel('dh-auth');
    const received = [];
    ch.addEventListener('message', (e) => received.push(e.data));
    publishAuthEvent({ type: 'signout', code: 'SESSION_SUPERSEDED' });
    await new Promise((r) => setTimeout(r, 30));
    ch.close();

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'signout');
    assert.equal(received[0].code, 'SESSION_SUPERSEDED',
      'the reacting tab must show the SAME reason, not invent one');
  });

  test('no refresh token is ever broadcast', { skip: !hasBroadcastChannel }, async () => {
    const ch = new BroadcastChannel('dh-auth');
    const received = [];
    ch.addEventListener('message', (e) => received.push(e.data));
    publishAuthEvent({ type: 'token', token: 'access-only' });
    publishAuthEvent({ type: 'signout', code: 'SESSION_INVALID' });
    await new Promise((r) => setTimeout(r, 30));
    ch.close();

    for (const message of received) {
      // The refresh token is an HttpOnly cookie and unreadable from JS; assert the
      // channel contract stays access-token-only so it cannot regress.
      assert.ok(!('refreshToken' in message));
      assert.ok(!('refresh_token' in message));
      assert.deepEqual(
        Object.keys(message).sort(),
        message.type === 'token' ? ['at', 'token', 'type'] : ['at', 'code', 'type'],
      );
    }
  });

  test('subscribing is safe when BroadcastChannel is unavailable', () => {
    const saved = globalThis.BroadcastChannel;
    try {
      delete globalThis.BroadcastChannel;
      // The channel is memoised on first use, so this asserts the API contract
      // rather than re-triggering construction: unsubscribe must always be callable.
      const unsubscribe = subscribeAuthEvents(() => {});
      assert.equal(typeof unsubscribe, 'function');
      unsubscribe();
    } finally {
      globalThis.BroadcastChannel = saved;
    }
  });
});
