import { AlertTriangle, Check, EyeOff, MousePointerClick } from "lucide-react";
import { validateMappingValue } from "./customTemplateUiUtils";

export default function CustomTemplateFieldPanel({ mapping, onChange, onApprove, onIgnore }) {
  if (!mapping) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-white p-6 text-center text-sm text-[#6D6E71]">
        <MousePointerClick size={20} className="text-[#A5A5A5]" />
        Click a highlighted field on the slide to review or edit it.
      </div>
    );
  }

  const warning = validateMappingValue(mapping);

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-card">
      <p className="text-xs font-bold uppercase tracking-[0.06em] text-[#8BC53D]">
        Slide {mapping.slideNumber ?? "—"}
      </p>
      <h3 className="mt-1 text-sm font-bold text-[#050505]">
        {mapping.semanticMeaning || "Unresolved placeholder"}
      </h3>
      <span className="mt-1 inline-block rounded bg-bg-page px-1.5 py-0.5 font-mono text-[11px] text-[#6D6E71]">
        {mapping.placeholderText}
      </span>

      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">Value</span>
        <textarea
          value={mapping.value || ""}
          disabled={mapping.ignored}
          onChange={(event) => onChange(mapping.placeholderId, event.target.value)}
          className="theme-input min-h-[70px] text-sm disabled:bg-bg-page"
        />
      </label>
      {warning ? (
        <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-700">
          <AlertTriangle size={11} /> {warning}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between text-[11px] text-[#6D6E71]">
        <span className="truncate">{mapping.selectedDataSource || "No source"}</span>
        <span className="shrink-0 font-bold">
          {Math.round(Number(mapping.mappingConfidence || 0) * 100)}% confidence
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onApprove(mapping.placeholderId)}
          disabled={mapping.ignored}
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={12} /> Approve
        </button>
        <button
          onClick={() => onIgnore(mapping.placeholderId)}
          className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-3 py-2 text-xs font-bold text-[#6D6E71] hover:bg-bg-page"
        >
          <EyeOff size={12} /> Ignore
        </button>
      </div>
    </div>
  );
}
