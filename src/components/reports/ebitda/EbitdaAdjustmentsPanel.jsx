import { Fragment, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import AddbackEditorModal from "./AddbackEditorModal";
import { getProfitMetricConfig } from "../../../lib/profitMetric";
import { cn } from "../../../lib/utils";
import {
  calculateAdjustedEbitdaByYear,
  calculateAdjustmentTotalsByYear,
  filterAdjustmentsByApprovalStatus,
  getAdjustmentYearSourceValue,
  getAdjustmentYearValue,
} from "../../../services/ebitdaAdjustmentService";

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeVendorScope(scope = []) {
  const values = Array.isArray(scope) ? scope : [scope];
  return Array.from(
    new Set(
      values
        .map((item) => {
          if (typeof item === "string") return normalizeText(item);
          if (!item || typeof item !== "object") return "";
          return normalizeText(item.vendorName || item.vendor_name || item.name || item.label || item.value);
        })
        .filter(Boolean),
    ),
  );
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}%`;
}

function formatSignedCurrency(formatCurrency, value) {
  const numeric = toNumber(value, 0);
  const formatted = formatCurrency?.(Math.abs(numeric)) ?? Math.abs(numeric).toFixed(2);
  return numeric < 0 ? `(${formatted})` : formatted;
}

function getAdjustmentTypeLabel(adjustment, typeOptionsByKey, fallbackLabel = "Addback") {
  const typeKey = normalizeText(adjustment?.typeKey || adjustment?.type_key || "");
  return (
    adjustment?.type?.label ||
    typeOptionsByKey.get(typeKey)?.label ||
    typeKey ||
    fallbackLabel
  );
}

function getYearEntry(adjustment, year) {
  if (!adjustment?.values) return {};
  return adjustment.values[String(year)] || adjustment.values[year] || {};
}

function getYearValue(adjustment, year) {
  return getAdjustmentYearValue(adjustment, year);
}

function getYearSourceValue(adjustment, year) {
  return getAdjustmentYearSourceValue(adjustment, year);
}

function getCommentCount(adjustment) {
  return Array.isArray(adjustment?.comments) ? adjustment.comments.length : 0;
}

function getAttachmentCount(adjustment) {
  return Array.isArray(adjustment?.attachments) ? adjustment.attachments.length : 0;
}

function buildDuplicateWarnings(adjustments = [], duplicateLabel = "addback") {
  const warnings = [];
  const seen = new Map();

  for (const adjustment of adjustments) {
    const key = [
      normalizeText(adjustment?.linkedAccountId || adjustment?.accountId || ""),
      normalizeText(adjustment?.linkedAccountName || adjustment?.name || "").toLowerCase(),
      normalizeText(adjustment?.typeKey || adjustment?.type_key || "").toLowerCase(),
      normalizeText(adjustment?.vendorScopeMode || adjustment?.vendor_scope_mode || "").toLowerCase(),
      JSON.stringify(normalizeVendorScope(adjustment?.vendorScope || adjustment?.vendor_scope || [])),
    ].join("|");

    if (!seen.has(key)) {
      seen.set(key, adjustment);
      continue;
    }

    const existing = seen.get(key);
    warnings.push({
      type: "duplicate_adjustment",
      message: `Potential duplicate ${duplicateLabel} detected for ${adjustment?.linkedAccountName || adjustment?.name || "an adjustment"}.`,
      adjustmentIds: [existing?.id, adjustment?.id].filter(Boolean),
    });
  }

  return warnings;
}

export default function EbitdaAdjustmentsPanel({
  years = [],
  adjustments = [],
  typeOptions = [],
  accountOptions = [],
  vendorOptions = [],
  referenceIndex = null,
  fallbackLookup = null,
  baseEbitdaByYear = {},
  revenueByYear = {},
  formatCurrency,
  loading = false,
  error = "",
  isSaving = false,
  onSaveAdjustment,
  onDeleteAdjustment,
  profitMetricConfig = getProfitMetricConfig(),
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAdjustment, setEditingAdjustment] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const typeOptionsByKey = useMemo(() => {
    const map = new Map();
    for (const option of typeOptions || []) {
      const key = normalizeText(option?.typeKey || option?.type_key || "");
      if (!key) continue;
      map.set(key, option);
    }
    return map;
  }, [typeOptions]);
  const sectionLabel = profitMetricConfig.sectionLabel;
  const sectionButtonLabel = profitMetricConfig.sectionButtonLabel;
  const sectionIntro = profitMetricConfig.sectionIntro;
  const loadingLabel = profitMetricConfig.loadingLabel;
  const emptyLabel = profitMetricConfig.emptyLabel;
  const totalRowLabel = profitMetricConfig.totalRowLabel;
  const totalRowNote = `Approved ${sectionLabel.toLowerCase()} total`;
  const finalRowLabel = profitMetricConfig.finalRowLabel;
  const finalRowSubtitle = profitMetricConfig.finalRowSubtitle;
  const percentRowLabel = profitMetricConfig.percentRowLabel;
  const itemSingularLabel = profitMetricConfig.itemSingularLabel;

  const duplicateWarnings = useMemo(() => buildDuplicateWarnings(adjustments, itemSingularLabel.toLowerCase()), [adjustments, itemSingularLabel]);
  const duplicateIdSet = useMemo(() => {
    const ids = new Set();
    duplicateWarnings.forEach((warning) => {
      (warning.adjustmentIds || []).forEach((id) => ids.add(id));
    });
    return ids;
  }, [duplicateWarnings]);

  const approvedAdjustments = useMemo(
    () => filterAdjustmentsByApprovalStatus(adjustments, "approved"),
    [adjustments],
  );

  const totalsByYear = useMemo(() => {
    return calculateAdjustmentTotalsByYear(adjustments, years, "approved");
  }, [adjustments, years]);

  const adjustedEbitdaByYear = useMemo(
    () => calculateAdjustedEbitdaByYear(baseEbitdaByYear, totalsByYear, years),
    [baseEbitdaByYear, totalsByYear, years],
  );

  const resolvedAccountOptions = accountOptions.length
    ? accountOptions
    : Array.from(
      new Map(
        (adjustments || [])
          .map((adjustment) => {
            const label = normalizeText(adjustment?.linkedAccountName || adjustment?.name || "");
            if (!label) return null;
            return [label, { label, accountId: normalizeText(adjustment?.linkedAccountId || adjustment?.accountId || "") }];
          })
          .filter(Boolean),
      ).values(),
    );

  const resolvedVendorOptions = vendorOptions.length
    ? vendorOptions
    : Array.from(
      new Map(
        (adjustments || [])
          .flatMap((adjustment) => normalizeVendorScope(adjustment?.vendorScope || adjustment?.vendor_scope || []))
          .filter(Boolean)
          .map((label) => [label, { label }]),
      ).values(),
    );

  const closeModal = () => {
    if (isSaving) return;
    setIsModalOpen(false);
    setEditingAdjustment(null);
  };

  const openNewAdjustment = () => {
    setEditingAdjustment(null);
    setIsModalOpen(true);
  };

  const openEditAdjustment = (adjustment) => {
    setEditingAdjustment(adjustment || null);
    setIsModalOpen(true);
  };

  const handleSave = async (draft) => {
    await onSaveAdjustment?.(draft);
    setIsModalOpen(false);
    setEditingAdjustment(null);
  };

  const handleDelete = async (adjustment) => {
    if (!adjustment?.id || isSaving) return;
    const ok = window.confirm(`Delete "${adjustment.name || adjustment.linkedAccountName || `this ${itemSingularLabel.toLowerCase()}`}"?`);
    if (!ok) return;
    await onDeleteAdjustment?.(adjustment.id);
    if (editingAdjustment?.id === adjustment.id) {
      setIsModalOpen(false);
      setEditingAdjustment(null);
    }
  };

  const toggleExpanded = (adjustmentId) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(adjustmentId)) next.delete(adjustmentId);
      else next.add(adjustmentId);
      return next;
    });
  };

  const colSpan = years.length + 2;
  const hasRows = Array.isArray(adjustments) && adjustments.length > 0;

  return (
    <>
      <tr className="bg-gray-100">
        <td colSpan={1 + years.length} className="p-0">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-bold text-[#050505]">
                  <span>{sectionLabel}</span>
                  {adjustments.length > 0 ? (
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                      {adjustments.length}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {sectionIntro}
                </p>
              </div>
              <button
                type="button"
                onClick={openNewAdjustment}
                className="flex items-center gap-1.5 rounded-md bg-[#8bc53d] px-3 py-1.5 text-[11px] font-bold text-white transition-colors hover:bg-[#78ab34]"
              >
                <Plus size={12} strokeWidth={3} />
                {sectionButtonLabel}
              </button>
            </div>
          </div>
        </td>
        <td className="bg-gray-100" style={{ borderLeft: "2px solid #cbd5e1" }} />
      </tr>

      {error ? (
        <tr className="border-b border-amber-200 bg-amber-50">
          <td colSpan={colSpan} className="px-4 py-3">
            <div className="flex items-center gap-2 text-[12px] text-amber-800">
              <AlertTriangle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          </td>
        </tr>
      ) : null}

      {duplicateWarnings.length > 0 ? (
        <tr className="border-b border-amber-200 bg-amber-50">
          <td colSpan={colSpan} className="px-4 py-3">
            <div className="flex items-center gap-2 text-[12px] text-amber-800">
              <AlertTriangle size={14} className="shrink-0" />
              <span>
                Potential duplicate {sectionLabel.toLowerCase()} detected. Review rows with the same account, type, or vendor scope.
              </span>
            </div>
          </td>
        </tr>
      ) : null}

      {loading && !hasRows ? (
        <tr className="border-b border-[#f1f5f9] bg-white">
          <td colSpan={colSpan} className="px-4 py-8 text-center text-[13px] text-text-muted">
            {loadingLabel}
          </td>
        </tr>
      ) : null}

      {!loading && !hasRows ? (
        <tr className="border-b border-[#f1f5f9] bg-white">
          <td colSpan={colSpan} className="px-4 py-8 text-center text-[13px] text-text-muted">
            {emptyLabel}
          </td>
        </tr>
      ) : null}

      {approvedAdjustments.map((adjustment) => {
        const isExpanded = expandedIds.has(adjustment.id);
        const isDuplicate = duplicateIdSet.has(adjustment.id);
        const commentCount = getCommentCount(adjustment);
        const attachmentCount = getAttachmentCount(adjustment);
        const typeLabel = getAdjustmentTypeLabel(adjustment, typeOptionsByKey, itemSingularLabel);
        const vendorScope = normalizeVendorScope(adjustment?.vendorScope || adjustment?.vendor_scope || []);
        const vendorScopeMode = normalizeText(adjustment?.vendorScopeMode || adjustment?.vendor_scope_mode || "entire_account", "entire_account");
        const description = normalizeText(adjustment?.description || "");
        const detailNote =
          normalizeText(adjustment?.supportingExplanation || adjustment?.supporting_explanation || "") ||
          normalizeText(adjustment?.analystComments || adjustment?.analyst_comments || "") ||
          normalizeText(adjustment?.internalNotes || adjustment?.internal_notes || "");

        return (
          <Fragment key={adjustment.id}>
            <tr
              className={cn(
                "group border-b border-[#f1f5f9] transition-colors",
                isDuplicate ? "bg-amber-50/60 hover:bg-amber-50" : "hover:bg-slate-50",
              )}
            >
              <td className="p-3 pl-6 text-text-primary">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(adjustment.id)}
                    className="flex h-6 w-6 items-center justify-center rounded-full border border-transparent text-text-muted transition-colors hover:border-border hover:bg-white hover:text-text-primary"
                    title={isExpanded ? "Collapse row" : "Expand row"}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-text-primary">
                        {adjustment.name || adjustment.linkedAccountName || `Untitled ${itemSingularLabel}`}
                      </span>
                      {isDuplicate ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                          Duplicate
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-text-muted">
                      <span>{typeLabel}</span>
                      {adjustment.linkedAccountName ? (
                        <>
                          <span>Account: {adjustment.linkedAccountName}</span>
                          <span className="text-border">|</span>
                        </>
                      ) : (
                        <span>Manual {itemSingularLabel.toLowerCase()}</span>
                      )}
                      <span>Scope: {vendorScopeMode.replace(/_/g, " ")}</span>
                      {vendorScope.length > 0 ? (
                        <>
                          <span className="text-border">|</span>
                          <span className="truncate">Vendors: {vendorScope.join(", ")}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </td>

              {years.map((year) => {
                const yearValue = getYearValue(adjustment, year);
                const sourceValue = getYearSourceValue(adjustment, year);
                const hasOverride = Number.isFinite(Number(getYearEntry(adjustment, year)?.overrideValue))
                  || Number.isFinite(Number(getYearEntry(adjustment, year)?.userValue));

                return (
                  <td key={year} className="p-3 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="font-bold text-[#050505]">{formatSignedCurrency(formatCurrency, yearValue)}</span>
                      {sourceValue !== yearValue ? (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
                          {formatSignedCurrency(formatCurrency, sourceValue)}
                        </span>
                      ) : null}
                      {hasOverride ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                          Override
                        </span>
                      ) : null}
                    </div>
                  </td>
                );
              })}

              <td className="p-2" style={{ borderLeft: "2px solid #f1f5f9" }}>
                <div className="flex h-full flex-col justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                      {attachmentCount > 0 ? <Paperclip size={12} /> : null}
                      <span>
                        {attachmentCount > 0
                          ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`
                          : "No attachments"}
                      </span>
                    </div>
                    {detailNote ? (
                      <p className="line-clamp-3 text-[12px] leading-snug text-slate-600">
                        {detailNote}
                      </p>
                    ) : null}
                    {commentCount > 0 ? (
                      <p className="text-[11px] text-text-muted">
                        {commentCount} comment{commentCount === 1 ? "" : "s"}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openEditAdjustment(adjustment)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border-input bg-white px-3 py-1.5 text-[11px] font-semibold text-text-primary transition-colors hover:bg-bg-page"
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(adjustment)}
                      disabled={isSaving}
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              </td>
            </tr>

            {isExpanded ? (
              <tr className="border-b border-[#e2e8f0] bg-slate-50/80">
                <td colSpan={colSpan} className="px-4 py-4">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="rounded-lg border border-border bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Description</div>
                      <div className="mt-1 text-[13px] text-text-primary">
                        {description || "No description provided."}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Reporting Basis</div>
                      <div className="mt-1 text-[13px] text-text-primary">
                        Year-based
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Linked Account</div>
                      <div className="mt-1 text-[13px] text-text-primary">
                        {adjustment.linkedAccountName || `Manual ${itemSingularLabel.toLowerCase()}`}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Vendor Scope</div>
                      <div className="mt-1 text-[13px] text-text-primary">
                        {vendorScope.length > 0 ? vendorScope.join(", ") : "Entire account"}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Notes</div>
                      <div className="mt-1 text-[13px] text-text-primary">
                        {detailNote || "No notes added yet."}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-white p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Attachments</div>
                      <div className="mt-1 space-y-1 text-[13px] text-text-primary">
                        {(adjustment.attachments || []).length > 0 ? (
                          adjustment.attachments.map((attachment) => (
                            <div key={attachment.id || attachment.fileUrl || attachment.file_url} className="flex items-start gap-2">
                              <Paperclip size={12} className="mt-1 shrink-0 text-text-muted" />
                              <div className="min-w-0">
                                <div className="truncate">{attachment.fileName || attachment.file_name}</div>
                                {attachment.contentType || attachment.content_type ? (
                                  <div className="text-[11px] text-text-muted">
                                    {attachment.contentType || attachment.content_type}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-text-muted">No attachments uploaded.</div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-white p-3 md:col-span-2 xl:col-span-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Comments</div>
                      <div className="mt-2 space-y-2">
                        {(adjustment.comments || []).length > 0 ? (
                          adjustment.comments.map((comment) => (
                            <div key={comment.id || `${adjustment.id}-comment-${comment.body}`} className="rounded-md bg-bg-page/70 px-3 py-2 text-[13px] text-text-primary">
                              <div className="font-medium text-text-muted">
                                {normalizeText(comment.commentType || comment.comment_type || "internal", "internal")}
                              </div>
                              <div className="mt-1">{comment.body || comment.comment || comment.text}</div>
                            </div>
                          ))
                        ) : (
                          <div className="text-[13px] text-text-muted">No comments yet.</div>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            ) : null}
          </Fragment>
        );
      })}

      <tr className="border-t border-[#cbd5e1] bg-[#eef6e0]">
        <td className="p-3 font-bold text-[#050505]">{totalRowLabel}</td>
        {years.map((year) => {
          const yearTotal = toNumber(totalsByYear[String(year)] ?? 0, 0);
          return (
            <td key={year} className="p-3 text-right font-bold text-[#050505]">
              {formatSignedCurrency(formatCurrency, yearTotal)}
            </td>
          );
        })}
        <td className="p-2 text-[12px] font-semibold text-slate-600" style={{ borderLeft: "2px solid #d6e7b5" }}>
          {totalRowNote}
        </td>
      </tr>

      <tr className="border-t-2 border-[#8bc53d] bg-[#f8fafc]">
        <td className="p-4 font-bold text-[#050505] text-[15px]">{finalRowLabel}</td>
        {years.map((year) => {
          const adjustedValue = toNumber(adjustedEbitdaByYear[String(year)] ?? 0, 0);
          return (
            <td key={year} className="p-4 text-right font-bold text-[#8bc53d] text-[16px]">
              {formatSignedCurrency(formatCurrency, adjustedValue)}
            </td>
          );
        })}
        <td className="p-2 bg-[#f8fafc]" style={{ borderLeft: "2px solid #8bc53d" }}>
          <div className="text-[12px] font-semibold text-slate-700">
            {finalRowSubtitle}
          </div>
        </td>
      </tr>

      <tr className="border-b border-[#cbd5e1] bg-white">
        <td className="p-3 font-bold text-[#050505]">{percentRowLabel}</td>
        {years.map((year) => {
          const adjustedEbitda = toNumber(adjustedEbitdaByYear[String(year)] ?? 0, 0);
          const revenue = toNumber(revenueByYear[String(year)] ?? 0, 0);
          const ebitdaPercent = revenue > 0 ? (adjustedEbitda / revenue) * 100 : 0;

          return (
            <td key={year} className="p-3 text-right font-bold text-text-primary">
              {formatPercent(ebitdaPercent)}
            </td>
          );
        })}
        <td className="p-1 bg-white" style={{ borderLeft: "2px solid #cbd5e1" }}>
          <div className="px-3 py-2 text-[12px] text-text-muted">
            {`${finalRowLabel} margin based on current revenue`}
          </div>
        </td>
      </tr>

      <AddbackEditorModal
        key={`${isModalOpen ? "open" : "closed"}:${editingAdjustment?.id || "new"}:${years.join("|")}:${typeOptions.map((type) => type.typeKey).join("|")}`}
        isOpen={isModalOpen}
        onClose={closeModal}
        onSave={handleSave}
        adjustment={editingAdjustment}
        years={years}
        typeOptions={typeOptions}
        accountOptions={resolvedAccountOptions}
        vendorOptions={resolvedVendorOptions}
        referenceIndex={referenceIndex}
        fallbackLookup={fallbackLookup}
        isSaving={isSaving}
      />
    </>
  );
}
