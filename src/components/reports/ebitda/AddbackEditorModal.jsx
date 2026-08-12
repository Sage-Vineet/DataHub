import { useMemo, useState } from "react";
import { Plus, Trash2, ChevronDown, Paperclip } from "lucide-react";
import Modal from "../../../components/common/Modal";
import FileUpload from "../../../components/common/FileUpload";
import MultiSelectDropdown from "../../../components/common/MultiSelectDropdown";
import { getProfitMetricConfig } from "../../../lib/profitMetric";
import {
  applyReferenceValues,
  buildAdjustmentDraft,
  normalizeVendorScope,
} from "../../../services/ebitdaAdjustmentService";

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatCurrency(value) {
  const numeric = toNumber(value, 0);
  if (!Number.isFinite(numeric) || numeric === 0) return "-";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(numeric));
}

function buildInitialDraft(adjustment, typeOptions) {
  return adjustment
    ? buildAdjustmentDraft(adjustment)
    : buildAdjustmentDraft({
        name: "",
        typeKey: typeOptions?.[0]?.typeKey || "other_addback",
        values: {},
        vendorScope: [],
      });
}

export default function AddbackEditorModal({
  isOpen,
  onClose,
  onSave,
  adjustment,
  years = [],
  typeOptions = [],
  accountOptions = [],
  vendorOptions = [],
  // Key Reports path: account -> vendor names, for dropdown narrowing ONLY.
  // Kept separate from referenceIndex so it can never reach applyReferenceValues
  // and change a calculated adjustment value.
  vendorsByAccount = null,
  referenceIndex = null,
  fallbackLookup = null,
  isSaving = false,
  profitMetricConfig = getProfitMetricConfig(),
}) {
  const [draft, setDraft] = useState(() => buildInitialDraft(adjustment, typeOptions));
  const [pendingFiles, setPendingFiles] = useState([]);

  const vendorsForAccount = useMemo(() => {
    const accountName = draft.linkedAccountName || draft.name || "";
    // Two narrowing sources, same meaning:
    //   * referenceIndex.accountMap — the Manual GL path (unchanged);
    //   * vendorsByAccount          — the Key Reports path, supplied as its own
    //     prop precisely so it never reaches applyReferenceValues, which would
    //     treat a referenceIndex as a source of transactions and rebuild
    //     adjustment values from it.
    const accountEntry = referenceIndex?.accountMap?.get(accountName);
    const accountVendorNames = accountEntry
      ? Array.from(accountEntry.vendors?.keys?.() || [])
      : (vendorsByAccount?.get?.(accountName) || []);
    // No account selected, or an account with no vendor attribution: show the
    // full list rather than an empty dropdown.
    if (!accountVendorNames.length) return vendorOptions || [];
    return (vendorOptions || []).filter((vendor) =>
      accountVendorNames.includes(vendor.label),
    );
  }, [draft.linkedAccountName, draft.name, referenceIndex, vendorsByAccount, vendorOptions]);

  const updateDraft = (updater) => {
    setDraft((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      return next;
    });
  };

  const recalculateRow = (nextDraft, overrideLookup = fallbackLookup) => {
    return applyReferenceValues(nextDraft, years, {
      referenceIndex,
      fallbackLookup: overrideLookup,
    });
  };

  const updateField = (field, value) => {
    updateDraft((current) => ({ ...current, [field]: value }));
  };

  const handleTypeChange = (typeKey) => {
    updateDraft((current) => ({ ...current, typeKey }));
  };

  const handleAccountChange = (accountName) => {
    updateDraft((current) => {
      const match = accountOptions.find((option) => option.label === accountName);
      const next = {
        ...current,
        linkedAccountName: accountName,
        linkedAccountId: match?.accountId || "",
        isManual: !accountName,
      };
      return recalculateRow(next);
    });
  };

  const handleVendorScopeModeChange = (mode) => {
    updateDraft((current) => {
      const next = { ...current, vendorScopeMode: mode };
      return recalculateRow(next);
    });
  };

  const handleVendorScopeChange = (vendors) => {
    updateDraft((current) => {
      const next = { ...current, vendorScope: normalizeVendorScope(vendors) };
      return recalculateRow(next);
    });
  };

  const handleAnnualValueChange = (year, value) => {
    const numeric = value === "" ? null : Math.abs(toNumber(value, null));
    updateDraft((current) => {
      const nextValues = { ...(current.values || {}) };
      const currentEntry = nextValues[String(year)] || {};
      nextValues[String(year)] = {
        ...currentEntry,
        overrideValue: numeric,
        userValue: numeric,
        overrideReason: currentEntry.overrideReason || current.overrideReason || "",
        value: numeric ?? currentEntry.apiValue ?? currentEntry.value ?? 0,
      };
      return { ...current, values: nextValues };
    });
  };

  const handleSave = async () => {
    const normalizedDraft = recalculateRow(draft);
    const uploadPayload = {
      ...normalizedDraft,
      attachments: normalizedDraft.attachments || [],
      pendingFiles,
    };
    await onSave?.(uploadPayload);
  };

  const attachmentCount = (draft.attachments || []).length + (pendingFiles || []).length;
  const modalTitle = adjustment ? profitMetricConfig.modalTitleEdit : profitMetricConfig.modalTitleAdd;
  const modalNameLabel = profitMetricConfig.modalNameLabel;
  const modalTypeLabel = profitMetricConfig.modalTypeLabel;
  const modalSaveLabel = profitMetricConfig.modalSaveLabel;
  const modalPlaceholderLabel = profitMetricConfig.modalPlaceholderLabel;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={modalTitle}
      size="xl"
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-4">
            <div className="grid gap-2">
              <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">{modalNameLabel}</label>
              <input
                value={draft.name || ""}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder={`Enter ${modalPlaceholderLabel.toLowerCase()} name`}
                className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">{modalTypeLabel}</label>
              <div className="relative">
                <select
                  value={draft.typeKey || ""}
                  onChange={(event) => handleTypeChange(event.target.value)}
                  className="h-10 w-full appearance-none rounded-md border border-border-input bg-bg-card px-3 pr-9 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {typeOptions.map((type) => (
                    <option key={type.typeKey} value={type.typeKey}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" />
              </div>
            </div>

            <div className="grid gap-2">
              <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Description</label>
              <textarea
                value={draft.description || ""}
                onChange={(event) => updateField("description", event.target.value)}
                placeholder="Owner's family travel booked through company expense account."
                rows={4}
                className="rounded-md border border-border-input bg-bg-card px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Linked P&L Account</label>
              <div className="relative">
                <select
                  value={draft.linkedAccountName || ""}
                  onChange={(event) => handleAccountChange(event.target.value)}
                  className="h-10 w-full appearance-none rounded-md border border-border-input bg-bg-card px-3 pr-9 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">Manual {modalPlaceholderLabel.toLowerCase()}</option>
                  {accountOptions.map((option) => (
                    <option key={option.accountId || option.label} value={option.label}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted" />
              </div>
            </div>

            <div className="grid gap-2">
              <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Vendor Scope</label>
              <div className="grid gap-2">
                {["entire_account", "specific_vendor", "multiple_vendors"].map((mode) => (
                  <label key={mode} className="flex items-center gap-2 text-[13px] text-text-primary">
                    <input
                      type="radio"
                      name="vendor-scope-mode"
                      checked={draft.vendorScopeMode === mode}
                      className="accent-[#8bc53d]"
                      onChange={() => handleVendorScopeModeChange(mode)}
                    />
                    <span className="capitalize">{mode.replace(/_/g, " ")}</span>
                  </label>
                ))}
              </div>
              <MultiSelectDropdown
                options={vendorsForAccount.map((item) => item.label)}
                values={normalizeVendorScope(draft.vendorScope || [])}
                onChange={handleVendorScopeChange}
                placeholder={vendorsForAccount.length ? "Select vendors" : "No vendors found"}
                className="w-full"
              />
            </div>

          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-bg-page/40 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-[14px] font-semibold text-text-primary">Values</h3>
                  <p className="text-[12px] text-text-muted">Edit yearly totals directly or fine-tune the selected year below.</p>
                </div>
                <div className="text-[12px] text-text-muted">
                  {attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}` : "No attachments"}
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-border bg-white">
                <table className="w-full text-[13px]">
                  <thead className="bg-bg-page text-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">Year</th>
                      <th className="px-3 py-2 text-right">Auto</th>
                      <th className="px-3 py-2 text-right">Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((year) => {
                      const yearEntry = draft.values?.[String(year)] || {};
                      const total = yearEntry.overrideValue ?? yearEntry.userValue ?? yearEntry.value ?? yearEntry.apiValue ?? 0;
                      return (
                        <tr key={year} className="border-t border-border">
                          <td className="px-3 py-2 font-medium text-text-primary">
                            FY {year}
                          </td>
                          <td className="px-3 py-2 text-right text-text-muted">{formatCurrency(yearEntry.apiValue)}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              value={total ?? ""}
                              onChange={(event) => handleAnnualValueChange(year, event.target.value)}
                              className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-right text-[13px] text-text-primary focus:border-primary focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid gap-4 rounded-xl border border-border bg-bg-page/40 p-4">
              <div>
                <h3 className="text-[14px] font-semibold text-text-primary">Notes</h3>
                <p className="text-[12px] text-text-muted">Keep a concise explanation and any analyst commentary here.</p>
              </div>

              <div className="grid gap-2">
                <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Internal Notes</label>
                <textarea
                  rows={3}
                  value={draft.internalNotes || ""}
                  onChange={(event) => updateField("internalNotes", event.target.value)}
                  className="rounded-md border border-border-input bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="grid gap-2">
                <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Analyst Comments</label>
                <textarea
                  rows={3}
                  value={draft.analystComments || ""}
                  onChange={(event) => updateField("analystComments", event.target.value)}
                  className="rounded-md border border-border-input bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="grid gap-2">
                <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Supporting Explanation</label>
                <textarea
                  rows={3}
                  value={draft.supportingExplanation || ""}
                  onChange={(event) => updateField("supportingExplanation", event.target.value)}
                  className="rounded-md border border-border-input bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="grid gap-2">
                <label className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">Attachments</label>
                <FileUpload
                  onFilesChange={setPendingFiles}
                  accept=".pdf,.xls,.xlsx,.doc,.docx,.png,.jpg,.jpeg"
                  multiple
                  maxMB={15}
                />
                {draft.attachments?.length ? (
                  <div className="space-y-2">
                    {draft.attachments.map((attachment) => (
                      <div
                        key={attachment.id || attachment.fileUrl}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-white px-3 py-2"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Paperclip size={14} className="shrink-0 text-text-muted" />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-text-primary">{attachment.fileName || attachment.file_name}</div>
                            <div className="truncate text-[11px] text-text-muted">{attachment.fileUrl || attachment.file_url}</div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            updateDraft((current) => ({
                              ...current,
                              attachments: (current.attachments || []).filter((item) => (item.id || item.fileUrl) !== (attachment.id || attachment.fileUrl)),
                            }));
                          }}
                          className="rounded-md p-1 text-red-500 hover:bg-red-50"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {pendingFiles.length > 0 && (
                  <div className="text-[12px] text-text-muted">
                    {pendingFiles.length} new file{pendingFiles.length === 1 ? "" : "s"} ready to upload on save.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-input bg-white px-4 py-2 text-[13px] font-semibold text-text-primary hover:bg-bg-page"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-md bg-[#8bc53d] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#78ab34] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={14} />
            {isSaving ? "Saving..." : modalSaveLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
