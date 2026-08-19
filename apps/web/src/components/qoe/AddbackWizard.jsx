import { useMemo, useState } from "react";

/**
 * The typed add-back wizard (`QE - 0004`).
 *
 * The user MUST choose a sourcing kind before anything else, because the kind
 * determines where the amount comes from and what the form is allowed to
 * collect:
 *
 *   P&L Account / Vendor  amount is pulled from the GL and is not editable
 *   Recast                amount is the delta from a normalized post-close value
 *   Manual Adjustment     free-form amount, written explanation required
 *   Balance Sheet Change  supplied amounts (a BS delta is not a P&L row)
 */

const KINDS = [
  {
    key: "pnl_account_vendor",
    label: "P&L Account / Vendor",
    blurb: "Pull the amount straight from the general ledger for an account, optionally narrowed to specific vendors.",
  },
  {
    key: "recast",
    label: "Recast",
    blurb: "Normalize an account to its expected post-close value. The add-back is the difference.",
  },
  {
    key: "manual_adjustment",
    label: "Manual Adjustment",
    blurb: "Enter an amount by hand. A written explanation is required before it can be saved.",
  },
  {
    key: "balance_sheet_change",
    label: "Balance Sheet Change",
    blurb: "An adjustment sourced from a balance-sheet movement rather than a P&L account.",
  },
];

const TYPE_KEYS = [
  ["personal_expense", "Personal Expense"],
  ["non_recurring_charge", "Non-recurring Charge"],
  ["officer_compensation", "Officer Compensation"],
  ["related_party_rent", "Related Party Rent"],
  ["other_non_market_wages", "Other Non-Market Wages"],
  ["prior_period_adjustment", "Prior Period Adjustment"],
  ["accrual_adjustment", "Accrual Adjustment"],
  ["other_addback", "Other Addback"],
];

const field = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";

export default function AddbackWizard({ open, onClose, onSave, accounts, periods, dataSource }) {
  const [kind, setKind] = useState(null);
  const [form, setForm] = useState({});
  const [values, setValues] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const plAccounts = useMemo(
    () => (accounts || []).filter((a) => a.statementType === "profit_loss"),
    [accounts],
  );

  const reset = () => {
    setKind(null);
    setForm({});
    setValues({});
    setError("");
  };

  const close = () => {
    reset();
    onClose?.();
  };

  if (!open) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const needsAccount = kind === "pnl_account_vendor" || kind === "recast";
  const needsValues = kind === "manual_adjustment" || kind === "balance_sheet_change";
  const needsExplanation = kind === "manual_adjustment";

  async function save() {
    setError("");

    if (!form.name?.trim()) return setError("Give the add-back a name.");
    if (needsAccount && !form.linked_account_id) {
      return setError("Select the GL account this add-back is sourced from.");
    }
    if (needsExplanation && !form.explanation?.trim()) {
      return setError("A manual adjustment requires a written explanation before saving.");
    }
    if (kind === "recast" && !form.recast_normalized_value) {
      return setError("Enter the normalized post-close value this account is recast to.");
    }

    const payload = {
      kind,
      data_source: dataSource,
      type_key: form.type_key || "other_addback",
      name: form.name.trim(),
      granularity: form.granularity || "detail",
      linked_account_id: needsAccount ? form.linked_account_id : null,
      vendor_scope: form.vendor_scope
        ? form.vendor_scope.split(",").map((v) => v.trim()).filter(Boolean)
        : [],
      group_label: form.group_label?.trim() || null,
      group_id: form.group_label?.trim()
        ? form.group_label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
        : null,
      explanation: form.explanation?.trim() || null,
      commentary: form.commentary?.trim() || null,
    };

    if (kind === "recast") {
      payload.recast_normalized_value = Number(form.recast_normalized_value);
    }
    // A GL-sourced amount is never sent from the client — the server reads it
    // from the ledger and the contract rejects a manually supplied figure.
    if (needsValues) {
      const parsed = {};
      for (const [key, raw] of Object.entries(values)) {
        const n = Number(raw);
        if (Number.isFinite(n) && n !== 0) parsed[key] = n;
      }
      if (Object.keys(parsed).length === 0) return setError("Enter an amount for at least one period.");
      payload.values = parsed;
    }

    setSaving(true);
    try {
      await onSave(payload);
      close();
    } catch (err) {
      setError(err?.message || "Could not save the add-back.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8">
      <div className="w-full max-w-2xl max-h-[calc(100%-1rem)] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Add New Add-Back</h2>
            <p className="text-sm text-slate-500">
              {kind ? KINDS.find((k) => k.key === kind)?.blurb : "Choose how this add-back is sourced."}
            </p>
          </div>
          <button onClick={close} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Step 1 — the kind gate. Nothing else renders until it is chosen. */}
          {!kind && (
            <div className="grid gap-3 sm:grid-cols-2">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  onClick={() => setKind(k.key)}
                  className="rounded-lg border border-slate-200 p-4 text-left transition hover:border-sky-400 hover:bg-sky-50"
                >
                  <div className="font-medium text-slate-900">{k.label}</div>
                  <div className="mt-1 text-xs text-slate-500">{k.blurb}</div>
                </button>
              ))}
            </div>
          )}

          {kind && (
            <>
              <button
                onClick={() => setKind(null)}
                className="text-xs text-sky-600 hover:underline"
              >
                ← Choose a different type
              </button>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-slate-700">Name</label>
                  <input className={field} value={form.name || ""} onChange={set("name")}
                         placeholder="e.g. Owner's personal vehicle" />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Category</label>
                  <select className={field} value={form.type_key || "other_addback"} onChange={set("type_key")}>
                    {TYPE_KEYS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Granularity</label>
                  <select className={field} value={form.granularity || "detail"} onChange={set("granularity")}>
                    <option value="detail">Account-level detail</option>
                    <option value="smoothed">Smoothed evenly across periods</option>
                  </select>
                </div>

                {needsAccount && (
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-sm font-medium text-slate-700">GL account</label>
                    <select className={field} value={form.linked_account_id || ""} onChange={set("linked_account_id")}>
                      <option value="">Select an account…</option>
                      {plAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    {kind === "pnl_account_vendor" && (
                      <p className="mt-1 text-xs text-slate-500">
                        The amount is read from the general ledger and cannot be edited by hand.
                      </p>
                    )}
                  </div>
                )}

                {kind === "pnl_account_vendor" && (
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-sm font-medium text-slate-700">
                      Vendors <span className="font-normal text-slate-400">(optional — blank means the whole account)</span>
                    </label>
                    <input className={field} value={form.vendor_scope || ""} onChange={set("vendor_scope")}
                           placeholder="Vendor 001, Vendor 014" />
                  </div>
                )}

                {kind === "recast" && (
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-sm font-medium text-slate-700">
                      Normalized post-close value
                    </label>
                    <input className={field} type="number" value={form.recast_normalized_value || ""}
                           onChange={set("recast_normalized_value")} placeholder="180000" />
                    <p className="mt-1 text-xs text-slate-500">
                      The add-back is the actual GL amount less this value.
                    </p>
                  </div>
                )}

                {needsValues && (
                  <div className="sm:col-span-2">
                    <label className="mb-2 block text-sm font-medium text-slate-700">Amount by period</label>
                    <div className="grid gap-2 sm:grid-cols-4">
                      {(periods || []).map((p) => {
                        const key = p.month === null
                          ? String(p.fiscalYear)
                          : `${p.fiscalYear}-${String(p.month).padStart(2, "0")}`;
                        return (
                          <div key={key}>
                            <span className="mb-1 block text-xs text-slate-500">{p.label}</span>
                            <input className={field} type="number" value={values[key] || ""}
                                   onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-slate-700">
                    Explanation {needsExplanation && <span className="text-rose-600">*</span>}
                  </label>
                  <textarea className={field} rows={2} value={form.explanation || ""} onChange={set("explanation")}
                            placeholder={needsExplanation
                              ? "Required — why is this adjustment appropriate?"
                              : "Optional supporting note"} />
                </div>

                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-slate-700">
                    Group <span className="font-normal text-slate-400">(optional subtotal header)</span>
                  </label>
                  <input className={field} value={form.group_label || ""} onChange={set("group_label")}
                         placeholder="e.g. Discretionary owner expenses" />
                </div>
              </div>

              {error && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {kind && (
          <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
            <button onClick={close} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button onClick={save} disabled={saving}
                    className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">
              {saving ? "Saving…" : "Save add-back"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
