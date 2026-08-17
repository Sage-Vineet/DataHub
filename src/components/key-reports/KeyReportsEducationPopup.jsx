import { useState } from "react";
import { createPortal } from "react-dom";
import { Info, X } from "lucide-react";

// First-visit educational popup. Shown until the user dismisses it permanently
// ("Don't show again" persists per-user via the popup-preference API).
export default function KeyReportsEducationPopup({ onClose, onDismissForever }) {
  const [dontShow, setDontShow] = useState(false);

  const handleClose = () => {
    if (dontShow) onDismissForever?.();
    onClose?.();
  };

  // Portalled to <body> — the page content wrapper it would otherwise sit
  // inside animates in with a `transform` (animate-fadeIn), which makes that
  // wrapper the containing block for `position: fixed` descendants instead of
  // the viewport. Without the portal this popup centers on the full page
  // height rather than the screen, landing off-screen on long pages.
  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#EEF6E0] text-primary">
            <Info size={20} />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-bold text-text-primary">About Key Reports</h3>
            <p className="mt-2 text-sm leading-relaxed text-secondary">
              The Key Reports linked here will drive future workflows for the CIM Preparation and
              Quality of Earnings modules. This is how the system will recognize which reports are the
              current versions.
            </p>
          </div>
          <button onClick={handleClose} className="rounded-md p-1 text-text-muted hover:bg-bg-page">
            <X size={18} />
          </button>
        </div>

        <label className="mt-5 flex cursor-pointer items-center gap-2 text-sm text-secondary">
          <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
          Don&apos;t show again
        </label>

        <div className="mt-5 flex justify-end">
          <button
            onClick={handleClose}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
