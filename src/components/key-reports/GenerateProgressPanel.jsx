/**
 * GenerateProgressPanel
 *
 * Shown while `handleGenerate` is in-flight and after it completes / fails.
 * Simulates stage-by-stage progress via a time-based ticker (the backend is a
 * single synchronous request today) — structured so swapping the ticker for
 * real SSE / WebSocket events requires no further component changes.
 *
 * When a `progress` prop with a numeric `pct` is supplied (real backend progress
 * polled from the /generate-progress endpoint), the bar and active stage are
 * driven by that REAL pipeline position. When it is absent (older backend, a
 * lost/restarted run, or before the first poll lands) the component falls back
 * to the time-based ticker so it still animates.
 *
 * Props
 *   status        "idle" | "generating" | "done" | "error"
 *   startedAt     ISO string — when generation was kicked off
 *   finishedAt    ISO string — set on completion / error
 *   errorStage    string | null — stage key that failed (e.g. "ai_processing")
 *   errorMessage  string | null
 *   progress      { stageKey, stageLabel, pct, message } | null — live backend progress
 *   onRetry       () => void — called when the user clicks Retry
 */

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Zap,
  Database,
  Brain,
  BarChart3,
  FileText,
  Camera,
  ShieldCheck,
  PartyPopper,
  RefreshCw,
} from "lucide-react";
import { cn } from "../../lib/utils";

// ── Stage definitions ─────────────────────────────────────────────────────────
const STAGES = [
  {
    key: "preparing",
    label: "Preparing Data",
    desc: "Validating linked files…",
    Icon: Database,
    weight: 8,
  },
  {
    key: "reading_gl",
    label: "Reading GL",
    desc: "Loading General Ledger entries…",
    Icon: FileText,
    weight: 15,
  },
  {
    key: "ai_processing",
    label: "Processing AI",
    desc: "Extracting financial data with Gemini…",
    Icon: Brain,
    weight: 28,
  },
  {
    key: "coa",
    label: "Generating Chart of Accounts",
    desc: "Classifying accounts and building hierarchy…",
    Icon: BarChart3,
    weight: 15,
  },
  {
    key: "financial_reports",
    label: "Generating Financial Reports",
    desc: "Building P&L, Balance Sheet, Cash Flow…",
    Icon: FileText,
    weight: 14,
  },
  {
    key: "snapshots",
    label: "Creating Snapshots",
    desc: "Persisting report snapshots…",
    Icon: Camera,
    weight: 10,
  },
  {
    key: "validation",
    label: "Validation",
    desc: "Running data quality checks…",
    Icon: ShieldCheck,
    weight: 8,
  },
  {
    key: "completed",
    label: "Completed",
    desc: "All reports are ready.",
    Icon: PartyPopper,
    weight: 2,
  },
];

// Compute cumulative breakpoints [0..100] for each stage boundary.
const totalWeight = STAGES.reduce((s, st) => s + st.weight, 0);
let _cum = 0;
const BREAKPOINTS = STAGES.map((st) => {
  const start = _cum;
  _cum += (st.weight / totalWeight) * 100;
  return { start, end: _cum };
});

// Animation speed
const PCT_PER_SEC = 9; // ~11 s to reach STALL_AT
const TICK_MS = 250;
const STALL_AT = 98; // freeze here until API resolves

function computeStageIndex(pct) {
  for (let i = BREAKPOINTS.length - 1; i >= 0; i--) {
    if (pct >= BREAKPOINTS[i].start) return i;
  }
  return 0;
}

function stageIndexOfKey(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx >= 0 ? idx : -1;
}

function formatTs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleTimeString();
}

// ── StageRow ─────────────────────────────────────────────────────────────────
function StageRow({ stage, stageStatus, errorMessage, liveMessage }) {
  const { label, desc, Icon } = stage;
  // Prefer the live backend message on the active row when one is available.
  const activeDesc = liveMessage || desc;

  const iconBg =
    stageStatus === "done"
      ? "bg-emerald-500"
      : stageStatus === "active"
      ? "bg-primary"
      : stageStatus === "error"
      ? "bg-red-500"
      : "bg-gray-200";

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl px-3 py-2.5 transition-all",
        stageStatus === "active" && "bg-primary/5 ring-1 ring-primary/20",
        stageStatus === "done" && "bg-emerald-50/60",
        stageStatus === "error" && "bg-red-50 ring-1 ring-red-200",
        stageStatus === "idle" && "opacity-40"
      )}
    >
      {/* Status icon */}
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full",
          iconBg
        )}
      >
        {stageStatus === "done" ? (
          <CheckCircle2 size={13} className="text-white" />
        ) : stageStatus === "active" ? (
          <Loader2 size={13} className="animate-spin text-white" />
        ) : stageStatus === "error" ? (
          <AlertCircle size={13} className="text-white" />
        ) : (
          <Icon size={13} className="text-gray-400" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[13px] font-semibold leading-snug",
            stageStatus === "done"
              ? "text-emerald-700"
              : stageStatus === "active"
              ? "text-primary"
              : stageStatus === "error"
              ? "text-red-700"
              : "text-text-muted"
          )}
        >
          {label}
        </p>
        {(stageStatus === "active" || stageStatus === "error") && (
          <p
            className={cn(
              "mt-0.5 text-[11px] leading-relaxed",
              stageStatus === "error" ? "text-red-600" : "text-text-secondary"
            )}
          >
            {stageStatus === "error" && errorMessage ? errorMessage : activeDesc}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GenerateProgressPanel({
  status = "idle",
  startedAt = null,
  finishedAt = null,
  errorStage = null,
  errorMessage = null,
  progress = null,
  onRetry,
}) {
  // Single monotonic percentage source. The interval below advances it — either
  // following the real backend target (when available) or simulating progress as
  // a fallback — and never lets it move backward. Resets on remount, which the
  // parent forces per run via `key={startedAt}`.
  const [pct, setPct] = useState(0);
  const tickerRef = useRef(null);
  const pctRef = useRef(0);

  // Real backend progress takes precedence over the simulated ticker whenever a
  // numeric percentage is available for an in-flight run.
  const hasRealProgress =
    status === "generating" && progress && Number.isFinite(progress.pct);

  // Mirror the latest real target into a ref so the interval callback reads the
  // freshest value without needing to be torn down and recreated on every poll.
  const realPctRef = useRef(null);
  useEffect(() => {
    realPctRef.current = hasRealProgress ? progress.pct : null;
  }, [hasRealProgress, progress]);

  useEffect(() => {
    if (status === "generating") {
      tickerRef.current = setInterval(() => {
        const realTarget = realPctRef.current;
        let next;
        if (realTarget != null) {
          // Follow the real backend progress; never move backward, never exceed it.
          next = Math.max(pctRef.current, Math.min(STALL_AT, realTarget));
        } else {
          // Fallback: simulate progress until real data (or completion) arrives.
          next = Math.min(STALL_AT, pctRef.current + (PCT_PER_SEC * TICK_MS) / 1000);
        }
        pctRef.current = next;
        setPct(next);
      }, TICK_MS);
    } else if (tickerRef.current) {
      clearInterval(tickerRef.current);
    }
    return () => {
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [status]);

  const isGenerating = status === "generating";
  const isDone = status === "done";
  const isError = status === "error";

  const currentStageIdx = isGenerating
    ? hasRealProgress && stageIndexOfKey(progress.stageKey) >= 0
      ? stageIndexOfKey(progress.stageKey)
      : computeStageIndex(pct)
    : isDone
    ? STAGES.length - 1
    : isError
    ? (() => {
        const idx = STAGES.findIndex((s) => s.key === errorStage);
        return idx >= 0 ? idx : 2; // default to ai_processing
      })()
    : -1;

  const stageStatusOf = (i) => {
    if (status === "idle") return "idle";
    if (isError) {
      if (i < currentStageIdx) return "done";
      if (i === currentStageIdx) return "error";
      return "idle";
    }
    if (isDone) return "done";
    if (i < currentStageIdx) return "done";
    if (i === currentStageIdx) return "active";
    return "idle";
  };

  const displayPct = isDone ? 100 : Math.round(pct);

  const currentStageLabel =
    isGenerating && currentStageIdx >= 0
      ? STAGES[currentStageIdx]?.label
      : isDone
      ? "All stages complete"
      : isError
      ? "Generation stopped"
      : "";

  return (
    <div className="space-y-4">
      {/* ── Header card ─────────────────────────────────────────────── */}
      <div
        className={cn(
          "rounded-2xl border p-5 shadow-sm transition-all",
          isGenerating && "border-primary/20 bg-gradient-to-br from-white to-[#F8FBF3]",
          isDone && "border-emerald-200 bg-gradient-to-br from-white to-emerald-50/40",
          isError && "border-red-200 bg-red-50/40",
          status === "idle" && "border-border bg-white"
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
                isGenerating && "bg-primary/10",
                isDone && "bg-emerald-100",
                isError && "bg-red-100",
                status === "idle" && "bg-bg-page"
              )}
            >
              {isGenerating && <Zap size={15} className="text-primary" />}
              {isDone && <CheckCircle2 size={15} className="text-emerald-600" />}
              {isError && <AlertCircle size={15} className="text-red-600" />}
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                Generate Workflow
              </p>
              <h2 className="mt-0.5 text-sm font-bold text-text-primary">
                {isGenerating
                  ? "Generating…"
                  : isDone
                  ? "Generation Complete"
                  : isError
                  ? "Generation Failed"
                  : ""}
              </h2>
            </div>
          </div>

          <span
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold",
              isGenerating && "border-primary/20 bg-primary/10 text-primary",
              isDone && "border-emerald-200 bg-emerald-100 text-emerald-700",
              isError && "border-red-200 bg-red-100 text-red-700"
            )}
          >
            {isGenerating ? `${displayPct}%` : isDone ? "Complete" : isError ? "Failed" : ""}
          </span>
        </div>

        {/* Subtitle */}
        <p className="mt-2 text-sm text-text-secondary">
          {isGenerating
            ? "Your data is being generated. This may take a few minutes. The application will automatically update when processing completes."
            : isDone
            ? "All financial reports are ready. Click Open Reports to view them."
            : isError
            ? "A stage failed. Review the error below and click Retry."
            : ""}
        </p>

        {/* Timestamps */}
        {startedAt && (
          <p className="mt-1 text-xs text-text-muted">
            Started {formatTs(startedAt)}
            {finishedAt && ` · Finished ${formatTs(finishedAt)}`}
          </p>
        )}

        {/* Progress bar */}
        {(isGenerating || isDone || isError) && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[11px] text-text-muted">
              <span>{currentStageLabel}</span>
              <span className="tabular-nums font-semibold">{displayPct}%</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-300",
                  isDone ? "bg-emerald-500" : isError ? "bg-red-400" : "bg-primary"
                )}
                style={{ width: `${displayPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Stage list ──────────────────────────────────────────────── */}
      {/* Hidden once generation is complete — the "Generation Complete" header
          card above already conveys the finished state; the per-stage list is
          only useful while running or when a stage failed (to show which + Retry). */}
      {(isGenerating || isError) && (
        <div className="rounded-2xl border border-border bg-white p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
            Progress
          </p>
          <div className="space-y-1">
            {STAGES.map((stage, i) => (
              <StageRow
                key={stage.key}
                stage={stage}
                stageStatus={stageStatusOf(i)}
                errorMessage={i === currentStageIdx && isError ? errorMessage : null}
                liveMessage={
                  i === currentStageIdx && isGenerating && hasRealProgress
                    ? progress.message
                    : null
                }
              />
            ))}
          </div>

          {/* Retry */}
          {isError && onRetry && (
            <div className="mt-4 flex justify-end">
              <button
                onClick={onRetry}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <RefreshCw size={14} />
                Retry Generation
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
