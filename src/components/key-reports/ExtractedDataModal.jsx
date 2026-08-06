import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Search, ChevronLeft, ChevronRight, Loader2, Database } from "lucide-react";
import { getKeyReportExtractedData } from "../../lib/api";

const DATA_TYPE_LABELS = {
  profit_loss: "Profit & Loss",
  balance_sheet: "Balance Sheet",
  general_ledger: "General Ledger",
  tax_return: "Tax Return",
  bank_statement: "Bank Statement",
};

const fmtAmt = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtDate = (v) => {
  if (!v) return "—";
  try {
    const d = new Date(v + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return String(v);
  }
};

const fmtText = (v) => (v != null && v !== "" ? String(v) : "—");

const COLUMNS = {
  profit_loss: [
    { key: "fiscal_year", label: "Year", w: 56 },
    { key: "account_number", label: "Account #", w: 96, render: fmtText },
    { key: "account_name", label: "Account Name", grow: true },
    { key: "category", label: "Category", w: 120, render: fmtText },
    { key: "sub_category", label: "Sub-Category", w: 120, render: fmtText },
    { key: "amount", label: "Amount", w: 120, render: fmtAmt, numeric: true },
  ],
  balance_sheet: [
    { key: "fiscal_year", label: "Year", w: 56 },
    { key: "as_of_date", label: "As of Date", w: 104, render: fmtDate },
    { key: "account_number", label: "Account #", w: 96, render: fmtText },
    { key: "account_name", label: "Account Name", grow: true },
    { key: "section", label: "Section", w: 120, render: fmtText },
    { key: "amount", label: "Balance", w: 120, render: fmtAmt, numeric: true },
  ],
  general_ledger: [
    { key: "row_type",          label: "Row Type",        w: 130, render: fmtText },
    { key: "account_section",   label: "Account Section", w: 180, render: fmtText },
    { key: "account_name",      label: "Account Name",    w: 200, render: fmtText },
    { key: "account_number",    label: "Account #",       w: 90,  render: fmtText },
    { key: "transaction_date",  label: "Date",            w: 96,  render: fmtDate },
    { key: "fiscal_month",      label: "Month",           w: 56,  render: fmtText },
    { key: "transaction_type",  label: "Type",            w: 100, render: fmtText },
    { key: "transaction_number",label: "Ref #",           w: 80,  render: fmtText },
    { key: "memo",              label: "Memo",            grow: true, render: fmtText },
    { key: "split_account",     label: "Split",           w: 160, render: fmtText },
    { key: "debit_amount",      label: "Debit",           w: 110, render: fmtAmt, numeric: true },
    { key: "credit_amount",     label: "Credit",          w: 110, render: fmtAmt, numeric: true },
    { key: "amount",            label: "Net Amount",      w: 110, render: fmtAmt, numeric: true },
    { key: "running_balance",   label: "Balance",         w: 110, render: fmtAmt, numeric: true },
  ],
  tax_return: [
    { key: "tax_year", label: "Year", w: 56 },
    { key: "schedule", label: "Schedule", w: 90, render: fmtText },
    { key: "section", label: "Section", w: 110, render: fmtText },
    { key: "field_name", label: "Field Name", w: 140 },
    { key: "field_label", label: "Label", grow: true, render: fmtText },
    { key: "field_value", label: "Value", w: 120, render: fmtText },
    { key: "field_amount", label: "Amount", w: 110, render: fmtAmt, numeric: true },
  ],
  bank_statement: [
    { key: "transaction_date", label: "Date", w: 104, render: fmtDate },
    { key: "bank_account", label: "Bank Account", w: 140 },
    { key: "description", label: "Description", grow: true, render: fmtText },
    { key: "amount", label: "Amount", w: 110, render: fmtAmt, numeric: true },
    { key: "running_balance", label: "Balance", w: 110, render: fmtAmt, numeric: true },
    { key: "transaction_type", label: "Type", w: 90, render: fmtText },
  ],
};

const PAGE_SIZE = 50;

export default function ExtractedDataModal({ open, onClose, versionId, dataType, year }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cols = COLUMNS[dataType] || [];
  const typeLabel = DATA_TYPE_LABELS[dataType] || dataType;
  const title = year ? `${typeLabel} — ${year}` : typeLabel;

  // Debounce search input → actual search param
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset state whenever the modal target changes
  useEffect(() => {
    if (open) {
      setPage(1);
      setSearchInput("");
      setSearch("");
      setRows([]);
      setTotal(0);
      setError(null);
    }
  }, [open, dataType, year]);

  // Fetch extracted data
  useEffect(() => {
    if (!open || !versionId || !dataType) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getKeyReportExtractedData(versionId, {
      dataType,
      year: year ?? undefined,
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows || []);
        setTotal(res.total || 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load extracted data.");
        setRows([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, versionId, dataType, year, page, search]);

  if (!open) return null;

  const rangeStart = Math.min((page - 1) * PAGE_SIZE + 1, total);
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  const modal = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.25rem 1rem",
        boxSizing: "border-box",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(255,255,255,0.35)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      />

      {/* Modal card */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 1100,
          maxHeight: "calc(100vh - 2.5rem)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          border: "1px solid var(--color-border, #e5e7eb)",
          background: "#ffffff",
          boxShadow: "0 8px 40px rgba(0,0,0,0.13)",
          animation: "edModalIn 0.15s ease",
        }}
      >
        {/* Header */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--color-border, #e5e7eb)",
            padding: "0.875rem 1.25rem",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <Database
              size={16}
              style={{ color: "var(--color-primary, #22c55e)", flexShrink: 0 }}
            />
            <div style={{ minWidth: 0 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: "0.9375rem",
                  fontWeight: 700,
                  color: "var(--color-text-primary, #111)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {title}
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: "0.75rem",
                  color: "var(--color-text-muted, #9ca3af)",
                }}
              >
                Extracted data from source documents
                {total > 0 ? ` · ${total.toLocaleString()} total rows` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--color-secondary, #6b7280)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--color-bg-page, #f3f4f6)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Toolbar */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            padding: "0.625rem 1.25rem",
            borderBottom: "1px solid var(--color-border, #e5e7eb)",
            background: "var(--color-bg-page, #f9fafb)",
          }}
        >
          {/* Search */}
          <div style={{ position: "relative", flex: "1 1 200px", maxWidth: 340 }}>
            <Search
              size={13}
              style={{
                position: "absolute",
                left: 9,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--color-text-muted, #9ca3af)",
                pointerEvents: "none",
              }}
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={`Search ${typeLabel}…`}
              style={{
                width: "100%",
                boxSizing: "border-box",
                paddingLeft: 30,
                paddingRight: 10,
                paddingTop: 6,
                paddingBottom: 6,
                fontSize: "0.8125rem",
                border: "1px solid var(--color-border, #e5e7eb)",
                borderRadius: 8,
                outline: "none",
                background: "#fff",
                color: "var(--color-text-primary, #111)",
              }}
            />
          </div>

          {/* Range label */}
          {total > 0 && (
            <span
              style={{
                fontSize: "0.75rem",
                color: "var(--color-text-muted, #9ca3af)",
                whiteSpace: "nowrap",
                marginLeft: "auto",
              }}
            >
              {rangeStart}–{rangeEnd} of {total.toLocaleString()}
            </span>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--color-border, #e5e7eb)",
                  background: "#fff",
                  cursor: page === 1 ? "default" : "pointer",
                  color:
                    page === 1
                      ? "var(--color-text-muted, #9ca3af)"
                      : "var(--color-text-primary, #111)",
                  opacity: page === 1 ? 0.4 : 1,
                }}
              >
                <ChevronLeft size={14} />
              </button>
              <span
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-text-secondary, #6b7280)",
                  minWidth: 72,
                  textAlign: "center",
                }}
              >
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages || loading}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid var(--color-border, #e5e7eb)",
                  background: "#fff",
                  cursor: page === totalPages ? "default" : "pointer",
                  color:
                    page === totalPages
                      ? "var(--color-text-muted, #9ca3af)"
                      : "var(--color-text-primary, #111)",
                  opacity: page === totalPages ? 0.4 : 1,
                }}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Table body */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "3rem",
                gap: 10,
                color: "var(--color-text-muted, #9ca3af)",
              }}
            >
              <Loader2 size={20} style={{ animation: "edSpin 1s linear infinite" }} />
              <span style={{ fontSize: "0.875rem" }}>Loading extracted data…</span>
            </div>
          ) : error ? (
            <div
              style={{
                padding: "2rem 1.5rem",
                color: "#dc2626",
                fontSize: "0.875rem",
              }}
            >
              {error}
            </div>
          ) : rows.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "3rem",
                color: "var(--color-text-muted, #9ca3af)",
              }}
            >
              <Database size={32} style={{ opacity: 0.25, marginBottom: 12 }} />
              <p style={{ margin: 0, fontSize: "0.875rem", fontWeight: 500 }}>
                No records found.
              </p>
              {search && (
                <p style={{ margin: "4px 0 0", fontSize: "0.8125rem" }}>
                  Try clearing the search filter.
                </p>
              )}
            </div>
          ) : (
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.8125rem",
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                {cols.map((col) => (
                  <col
                    key={col.key}
                    style={col.grow ? { width: "auto" } : { width: col.w }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--color-border, #e5e7eb)",
                    background: "var(--color-bg-page, #f9fafb)",
                  }}
                >
                  {cols.map((col) => (
                    <th
                      key={col.key}
                      style={{
                        padding: "7px 12px",
                        textAlign: col.numeric ? "right" : "left",
                        fontWeight: 600,
                        color: "var(--color-text-muted, #9ca3af)",
                        fontSize: "0.6875rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        position: "sticky",
                        top: 0,
                        background: "var(--color-bg-page, #f9fafb)",
                        zIndex: 1,
                        borderBottom: "1px solid var(--color-border, #e5e7eb)",
                      }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr
                    key={row.id ?? idx}
                    style={{
                      borderBottom: "1px solid var(--color-border, #f3f4f6)",
                      background: idx % 2 === 0 ? "#ffffff" : "var(--color-bg-page, #fafafa)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#f0fdf4";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        idx % 2 === 0 ? "#ffffff" : "var(--color-bg-page, #fafafa)";
                    }}
                  >
                    {cols.map((col) => {
                      const raw = row[col.key];
                      const rendered = col.render ? col.render(raw) : fmtText(raw);
                      return (
                        <td
                          key={col.key}
                          title={typeof rendered === "string" && rendered !== "—" ? rendered : undefined}
                          style={{
                            padding: "6px 12px",
                            textAlign: col.numeric ? "right" : "left",
                            color: "var(--color-text-primary, #111)",
                            fontVariantNumeric: col.numeric ? "tabular-nums" : undefined,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {rendered}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <style>{`
        @keyframes edModalIn {
          from { opacity: 0; transform: scale(0.97) translateY(6px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes edSpin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );

  return createPortal(modal, document.body);
}
