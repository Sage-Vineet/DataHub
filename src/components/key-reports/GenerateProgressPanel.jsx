/**
 * GenerateProgressPanel
 *
 * Shown while `handleGenerate` is in-flight and after it completes / fails.
 * While generating, it polls the backend for the REAL pipeline stage (derived
 * from the sync log markers, from "=== Sync started ===" to
 * "=== Sync complete ===") and advances the bar accordingly, so the percentage
 * reflects actual progress rather than a timer. The bar creeps within the
 * current stage's band for liveliness but never past the real stage, and
 * completes when the generation request resolves (status → "done").
 *
 * Props
 *   status        "idle" | "generating" | "done" | "error"
 *   versionId     string — version being generated (drives progress polling)
 *   startedAt     ISO string — when generation was kicked off
 *   finishedAt    ISO string — set on completion / error
 *   errorStage    string | null — stage key that failed (e.g. "ai_processing")
 *   errorMessage  string | null
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
import { getKeyReportGenerateProgress } from "../../lib/api";

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
    // key must keep matching the backend's own stage identifier
    // (keyReportProgress.js's STAGE_MARKERS) — only the user-facing
    // label/desc below are display text.
    key: "ai_processing",
    label: "Extracting Documents",
    desc: "Extracting financial data from uploaded documents…",
    Icon: Brain,
    weight: 28,
  },
  {
    key: "coa",
    label: "Generating Chart of Accounts",
    desc: "Matching accounts to your documents and building hierarchy…",
    Icon: BarChart3,
    weight: 15,
  },
  {
    key: "financial_reports",
    label: "Generating Financial Reports",
    desc: "Building Trial Balance, P&L, Balance Sheet, Cash Flow…",
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

// Map each stage key → its index, so a stage reported by the backend resolves
// to a position in STAGES / BREAKPOINTS.
const STAGE_INDEX_BY_KEY = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

// Animation / polling cadence.
const CREEP_PER_SEC = 5; // gentle within-stage fill so a long stage isn't frozen
const TICK_MS = 250;
const POLL_MS = 1200; // how often we ask the backend which stage it's really on
const STALL_AT = 98; // cap until the generation request actually resolves

// Target fill for a stage index: the END of that stage's weighted band, capped
// so the bar never claims completion before the request resolves (status→done).
function targetPctForStage(idx) {
  if (idx == null || idx < 0) return 0;
  return Math.min(STALL_AT, BREAKPOINTS[idx].end);
}

function formatTs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleTimeString();
}

// ── StageRow ─────────────────────────────────────────────────────────────────
function StageRow({ stage, stageStatus, errorMessage }) {
  const { label, desc, Icon } = stage;

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
            {stageStatus === "error" && errorMessage ? errorMessage : desc}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GenerateProgressPanel({
  status = "idle",
  versionId = null,
  startedAt = null,
  finishedAt = null,
  errorStage = null,
  errorMessage = null,
  onRetry,
}) {
  const [pct, setPct] = useState(0);
  const [stageIdx, setStageIdx] = useState(0);
  const pctRef = useRef(0);
  const stageIdxRef = useRef(0);
  // Seed the target at the first stage so the bar shows immediate motion while
  // the first poll is in flight (we ARE in "Preparing Data" at that point).
  const targetRef = useRef(targetPctForStage(0));

  // Poll the backend for the real pipeline stage while generating. Forward-only:
  // a transient poll failure or an out-of-order reply never rewinds the bar.
  useEffect(() => {
    if (status !== "generating" || !versionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await getKeyReportGenerateProgress(versionId);
        if (cancelled) return;
        const stage = res?.progress?.stage;
        const idx = stage != null ? STAGE_INDEX_BY_KEY[stage] : undefined;
        if (idx != null && idx >= stageIdxRef.current) {
          stageIdxRef.current = idx;
          setStageIdx(idx);
          targetRef.current = Math.max(targetRef.current, targetPctForStage(idx));
        }
      } catch {
        /* transient poll failure — keep last known progress */
      }
    };
    poll(); // fire immediately, then on an interval
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status, versionId]);

  // Creep the displayed percentage toward the current stage's target, bounded by
  // the real stage — the bar can never run ahead of what the backend reports.
  useEffect(() => {
    if (status !== "generating") return;
    const id = setInterval(() => {
      const step = (CREEP_PER_SEC * TICK_MS) / 1000;
      const next = Math.min(targetRef.current, pctRef.current + step);
      if (next !== pctRef.current) {
        pctRef.current = next;
        setPct(next);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [status]);

  const isGenerating = status === "generating";
  const isDone = status === "done";
  const isError = status === "error";

  const currentStageIdx = isGenerating
    ? stageIdx
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
