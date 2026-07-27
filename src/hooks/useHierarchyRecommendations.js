import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getHierarchyRecommendations,
  acceptHierarchyRecommendation,
  ignoreHierarchyRecommendation,
} from "../lib/api";

// AI Hierarchy Recommendations — advisory-only suggestions generated after
// COA generation. Extracted from the old standalone AiHierarchyRecommendationsPanel
// so the tree editor can render them as inline per-node badges instead of a
// separate section. Fetching/accept/ignore behavior is unchanged.
export function useHierarchyRecommendations(versionId, notify) {
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
      notify?.(e.message || "Failed to load AI hierarchy recommendations.", "error");
      setRecommendations([]);
    } finally {
      setLoading(false);
    }
  }, [versionId, notify]);

  useEffect(() => { load(); }, [load]);

  const byAccountId = useMemo(() => {
    const m = new Map();
    for (const r of recommendations) if (r.status === "pending") m.set(r.accountId, r);
    return m;
  }, [recommendations]);

  const accept = useCallback(async (recommendationId) => {
    setDecidingId(recommendationId);
    try {
      await acceptHierarchyRecommendation(recommendationId);
      notify?.("Recommendation accepted — Chart of Accounts updated.", "success");
      await load();
      return true;
    } catch (e) {
      notify?.(e.message || "Failed to accept recommendation.", "error");
      return false;
    } finally {
      setDecidingId(null);
    }
  }, [load, notify]);

  const ignore = useCallback(async (recommendationId) => {
    setDecidingId(recommendationId);
    try {
      await ignoreHierarchyRecommendation(recommendationId);
      notify?.("Recommendation ignored.", "success");
      await load();
    } catch (e) {
      notify?.(e.message || "Failed to ignore recommendation.", "error");
    } finally {
      setDecidingId(null);
    }
  }, [load, notify]);

  return { recommendations, byAccountId, loading, decidingId, accept, ignore, reload: load };
}
