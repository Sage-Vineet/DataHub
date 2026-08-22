// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHierarchyRecommendations } from './useHierarchyRecommendations';

/**
 * The client half of the reasonableness review.
 *
 * The behaviour worth pinning is what happens when a decision fails. A 409
 * means the account moved since the recommendation was generated, and the right
 * response is neither a retry nor a generic error — it is a specific message
 * and a reload, so the stale row leaves the list instead of sitting there
 * re-failing. Everything else here is listing and grouping.
 *
 * Per-file jsdom: this package's suite runs in `node` and relies on Node's
 * Blob/TextDecoder elsewhere, so the environment is opted into where a DOM is
 * actually needed rather than switched on globally.
 */

vi.mock('../lib/api', () => ({
  getHierarchyRecommendations: vi.fn(),
  applyHierarchyRecommendation: vi.fn(),
  rejectHierarchyRecommendation: vi.fn(),
}));

const api = await import('../lib/api');

const reco = (over = {}) => ({
  id: 'r1',
  accountId: 'acc-1',
  accountName: 'Interest Income',
  status: 'PENDING',
  confidenceBand: 'HIGH',
  currentHierarchy: ['Net Income', 'Income', 'Interest Income'],
  recommendedHierarchy: ['Net Income', 'Other Income', 'Interest Income'],
  ...over,
});

beforeEach(() => {
  api.getHierarchyRecommendations.mockResolvedValue({ recommendations: [reco()] });
  api.applyHierarchyRecommendation.mockResolvedValue({ success: true });
  api.rejectHierarchyRecommendation.mockResolvedValue({ success: true });
});

afterEach(() => {
  // Explicit, because this package has no vitest setup file — so
  // testing-library's automatic cleanup never registers and every rendered hook
  // stays mounted. They accumulate across cases and the later ones then hang
  // inside `act`, which is a confusing way to learn this.
  cleanup();
  vi.clearAllMocks();
});

describe('loading', () => {
  it('lists recommendations for the version', async () => {
    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', vi.fn()));

    await waitFor(() => expect(result.current.recommendations).toHaveLength(1));
    expect(api.getHierarchyRecommendations).toHaveBeenCalledWith('ver-1');
    expect(result.current.loading).toBe(false);
  });

  it('does not call the API without a version', async () => {
    // Which is also how the grid switches the feature off: it passes null when
    // the module is not mounted, so nothing requests a path legacy cannot serve.
    const { result } = renderHook(() => useHierarchyRecommendations(null, vi.fn()));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getHierarchyRecommendations).not.toHaveBeenCalled();
    expect(result.current.recommendations).toEqual([]);
  });

  it('reports a load failure and shows an empty list rather than stale rows', async () => {
    api.getHierarchyRecommendations.mockRejectedValue(new Error('gateway down'));
    const notify = vi.fn();

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));

    await waitFor(() => expect(notify).toHaveBeenCalledWith('gateway down', 'error'));
    expect(result.current.recommendations).toEqual([]);
  });
});

describe('grouping', () => {
  it('counts only pending rows, and indexes them by account', async () => {
    api.getHierarchyRecommendations.mockResolvedValue({
      recommendations: [
        reco({ id: 'r1', status: 'PENDING' }),
        reco({ id: 'r2', accountId: 'acc-2', status: 'APPLIED' }),
        reco({ id: 'r3', accountId: 'acc-3', status: 'REJECTED' }),
      ],
    });

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', vi.fn()));

    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    // A decided recommendation is history, not a queue item.
    expect(result.current.byAccountId.get('acc-1')?.id).toBe('r1');
    expect(result.current.byAccountId.has('acc-2')).toBe(false);
  });

  it('splits pending rows by confidence band', async () => {
    api.getHierarchyRecommendations.mockResolvedValue({
      recommendations: [
        reco({ id: 'h', confidenceBand: 'HIGH' }),
        reco({ id: 'm', confidenceBand: 'MEDIUM' }),
        reco({ id: 'l1', confidenceBand: 'LOW' }),
        reco({ id: 'l2', confidenceBand: 'LOW' }),
      ],
    });

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', vi.fn()));

    await waitFor(() => expect(result.current.pending).toHaveLength(4));
    expect(result.current.byConfidence.HIGH).toHaveLength(1);
    expect(result.current.byConfidence.MEDIUM).toHaveLength(1);
    expect(result.current.byConfidence.LOW).toHaveLength(2);
  });

  it('tolerates a response with no recommendations key', async () => {
    api.getHierarchyRecommendations.mockResolvedValue({});
    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', vi.fn()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recommendations).toEqual([]);
  });
});

describe('accept', () => {
  it('applies, reports success, and refetches', async () => {
    const notify = vi.fn();
    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    // Counted from a baseline rather than absolutely: how many times the mount
    // effect fires is React's business, and asserting a total makes this test
    // fail for reasons that have nothing to do with accepting.
    const before = api.getHierarchyRecommendations.mock.calls.length;

    let ok;
    await act(async () => {
      ok = await result.current.accept('r1');
    });

    expect(ok).toBe(true);
    expect(api.applyHierarchyRecommendation).toHaveBeenCalledWith('r1');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('applied'), 'success');
    expect(api.getHierarchyRecommendations.mock.calls.length).toBe(before + 1);
  });

  it('gives a 409 its own message and reloads, so the stale row leaves the list', async () => {
    // The whole point of the distinction: retrying a stale proposal cannot
    // work, and telling the reviewer to re-run the check is different advice
    // from telling them it failed.
    const stale = Object.assign(new Error('Conflict'), { status: 409 });
    api.applyHierarchyRecommendation.mockRejectedValue(stale);
    const notify = vi.fn();

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    const before = api.getHierarchyRecommendations.mock.calls.length;

    let ok;
    await act(async () => {
      ok = await result.current.accept('r1');
    });

    expect(ok).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Re-run the reasonableness check'),
      'error',
    );
    // Reloaded, which is what removes the stale row from the queue.
    expect(api.getHierarchyRecommendations.mock.calls.length).toBe(before + 1);
  });

  it('recognises staleness from the raw message when no status survived', async () => {
    // `request()` rewrites `message` for humans but keeps `rawMessage`; a
    // proxy or a transport error can drop the status entirely.
    const stale = Object.assign(new Error('Something went wrong'), {
      rawMessage: 'This account has changed since the recommendation was generated.',
    });
    api.applyHierarchyRecommendation.mockRejectedValue(stale);
    const notify = vi.fn();

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await act(async () => {
      await result.current.accept('r1');
    });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Re-run the reasonableness check'),
      'error',
    );
  });

  it('reports an ordinary failure as itself, and does not reload', async () => {
    api.applyHierarchyRecommendation.mockRejectedValue(new Error('That was unsafe.'));
    const notify = vi.fn();

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    const before = api.getHierarchyRecommendations.mock.calls.length;
    await act(async () => {
      await result.current.accept('r1');
    });

    expect(notify).toHaveBeenCalledWith('That was unsafe.', 'error');
    // No refetch: nothing changed server-side, so one would just be noise.
    expect(api.getHierarchyRecommendations.mock.calls.length).toBe(before);
  });

  it('clears the deciding indicator whichever way it goes', async () => {
    api.applyHierarchyRecommendation.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', vi.fn()));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    await act(async () => {
      await result.current.accept('r1');
    });

    expect(result.current.decidingId).toBeNull();
  });
});

describe('reject', () => {
  it('records a reason and refetches', async () => {
    const notify = vi.fn();
    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    const before = api.getHierarchyRecommendations.mock.calls.length;

    await act(async () => {
      await result.current.ignore('r1', 'intentional for this client');
    });

    expect(api.rejectHierarchyRecommendation).toHaveBeenCalledWith(
      'r1',
      'intentional for this client',
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('unchanged'), 'success');
    expect(api.getHierarchyRecommendations.mock.calls.length).toBe(before + 1);
  });

  it('reports a failure without pretending the decision was recorded', async () => {
    api.rejectHierarchyRecommendation.mockRejectedValue(new Error('write failed'));
    const notify = vi.fn();

    const { result } = renderHook(() => useHierarchyRecommendations('ver-1', notify));
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    let ok;
    await act(async () => {
      ok = await result.current.ignore('r1');
    });

    expect(ok).toBe(false);
    expect(notify).toHaveBeenCalledWith('write failed', 'error');
  });
});
