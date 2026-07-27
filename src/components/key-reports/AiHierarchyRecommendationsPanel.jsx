import { useCallback, useEffect, useState } from "react";
import { Sparkles, Loader2, Check, X, ArrowRight } from "lucide-react";
import {
  getHierarchyRecommendations,
  acceptHierarchyRecommendation,
  ignoreHierarchyRecommendation,
} from "../../lib/api";

function confidenceLabel(confidence) {
  const n = Number(confidence);
  if (!Number.isFinite(n)) return null;
  if (n >= 0.85) return { text: "High confidence", className: "bg-emerald-50 text-emerald-700" };
  if (n >= 0.7) return { text: "Medium confidence", className: "bg-amber-50 text-amber-700" };
  return { text: "Low confidence", className: "bg-bg-page text-text-muted" };
}

// Renders a hierarchy path as "A > B > C", inserting the recommended roll-up
// (when provided) directly above the account's own name — the last entry.
function HierarchyPath({ levels, insertBefore }) {
  const path = Array.isArray(levels) ? levels.filter(Boolean) : [];
  const own = path[path.length - 1];
  const ancestry = path.slice(0, -1);
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {ancestry.map((label, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="rounded-md bg-bg-page px-2 py-1 text-text-muted">{label}</span>
          <ArrowRight size={11} className="text-text-muted" />
        </span>
      ))}
      {insertBefore && (
        <span className="flex items-center gap-1">
          <span className="rounded-md border border-dashed border-primary bg-primary/5 px-2 py-1 font-medium text-primary">
            {insertBefore}
          </span>
          <ArrowRight size={11} className="text-text-muted" />
        </span>
      )}
      {own && <span className="rounded-md bg-white px-2 py-1 font-semibold text-text-primary">{own}</span>}
    </div>
  );
}

export default function AiHierarchyRecommendationsPanel({ versionId, notify }) {
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

  const handleAccept = async (recommendationId) => {
    setDecidingId(recommendationId);
    try {
      await acceptHierarchyRecommendation(recommendationId);
      notify?.("Recommendation accepted — Chart of Accounts updated.", "success");
      await load();
    } catch (e) {
      notify?.(e.message || "Failed to accept recommendation.", "error");
    } finally {
      setDecidingId(null);
    }
  };

  const handleIgnore = async (recommendationId) => {
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
  };

  const pending = recommendations.filter((r) => r.status === "pending");

  if (!loading && pending.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-white p-5">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-primary" />
        <span className="text-sm font-semibold text-text-primary">AI Hierarchy Recommendations</span>
        <span className="text-xs text-text-muted">
          — {loading ? "checking for suggestions…" : `${pending.length} recommendation${pending.length === 1 ? "" : "s"} found`}
        </span>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Optional roll-up suggestions for accounts that already have the correct classification.
        Nothing changes until you accept a suggestion below.
      </p>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading recommendations…
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {pending.map((rec) => {
            const conf = confidenceLabel(rec.confidence);
            const deciding = decidingId === rec.id;
            return (
              <div key={rec.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-text-primary">{rec.accountName}</span>
                  {conf && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${conf.className}`}>
                      {conf.text}
                    </span>
                  )}
                </div>

                <div className="mt-3 grid gap-2">
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Current</div>
                    <HierarchyPath levels={rec.currentHierarchy} />
                  </div>
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Suggested</div>
                    <HierarchyPath levels={rec.currentHierarchy} insertBefore={rec.recommendedRollup} />
                  </div>
                </div>

                {rec.reason && (
                  <p className="mt-3 text-xs text-text-muted">{rec.reason}</p>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => handleAccept(rec.id)}
                    disabled={deciding}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {deciding ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Accept
                  </button>
                  <button
                    onClick={() => handleIgnore(rec.id)}
                    disabled={deciding}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:bg-bg-page disabled:opacity-50"
                  >
                    <X size={12} />
                    Ignore
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
