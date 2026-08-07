import { useEffect, useState } from "react";
import { useToast } from "../../context/ToastContext";
import {
  subscribeGeneration,
  listUnnotifiedCompletions,
  markGenerationNotified,
} from "../../lib/keyReportGeneration";

// App-level listener (mounted once, inside ToastProvider) that pops a top-right
// toast whenever a Key Reports generation finishes — on WHATEVER page the user
// is currently on, and on their next visit if they were away while it ran. Each
// completion is announced exactly once.
export default function KeyReportGenerationToaster() {
  const toast = useToast();
  const [tick, setTick] = useState(0);

  // Re-scan whenever the generation manager emits a change.
  useEffect(() => subscribeGeneration(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    const showToast = toast?.showToast;
    if (!showToast) return;
    listUnnotifiedCompletions().forEach((state) => {
      const label = state.versionLabel || "Key Reports version";
      // CONFIRMED ROOT CAUSE (fixed here): this used to branch on
      // `state.status === "done"` and `state.warnCount`, neither of which this
      // state machine has ever written (see lib/keyReportGeneration.js's real
      // terminal statuses: "reports_ready" / "coa_review_required" /
      // "coa_generation_failed" / "error" — WorkspaceKeyReports.jsx's own doc
      // comment lists the same four). Every completion therefore fell through
      // to the `else` branch, including a fully successful Proposed-COA
      // generation — "generation failed" popped even when generation
      // succeeded and was simply waiting on the user's review/approve.
      const w = Array.isArray(state.warnings) ? state.warnings.length : 0;
      if (state.status === "reports_ready") {
        showToast({
          type: "success",
          title: `${label} — reports ready`,
          message: `Generation completed successfully${w ? ` with ${w} warning${w === 1 ? "" : "s"}` : ""}.`,
        });
      } else if (state.status === "coa_review_required") {
        showToast({
          type: "success",
          title: `${label} — Chart of Accounts ready for review`,
          message: "A Proposed Chart of Accounts was generated. Review and approve it to generate reports.",
        });
      } else {
        // "coa_generation_failed" / "error" — the only two real failure states.
        showToast({
          type: "error",
          title: `${label} — generation failed`,
          message: state.error || "Please try generating again.",
        });
      }
      markGenerationNotified(state.clientId, state.versionId);
    });
  }, [tick, toast]);

  return null;
}
