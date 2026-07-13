import { FileText, Loader2, Sparkles, Upload } from "lucide-react";
import Modal from "../common/Modal";

const PPTX_ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

export default function TemplateSelectionModal({
  isOpen,
  onClose,
  onSelectDefault,
  onUploadFile,
  uploading = false,
  progressMessage = "",
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Choose a CIM Template" size="lg">
      <p className="mb-4 text-sm text-[#6D6E71]">
        Use the built-in CIM template, or upload your own PowerPoint template and let the
        Template Intelligence Engine detect and fill in the bracketed placeholders automatically.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          onClick={onSelectDefault}
          disabled={uploading}
          className="flex flex-col items-start gap-2 rounded-xl border border-border bg-white p-4 text-left transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#EEF6E0] text-[#476E2C]">
            <FileText size={18} />
          </span>
          <span className="text-sm font-bold text-[#050505]">Use Default CIM Template</span>
          <span className="text-xs text-[#6D6E71]">
            Continue with the existing fixed-template workflow — no changes.
          </span>
        </button>

        <label
          className={`flex flex-col items-start gap-2 rounded-xl border border-border bg-white p-4 text-left transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] ${
            uploading ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          }`}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#EEF6E0] text-[#476E2C]">
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
          </span>
          <span className="text-sm font-bold text-[#050505]">Upload Custom PowerPoint Template</span>
          <span className="text-xs text-[#6D6E71]">
            {uploading
              ? progressMessage || "Analyzing your template…"
              : "Upload a .pptx file. Placeholders inside [square brackets] will be auto-filled from your financial data."}
          </span>
          <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-bold text-[#476E2C]">
            <Upload size={12} />
            Choose file
          </span>
          <input
            type="file"
            accept={PPTX_ACCEPT}
            className="sr-only"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUploadFile(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
    </Modal>
  );
}
