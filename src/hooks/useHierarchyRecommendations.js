import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getHierarchyRecommendations,
  applyHierarchyRecommendation,
  rejectHierarchyRecommendation,
} from "../lib/api";
import { clearCachedFinancials } from "../lib/keyReportFinancials";

// AI Reasonableness Check — advisory-only recommendations generated after the
// deterministic COA has been built. This hook only ever LISTS them and records
// a user's decision; it never generates or modifies a hierarchy itself.
//
// Statuses come back from the API uppercase: PENDING / APPLIED / REJECTED.
export function useHierarchyRecommendations(clientId, versionId, notify) {
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [decidingId, setDecidingId] = useState(null);

  const load = useCallback(async () => {
    if (!versionId) { setRecommendations([]); return; }
    setLoading(true);
    try {
      const res = await getHierarchyRecommendations(versionId);
      setRecommendations(res?.recommendations || []);
    } catch (e) {
      notify?.(e.message || "Failed to load AI recommendations.", "error");
      setRecommendations([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  // Deferred a microtask so the fetch's own setLoading doesn't run
  // synchronously inside the effect body — same pattern ChartOfAccountsGrid
  // already uses for its COA load.
  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  const pending = useMemo(
    () => recommendations.filter((r) => r.status === "PENDING"),
    [recommendations],
  );

  const byAccountId = useMemo(() => {
    const m = new Map();
    for (const r of pending) m.set(r.accountId, r);
    return m;
  }, [pending]);

  // Only recommendations that can materially move a statement are worth
  // putting in front of a reviewer; the backend already filters, this groups
  // what survives so the panel can lead with the confident ones.
  const byConfidence = useMemo(() => ({
    HIGH: pending.filter((r) => r.confidenceBand === "HIGH"),
    MEDIUM: pending.filter((r) => r.confidenceBand === "MEDIUM"),
    LOW: pending.filter((r) => r.confidenceBand === "LOW"),
  }), [pending]);

  const accept = useCallback(async (recommendationId) => {
    setDecidingId(recommendationId);
    try {
      await applyHierarchyRecommendation(recommendationId);
      clearCachedFinancials(clientId, versionId);
      notify?.("Recommendation applied — Chart of Accounts updated.", "success");
      await load();
      return true;
    } catch (e) {
      // A 409 means the account changed since the recommendation was made.
      // Surfaced as its own message: the fix is to re-run the check, not to
      // retry the same stale proposal.
      const stale = e?.status === 409 || /changed since/i.test(e?.message || "");
      notify?.(
        stale
          ? "This account has changed since the recommendation was generated. Re-run the reasonableness check for an up-to-date suggestion."
          : (e.message || "Failed to apply recommendation."),
        "error",
      );
      if (stale) await load();
      return false;
    } finally {
      setDecidingId(null);
    }
  }, [load, notify, clientId, versionId]);

  const ignore = useCallback(async (recommendationId, reason = null) => {
    setDecidingId(recommendationId);
    try {
      await rejectHierarchyRecommendation(recommendationId, reason);
      notify?.("Recommendation rejected — Chart of Accounts unchanged.", "success");
      await load();
    } catch (e) {
      notify?.(e.message || "Failed to reject recommendation.", "error");
    } finally {
      setDecidingId(null);
    }
  }, [load, notify]);

  return { recommendations, pending, byAccountId, byConfidence, loading, decidingId, accept, ignore, reload: load };
}
