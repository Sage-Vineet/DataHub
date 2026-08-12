/**
 * Cross-tab authentication coordination.
 *
 * ── THE RACE THIS FIXES ─────────────────────────────────────────────────────
 * Refresh-token rotation is single-use by design: rotateRefreshToken overwrites
 * the stored jti hash and the update is conditional on the presented hash still
 * being current. Its own comment states the consequence — "two concurrent
 * refreshes race here and exactly one wins. The loser sees zero updated rows and
 * is treated as a replay" — which revokes the entire token family as
 * `reuse_detected`.
 *
 * api.js guarded this with a module-scoped `refreshInFlight` promise, but a
 * module scope is PER TAB. Two tabs of the app are two independent memory
 * contexts, so both could refresh at once: tab A rotates, tab B presents the
 * now-stale cookie, and the server correctly concludes replay and kills the
 * family. Both tabs get signed out, and the cause looks like a security incident
 * when it was ordinary concurrency.
 *
 * ── HOW IT IS FIXED ─────────────────────────────────────────────────────────
 * Two independent mechanisms, so correctness does not depend on either alone:
 *
 *   1. A cross-tab mutex around the refresh, via the Web Locks API. Only one tab
 *      performs the network call at a time.
 *   2. DOUBLE-CHECKED ADOPTION inside the lock. Before calling the server, the
 *      holder re-reads the persisted access token. If it changed while the tab
 *      was queued, another tab has already refreshed — so it adopts that result
 *      and performs NO second rotation. This is what actually prevents the
 *      replay, and it keeps working even where Web Locks is unavailable.
 *
 * A BroadcastChannel then pushes the new token (and any sign-out) to sibling
 * tabs immediately, so their in-memory copies never go stale.
 *
 * Nothing here stores a refresh token: that is an HttpOnly cookie the browser
 * sends on its own and JavaScript cannot read. Only the short-lived access token
 * crosses this channel, and only between same-origin tabs of this app.
 */

const CHANNEL_NAME = 'dh-auth';
const REFRESH_LOCK = 'dh-auth-refresh';

/** Milliseconds a refresh may hold the lock before other tabs stop waiting. */
const LOCK_TIMEOUT_MS = 15_000;

let channel = null;

function getChannel() {
  if (channel !== null) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : false;
    // Node's BroadcastChannel holds a libuv handle that keeps the event loop
    // alive, so a memoised channel would stop any Node process (a test runner, a
    // future SSR/prerender pass) from ever exiting. Browsers have no unref() and
    // need none — the channel dies with the tab. Guarded so it is a no-op there.
    if (channel && typeof channel.unref === 'function') channel.unref();
  } catch {
    channel = false; // unsupported / blocked — the storage event still covers logout
  }
  return channel;
}

/**
 * Close the channel and forget it. Only needed by tests and by any non-browser
 * host that must shut down cleanly; a browser tab never calls this.
 */
export function closeAuthChannel() {
  if (channel && typeof channel.close === 'function') {
    try { channel.close(); } catch { /* already closed */ }
  }
  channel = null;
}

/**
 * Publish an auth event to every other tab.
 * @param {{type: 'token'|'signout', token?: string|null, code?: string|null}} message
 */
export function publishAuthEvent(message) {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ ...message, at: Date.now() });
  } catch {
    /* channel closed — non-fatal, the receiving tab still has its own timers */
  }
}

/**
 * Subscribe to auth events from other tabs.
 * @param {(message: {type: string, token?: string|null, code?: string|null}) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribeAuthEvents(handler) {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (event) => {
    const data = event?.data;
    if (data && typeof data.type === 'string') handler(data);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

const hasWebLocks = () =>
  typeof navigator !== 'undefined' &&
  navigator.locks &&
  typeof navigator.locks.request === 'function';

/**
 * Run `task` while holding the cross-tab refresh lock.
 *
 * Falls back to running `task` directly when Web Locks is unavailable. That
 * fallback is safe because the caller's double-check (see refreshAccessToken)
 * is what prevents a second rotation — the lock only reduces how often two tabs
 * reach the network at the same moment.
 *
 * A held lock is abandoned after LOCK_TIMEOUT_MS so a crashed or suspended tab
 * cannot deadlock the others. Web Locks are released automatically when a tab
 * dies, so this timeout only guards a tab that is alive but wedged.
 */
export async function withRefreshLock(task) {
  if (!hasWebLocks()) return task();

  let timeoutId = null;
  try {
    return await navigator.locks.request(REFRESH_LOCK, { mode: 'exclusive' }, async () => {
      const guarded = Promise.race([
        task(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(Object.assign(new Error('Refresh lock timed out'), { transient: true })),
            LOCK_TIMEOUT_MS,
          );
        }),
      ]);
      return await guarded;
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
