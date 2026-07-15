import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  EyeOff,
  FileText,
  Loader2,
  RefreshCw,
} from "lucide-react";
import Modal from "../common/Modal";
import { validateMappingValue } from "./customTemplateUiUtils";

const STATUS_META = {
  auto_filled: { label: "Auto-filled", className: "bg-emerald-50 text-emerald-700" },
  needs_review: { label: "Needs review", className: "bg-amber-50 text-amber-700" },
  manual: { label: "Manual", className: "bg-[#EEF6E0] text-[#476E2C]" },
  ignored: { label: "Ignored", className: "bg-bg-page text-[#6D6E71]" },
};

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.needs_review;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${meta.className}`}>
      {meta.label}
    </span>
  );
}

function MappingRow({ mapping, onChange, onApprove, onIgnore }) {
  const warning = validateMappingValue(mapping);
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-bg-page px-1.5 py-0.5 font-mono text-[11px] text-[#050505]">
            {mapping.placeholderText}
          </span>
          <span className="text-xs font-semibold text-[#476E2C]">
            {mapping.semanticMeaning || "Unresolved placeholder"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <StatusPill status={mapping.ignored ? "ignored" : mapping.status} />
          <span className="text-[10px] font-semibold text-[#6D6E71]">
            {Math.round(Number(mapping.mappingConfidence || 0) * 100)}%
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={mapping.value || ""}
          disabled={mapping.ignored}
          onChange={(event) => onChange(mapping.placeholderId, event.target.value)}
          placeholder="Enter value"
          className="min-w-[140px] flex-1 rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-text-primary disabled:bg-bg-page"
        />
        <button
          onClick={() => onApprove(mapping.placeholderId)}
          disabled={mapping.ignored}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={12} /> Approve
        </button>
        <button
          onClick={() => onIgnore(mapping.placeholderId)}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs font-semibold text-[#6D6E71] hover:bg-bg-page"
        >
          <EyeOff size={12} /> Ignore
        </button>
      </div>
      {mapping.selectedDataSource ? (
        <p className="mt-1 text-[11px] text-[#6D6E71]">Source: {mapping.selectedDataSource}</p>
      ) : null}
      {warning ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-700">
          <AlertTriangle size={11} /> {warning}
        </p>
      ) : null}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-white px-3 py-2 text-center">
      <div className="text-lg font-bold text-[#050505]">{value}</div>
      <div className="text-[10px] font-semibold uppercase text-[#6D6E71]">{label}</div>
    </div>
  );
}

export default function CustomTemplateIntelligenceModal({
  isOpen,
  onClose,
  state,
  summary,
  onMappingChange,
  onApprove,
  onIgnore,
  onDownloadSchema,
  onReplaceTemplate,
}) {
  const [filter, setFilter] = useState("all");
  const mappings = useMemo(() => Object.values(state?.mappings || {}), [state?.mappings]);
  const bySlide = useMemo(() => {
    const filtered = mappings.filter((mapping) => {
      if (filter === "unresolved") {
        return !mapping.ignored && (!mapping.value || mapping.status === "needs_review");
      }
      if (filter === "auto_filled") return mapping.status === "auto_filled" && !mapping.ignored;
      return true;
    });
    const groups = new Map();
    filtered
      .sort((a, b) => (a.slideNumber || 0) - (b.slideNumber || 0))
      .forEach((mapping) => {
        const key = mapping.slideNumber || "General";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(mapping);
      });
    return Array.from(groups.entries());
  }, [mappings, filter]);

  const warnings = state?.validationReport?.warnings || [];

  if (state?.status === "analyzing") {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Analyzing Custom Template" size="lg">
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Loader2 size={28} className="animate-spin text-[#476E2C]" />
          <p className="text-sm font-semibold text-[#050505]">{state?.progressMessage || "Analyzing your template…"}</p>
          <p className="text-xs text-[#6D6E71]">This detects placeholders and maps them to your financial data.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Custom Template Intelligence" size="xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#050505]">
          <FileText size={16} className="text-[#476E2C]" />
          {state?.fileMeta?.fileName || state?.analysis?.template?.fileName || "Custom template"}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-bold text-[#476E2C] hover:bg-[#EEF6E0]">
            <RefreshCw size={12} />
            Replace Template
            <input
              type="file"
              accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onReplaceTemplate(file);
                event.target.value = "";
              }}
            />
          </label>
          <button
            onClick={onDownloadSchema}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-bold text-[#476E2C] hover:bg-[#EEF6E0]"
          >
            <Download size={12} />
            Schema JSON
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        <StatCard label="Slides" value={summary?.slideCount ?? 0} />
        <StatCard label="Placeholders" value={summary?.placeholderCount ?? 0} />
        <StatCard label="Auto-filled" value={summary?.autoFilled ?? 0} />
        <StatCard label="Unresolved" value={summary?.unresolved ?? 0} />
        <StatCard label="Warnings" value={summary?.warnings ?? 0} />
        <StatCard label="Confidence" value={`${Math.round((summary?.confidenceScore ?? 0) * 100)}%`} />
      </div>

      {warnings.length > 0 ? (
        <div className="mb-4 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3">
          {warnings.slice(0, 6).map((warning) => (
            <p key={warning.id} className="flex items-start gap-1.5 text-xs text-amber-800">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {warning.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="mb-3 flex items-center gap-1.5">
        {[
          { key: "all", label: "All" },
          { key: "unresolved", label: "Unresolved" },
          { key: "auto_filled", label: "Auto-filled" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              filter === tab.key ? "bg-[#476E2C] text-white" : "bg-bg-page text-[#6D6E71] hover:bg-[#EEF6E0]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {bySlide.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#6D6E71]">No placeholders match this filter.</p>
        ) : (
          bySlide.map(([slideNumber, items]) => (
            <div key={slideNumber}>
              <p className="mb-1.5 text-xs font-bold uppercase text-[#6D6E71]">
                {slideNumber === "General" ? "General" : `Slide ${slideNumber}`}
              </p>
              <div className="space-y-2">
                {items.map((mapping) => (
                  <MappingRow
                    key={mapping.placeholderId}
                    mapping={mapping}
                    onChange={onMappingChange}
                    onApprove={onApprove}
                    onIgnore={onIgnore}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
