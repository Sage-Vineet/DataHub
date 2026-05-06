import { Download, FolderUp, Loader2, X } from "lucide-react";

export default function ExportDestinationModal({
  isOpen,
  title,
  description,
  isSubmitting,
  onClose,
  onSelect,
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-md rounded-[28px] border border-[#E6E8EE] bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[#E8ECF2] px-6 py-5">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#667085]">
              Export Destination
            </p>
            <h3 className="mt-1 text-[22px] font-bold text-[#101828]">
              {title}
            </h3>
            {description ? (
              <p className="mt-2 text-[14px] text-[#667085]">{description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-xl p-2 text-[#667085] transition-colors hover:bg-[#F3F4F6] hover:text-[#101828] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-3 px-6 py-5">
          <button
            onClick={() => onSelect("local")}
            disabled={isSubmitting}
            className="flex items-start gap-4 rounded-2xl border border-[#D9DEE8] bg-white px-4 py-4 text-left transition-all hover:border-[#8BC53D] hover:bg-[#F8FBF2] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="mt-0.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#EEF2FF]">
              <Download size={20} className="text-[#4338CA]" />
            </div>
            <div>
              <p className="text-[15px] font-semibold text-[#101828]">
                Download Locally
              </p>
              <p className="mt-1 text-[13px] text-[#667085]">
                Save the exported file directly to your computer.
              </p>
            </div>
          </button>

          <button
            onClick={() => onSelect("dataroom")}
            disabled={isSubmitting}
            className="flex items-start gap-4 rounded-2xl border border-[#D9DEE8] bg-white px-4 py-4 text-left transition-all hover:border-[#8BC53D] hover:bg-[#F8FBF2] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="mt-0.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#EAF7E2]">
              <FolderUp size={20} className="text-[#476E2C]" />
            </div>
            <div>
              <p className="text-[15px] font-semibold text-[#101828]">
                Upload to DataRoom
              </p>
              <p className="mt-1 text-[13px] text-[#667085]">
                Place the file inside the company&apos;s default DataRoom report
                folders.
              </p>
            </div>
          </button>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[#E8ECF2] px-6 py-4">
          {isSubmitting ? (
            <div className="inline-flex items-center gap-2 text-[13px] font-medium text-[#667085]">
              <Loader2 size={15} className="animate-spin" />
              Processing export...
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
