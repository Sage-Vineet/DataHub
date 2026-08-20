import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFeatures } from './api';

/**
 * The feature payload the SPA renders from.
 *
 * The rule under test is the default. A backend kill switch only subtracts a
 * feature if the client treats "I could not find out" as "off" — treating it as
 * "on" is what leaves a dead nav entry and a spinner that never settles.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('fetchFeatures', () => {
  it('returns the feature set the gateway declares', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ status: 'ok', service: 'gateway', features: { qa: true, cim: false } }),
    }));

    await expect(fetchFeatures()).resolves.toEqual({ qa: true, cim: false });
  });

  it('returns an empty set when the gateway declares none', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ status: 'ok' }) }));

    // Empty, not undefined: every lookup then resolves to "off" rather than
    // throwing somewhere deep in a component.
    await expect(fetchFeatures()).resolves.toEqual({});
  });

  it('rejects on a non-OK response rather than reporting no features', async () => {
    // The distinction matters: an empty set and a failed request are different
    // facts, and only the provider gets to decide they both mean "off".
    stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));

    await expect(fetchFeatures()).rejects.toThrow(/503/);
  });

  it('rejects when the gateway is unreachable', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(fetchFeatures()).rejects.toThrow();
  });

  it('asks the gateway with credentials, so a cookie session is honoured', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ features: {} }) }));
    stubFetch(spy);

    await fetchFeatures();

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toMatch(/\/healthz$/);
    expect(init).toMatchObject({ credentials: 'include' });
  });
});
