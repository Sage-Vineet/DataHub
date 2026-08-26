import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getHierarchyRecommendations,
  applyHierarchyRecommendation,
  rejectHierarchyRecommendation,
} from '../lib/api';

/**
 * The chart-of-accounts reasonableness review, from the client side.
 *
 * Ported from `data_room`. Advisory only: this hook LISTS recommendations and
 * records a decision. It never generates one and never edits a hierarchy — an
 * accepted recommendation is applied by the server, through the same path the
 * manual "Edit Chart of Accounts" grid uses.
 *
 * Statuses arrive uppercase: PENDING / APPLIED / REJECTED.
 *
 * Two deliberate differences from the original:
 *
 *  - No `clientId`, and no financials-cache invalidation. The original called
 *    `clearCachedFinancials(clientId, versionId)` after applying; that cache
 *    module does not exist on this branch, so there is nothing to clear and a
 *    parameter that existed only to address it would be dead weight. If a cache
 *    is introduced later, this is where it gets cleared.
 *
 *  - `apply` rather than `accept`. Both endpoints exist; `apply` reports a
 *    stale recommendation as a 409 body instead of a thrown error, which is
 *    what lets the message below be specific.
 *
 * Guard callers with `useFeature('coaReview')`: with the module off these paths
 * fall through to legacy, which does not serve them.
 */
export function useHierarchyRecommendations(versionId, notify) {
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [decidingId, setDecidingId] = useState(null);

  const load = useCallback(async () => {
    if (!versionId) {
      setRecommendations([]);
      return;
    }
    setLoading(true);
    try {
      const res = await getHierarchyRecommendations(versionId);
      setRecommendations(res?.recommendations || []);
    } catch (e) {
      notify?.(e.message || 'Failed to load review recommendations.', 'error');
      setRecommendations([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  // Deferred a microtask so the fetch's own setLoading does not run
  // synchronously inside the effect body — the same pattern the COA grid uses
  // for its own load.
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  const pending = useMemo(
    () => recommendations.filter((r) => r.status === 'PENDING'),
    [recommendations],
  );

  /** Pending recommendation per account, for an inline badge. */
  const byAccountId = useMemo(() => {
    const map = new Map();
    for (const r of pending) map.set(r.accountId, r);
    return map;
  }, [pending]);

  // The server already drops anything immaterial; this groups what survives so
  // the panel can lead with the confident ones.
  const byConfidence = useMemo(
    () => ({
      HIGH: pending.filter((r) => r.confidenceBand === 'HIGH'),
      MEDIUM: pending.filter((r) => r.confidenceBand === 'MEDIUM'),
      LOW: pending.filter((r) => r.confidenceBand === 'LOW'),
    }),
    [pending],
  );

  const accept = useCallback(
    async (recommendationId) => {
      setDecidingId(recommendationId);
      try {
        await applyHierarchyRecommendation(recommendationId);
        notify?.('Recommendation applied — Chart of Accounts updated.', 'success');
        await load();
        return true;
      } catch (e) {
        // A 409 means the account changed since the recommendation was made.
        // Given its own message because the fix is to re-run the check, not to
        // retry the same stale proposal — and reloading here is what makes the
        // stale row disappear from the list rather than sit there re-failing.
        const stale = e?.status === 409 || /changed since/i.test(e?.rawMessage || e?.message || '');
        notify?.(
          stale
            ? 'This account has changed since the recommendation was generated. Re-run the reasonableness check for an up-to-date suggestion.'
            : e.message || 'Failed to apply recommendation.',
          'error',
        );
        if (stale) await load();
        return false;
      } finally {
        setDecidingId(null);
      }
    },
    [load, notify],
  );

  const ignore = useCallback(
    async (recommendationId, reason = null) => {
      setDecidingId(recommendationId);
      try {
        await rejectHierarchyRecommendation(recommendationId, reason);
        notify?.('Recommendation rejected — Chart of Accounts unchanged.', 'success');
        await load();
        return true;
      } catch (e) {
        notify?.(e.message || 'Failed to reject recommendation.', 'error');
        return false;
      } finally {
        setDecidingId(null);
      }
    },
    [load, notify],
  );

  return {
    recommendations,
    pending,
    byAccountId,
    byConfidence,
    loading,
    decidingId,
    accept,
    ignore,
    reload: load,
  };
}
