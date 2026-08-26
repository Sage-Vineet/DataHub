import { useEffect } from "react";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { cn } from "../../lib/utils";

const STAGES = [
  { id: "upload",   label: "Uploading Files" },
  { id: "stage",    label: "Staging Transactions" },
  { id: "validate", label: "Validating Data" },
  { id: "prepare",  label: "Preparing Reports" },
];

function stageIndex(id) {
  return STAGES.findIndex((s) => s.id === id);
}

/**
 * Full-screen overlay progress modal for the GL staging pipeline.
 *
 * @param {{ isActive, stage, message, pct, error }} progress
 *   stage: "upload" | "stage" | "validate" | "prepare" | "complete" | "error"
 *   pct  : 0-100
 *   error: string | null
 */
export default function StagingProgressModal({ progress }) {
  const { isActive = false, stage = "upload", message = "", pct = 0, error = null } = progress || {};

  // Lock body scroll while active.
  useEffect(() => {
    if (isActive) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [isActive]);

  if (!isActive) return null;

  const isError    = stage === "error";
  const isComplete = stage === "complete";
  const curIdx     = stageIndex(stage);
  const clampedPct = Math.min(100, Math.max(0, pct));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />

      {/* Card */}
      <div
        className="relative w-full max-w-md rounded-2xl border border-border bg-bg-card p-6 shadow-2xl"
        style={{ animation: "stagingFadeIn 200ms ease-out both" }}
      >
        {/* Icon + title */}
        <div className="mb-5 text-center">
          <div
            className={cn(
              "mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full",
              isError    ? "bg-red-100"   :
              isComplete ? "bg-green-100" :
                           "bg-primary/12",
            )}
          >
            {isError ? (
              <AlertCircle size={22} className="text-red-600" />
            ) : isComplete ? (
              <CheckCircle2 size={22} className="text-green-600" />
            ) : (
              <Loader2 size={22} className="animate-spin text-primary" />
            )}
          </div>
          <h3 className="text-[17px] font-semibold text-text-primary">
            {isError ? "Staging Failed" : isComplete ? "Staging Complete" : "Processing…"}
          </h3>
          <p className="mt-1 text-[13px] text-text-secondary leading-relaxed">
            {message || "Please wait while your data is being processed."}
          </p>
        </div>

        {/* Progress bar */}
        {!isError && (
          <div className="mb-5">
            <div className="mb-1.5 flex items-center justify-between text-[12px] text-text-secondary">
              <span>{isComplete ? "Completed" : "Progress"}</span>
              <span className="font-semibold text-text-primary">{Math.round(clampedPct)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-bg-page">
              <div
                className={cn(
                  "h-full rounded-full",
                  isComplete ? "bg-green-500" : "bg-primary",
                )}
                style={{
                  width: `${clampedPct}%`,
                  transition: "width 600ms cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              />
            </div>
          </div>
        )}

        {/* Stage checklist */}
        {!isError && (
          <div className="space-y-1.5">
            {STAGES.map((s, i) => {
              const done    = isComplete || curIdx > i;
              const current = !isComplete && curIdx === i;
              return (
                <div
                  key={s.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors duration-200",
                    current ? "bg-primary/10 font-medium text-primary" :
                    done    ? "text-text-secondary"                    :
                              "text-text-muted",
                  )}
                >
                  {/* Stage dot / icon */}
                  <div
                    className={cn(
                      "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full transition-colors duration-200",
                      done    ? "bg-green-500"  :
                      current ? "bg-primary"    :
                                "bg-bg-page border border-border",
                    )}
                  >
                    {done ? (
                      <CheckCircle2 size={11} className="text-white" />
                    ) : current ? (
                      <Loader2 size={10} className="animate-spin text-white" />
                    ) : null}
                  </div>
                  <span>{s.label}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Error detail */}
        {isError && (
          <div className="space-y-3">
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 leading-relaxed">
              {error || message || "An unexpected error occurred."}
            </div>
            <p className="text-center text-[12px] text-text-muted">
              This dialog will close automatically. You can retry from Step 1.
            </p>
          </div>
        )}
      </div>

      {/* Keyframe injected at document level via a style tag — avoids adding to global CSS */}
      <style>{`
        @keyframes stagingFadeIn {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to   { opacity: 1; transform: scale(1)    translateY(0px); }
        }
      `}</style>
    </div>
  );
}
