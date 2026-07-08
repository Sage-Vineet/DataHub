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
      if (state.status === "done") {
        const w = state.warnCount || 0;
        showToast({
          type: "success",
          title: `${label} — reports ready`,
          message: `Generation completed successfully${w ? ` with ${w} warning${w === 1 ? "" : "s"}` : ""}.`,
        });
      } else {
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
