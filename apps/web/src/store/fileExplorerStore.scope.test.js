import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearScopedFileExplorerState, getScopedStorageName } from './fileExplorerStore';

/**
 * Per-user scoping of the file-explorer cache.
 *
 * This store persists `tree` and `folderAccess`, and `folderAccess` is what
 * drives the client-side permission gate. Under a single global key, the next
 * person to sign in on a shared device inherited both — a demo tablet or a
 * hot-desk browser is enough to reproduce it.
 */

function stubStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
  };
  // Object.keys(window.localStorage) has to enumerate the entries, the way it
  // does on a real Storage object.
  const proxy = new Proxy(storage, {
    ownKeys: () => [...data.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (target, prop) =>
      prop in target ? target[prop] : data.has(String(prop)) ? data.get(String(prop)) : undefined,
  });
  vi.stubGlobal('window', { localStorage: proxy });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getScopedStorageName', () => {
  it('keys the cache to the signed-in user', () => {
    stubStorage({ 'datahub.activeUserId': 'user-1' });

    expect(getScopedStorageName()).toBe('leo-file-explorer:user-1');
  });

  it('gives two users two different keys', () => {
    stubStorage({ 'datahub.activeUserId': 'user-1' });
    const first = getScopedStorageName();
    stubStorage({ 'datahub.activeUserId': 'user-2' });

    expect(getScopedStorageName()).not.toBe(first);
  });

  it('falls back to an anonymous key before anyone signs in', () => {
    stubStorage({});

    expect(getScopedStorageName()).toBe('leo-file-explorer:anon');
  });

  it('survives storage being unavailable', () => {
    // Private browsing, or a locked-down browser. Nothing persists, so nothing
    // leaks — the key just has to not throw on the way there.
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('access denied');
      },
    });

    expect(getScopedStorageName()).toBe('leo-file-explorer:anon');
  });
});

describe('clearScopedFileExplorerState', () => {
  let data;

  beforeEach(() => {
    data = stubStorage({
      'leo-file-explorer:user-1': '{"tree":{},"folderAccess":{}}',
      'leo-file-explorer:user-2': '{"tree":{}}',
      'leo-file-explorer:anon': '{}',
      'datahub.activeUserId': 'user-1',
      'unrelated-key': 'keep me',
    });
  });

  it('forgets every user’s cached tree and grants', () => {
    clearScopedFileExplorerState();

    expect(data.has('leo-file-explorer:user-1')).toBe(false);
    expect(data.has('leo-file-explorer:user-2')).toBe(false);
    expect(data.has('leo-file-explorer:anon')).toBe(false);
  });

  it('leaves everything else alone', () => {
    clearScopedFileExplorerState();

    expect(data.get('unrelated-key')).toBe('keep me');
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('access denied');
      },
    });

    expect(() => clearScopedFileExplorerState()).not.toThrow();
  });
});
