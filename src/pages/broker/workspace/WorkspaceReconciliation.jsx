import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";

import { getStoredToken, setSelectedReportSource, loadSavedQBBankActivityRequest } from "../../../lib/api";
import { useDataSource } from "../../../context/DataSourceContext";
import { useDatasetVersionStore } from "../../../store/useDatasetVersionStore";
import { emitWorkspaceDataSourceUpdated } from "../../../lib/dataSourceEvents";
import { cn, formatNumber, formatCurrency } from "../../../lib/utils";
import {
  REPORT_SOURCE_KEYS,
  REPORT_SOURCE_OPTIONS,
  normalizeReportSourceKey,
  getReportSourceLabel,
} from "../../../lib/report-source";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

const MONTHS = [
  { value: "01", label: "January" },
  { value: "02", label: "February" },
  { value: "03", label: "March" },
  { value: "04", label: "April" },
  { value: "05", label: "May" },
  { value: "06", label: "June" },
  { value: "07", label: "July" },
  { value: "08", label: "August" },
  { value: "09", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];
const YEARS = Array.from({ length: 10 }, (_, i) => 2020 + i);

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const QB_BANK_ACTIVITY_ENDPOINT = `${API_BASE_URL}/qb-bank-activity`;
const QB_BANK_ACTIVITY_SAVED_ENDPOINT = `${API_BASE_URL}/qb-bank-activity/saved`;
const QB_ONE_BANK_ACTIVITY_ENDPOINT = `${API_BASE_URL}/qb-one-bank-activity`;
const EXTRACT_BANK_PDF_RECORDS_ENDPOINT = `${API_BASE_URL}/extract-bank-pdf-records`;
const QMS_BANK_DATA_ENDPOINT = `${API_BASE_URL}/manual-report-uploads/qms-bank-data`;
const MANUAL_BANK_DATA_ENDPOINT = `${API_BASE_URL}/manual-upload/bank-data`;
const BS_BANK_BALANCES_ENDPOINT = `${API_BASE_URL}/manual-report-uploads/bs-bank-balances`;
const BANK_RECON_ADJ_ENDPOINT = `${API_BASE_URL}/bank-reconciliation-adjustments`;
const BANK_RECON_ADDBACK_ITEMS_ENDPOINT = `${API_BASE_URL}/bank-reconciliation-addback-items`;
const BANK_RECON_LINE_ITEMS_ENDPOINT = `${API_BASE_URL}/bank-reconciliation-line-items`;
const MANUAL_PL_ALL_ENDPOINT = `${API_BASE_URL}/manual-report-uploads/reports/profit_and_loss/all`;
const RECONCILIATION_STORAGE_PREFIX = "workspace-reconciliation";

// ── BS bank-balance helpers (module-level — no React context needed) ────────
const _bsNormName = (name) =>
  String(name || "").trim().toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
const _bsLastFour = (name) => {
  const m = String(name || "").match(/\b(\d{4})\b/);
  return m ? m[1] : "";
};
// Returns the matched {name, accountNumber, amount} entry or null
function matchBsBank(queryName, bankAccounts) {
  if (!bankAccounts?.length || !queryName) return null;
  const qFour = _bsLastFour(queryName);
  const qNorm = _bsNormName(queryName);
  if (qFour) {
    const byFour = bankAccounts.filter((b) => b.accountNumber === qFour);
    if (byFour.length === 1) return byFour[0];
    if (byFour.length > 1) {
      // disambiguate by name among candidates sharing the same account number
      const nameHit = byFour.find(
        (b) =>
          _bsNormName(b.name) === qNorm ||
          qNorm.includes(_bsNormName(b.name)) ||
          _bsNormName(b.name).includes(qNorm),
      );
      if (nameHit) return nameHit;
      const qW = qNorm.split(" ").filter((w) => w.length > 2);
      if (qW.length) {
        let best = 0, bestMatch = null;
        for (const b of byFour) {
          const bW = _bsNormName(b.name).split(" ").filter((w) => w.length > 2);
          const overlap = qW.filter((w) => bW.includes(w)).length;
          const score = overlap / Math.max(qW.length, bW.length, 1);
          if (score > best) { best = score; bestMatch = b; }
        }
        if (bestMatch && best > 0) return bestMatch;
      }
    }
  }
  const exact = bankAccounts.find((b) => _bsNormName(b.name) === qNorm);
  if (exact) return exact;
  const contains = bankAccounts.find(
    (b) => _bsNormName(b.name).includes(qNorm) || qNorm.includes(_bsNormName(b.name)),
  );
  if (contains) return contains;
  // Stop-word aware word overlap: generic banking words (e.g. "bank") must not
  // decide a match when a more specific identifier (e.g. "needham") is present.
  // Numeric tokens (account number digits embedded in display names) are excluded.
  const BS_STOP = new Set(["bank", "banks", "banking", "financial", "corp", "inc",
    "llc", "ltd", "national", "savings", "credit", "union", "trust", "services",
    "group", "company"]);
  const allW = (s) => s.split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const sigW = (s) => allW(s).filter((w) => !BS_STOP.has(w));
  const qAll = allW(qNorm);
  const qSig = sigW(qNorm);
  if (qAll.length) {
    // First pass — only significant (non-stop, non-numeric) words
    if (qSig.length) {
      let best = 0, bestMatch = null;
      for (const b of bankAccounts) {
        const bSig = sigW(_bsNormName(b.name));
        const overlap = qSig.filter((w) => bSig.includes(w)).length;
        const score = overlap / Math.max(qSig.length, bSig.length, 1);
        if (score > best) { best = score; bestMatch = b; }
      }
      if (bestMatch && best > 0) return bestMatch;
    }
    // Second pass — all non-numeric words (fallback when no significant hit)
    let best = 0, bestMatch = null;
    for (const b of bankAccounts) {
      const bWords = allW(_bsNormName(b.name));
      const overlap = qAll.filter((w) => bWords.includes(w)).length;
      const score = overlap / Math.max(qAll.length, bWords.length, 1);
      if (score > best && score > 0.3) { best = score; bestMatch = b; }
    }
    if (bestMatch) return bestMatch;
  }
  return null;
}

const getErrMsg = (e) => (e instanceof Error ? e.message : String(e));
const getWorkspaceStorageKey = (clientId) =>
  `${RECONCILIATION_STORAGE_PREFIX}:${clientId || "default"}`;
const getDefaultExpandedAccounts = () => ({});
const getLastFourDigits = (accountNumber) => String(accountNumber ?? "").slice(-4);
const TABLE_LABEL_COL_WIDTH = "w-[280px]";
const TABLE_VALUE_COL_WIDTH = "w-[150px]";
const getStoredWorkspaceState = (clientId) => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getWorkspaceStorageKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};
const fmtAmt = (val) => {
  if (val == null || val === 0) return "-";
  return formatNumber(val, 2);
};
const fmtAcct = (val) => {
  if (val == null || val === 0) return "-";
  return formatNumber(val, 2);
};
const fmtVarianceAmt = (val) => {
  if (val == null || val === 0)
    return { display: "-", colorClass: "text-text-muted" };
  const formatted = formatNumber(Math.abs(val), 2);
  if (val < 0)
    return { display: `-${formatted}`, colorClass: "text-red-600 font-medium" };
  return { display: `+${formatted}`, colorClass: "text-green-600 font-medium" };
};
const fmtVariancePct = (val) => {
  if (val == null || val === 0) return { display: "-", colorClass: "text-text-muted" };
  const formatted = formatNumber(val, 1);
  // formatNumber returns "-" for 0, so guard above covers that case.
  if (val < 0)
    return { display: `${formatted}%`, colorClass: "text-red-600 font-medium" };
  return { display: `+${formatted}%`, colorClass: "text-green-600 font-medium" };
};
const monthLabel = (ym) => {
  const [y, m] = ym.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", {
    year: "2-digit",
    month: "short",
  });
};

/**
 * FreezeTable — frozen month header row with horizontally-scrollable body.
 *
 * Two-div approach: a sticky wrapper (no overflow) holds the header table so
 * position:sticky fires relative to the page scroll container (main).
 * The body div has overflow-x:auto; horizontal scrollLeft is kept in sync
 * with the header via a JS scroll listener.
 *
 * IMPORTANT: card containers must NOT use overflow:clip (Chrome bug blocks
 * sticky propagation). Use overflow-clip only on the card header child, not
 * the card outer div.
 */
function FreezeTable({ months, label, containerClass, children }) {
  const headScrollRef = useRef(null);
  const onBodyScroll = useCallback((e) => {
    if (headScrollRef.current) headScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
  }, []);

  // Inline styles guarantee identical pixel widths in both tables regardless
  // of how each container computes min-w-full. Tailwind classes on <col> can
  // yield different effective widths when the two scroll containers differ.
  const colGroup = (
    <colgroup>
      <col style={{ width: 280, minWidth: 280 }} />
      {months.map((m) => <col key={m} style={{ width: 150, minWidth: 150 }} />)}
      <col style={{ width: 150, minWidth: 150 }} />
    </colgroup>
  );

  return (
    <div className={containerClass}>
      {/* Sticky month header — sticks at top of main scroll container */}
      <div className="sticky top-0 z-20">
        <div ref={headScrollRef} className="no-scrollbar overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            {colGroup}
            <thead>
              <tr className="bg-[#F8FBF1]">
                <th className="sticky left-0 z-30 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary">
                  {label}
                </th>
                {months.map((m) => (
                  <th
                    key={m}
                    className={cn(
                      "whitespace-nowrap border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
                      TABLE_VALUE_COL_WIDTH,
                    )}
                  >
                    {monthLabel(m)}
                  </th>
                ))}
                <th className={cn(
                  "border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
                  TABLE_VALUE_COL_WIDTH,
                )}>
                  TTM
                </th>
              </tr>
            </thead>
          </table>
        </div>
      </div>

      {/* Scrollable body — syncs horizontal scroll to the header above */}
      <div className="overflow-x-auto rounded-b-[var(--radius-card)]" onScroll={onBodyScroll}>
        <table className="w-full table-fixed border-collapse bg-white text-[13px]">
          {colGroup}
          <tbody>
            {children}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Inline editable cell for Activity Review adjustment rows.
 * Defined outside the main component so React never unmounts it mid-edit.
 */
function EditableCell({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(value !== 0 ? String(value) : "");
    setEditing(true);
  };

  const commit = () => {
    const raw = String(draft).replace(/,/g, "").trim();
    const parsed = parseFloat(raw);
    onSave(Number.isFinite(parsed) ? parsed : 0);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full bg-blue-50 border border-blue-400 rounded px-2 py-0 text-right text-[12px] tabular-nums outline-none focus:ring-1 focus:ring-blue-400"
      />
    );
  }

  return (
    <span
      onClick={startEdit}
      className={cn(
        "block w-full text-right text-[12px] tabular-nums rounded px-1 py-[3px] min-h-[20px]",
        "cursor-pointer hover:bg-blue-50/80 transition-colors select-none",
        value !== 0 ? "text-text-primary" : "text-text-muted/40",
      )}
      title="Click to edit"
    >
      {value !== 0 ? formatNumber(value, 2) : "-"}
    </span>
  );
}

/**
 * Editable adjustment row — one editable cell per month + TTM total.
 * Defined outside the main component to keep component identity stable
 * (avoids unmounting EditableCell on every re-render).
 */
function AdjRow({ label, rowKey, months, reconAdjustments, onSave }) {
  const getAdj = (m) => reconAdjustments?.[`${m}_${rowKey}`] ?? 0;
  const ttmTotal = months.slice(-12).reduce((s, m) => s + getAdj(m), 0);
  return (
    <tr className="bg-white hover:bg-blue-50/20">
      <td
        className={cn(
          "sticky left-0 z-[1] border border-border px-3 py-[5px] text-[12px]",
          "text-text-primary whitespace-nowrap bg-white pl-7",
          TABLE_LABEL_COL_WIDTH,
        )}
      >
        {label}
      </td>
      {months.map((month) => (
        <td key={month} className={cn("border border-border px-1 py-[2px]", TABLE_VALUE_COL_WIDTH)}>
          <EditableCell
            value={getAdj(month)}
            onSave={(val) => onSave(month, rowKey, val)}
          />
        </td>
      ))}
      <td
        className={cn(
          "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
          TABLE_VALUE_COL_WIDTH,
          ttmTotal !== 0 ? "text-text-primary" : "text-text-muted/40",
        )}
      >
        {ttmTotal !== 0 ? formatNumber(ttmTotal, 2) : "-"}
      </td>
    </tr>
  );
}

function AddbackItemRow({ item, months, onSaveAmounts, onDelete }) {
  const getAmt = (month) => Number(item.monthAmounts?.[month] ?? 0);
  const ttmTotal = months.slice(-12).reduce((sum, m) => sum + getAmt(m), 0);

  const handleSave = (month, val) => {
    const updated = { ...(item.monthAmounts || {}), [month]: val };
    if (val === 0) delete updated[month];
    onSaveAmounts(item.id, updated);
  };

  return (
    <tr className="hover:bg-blue-50/20">
      <td
        className={cn(
          "sticky left-0 z-[1] border border-border px-3 py-[5px] text-[12px]",
          "text-text-primary whitespace-nowrap bg-white pl-10",
          TABLE_LABEL_COL_WIDTH,
        )}
      >
        <div className="flex items-center justify-between gap-1 pr-1">
          <span className="truncate">{item.name}</span>
          <button
            onClick={() => {
              if (window.confirm(`Remove "${item.name}" from addbacks?`)) onDelete(item.id);
            }}
            title="Remove"
            className="flex-shrink-0 text-text-muted hover:text-red-500 transition-colors text-[15px] leading-none font-medium"
          >
            ×
          </button>
        </div>
      </td>
      {months.map((month) => (
        <td key={month} className={cn("border border-border px-1 py-[2px]", TABLE_VALUE_COL_WIDTH)}>
          <EditableCell value={getAmt(month)} onSave={(val) => handleSave(month, val)} />
        </td>
      ))}
      <td
        className={cn(
          "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
          TABLE_VALUE_COL_WIDTH,
          ttmTotal !== 0 ? "text-text-primary" : "text-text-muted/40",
        )}
      >
        {ttmTotal !== 0 ? formatNumber(ttmTotal, 2) : "-"}
      </td>
    </tr>
  );
}

function AddbacksRowGroup({ section, months, addbackItems, onSaveAmounts, onDelete, onOpenPicker }) {
  const sectionItems = addbackItems.filter((i) => i.section === section);

  const totalPerMonth = months.reduce((acc, month) => {
    acc[month] = sectionItems.reduce(
      (sum, item) => sum + Number(item.monthAmounts?.[month] ?? 0),
      0,
    );
    return acc;
  }, {});

  const ttmTotal = months.slice(-12).reduce((sum, m) => sum + (totalPerMonth[m] ?? 0), 0);

  return (
    <>
      <tr className="bg-white hover:bg-blue-50/20">
        <td
          className={cn(
            "sticky left-0 z-[1] border border-border px-3 py-[5px] text-[12px]",
            "text-text-primary whitespace-nowrap bg-white pl-7 font-medium",
            TABLE_LABEL_COL_WIDTH,
          )}
        >
          <div className="flex items-center gap-2">
            <span>Addbacks</span>
            <button
              onClick={onOpenPicker}
              title="Add addback item"
              className="flex items-center justify-center w-[18px] h-[18px] rounded-full bg-green-500 text-white hover:bg-green-600 transition-colors text-[13px] leading-none font-bold"
            >
              +
            </button>
          </div>
        </td>
        {months.map((month) => (
          <td
            key={month}
            className={cn(
              "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
              TABLE_VALUE_COL_WIDTH,
              totalPerMonth[month] !== 0 ? "text-text-primary" : "text-text-muted/40",
            )}
          >
            {totalPerMonth[month] !== 0 ? formatNumber(totalPerMonth[month], 2) : "-"}
          </td>
        ))}
        <td
          className={cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            TABLE_VALUE_COL_WIDTH,
            ttmTotal !== 0 ? "text-text-primary" : "text-text-muted/40",
          )}
        >
          {ttmTotal !== 0 ? formatNumber(ttmTotal, 2) : "-"}
        </td>
      </tr>
      {sectionItems.map((item) => (
        <AddbackItemRow
          key={item.id}
          item={item}
          months={months}
          onSaveAmounts={onSaveAmounts}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function fmtML(mk) {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y, m] = mk.split("-");
  return `${MONTHS[+m - 1]} '${String(y).slice(-2)}`;
}

// Parse a period label like "Jan 24" or "Mar 2026" into an ISO month key "YYYY-MM"
function parsePeriodLabel(label) {
  const MM = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
               Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
  const m = String(label || "").trim().match(/^([A-Za-z]{3})\s+(\d{2,4})$/);
  if (!m) return null;
  const mm = MM[m[1]];
  if (!mm) return null;
  const yr = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${yr}-${mm}`;
}

// Parse manual P&L upload response into plIncomeItems / plExpenseItems arrays
function parseManualPLItems(files) {
  const plIncomeItems = [];
  const plExpenseItems = [];
  if (!Array.isArray(files) || files.length === 0) return { plIncomeItems, plExpenseItems };
  const file = files[0];
  const { rows, periods } = file?.data || {};
  if (!rows || !periods) return { plIncomeItems, plExpenseItems };
  const periodKeys = periods.map(parsePeriodLabel);

  function extractItems(rowList, target, source) {
    for (const row of (rowList || [])) {
      if (row.type === "data" && row.name) {
        const monthAmounts = {};
        (row.colAmounts || []).forEach((val, idx) => {
          const mk = periodKeys[idx];
          if (mk && val != null && val !== 0) monthAmounts[mk] = val;
        });
        target.push({ name: row.name, source, monthAmounts });
      }
      if (row.children?.length) extractItems(row.children, target, source);
    }
  }

  for (const row of rows) {
    if (row.type !== "header") continue;
    const sn = (row.name || "").toLowerCase();
    if (sn.includes("income") || sn.includes("revenue")) {
      extractItems(row.children || [], plIncomeItems, "pl_income");
    } else if (sn.includes("expense") || sn.includes("cost")) {
      extractItems(row.children || [], plExpenseItems, "pl_expense");
    }
  }

  return { plIncomeItems, plExpenseItems };
}

function AddbackPickerModal({
  isOpen,
  section,
  months,
  clientId,
  startDate,
  endDate,
  accountingMethod,
  getHeaders,
  existingItems,
  reportSource,
  onAdd,
  onClose,
}) {
  const isQBOnline = reportSource === "quickbooks_online";
  const isManualUpload = reportSource === "manual_upload_excel_pdf";
  const hasPLData = isQBOnline || isManualUpload;

  // Default tab: deposits→income items, withdrawals→expense items; no-P&L modes→manual only
  const defaultTab = hasPLData ? (section === "withdrawals" ? "expense" : "income") : "manual";
  const [tab, setTab] = useState(defaultTab);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [lineItems, setLineItems] = useState({ plIncomeItems: [], plExpenseItems: [] });
  const [fetchError, setFetchError] = useState(null);
  const [manualName, setManualName] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setTab(hasPLData ? (section === "withdrawals" ? "expense" : "income") : "manual");
    setFetchError(null);
    setLineItems({ plIncomeItems: [], plExpenseItems: [] });

    if (!hasPLData || !clientId) return;

    setLoading(true);

    if (isQBOnline) {
      const params = new URLSearchParams({
        clientId,
        start_date: startDate,
        end_date: endDate,
        accounting_method: accountingMethod || "Accrual",
      });
      fetch(`${BANK_RECON_LINE_ITEMS_ENDPOINT}?${params}`, { headers: getHeaders() })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.success) {
            setLineItems({ plIncomeItems: d.plIncomeItems || [], plExpenseItems: d.plExpenseItems || [] });
          } else {
            setFetchError("Could not load P&L items from QuickBooks.");
          }
        })
        .catch(() => setFetchError("Could not load P&L items from QuickBooks."))
        .finally(() => setLoading(false));
    } else if (isManualUpload) {
      fetch(`${MANUAL_PL_ALL_ENDPOINT}?clientId=${clientId}`, { headers: getHeaders() })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.success && Array.isArray(d.files)) {
            setLineItems(parseManualPLItems(d.files));
          } else {
            setFetchError("Could not load P&L items from manual upload.");
          }
        })
        .catch(() => setFetchError("Could not load P&L items from manual upload."))
        .finally(() => setLoading(false));
    }
  }, [isOpen, reportSource, section, clientId, startDate, endDate, accountingMethod]);

  if (!isOpen) return null;

  const existingNames = new Set(
    existingItems.filter((i) => i.section === section).map((i) => i.name),
  );
  const sourceItems = tab === "income" ? lineItems.plIncomeItems : lineItems.plExpenseItems;
  const filtered = sourceItems.filter(
    (i) =>
      !existingNames.has(i.name) &&
      i.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleAddItem = (name, source, monthAmounts) => {
    onAdd(name, source, monthAmounts);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[520px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-[14px] font-semibold text-text-primary">
            Add Addback — {section === "deposits" ? "Deposits" : "Withdrawals"}
          </h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-[20px] leading-none w-6 h-6 flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="flex border-b border-border">
          {(hasPLData
            ? [["income", "P&L Income"], ["expense", "P&L Expenses"], ["manual", "Manual"]]
            : [["manual", "Manual"]]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "px-4 py-2 text-[12px] font-medium border-b-2 transition-colors",
                tab === key
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-text-muted hover:text-text-primary",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "manual" ? (
          <div className="p-5 flex flex-col gap-3">
            <p className="text-[12px] text-text-muted">
              Enter a name for the addback item. Edit monthly amounts directly in the table.
            </p>
            <input
              type="text"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="e.g. Owner Distributions"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualName.trim()) {
                  handleAddItem(manualName.trim(), "manual", {});
                  setManualName("");
                }
                if (e.key === "Escape") onClose();
              }}
              className="border border-border rounded-lg px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              onClick={() => {
                if (!manualName.trim()) return;
                handleAddItem(manualName.trim(), "manual", {});
                setManualName("");
              }}
              disabled={!manualName.trim()}
              className="self-start px-4 py-2 bg-blue-600 text-white text-[12px] font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add Item
            </button>
          </div>
        ) : (
          <>
            <div className="px-4 pt-3 pb-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search accounts..."
                className="w-full border border-border rounded-lg px-3 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {loading ? (
                <div className="flex items-center justify-center py-8 text-[12px] text-text-muted">
                  Loading P&L items…
                </div>
              ) : fetchError ? (
                <div className="mx-2 my-3 px-3 py-3 bg-orange-50 border border-orange-200 rounded-lg text-[12px] text-orange-700">
                  {fetchError}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-[12px] text-text-muted">
                  {search ? "No items match your search." : "No items available."}
                </div>
              ) : (
                filtered.map((item) => {
                  const filterMonths = months || [];
                  const monthsWithData = filterMonths.filter(
                    (m) => item.monthAmounts?.[m] != null,
                  );
                  const outsideRange = Object.keys(item.monthAmounts || {}).filter(
                    (m) => !filterMonths.includes(m),
                  );
                  return (
                    <button
                      key={item.name}
                      onClick={() => handleAddItem(item.name, item.source, item.monthAmounts)}
                      className="w-full flex flex-col px-3 py-2.5 rounded-lg hover:bg-blue-50 text-left transition-colors group border-b border-border/40 last:border-0"
                    >
                      <span className="text-[12px] text-text-primary font-medium group-hover:text-blue-700">
                        {item.name}
                      </span>
                      {monthsWithData.length > 0 ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                          {monthsWithData.map((m) => {
                            const val = Number(item.monthAmounts[m]);
                            return (
                              <span key={m} className="text-[10px] text-text-muted">
                                {fmtML(m)}:{" "}
                                <span
                                  className={
                                    val < 0 ? "text-red-500 font-medium" : "text-green-700 font-medium"
                                  }
                                >
                                  {formatNumber(val, 0)}
                                </span>
                              </span>
                            );
                          })}
                          {outsideRange.length > 0 && (
                            <span className="text-[10px] text-text-muted/50 italic">
                              +{outsideRange.length} outside range
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-text-muted/60 mt-0.5 italic">
                          No data in selected range
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Normalize the API response into the shape consumed by the table renderer.
 *
 * API shape (per bank):
 *   bank.bank_name          string
 *   bank.accounts[0].months[]  { monthKey, startingBalance, deposits, withdrawals, endingBalance }
 *   bank.accounts[0].totals    { startingBalance, deposits, withdrawals, endingBalance }
 *
 * Normalised shape (per bank):
 *   { bankName, months[], totals }
 */

// Convert "Jan-2025" display key ↔ "2025-01" ISO key
const _DISP_MONTH_MAP = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const _ISO_TO_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const displayMonthToIso = (d) => {
  const [mon, year] = String(d || "").split("-");
  return _DISP_MONTH_MAP[mon] ? `${year}-${_DISP_MONTH_MAP[mon]}` : d;
};
const isoToDisplayMonth = (iso) => {
  const [year, month] = String(iso || "").split("-");
  const idx = parseInt(month, 10) - 1;
  return `${_ISO_TO_SHORT[idx] || month}-${year}`;
};

// Normalize a month entry that may be a string "Jan-2025" or object {key, label}
const normMonth = (m) => {
  if (typeof m === "string") return { key: displayMonthToIso(m), label: m };
  if (m?.key) return m;
  if (m?.monthKey) return { key: m.monthKey, label: isoToDisplayMonth(m.monthKey) };
  return null;
};

// Normalize a totals entry that may have {month: "Jan-2025"} or {monthKey: "2025-01"}
const normTotal = (t) => {
  const key = t.monthKey || (t.month ? displayMonthToIso(t.month) : null);
  return { ...t, monthKey: key };
};

const normalizeExtractedBankPdfData = (payload) => {
  if (!payload?.banks?.length || !payload?.months?.length) return null;

  const months = (payload.months || []).map(normMonth).filter(Boolean);
  if (!months.length) return null;

  const banks = payload.banks.map((bank) => {
    const acct = bank.accounts?.[0];
    // Dropdown display name: prefer bank_name (includes last-4 suffix) for uniqueness
    const displayName = bank.bank_name || bank.bankName || "Unknown Bank";
    return {
      bankName: displayName,
      bankNameClean: bank.bank_name_clean || bank.bankName || displayName,
      accountName: bank.account_name || bank.accountName || "",
      accountNumber: bank.account_number || bank.accountNumber || "",
      status: acct?.status || "Verified",
      months: (acct?.months || []).map((m) => ({
        monthKey: m.monthKey,
        startingBalance: m.startingBalance ?? 0,
        deposits: m.deposits ?? 0,
        withdrawals: m.withdrawals ?? 0,
        endingBalance: m.endingBalance ?? 0,
        status: m.status || "Verified",
        statementStartDate: m.statement_start_date || "",
        statementEndDate: m.statement_end_date || "",
      })),
      totals: {
        startingBalance:
          acct?.totals?.startingBalance ??
          (acct?.months || []).reduce((sum, m) => sum + (m.startingBalance || 0), 0),
        deposits:
          acct?.totals?.deposits ??
          (acct?.months || []).reduce((sum, m) => sum + (m.deposits || 0), 0),
        withdrawals:
          acct?.totals?.withdrawals ??
          (acct?.months || []).reduce((sum, m) => sum + (m.withdrawals || 0), 0),
        endingBalance:
          acct?.totals?.endingBalance ??
          (acct?.months || []).reduce((sum, m) => sum + (m.endingBalance || 0), 0),
      },
    };
  });

  return {
    months,
    banks,
    totals: (payload.totals || []).map(normTotal),
    syncedAt: payload.syncedAt || null,
    documentCount: payload.documentCount || banks.length,
  };
};
function buildEmptyTTM() {
  return {
    startingBalance: 0,
    deposits: 0,
    withdrawals: 0,
    endingBalance: 0,
    intercompanyDeposits: 0,
    intercompanyWithdraws: 0,
    footingCheck: 0,
    priorMonthCheck: 0,
    perBalanceSheet: 0,
    variance: 0,
    outstandingChecks: 0,
    unreconciledDollar: 0,
    unreconciledPct: 0,
  };
}

function buildEmptyActivityReviewRow() {
  return {
    totalDeposits: 0,
    intercompanyTransfers: 0,
    externalDeposits: 0,
    salesPerFinancials: 0,
    depositsDollarVar: 0,
    depositsPctVar: 0,
    changeInAR: 0,
    changeInARRetentions: 0,
    fixedAssetDisposals: 0,
    depositsOther: 0,
    depositsUnreconciledDollar: 0,
    depositsUnreconciledPct: 0,
    totalWithdrawals: 0,
    withdrawIntercompanyTransfers: 0,
    externalWithdraws: 0,
    expensesPerFinancials: 0,
    withdrawsDollarVar: 0,
    withdrawsPctVar: 0,
    ownerWithdraws: 0,
    changeInCurrentLiabilities: 0,
    changeInLTLiabilities: 0,
    depreciationExpense: 0,
    amortizationExpense: 0,
    badDebtExpense: 0,
    fixedAssetPurchases: 0,
    withdrawsOther: 0,
    withdrawsUnreconciledDollar: 0,
    withdrawsUnreconciledPct: 0,
  };
}

export default function WorkspaceReconciliation() {
  const { clientId } = useParams();
  // Use the global DataSourceContext as the single source of truth for the active source.
  // This is the same value the header badge shows (localStorage-backed, survives refreshes).
  // WorkspaceReconciliation must never call getReportSources independently — doing so reads
  // only the DB value and can be stale relative to the localStorage cache in DataSourceContext.
  const { activeSource: contextActiveSource, sourceRecords: contextSourceRecords } = useDataSource();
  // Shared dataset-version selection (same store Reports writes to) so the
  // reconciliation reconciles against the version chosen in Reports. Manual GL only.
  const glVersions = useDatasetVersionStore((s) => s.versions);
  const glSelectedVersion = useDatasetVersionStore((s) => s.selectedVersion);
  const setGlSelectedVersion = useDatasetVersionStore((s) => s.setSelectedVersion);
  const fetchGlVersions = useDatasetVersionStore((s) => s.fetchVersions);
  // Track the live GL scope (selected dataset version) so an in-flight bank-data
  // fetch for a previous version can be discarded if the user switches mid-fetch —
  // prevents stale-version data overwriting fresh (needs F5) data. Time filtering
  // is handled client-side by the From/To date pickers, not by a fiscal-year scope.
  const glScopeRef = useRef({ datasetVersion: glSelectedVersion });
  glScopeRef.current = { datasetVersion: glSelectedVersion };
  const storedState = getStoredWorkspaceState(clientId);
  const [expandedAccounts, setExpandedAccounts] = useState(
    storedState?.expandedAccounts || getDefaultExpandedAccounts(),
  );
  const [bankActivityStartMonth, setBankActivityStartMonth] = useState(
    storedState?.bankActivityStartMonth || "2026-01",
  );
  const [bankActivityEndMonth, setBankActivityEndMonth] = useState(
    storedState?.bankActivityEndMonth || "2026-04",
  );
  const [bankActivityAccountingMethod, setBankActivityAccountingMethod] =
    useState(storedState?.bankActivityAccountingMethod || "Accrual");
  const [qbBankActivity, setQbBankActivity] = useState(
    storedState?.qbBankActivity || null,
  );
  const [isLoadingBankActivity, setIsLoadingBankActivity] = useState(false);
  const [bankActivityError, setBankActivityError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState(storedState?.lastSyncedAt || null);
  const [bankActivityFetchStatus, setBankActivityFetchStatus] = useState({
    status: storedState?.qbBankActivity ? "success" : "idle",
    message: storedState?.qbBankActivity
      ? "Restored saved QuickBooks bank activity."
      : "",
  });
  const [selectedBalanceBankId, setSelectedBalanceBankId] = useState(
    storedState?.selectedBalanceBankId || "",
  );
  const [selectedManualBankName, setSelectedManualBankName] = useState("");
  const [oneBankAccountId, setOneBankAccountId] = useState(
    storedState?.oneBankAccountId || "",
  );
  const [qbOneBankActivity, setQbOneBankActivity] = useState(
    storedState?.qbOneBankActivity || null,
  );
  const [isLoadingOneBankActivity, setIsLoadingOneBankActivity] =
    useState(false);
  const [oneBankActivityError, setOneBankActivityError] = useState("");
  const [oneBankActivityFetchStatus, setOneBankActivityFetchStatus] = useState({
    status: storedState?.qbOneBankActivity ? "success" : "idle",
    message: storedState?.qbOneBankActivity
      ? "Restored saved single-account QuickBooks activity."
      : "",
  });
  const [extractedBankPdfData, setExtractedBankPdfData] = useState(null);
  const [isLoadingExtractedBankPdfData, setIsLoadingExtractedBankPdfData] =
    useState(false);
  const [extractedBankPdfError, setExtractedBankPdfError] = useState("");
  const [extractedBankPdfFetchStatus, setExtractedBankPdfFetchStatus] =
    useState({
      status: "idle",
      message: "",
    });
  const [manualMonthStart, setManualMonthStart] = useState(null);
  const [manualMonthEnd, setManualMonthEnd] = useState(null);
  const [bsBankBalances, setBsBankBalances] = useState(null);
  const [plFinancials, setPlFinancials] = useState(null);
  const [reportSources, setReportSources] = useState([]);
  const [selectedReportSource, setSelectedReportSourceState] = useState(
    normalizeReportSourceKey(
      storedState?.selectedReportSource || REPORT_SOURCE_KEYS.QUICKBOOKS,
    ),
  );
  // True only after getReportSources API confirms the actual source.
  // Prevents stale storedState from triggering the wrong endpoint on mount.
  const [isSourceConfirmedByServer, setIsSourceConfirmedByServer] = useState(false);
  // Persisted adjustment values keyed by "${month}_${rowKey}", e.g. "2025-01_changeInAR".
  const [reconAdjustments, setReconAdjustments] = useState({});
  // Named addback items (multi-item rows) for deposits and withdrawals sections.
  const [addbackItems, setAddbackItems] = useState([]);
  // Controls the addback picker modal: null = closed, { open, section, startDate, endDate } = open.
  const [addbackPickerState, setAddbackPickerState] = useState(null);

  // Always reflects the latest selectedReportSource — used to discard in-flight fetch results
  // that started under a different source (race condition: user switches source while a fetch
  // for the old source is still in-flight; the stale result would overwrite the correct data).
  // Assigned synchronously in the render body so the ref is always current before any effect fires.
  const activeSourceRef = useRef(selectedReportSource);
  activeSourceRef.current = selectedReportSource;

  const getHeaders = useCallback(
    () => {
      const token = getStoredToken();
      return {
        ...(token
          ? {
            Authorization: `Bearer ${token}`,
            "X-Access-Token": token,
            "X-Auth-Token": token,
            "X-Token": token,
          }
          : {}),
        ...(clientId ? { "X-Client-Id": clientId } : {}),
      };
    },
    [clientId],
  );

  useEffect(() => {
    // Reset server-confirmation guard so the unified loader cannot fire until
    // getReportSources confirms the correct source for this clientId.
    // Without this, navigating between clients (SPA) leaves isSourceConfirmedByServer=true,
    // causing the unified loader to dispatch the OLD source's endpoint for the new client.
    setIsSourceConfirmedByServer(false);

    const nextState = getStoredWorkspaceState(clientId);
    setExpandedAccounts(
      nextState?.expandedAccounts || getDefaultExpandedAccounts(),
    );
    setBankActivityStartMonth(nextState?.bankActivityStartMonth || "2026-01");
    setBankActivityEndMonth(nextState?.bankActivityEndMonth || "2026-04");
    setBankActivityAccountingMethod(
      nextState?.bankActivityAccountingMethod || "Accrual",
    );
    setQbBankActivity(nextState?.qbBankActivity || null);
    setBankActivityFetchStatus({
      status: nextState?.qbBankActivity ? "success" : "idle",
      message: nextState?.qbBankActivity
        ? "Restored saved QuickBooks bank activity."
        : "",
    });
    setBankActivityError("");
    setLastSyncedAt(nextState?.lastSyncedAt || null);
    setSelectedBalanceBankId(nextState?.selectedBalanceBankId || "");
    setOneBankAccountId(nextState?.oneBankAccountId || "");
    setQbOneBankActivity(nextState?.qbOneBankActivity || null);
    setOneBankActivityFetchStatus({
      status: nextState?.qbOneBankActivity ? "success" : "idle",
      message: nextState?.qbOneBankActivity
        ? "Restored saved single-account QuickBooks activity."
        : "",
    });
    setOneBankActivityError("");
    const restoredSource = normalizeReportSourceKey(
      nextState?.selectedReportSource || REPORT_SOURCE_KEYS.QUICKBOOKS,
    );
    // Always discard stored bank data — getReportSources will confirm the real source
    // and the unified loader will fetch fresh data from the correct endpoint.
    setExtractedBankPdfData(null);
    setExtractedBankPdfFetchStatus({ status: "idle", message: "" });
    setExtractedBankPdfError("");
    setSelectedReportSourceState(restoredSource);
  }, [clientId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const key = getWorkspaceStorageKey(clientId);
      const existing = getStoredWorkspaceState(clientId) || {};
      window.sessionStorage.setItem(
        key,
        JSON.stringify({
          ...existing,
          expandedAccounts,
          bankActivityStartMonth,
          bankActivityEndMonth,
          bankActivityAccountingMethod,
          qbBankActivity: qbBankActivity ?? existing.qbBankActivity ?? null,
          lastSyncedAt: lastSyncedAt ?? existing.lastSyncedAt ?? null,
          selectedBalanceBankId,
          oneBankAccountId,
          qbOneBankActivity:
            qbOneBankActivity ?? existing.qbOneBankActivity ?? null,
          extractedBankPdfData: extractedBankPdfData,
          // Store which source produced this data so stale cross-source data is never served.
          extractedBankPdfDataSource:
            extractedBankPdfData != null ? selectedReportSource : null,
          selectedReportSource,
        }),
      );
    } catch {
      // Ignore storage issues
    }
  }, [
    clientId,
    expandedAccounts,
    bankActivityStartMonth,
    bankActivityEndMonth,
    bankActivityAccountingMethod,
    qbBankActivity,
    lastSyncedAt,
    selectedBalanceBankId,
    oneBankAccountId,
    qbOneBankActivity,
    extractedBankPdfData,
    selectedReportSource,
  ]);

  // ── Load saved snapshot from DB (no QB connection needed) ─────────────────
  const loadSavedQBBankActivity = useCallback(async () => {
    if (!clientId) return;
    try {
      const params = new URLSearchParams({ clientId });
      const resp = await fetch(`${QB_BANK_ACTIVITY_SAVED_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      if (!resp.ok) return;
      const result = await resp.json();
      if (!result?.found || !result?.data) return;

      setQbBankActivity(result.data);
      setLastSyncedAt(result.updatedAt || null);
      const syncLabel = result.updatedAt
        ? new Date(result.updatedAt).toLocaleString()
        : "previously";
      setBankActivityFetchStatus({
        status: "success",
        message: `Restored saved data (last synced: ${syncLabel}).`,
      });
    } catch {
      // Non-fatal — page still works, user can click Fetch Activity
    }
  }, [clientId, getHeaders]);

  const loadQBBankActivity = async () => {
    setIsLoadingBankActivity(true);
    setBankActivityError("");
    setBankActivityFetchStatus({
      status: "loading",
      message: "Fetching QuickBooks bank activity...",
    });
    try {
      const [sy, sm] = bankActivityStartMonth.split("-");
      const [ey, em] = bankActivityEndMonth.split("-");
      const start_date = `${sy}-${sm}-01`;
      const lastDay = new Date(+ey, +em, 0).getDate();
      const end_date = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;

      const params = new URLSearchParams({
        start_date,
        end_date,
        accounting_method: bankActivityAccountingMethod,
      });
      if (clientId) params.append("clientId", clientId);

      const resp = await fetch(`${QB_BANK_ACTIVITY_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      const now = new Date().toISOString();
      setQbBankActivity(data);
      setLastSyncedAt(now);
      setBankActivityFetchStatus({
        status: "success",
        message: `Fetched ${data?.months?.length ?? 0} month(s) across ${data?.accounts?.length ?? 0} account(s). Last synced: ${new Date(now).toLocaleString()}.`,
      });
    } catch (e) {
      setBankActivityError(getErrMsg(e));
      setBankActivityFetchStatus({ status: "error", message: getErrMsg(e) });
      setQbBankActivity(null);
    } finally {
      setIsLoadingBankActivity(false);
    }
  };

  const loadQBOneBankActivity = async () => {
    if (!oneBankAccountId) {
      const msg = "Please select a QuickBooks bank account.";
      setOneBankActivityError(msg);
      setOneBankActivityFetchStatus({ status: "error", message: msg });
      return;
    }

    setIsLoadingOneBankActivity(true);
    setOneBankActivityError("");
    setOneBankActivityFetchStatus({
      status: "loading",
      message: "Fetching selected QuickBooks bank activity...",
    });

    try {
      const [sy, sm] = bankActivityStartMonth.split("-");
      const [ey, em] = bankActivityEndMonth.split("-");
      const start_date = `${sy}-${sm}-01`;
      const lastDay = new Date(+ey, +em, 0).getDate();
      const end_date = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;

      const params = new URLSearchParams({
        accountId: oneBankAccountId,
        start_date,
        end_date,
      });
      if (clientId) params.append("clientId", clientId);

      const resp = await fetch(`${QB_ONE_BANK_ACTIVITY_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      setQbOneBankActivity(data);
      setOneBankActivityFetchStatus({
        status: "success",
        message: `Loaded ${data?.monthlyData?.length ?? 0} month(s) for ${data?.account?.bankName || "selected account"
          }.`,
      });
    } catch (e) {
      setOneBankActivityError(getErrMsg(e));
      setOneBankActivityFetchStatus({
        status: "error",
        message: getErrMsg(e),
      });
      setQbOneBankActivity(null);
    } finally {
      setIsLoadingOneBankActivity(false);
    }
  };

  const loadExtractedBankPdfData = useCallback(async (opts = {}) => {
    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading extracted bank PDF records...",
    });

    try {
      const params = new URLSearchParams();
      if (clientId) params.append("clientId", clientId);
      // Pass the active source so the backend reads from the correct folder + cache partition.
      if (selectedReportSource) params.append("source", selectedReportSource);
      // Manual GL scoping: restrict to the selected dataset version (all years).
      // The From/To date pickers narrow the displayed months client-side.
      if (opts.datasetVersion) params.append("datasetVersion", String(opts.datasetVersion));
      const url = `${EXTRACT_BANK_PDF_RECORDS_ENDPOINT}?${params.toString()}`;
      const resp = await fetch(url, {
        cache: "no-store",
        headers: getHeaders(),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      const normalized = normalizeExtractedBankPdfData(data);
      // Discard result if source changed while this fetch was in-flight, or —
      // for Manual GL — if the selected version changed mid-fetch.
      if (activeSourceRef.current !== selectedReportSource) return;
      if (opts.datasetVersion != null &&
        String(glScopeRef.current.datasetVersion) !== String(opts.datasetVersion)) return;
      setExtractedBankPdfData(normalized);
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: `Loaded ${normalized?.banks?.length ?? 0} bank(s) across ${normalized?.months?.length ?? 0
          } month(s).`,
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({
        status: "error",
        message: getErrMsg(e),
      });
      setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders]);

  const loadQMSBankData = useCallback(async () => {
    // Always read from activeSourceRef.current (not the stale closure value of selectedReportSource).
    // A stale useCallback created when source was "quickbooks_manual" can survive into renders
    // where the source has already switched — the ref ensures we see the live current value.
    if (activeSourceRef.current !== REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      console.warn(`[BankData] loadQMSBankData blocked — activeSource=${activeSourceRef.current} is not QuickBooks Manual`);
      return;
    }

    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    setPlFinancials(null);
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading bank statement data from QuickBooks Manual source...",
    });

    try {
      const params = new URLSearchParams();
      if (clientId) params.append("clientId", clientId);
      const url = `${QMS_BANK_DATA_ENDPOINT}?${params.toString()}`;
      const resp = await fetch(url, { cache: "no-store", headers: getHeaders() });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      const normalized = normalizeExtractedBankPdfData(data);
      // Discard result if source changed while this fetch was in-flight.
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfData(normalized);
      // Set P&L financials from merged response (Sales/Expenses per Financials for Activity Review)
      setPlFinancials(data.plFinancials ?? null);
      setExtractedBankPdfFetchStatus({
        status: normalized ? "success" : "idle",
        message: normalized
          ? `Loaded ${normalized.banks?.length ?? 0} bank(s) across ${normalized.months?.length ?? 0} month(s).`
          : "No bank statement data found. Please sync your QuickBooks Manual Source folder first.",
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({ status: "error", message: getErrMsg(e) });
      setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders]);

  const loadManualBankData = useCallback(async () => {
    if (activeSourceRef.current !== REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      console.warn(`[BankData] loadManualBankData blocked — activeSource=${activeSourceRef.current} is not Manual Upload`);
      return;
    }
    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    setPlFinancials(null);
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading bank statement data from Manual Upload source...",
    });
    try {
      const params = new URLSearchParams();
      if (clientId) params.append("clientId", clientId);
      const url = `${MANUAL_BANK_DATA_ENDPOINT}?${params.toString()}`;
      const resp = await fetch(url, { cache: "no-store", headers: getHeaders() });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      if (activeSourceRef.current !== selectedReportSource) return;
      // Set BS bank accounts from the merged response (always, even for empty cases)
      if (data.balanceSheetBankAccounts?.bankAccounts?.length > 0) {
        setBsBankBalances({ success: true, ...data.balanceSheetBankAccounts });
      } else {
        setBsBankBalances(null);
      }
      // Set P&L financials (Sales/Expenses per Financials for Activity Review)
      setPlFinancials(data.plFinancials ?? null);
      if (data.empty) {
        setExtractedBankPdfData(null);
        setExtractedBankPdfFetchStatus({
          status: "success",
          message: data.message || "No bank statements uploaded. Upload PDF or Excel files to Manual Upload Source → Bank Statement.",
        });
        return;
      }
      const normalized = normalizeExtractedBankPdfData(data);
      setExtractedBankPdfData(normalized);
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: normalized
          ? `Loaded ${normalized.banks?.length ?? 0} bank(s).`
          : "No bank statement data found. Upload files to Manual Upload Source → Bank Statement.",
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({ status: "error", message: getErrMsg(e) });
      setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders]);

  // Fetches BS bank balances for manual/QMS sources and stores in bsBankBalances state.
  // Silently no-ops for QB Online (no manual BS files) and on errors (show "-" fallback).
  const loadBsBankBalances = useCallback(async (sourceKey, opts = {}) => {
    if (!clientId) return;
    console.log(`[BsBankBalances] Fetching for clientId=${clientId} source=${sourceKey}`);
    try {
      const params = new URLSearchParams();
      params.append("clientId", clientId);
      if (sourceKey) params.append("source", sourceKey);
      // Manual GL scoping: pick the Balance Sheet for the selected version.
      if (opts.datasetVersion) params.append("datasetVersion", String(opts.datasetVersion));
      const resp = await fetch(`${BS_BANK_BALANCES_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
        headers: getHeaders(),
      });
      if (!resp.ok) {
        console.warn(`[BsBankBalances] HTTP ${resp.status} from backend`);
        setBsBankBalances(null);
        return;
      }
      const data = await resp.json();
      console.log(`[BsBankBalances] Response: source=${data.source} year=${data.year} accounts=${data.bankAccounts?.length ?? 0}`);
      // For Manual GL, discard if the selected version changed while this fetch
      // was in-flight (last-write-wins guard).
      if (opts.datasetVersion != null &&
        String(glScopeRef.current.datasetVersion) !== String(opts.datasetVersion)) return;
      if (data?.success && data.bankAccounts?.length > 0) {
        setBsBankBalances(data);
      } else {
        console.log(`[BsBankBalances] No bank accounts returned (source="${data.source}"): ${data.message || ""}`);
        setBsBankBalances(null);
      }
    } catch (e) {
      console.error(`[BsBankBalances] Fetch error: ${e?.message || e}`);
      setBsBankBalances(null);
    }
  }, [clientId, getHeaders]);

  // Load persisted reconciliation adjustments for this company on mount / clientId change.
  useEffect(() => {
    if (!clientId) return;
    fetch(`${BANK_RECON_ADJ_ENDPOINT}?clientId=${clientId}`, { headers: getHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.success && Array.isArray(d.adjustments)) {
          const map = {};
          d.adjustments.forEach((a) => {
            map[`${a.month}_${a.rowKey}`] = Number(a.amount) || 0;
          });
          setReconAdjustments(map);
        }
      })
      .catch(() => {});
  }, [clientId, getHeaders]);

  // Load persisted addback items — isolated by company AND connection mode.
  useEffect(() => {
    if (!clientId || !selectedReportSource) return;
    setAddbackItems([]); // clear immediately so old mode's items never flash
    fetch(
      `${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}?clientId=${clientId}&reportSource=${encodeURIComponent(selectedReportSource)}`,
      { headers: getHeaders() },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.success && Array.isArray(d.items)) setAddbackItems(d.items);
      })
      .catch(() => {});
  }, [clientId, getHeaders, selectedReportSource]);

  const saveAdjustment = useCallback(
    async (month, rowKey, amount) => {
      const key = `${month}_${rowKey}`;
      setReconAdjustments((prev) => ({ ...prev, [key]: amount }));
      try {
        await fetch(BANK_RECON_ADJ_ENDPOINT, {
          method: "POST",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, month, rowKey, amount }),
        });
      } catch {
        // Value stays in local state even if the network request fails
      }
    },
    [clientId, getHeaders],
  );

  const createAddbackItem = useCallback(
    async (section, name, source, monthAmounts) => {
      try {
        const resp = await fetch(BANK_RECON_ADDBACK_ITEMS_ENDPOINT, {
          method: "POST",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, section, name, source, monthAmounts, reportSource: selectedReportSource }),
        });
        const data = await resp.json();
        if (data?.success && data.item) {
          setAddbackItems((prev) => [...prev, data.item]);
        }
      } catch { /* stays in local state */ }
    },
    [clientId, getHeaders, selectedReportSource],
  );

  const updateAddbackItemAmounts = useCallback(
    async (id, monthAmounts) => {
      setAddbackItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, monthAmounts } : i)),
      );
      try {
        await fetch(`${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}/${id}`, {
          method: "PUT",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, monthAmounts }),
        });
      } catch { /* value stays in local state */ }
    },
    [clientId, getHeaders],
  );

  const deleteAddbackItem = useCallback(
    async (id) => {
      setAddbackItems((prev) => prev.filter((i) => i.id !== id));
      try {
        await fetch(
          `${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}/${id}?clientId=${encodeURIComponent(clientId)}`,
          { method: "DELETE", headers: getHeaders() },
        );
      } catch { /* removed from local state already */ }
    },
    [clientId, getHeaders],
  );

  // Unified bank-data loader — dispatches ONLY based on server-confirmed source.
  // isSourceConfirmedByServer prevents stale storedState from triggering the wrong endpoint.
  // Never short-circuit on stored data — stored data may be from a different source.
  useEffect(() => {
    if (!clientId || !selectedReportSource || !isSourceConfirmedByServer) return;

    if (selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      // Manual Upload → single endpoint returns both bank data and balanceSheetBankAccounts
      void loadManualBankData();
    } else if (selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL) {
      // Manual GL → PDF/Excel extraction endpoint, scoped to the selected dataset
      // version so a different version's data never mixes in. All of the version's
      // months are fetched; the From/To date pickers narrow the view client-side.
      const glScope = { datasetVersion: glSelectedVersion };
      void loadExtractedBankPdfData(glScope);
      void loadBsBankBalances("manual_upload_excel_pdf", glScope);
    } else if (selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      // QuickBooks Manual ONLY → QMS endpoint reading "Quickbooks Manual Source" folder only
      void loadQMSBankData();
      void loadBsBankBalances("quickbooks_manual");
    }
    // QUICKBOOKS (QB Online) uses its own separate data flow — no action here
  }, [clientId, selectedReportSource, isSourceConfirmedByServer, glSelectedVersion, loadExtractedBankPdfData, loadManualBankData, loadQMSBankData, loadBsBankBalances]);

  // Auto-restore QB Online bank activity from DB on page load.
  // Fires when the server confirms the source is QB Online and there is no
  // session-cached data already loaded.  This way a page refresh or QBO
  // disconnect never leaves the table empty — the last successfully saved
  // snapshot is shown immediately without a fresh QBO API call.
  useEffect(() => {
    if (!isSourceConfirmedByServer) return;
    if (selectedReportSource !== REPORT_SOURCE_KEYS.QUICKBOOKS) return;
    if (qbBankActivity) return; // session already has data — no need to hit DB
    void loadSavedQBBankActivity();
  }, [isSourceConfirmedByServer, selectedReportSource, qbBankActivity, loadSavedQBBankActivity]);

  // When a saved snapshot loads without plFinancials (saved before this feature was added),
  // fetch P&L totals from the line-items endpoint and merge them in.
  useEffect(() => {
    if (selectedReportSource !== REPORT_SOURCE_KEYS.QUICKBOOKS) return;
    if (!clientId || !qbBankActivity?.months?.length) return;
    const hasIncome = Object.keys(qbBankActivity.plFinancials?.totalIncome || {}).length > 0;
    if (hasIncome) return;

    const mons = qbBankActivity.months;
    const startDate = `${mons[0]}-01`;
    const [ey, em] = mons[mons.length - 1].split("-");
    const endDate = `${mons[mons.length - 1]}-${String(new Date(+ey, +em, 0).getDate()).padStart(2, "0")}`;

    const params = new URLSearchParams({
      clientId,
      start_date: startDate,
      end_date: endDate,
      accounting_method: bankActivityAccountingMethod || "Accrual",
    });
    fetch(`${BANK_RECON_LINE_ITEMS_ENDPOINT}?${params}`, { headers: getHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.success) return;
        setQbBankActivity((prev) =>
          prev
            ? { ...prev, plFinancials: { totalIncome: d.plTotalIncome || {}, totalExpenses: d.plTotalExpenses || {} } }
            : prev,
        );
      })
      .catch(() => {});
  }, [qbBankActivity, selectedReportSource, clientId, bankActivityAccountingMethod, getHeaders]);

  // Drive selectedReportSource from DataSourceContext.activeSource — the single source of truth
  // that the header badge also reads. This eliminates the split-brain between the badge and the
  // reconciliation page that was causing qms-bank-data to fire in Manual Upload mode.
  useEffect(() => {
    if (!contextActiveSource) return;
    const confirmed = normalizeReportSourceKey(contextActiveSource);
    if (!confirmed) return;
    setSelectedReportSourceState(confirmed);
    setReportSources(
      Array.isArray(contextSourceRecords) ? contextSourceRecords.map((s) => ({
        key: normalizeReportSourceKey(s.sourceKey),
        label: s.sourceLabel || getReportSourceLabel(s.sourceKey),
      })) : [],
    );
    setExtractedBankPdfData(null);
    setExtractedBankPdfFetchStatus({ status: "idle", message: "" });
    setExtractedBankPdfError("");
    setBsBankBalances(null);
    setIsSourceConfirmedByServer(true);
  }, [contextActiveSource, contextSourceRecords]);

  const handleReportSourceChange = async (sourceKey) => {
    const normalized = normalizeReportSourceKey(sourceKey);
    const previous = selectedReportSource;
    setSelectedReportSourceState(normalized);
    // Clear ALL source-specific data immediately — never show cross-source data.
    setExtractedBankPdfData(null);
    setExtractedBankPdfFetchStatus({ status: "idle", message: "" });
    setExtractedBankPdfError("");
    setBsBankBalances(null);
    setQbBankActivity(null);
    setBankActivityFetchStatus({ status: "idle", message: "" });
    setBankActivityError("");
    setQbOneBankActivity(null);
    setOneBankActivityFetchStatus({ status: "idle", message: "" });
    setOneBankActivityError("");
    try {
      const payload = await setSelectedReportSource(normalized, { clientId });
      const confirmedKey = normalizeReportSourceKey(payload?.selectedSource) || normalized;
      // Notify DataSourceContext so the badge and all other consumers see the new source.
      emitWorkspaceDataSourceUpdated({ clientId, sourceKey: confirmedKey });
    } catch {
      setSelectedReportSourceState(previous);
      emitWorkspaceDataSourceUpdated({ clientId, sourceKey: previous });
    }
  };

  const sourceOptions = useMemo(() => {
    if (Array.isArray(reportSources) && reportSources.length > 0) {
      return reportSources.map((s) => ({
        key: normalizeReportSourceKey(s.sourceKey),
        label: s.sourceLabel || getReportSourceLabel(s.sourceKey),
      }));
    }
    return REPORT_SOURCE_OPTIONS.map((o) => ({ key: o.key, label: o.label }));
  }, [reportSources]);

  const isManualUpload = selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
  const isManualGl = selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL;
  const isQBManual = selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
  const isQBOnline = selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS;

  const allPdfMonths = useMemo(
    () => (extractedBankPdfData?.months || []).map((m) => m.key).sort(),
    [extractedBankPdfData],
  );

  useEffect(() => {
    if (!allPdfMonths.length) {
      setManualMonthStart(null);
      setManualMonthEnd(null);
    } else {
      setManualMonthStart(allPdfMonths[0]);
      setManualMonthEnd(allPdfMonths[allPdfMonths.length - 1]);
    }
  }, [allPdfMonths]);

  const filteredPdfMonths = useMemo(() => {
    if (!allPdfMonths.length) return [];
    const start = manualMonthStart || allPdfMonths[0];
    const end = manualMonthEnd || allPdfMonths[allPdfMonths.length - 1];
    return allPdfMonths.filter((m) => m >= start && m <= end);
  }, [allPdfMonths, manualMonthStart, manualMonthEnd]);

  // ── Manual GL version + fiscal-year scoping ─────────────────────────────────
  // Load available dataset versions (shared store, cached per company).
  useEffect(() => {
    if (!isManualGl || !clientId) return;
    void fetchGlVersions(clientId);
  }, [isManualGl, clientId, fetchGlVersions]);

  // Default the version selection (active → latest) when none is set or the
  // current store selection isn't among this company's versions.
  useEffect(() => {
    if (!isManualGl || !glVersions.length) return;
    const valid = glVersions.some((v) => String(v.value) === String(glSelectedVersion));
    if (glSelectedVersion && valid) return;
    const active = glVersions.find((v) => v.isActive) || glVersions[0];
    if (active) setGlSelectedVersion(String(active.value));
  }, [isManualGl, glVersions, glSelectedVersion, setGlSelectedVersion]);

  // Fiscal-year scoping removed for Bank Reconciliation — the From/To date pickers
  // are now the sole time filter. All of the selected version's months are fetched
  // and narrowed client-side via manualMonthStart / manualMonthEnd.

  // QMS loading is now handled in the unified bank-data loader effect above

  const reportMonths = qbBankActivity?.months?.length
    ? qbBankActivity.months
    : [];
  const hasData = reportMonths.length > 0;
  const balanceBankOptions = useMemo(() => {
    if (!qbBankActivity?.accounts?.length) return [];

    return qbBankActivity.accounts.map((account) => ({
      value: account.accountId,
      label: `${account.accountName} (${getLastFourDigits(account.accountNumber)})`,
    }));
  }, [qbBankActivity]);

  const manualBankOptions = useMemo(
    () => (extractedBankPdfData?.banks || []).map((b) => b.bankName),
    [extractedBankPdfData],
  );

  useEffect(() => {
    if (manualBankOptions.length > 0 && !manualBankOptions.includes(selectedManualBankName)) {
      setSelectedManualBankName(manualBankOptions[0]);
    }
  }, [manualBankOptions, selectedManualBankName]);
  const oneBankAccountOptions = useMemo(() => {
    if (!qbBankActivity?.accounts?.length) return [];

    return qbBankActivity.accounts
      .filter(
        (account, idx, all) =>
          all.findIndex((item) => item.accountId === account.accountId) === idx,
      )
      .map((account) => ({
        value: account.accountId,
        label: `${account.accountName}${account.accountNumber ? ` (${account.accountNumber})` : ""
          }`,
      }));
  }, [qbBankActivity]);

  useEffect(() => {
    const accounts = qbBankActivity?.accounts || [];
    if (!accounts.length) return;

    setExpandedAccounts((prev) => {
      const next = Object.fromEntries(
        accounts.map((account, index) => [
          account.accountId,
          prev?.[account.accountId] ?? index === 0,
        ]),
      );

      const hasSameKeys =
        Object.keys(next).length === Object.keys(prev || {}).length &&
        Object.keys(next).every((key) => key in (prev || {}));
      const hasSameValues = Object.keys(next).every(
        (key) => next[key] === prev?.[key],
      );

      return hasSameKeys && hasSameValues ? prev : next;
    });
  }, [qbBankActivity]);

  useEffect(() => {
    if (
      balanceBankOptions.length > 0 &&
      !balanceBankOptions.some((option) => option.value === selectedBalanceBankId)
    ) {
      setSelectedBalanceBankId(balanceBankOptions[0].value);
    }
  }, [balanceBankOptions, selectedBalanceBankId]);

  useEffect(() => {
    if (!selectedBalanceBankId) return;

    setExpandedAccounts((prev) => ({
      ...prev,
      [selectedBalanceBankId]: true,
    }));
  }, [selectedBalanceBankId]);

  useEffect(() => {
    if (!oneBankAccountId && oneBankAccountOptions.length > 0) {
      setOneBankAccountId(oneBankAccountOptions[0].value);
    }
  }, [oneBankAccountId, oneBankAccountOptions]);

  const buildAccountBalanceDataFallback = () => {
    return { rows: [], ttm: buildEmptyTTM() };
  };

  const buildAccountBalanceDataFromQB = (account) => {
    if (!account) {
      return buildAccountBalanceDataFallback();
    }

    const monthlyMap = Object.fromEntries(
      (account.monthlyData || []).map((row) => [row.month, row]),
    );

    const rows = reportMonths.map((month) => {
      const row = monthlyMap[month];
      return {
        month,
        startingBalance: row?.startingBalance ?? 0,
        deposits: row?.deposits ?? 0,
        withdrawals: row?.withdrawals ?? 0,
        endingBalance: row?.endingBalance ?? 0,
        intercompanyDeposits: row?.intercompanyDeposits ?? 0,
        intercompanyWithdraws: row?.intercompanyWithdraws ?? 0,
        perBalanceSheet: row?.perBalanceSheet ?? 0,
        variance: row?.variance ?? 0,
        outstandingChecks: 0,
        priorMonthCheck: row?.priorMonthCheck ?? 0,
        footingCheck: row?.footingCheck ?? 0,
        unreconciledDollar: 0,
        unreconciledPct: 0,
        _perBSCount: row?.perBalanceSheet != null ? 1 : 0,
      };
    });

    const withDerived = rows.map((r, i) => {
      const footingCheck =
        r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals);
      const priorMonthCheck =
        i === 0 ? 0 : rows[i - 1].endingBalance - r.startingBalance;
      const variance =
        r._perBSCount > 0 ? r.endingBalance - r.perBalanceSheet : 0;
      const outstandingChecks = 0;
      const unreconciledDollar = variance - outstandingChecks;
      const unreconciledPct =
        r.perBalanceSheet !== 0
          ? (unreconciledDollar / r.perBalanceSheet) * 100
          : 0;
      return {
        ...r,
        footingCheck,
        priorMonthCheck,
        variance,
        outstandingChecks,
        unreconciledDollar,
        unreconciledPct,
      };
    });

    const ttmRows = withDerived.slice(-12);
    const ttm = ttmRows.reduce(
      (acc, r, i) => ({
        startingBalance: i === 0 ? r.startingBalance : acc.startingBalance,
        deposits: acc.deposits + r.deposits,
        withdrawals: acc.withdrawals + r.withdrawals,
        endingBalance: r.endingBalance,
        intercompanyDeposits: acc.intercompanyDeposits + r.intercompanyDeposits,
        intercompanyWithdraws:
          acc.intercompanyWithdraws + r.intercompanyWithdraws,
        footingCheck: acc.footingCheck + r.footingCheck,
        priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
        perBalanceSheet: r.perBalanceSheet,
        variance: r.endingBalance - r.perBalanceSheet,
        outstandingChecks: acc.outstandingChecks + r.outstandingChecks,
        unreconciledDollar: acc.unreconciledDollar + r.unreconciledDollar,
        unreconciledPct: r.unreconciledPct,
      }),
      buildEmptyTTM(),
    );

    return { rows: withDerived, ttm };
  };

  const visibleBalanceAccounts = selectedBalanceBankId
    ? qbBankActivity?.accounts?.filter(
      (account) => account.accountId === selectedBalanceBankId,
    ) || []
    : qbBankActivity?.accounts || [];
  const allBankMonthlyMaps =
    qbBankActivity?.accounts?.map((account) =>
      Object.fromEntries((account.monthlyData || []).map((row) => [row.month, row])),
    ) || [];

  const activityRows = reportMonths.map((month) => {
    const totalDeposits = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.deposits || 0),
      0,
    );
    const totalWithdrawals = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.withdrawals || 0),
      0,
    );
    const intercompanyDeposits = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) =>
        sum + (monthlyMap[month]?.intercompanyDeposits || 0),
      0,
    );
    const intercompanyWithdraws = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) =>
        sum + (monthlyMap[month]?.intercompanyWithdraws || 0),
      0,
    );
    const intercompanyTransfers =
      intercompanyDeposits + intercompanyWithdraws;
    const externalDeposits = totalDeposits - intercompanyTransfers;
    const salesPerFinancials = qbBankActivity?.plFinancials?.totalIncome?.[month] ?? 0;
    const depositsDollarVar = salesPerFinancials - externalDeposits;
    const depositsPctVar =
      salesPerFinancials !== 0
        ? (depositsDollarVar / salesPerFinancials) * 100
        : 0;
    const changeInAR = 0;
    const changeInARRetentions = 0;
    const fixedAssetDisposals = 0;
    const depositsOther = 0;
    const depositsUnreconciledDollar =
      depositsDollarVar +
      changeInAR +
      changeInARRetentions +
      fixedAssetDisposals +
      depositsOther;
    const depositsUnreconciledPct =
      salesPerFinancials !== 0
        ? (depositsUnreconciledDollar / salesPerFinancials) * 100
        : 0;

    const withdrawIntercompanyTransfers = intercompanyWithdraws;
    const externalWithdraws =
      totalWithdrawals - withdrawIntercompanyTransfers;
    const expensesPerFinancials = qbBankActivity?.plFinancials?.totalExpenses?.[month] ?? 0;
    const withdrawsDollarVar = externalWithdraws - expensesPerFinancials;
    const withdrawsPctVar =
      expensesPerFinancials !== 0
        ? (withdrawsDollarVar / expensesPerFinancials) * 100
        : 0;
    const ownerWithdraws = 0;
    const changeInCurrentLiabilities = 0;
    const changeInLTLiabilities = 0;
    const depreciationExpense = 0;
    const amortizationExpense = 0;
    const badDebtExpense = 0;
    const fixedAssetPurchases = 0;
    const withdrawsOther = 0;
    const withdrawsUnreconciledDollar =
      withdrawsDollarVar +
      ownerWithdraws +
      changeInCurrentLiabilities +
      changeInLTLiabilities +
      depreciationExpense +
      amortizationExpense +
      badDebtExpense +
      fixedAssetPurchases +
      withdrawsOther;
    const withdrawsUnreconciledPct =
      expensesPerFinancials !== 0
        ? (withdrawsUnreconciledDollar / expensesPerFinancials) * 100
        : 0;

    return {
      month,
      totalDeposits,
      intercompanyTransfers,
      externalDeposits,
      salesPerFinancials,
      depositsDollarVar,
      depositsPctVar,
      changeInAR,
      changeInARRetentions,
      fixedAssetDisposals,
      depositsOther,
      depositsUnreconciledDollar,
      depositsUnreconciledPct,
      totalWithdrawals,
      withdrawIntercompanyTransfers,
      externalWithdraws,
      expensesPerFinancials,
      withdrawsDollarVar,
      withdrawsPctVar,
      ownerWithdraws,
      changeInCurrentLiabilities,
      changeInLTLiabilities,
      depreciationExpense,
      amortizationExpense,
      badDebtExpense,
      fixedAssetPurchases,
      withdrawsOther,
      withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct,
    };
  });

  const activityTTM = activityRows.slice(-12).reduce(
    (acc, r) => ({
      totalDeposits: acc.totalDeposits + r.totalDeposits,
      intercompanyTransfers:
        acc.intercompanyTransfers + r.intercompanyTransfers,
      externalDeposits: acc.externalDeposits + r.externalDeposits,
      salesPerFinancials: acc.salesPerFinancials + r.salesPerFinancials,
      depositsDollarVar: acc.depositsDollarVar + r.depositsDollarVar,
      depositsPctVar:
        acc.salesPerFinancials + r.salesPerFinancials !== 0
          ? ((acc.depositsDollarVar + r.depositsDollarVar) /
            (acc.salesPerFinancials + r.salesPerFinancials)) *
          100
          : 0,
      changeInAR: acc.changeInAR + r.changeInAR,
      changeInARRetentions:
        acc.changeInARRetentions + r.changeInARRetentions,
      fixedAssetDisposals: acc.fixedAssetDisposals + r.fixedAssetDisposals,
      depositsOther: acc.depositsOther + r.depositsOther,
      depositsUnreconciledDollar:
        acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar,
      depositsUnreconciledPct:
        acc.salesPerFinancials + r.salesPerFinancials !== 0
          ? ((acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar) /
            (acc.salesPerFinancials + r.salesPerFinancials)) *
          100
          : 0,
      totalWithdrawals: acc.totalWithdrawals + r.totalWithdrawals,
      withdrawIntercompanyTransfers:
        acc.withdrawIntercompanyTransfers + r.withdrawIntercompanyTransfers,
      externalWithdraws: acc.externalWithdraws + r.externalWithdraws,
      expensesPerFinancials:
        acc.expensesPerFinancials + r.expensesPerFinancials,
      withdrawsDollarVar: acc.withdrawsDollarVar + r.withdrawsDollarVar,
      withdrawsPctVar:
        acc.expensesPerFinancials + r.expensesPerFinancials !== 0
          ? ((acc.withdrawsDollarVar + r.withdrawsDollarVar) /
            (acc.expensesPerFinancials + r.expensesPerFinancials)) *
          100
          : 0,
      ownerWithdraws: acc.ownerWithdraws + r.ownerWithdraws,
      changeInCurrentLiabilities:
        acc.changeInCurrentLiabilities + r.changeInCurrentLiabilities,
      changeInLTLiabilities:
        acc.changeInLTLiabilities + r.changeInLTLiabilities,
      depreciationExpense:
        acc.depreciationExpense + r.depreciationExpense,
      amortizationExpense: acc.amortizationExpense + r.amortizationExpense,
      badDebtExpense: acc.badDebtExpense + r.badDebtExpense,
      fixedAssetPurchases: acc.fixedAssetPurchases + r.fixedAssetPurchases,
      withdrawsOther: acc.withdrawsOther + r.withdrawsOther,
      withdrawsUnreconciledDollar:
        acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct:
        acc.expensesPerFinancials + r.expensesPerFinancials !== 0
          ? ((acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar) /
            (acc.expensesPerFinancials + r.expensesPerFinancials)) *
          100
          : 0,
    }),
    buildEmptyActivityReviewRow(),
  );

  // ── Shared table sub-components ──────────────────────────────────────────

  const SpacerRow = ({ colCount }) => (
    <tr>
      <td
        colSpan={colCount}
        className="border-x border-border bg-slate-100 py-[3px]"
      />
    </tr>
  );

  const TableColGroup = ({ months }) => (
    <colgroup>
      <col className={TABLE_LABEL_COL_WIDTH} />
      {months.map((month) => (
        <col key={month} className={TABLE_VALUE_COL_WIDTH} />
      ))}
      <col className={TABLE_VALUE_COL_WIDTH} />
    </colgroup>
  );

  const TableHeader = ({ label, months }) => (
    <tr className="border-b border-primary/15 bg-[#F8FBF1]">
      <th
        className={cn(
          "sticky left-0 top-0 z-30 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary",
          TABLE_LABEL_COL_WIDTH,
        )}
      >
        {label}
      </th>
      {months.map((m) => (
        <th
          key={m}
          className={cn(
            "sticky top-0 z-20 whitespace-nowrap border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
            TABLE_VALUE_COL_WIDTH,
          )}
        >
          {monthLabel(m)}
        </th>
      ))}
      <th
        className={cn(
          "sticky top-0 z-20 border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
          TABLE_VALUE_COL_WIDTH,
        )}
      >
        TTM
      </th>
    </tr>
  );

  const DR = ({
    label,
    values,
    rawValues,
    bold,
    indent,
    check,
    rowType = "normal",
  }) => {
    const isVarianceRow =
      rowType === "variance-amt" || rowType === "variance-pct";

    const renderCell = (val, rawVal, i) => {
      if (isVarianceRow) {
        const numVal =
          rawVal != null ? rawVal : typeof val === "number" ? val : null;
        let formatted, colorClass;

        if (rowType === "variance-amt") {
          const result = fmtVarianceAmt(numVal);
          formatted = result.display;
          colorClass = result.colorClass;
        } else {
          const result = fmtVariancePct(numVal);
          formatted = result.display;
          colorClass = result.colorClass;
        }

        return (
          <td
            key={i}
            className={cn(
              "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
              colorClass,
            )}
          >
            {formatted}
          </td>
        );
      }

      return (
        <td
          key={i}
          className={cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            bold ? "font-semibold text-text-primary" : "text-text-primary",
            check ? "text-amber-700 italic" : "",
          )}
        >
          {val}
        </td>
      );
    };

    return (
      <tr
        className={cn(
          bold
            ? "bg-white"
            : check
              ? "bg-amber-50/40"
              : isVarianceRow
                ? "bg-white"
                : "bg-white hover:bg-slate-50/60",
        )}
      >
        <td
          className={cn(
            "sticky left-0 z-[1] border border-border px-3 py-[7px] text-[12px] text-text-primary whitespace-nowrap",
            TABLE_LABEL_COL_WIDTH,
            bold ? "bg-white" : check ? "bg-amber-50/40" : "bg-white",
            indent && "pl-7",
            bold && "font-semibold",
            check && "text-amber-700 italic",
          )}
        >
          {label}
        </td>
        {values.map((val, i) =>
          renderCell(val, rawValues ? rawValues[i] : null, i),
        )}
      </tr>
    );
  };

  const StatusBanner = ({ sync }) =>
    sync.status === "idle" ? null : (
      <div
        className={cn(
          "mt-4 flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-[13px]",
          sync.status === "error"
            ? "border-negative/20 text-negative"
            : sync.status === "success"
              ? "border-primary/20 text-primary"
              : "border-border text-text-secondary",
        )}
      >
        {sync.status === "loading" ? (
          <LoaderCircle size={16} className="animate-spin" />
        ) : sync.status === "error" ? (
          <AlertCircle size={16} />
        ) : (
          <CheckCircle2 size={16} />
        )}
        {sync.message}
      </div>
    );

  // ── Extracted Bank PDF table renderer ────────────────────────────────────
  // Renders one section per bank with rows:
  //   Starting Balance | [month cols] | Total
  //   Deposits         | ...
  //   Withdrawals      | ...
  //   Ending Balance   | ...
  // Plus a final "All Banks" totals section.

  const renderExtractedBankPdfTable = () => {
    const { months, banks, totals } = extractedBankPdfData;

    if (!banks?.length || !months?.length) return null;

    const METRICS = [
      { key: "startingBalance", label: "Starting Balance", bold: true },
      { key: "deposits", label: "Deposits", bold: false },
      { key: "withdrawals", label: "Withdrawals", bold: false },
      { key: "endingBalance", label: "Ending Balance", bold: true },
    ];

    // Build a monthKey → column-index map for fast look-ups
    const monthIndexMap = Object.fromEntries(months.map((m, i) => [m.key, i]));

    return (
      <div className="overflow-auto max-h-[600px] rounded-xl border border-border shadow-sm">
        <table className="min-w-full border-collapse bg-white text-[13px]">
          {/* ── Header ── */}
          <thead>
            <tr className="border-b border-primary/15 bg-[#F8FBF1]">
              <th className="sticky left-0 top-0 z-30 w-40 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary">
                Bank
              </th>
              <th className="sticky left-[160px] top-0 z-20 w-36 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary">
                Metric
              </th>
              {months.map((m) => (
                <th
                  key={m.key}
                  className="sticky top-0 z-20 min-w-[110px] whitespace-nowrap border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary"
                >
                  {m.label}
                </th>
              ))}
              <th className="sticky top-0 z-20 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary">
                Total
              </th>
            </tr>
          </thead>

          <tbody>
            {/* ── Per-bank rows ── */}
            {banks.map((bank, bi) => {
              // Index bank months by monthKey for O(1) access
              const bankMonthMap = Object.fromEntries(
                (bank.months || []).map((m) => [m.monthKey, m]),
              );

              return METRICS.map((metric, mi) => (
                <tr
                  key={`${bi}-${metric.key}`}
                  className={
                    metric.bold ? "bg-white" : "bg-white hover:bg-slate-50/60"
                  }
                >
                  {/* Bank name cell — spans all metric rows */}
                  {mi === 0 && (
                    <td
                      rowSpan={METRICS.length}
                      className="sticky left-0 z-[1] bg-white border border-border px-3 py-[7px] text-[12px] font-semibold text-text-primary align-middle"
                    >
                      {bank.bankName}
                    </td>
                  )}

                  {/* Metric label */}
                  <td
                    className={cn(
                      "sticky left-[160px] z-[1] bg-white border border-border px-3 py-[7px] text-[12px] text-text-primary whitespace-nowrap",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {metric.label}
                  </td>

                  {/* One cell per month */}
                  {months.map((m) => {
                    const val = bankMonthMap[m.key]?.[metric.key] ?? null;
                    return (
                      <td
                        key={m.key}
                        className={cn(
                          "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                          metric.bold && "font-semibold",
                        )}
                      >
                        {fmtAmt(val)}
                      </td>
                    );
                  })}

                  {/* Per-bank totals column */}
                  <td
                    className={cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {fmtAmt(bank.totals?.[metric.key] ?? null)}
                  </td>
                </tr>
              ));
            })}

            {/* ── Spacer between banks and cross-bank totals ── */}
            <tr>
              <td
                colSpan={months.length + 3}
                className="border-x border-border bg-slate-100 py-[3px]"
              />
            </tr>

            {/* ── All Banks totals section ── */}
            {METRICS.map((metric) => {
              // Build per-month cross-bank totals
              const monthValues = months.map((m) => {
                const entry = (totals || []).find((t) => t.monthKey === m.key);
                return entry?.[metric.key] ?? null;
              });

              // Grand total across all months for this metric
              const grandTotal = monthValues.reduce(
                (sum, v) => sum + (v ?? 0),
                0,
              );

              return (
                <tr
                  key={`total-${metric.key}`}
                  className={
                    metric.bold
                      ? "bg-[#F8FBF1]"
                      : "bg-[#F8FBF1] hover:bg-[#F2F8E7]"
                  }
                >
                  {/* "All Banks" label only on first metric row */}
                  {metric.key === "startingBalance" && (
                    <td
                      rowSpan={METRICS.length}
                      className="sticky left-0 z-[1] bg-[#F8FBF1] border border-border px-3 py-[7px] text-[12px] font-semibold text-primary align-middle"
                    >
                      All Banks
                    </td>
                  )}
                  {metric.key !== "startingBalance" ? null : null}

                  <td
                    className={cn(
                      "sticky left-[160px] z-[1] bg-[#F8FBF1] border border-border px-3 py-[7px] text-[12px] text-primary whitespace-nowrap",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {metric.label}
                  </td>

                  {monthValues.map((val, i) => (
                    <td
                      key={i}
                      className={cn(
                        "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                        metric.bold && "font-semibold",
                      )}
                    >
                      {fmtAmt(val)}
                    </td>
                  ))}

                  <td
                    className={cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                      metric.bold && "font-semibold",
                    )}
                  >
                    {fmtAmt(grandTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderOneBankActivityTable = () => {
    const rows = qbOneBankActivity?.monthlyData || [];
    if (!rows.length) return null;

    return (
      <div className="mt-4 overflow-auto max-h-[600px] rounded-xl border border-border shadow-sm">
        <table className="min-w-full border-collapse bg-white text-[13px]">
          <thead>
            <tr className="border-b border-primary/15 bg-[#F8FBF1]">
              <th className="sticky left-0 top-0 z-30 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary">
                Month
              </th>
              <th className="sticky top-0 z-20 min-w-[140px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Starting Balance
              </th>
              <th className="sticky top-0 z-20 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Deposits
              </th>
              <th className="sticky top-0 z-20 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Withdrawals
              </th>
              <th className="sticky top-0 z-20 min-w-[130px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary">
                Ending Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.month} className="bg-white hover:bg-slate-50/60">
                <td className="sticky left-0 z-[1] bg-white border border-border px-3 py-[7px] text-[12px] text-text-primary">
                  {monthLabel(row.month)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                  {fmtAmt(row.startingBalance)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                  {fmtAmt(row.deposits)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary">
                  {fmtAmt(row.withdrawals)}
                </td>
                <td className="border border-border px-3 py-[7px] text-right text-[12px] font-semibold tabular-nums text-text-primary">
                  {fmtAmt(row.endingBalance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // ── Balance account table renderer ───────────────────────────────────────

  const renderManualBalanceAccountTable = (bank, label) => {
    const pdfMonths = filteredPdfMonths;
    const monthMap = bank
      ? Object.fromEntries((bank.months || []).map((m) => [m.monthKey, m]))
      : {};
    const bankLabel = label || bank?.bankName || "Bank Account";
    const colCount = pdfMonths.length + 2;

    // BS bank balance for this specific bank
    const bsMatch = matchBsBank(bank?.bankName, bsBankBalances?.bankAccounts);
    const bsBalance = bsMatch != null ? bsMatch.amount : null;
    // Only the December of the BS year gets the perBalanceSheet value (year-end point-in-time)
    const bsYearEndKey = bsBankBalances?.year != null ? `${bsBankBalances.year}-12` : null;

    if (bank?.bankName) {
      if (bsMatch) {
        console.log(`[BsMatch] ${JSON.stringify({
          selectedBank: bank.bankName,
          detectedYear: bsBankBalances?.year,
          balanceSheetSource: bsBankBalances?.source,
          matchedBalanceSheetFile: bsBankBalances?.fileName,
          matchedAccount: bsMatch.name,
          extractedAmount: bsMatch.amount,
          perBalanceSheet: bsBalance,
        })}`);
      } else {
        console.warn(
          `[BsMatch] No matching bank account found in Balance Sheet for "${bank.bankName}".`,
          `Available: ${bsBankBalances?.bankAccounts?.map((b) => b.name).join(", ") || "none (bsBankBalances is null)"}`,
        );
      }
    }

    // Build rows with all fields, compute derived values
    const baseRows = pdfMonths.map((monthKey) => {
      const m = monthMap[monthKey];
      const perBalanceSheet = bsBalance != null && monthKey === bsYearEndKey ? bsBalance : null;
      return {
        month: monthKey,
        startingBalance: m?.startingBalance ?? 0,
        deposits: m?.deposits ?? 0,
        withdrawals: m?.withdrawals ?? 0,
        endingBalance: m?.endingBalance ?? 0,
        intercompanyDeposits: 0,
        intercompanyWithdraws: 0,
        perBalanceSheet,
        outstandingChecks: 0,
      };
    });

    const rows = baseRows.map((r, i) => {
      const footingCheck = r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals);
      const priorMonthCheck = i === 0 ? 0 : baseRows[i - 1].endingBalance - r.startingBalance;
      const outstandingChecks = 0;
      const variance = r.perBalanceSheet != null ? r.endingBalance - r.perBalanceSheet : null;
      const unreconciledDollar = variance != null ? variance - outstandingChecks : null;
      const unreconciledPct =
        variance != null && r.perBalanceSheet !== 0
          ? (unreconciledDollar / r.perBalanceSheet) * 100
          : null;
      return { ...r, footingCheck, priorMonthCheck, variance, unreconciledDollar, unreconciledPct };
    });

    const ttmSlice = rows.slice(-12);
    const ttmBase = ttmSlice.reduce(
      (acc, r, i) => ({
        startingBalance: i === 0 ? r.startingBalance : acc.startingBalance,
        deposits: acc.deposits + r.deposits,
        withdrawals: acc.withdrawals + r.withdrawals,
        endingBalance: r.endingBalance,
        intercompanyDeposits: 0,
        intercompanyWithdraws: 0,
        footingCheck: acc.footingCheck + r.footingCheck,
        priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
        perBalanceSheet: null,
        variance: null,
        outstandingChecks: 0,
        unreconciledDollar: null,
        unreconciledPct: null,
      }),
      buildEmptyTTM(),
    );

    // Override TTM perBalanceSheet with BS balance (point-in-time, not summed across months)
    const ttm = { ...ttmBase };
    if (bsBalance != null) {
      ttm.perBalanceSheet = bsBalance;
      ttm.variance = ttm.endingBalance - bsBalance;
      ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
      ttm.unreconciledPct =
        bsBalance !== 0 ? (ttm.unreconciledDollar / bsBalance) * 100 : null;
    }

    const v = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const va = (f) => [...rows.map((r) => fmtAcct(r[f])), fmtAcct(ttm[f])];
    const rawNums = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];

    const overallStatus = bank?.status || (rows.every((r) => Math.abs(r.footingCheck) <= 1) ? "Verified" : "Needs Review");

    return (
      <div className="mb-4 rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="flex w-full items-center justify-between overflow-clip rounded-t-[var(--radius-card)] border-b border-primary/15 bg-[#F8FBF1] px-4 py-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[14px] font-semibold text-primary">{bankLabel}</span>
            {bank?.accountName && (
              <span className="text-[12px] text-text-secondary">{bank.accountName}</span>
            )}
            {bank?.accountNumber && (
              <span className="rounded-full bg-bg-page px-2 py-0.5 text-[11px] font-mono text-text-muted border border-border">
                ···{String(bank.accountNumber).slice(-4)}
              </span>
            )}
          </div>
          {bank && (
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${overallStatus === "Verified"
              ? "bg-green-100 text-green-700"
              : "bg-amber-100 text-amber-700"
              }`}>
              {overallStatus}
            </span>
          )}
        </div>
        {isLoadingExtractedBankPdfData ? (
          <div className="border-t border-border bg-white flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary">
            <LoaderCircle size={15} className="animate-spin" />
            Loading bank statement data...
          </div>
        ) : pdfMonths.length === 0 ? (
          <div className="border-t border-border bg-white px-4 py-5 text-[13px] text-text-muted">No data available.</div>
        ) : (
          <FreezeTable months={pdfMonths} label={bankLabel} containerClass="border-t border-border bg-white">
            <DR label="Starting Balance" values={v("startingBalance")} bold />
            <DR label="Deposits" values={v("deposits")} />
            <DR label="Withdrawals" values={v("withdrawals")} />
            <DR label="Ending Balance" values={v("endingBalance")} bold />
            <SpacerRow colCount={colCount} />

            <DR label="Intercompany Deposits" values={v("intercompanyDeposits")} indent />
            <DR label="Intercompany Withdraws" values={v("intercompanyWithdraws")} indent />
            <SpacerRow colCount={colCount} />

            <DR label="Footing Check" values={va("footingCheck")} check />
            <DR label="Prior Month Check" values={va("priorMonthCheck")} check />
            <SpacerRow colCount={colCount} />

            <DR label="Per Balance Sheet" values={v("perBalanceSheet")} bold />
            <DR
              label="Variance"
              values={rawNums("variance")}
              rawValues={rawNums("variance")}
              rowType="variance-amt"
            />
            <SpacerRow colCount={colCount} />

            <DR label="Outstanding Checks" values={v("outstandingChecks")} />
            <DR
              label="Unreconciled $ Variance"
              values={rawNums("unreconciledDollar")}
              rawValues={rawNums("unreconciledDollar")}
              rowType="variance-amt"
            />
            <DR
              label="Unreconciled % Variance"
              values={rawNums("unreconciledPct")}
              rawValues={rawNums("unreconciledPct")}
              rowType="variance-pct"
            />
          </FreezeTable>
        )}
      </div>
    );
  };

  const renderBalanceAccountTable = (account) => {
    const { rows, ttm } = buildAccountBalanceDataFromQB(account);
    const isExpanded = expandedAccounts[account.accountId];
    const colCount = reportMonths.length + 2;
    const accountLabel = `${account.accountName} (${account.accountNumber ?? ""})`;

    const v = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const va = (f) => [...rows.map((r) => fmtAcct(r[f])), fmtAcct(ttm[f])];
    const rawNums = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];

    return (
      <div
        key={account.accountId}
        className="mb-4 rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <button
          type="button"
          className="flex w-full items-center justify-between overflow-clip rounded-t-[var(--radius-card)] border-b border-primary/15 bg-[#F8FBF1] px-4 py-3 font-semibold text-primary transition-colors hover:bg-[#F2F8E7]"
          onClick={() =>
            setExpandedAccounts((p) => ({
              ...p,
              [account.accountId]: !p?.[account.accountId],
            }))
          }
        >
          <div className="flex items-center gap-3">
            <span className="text-[14px] font-semibold">{account.accountName}</span>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-primary">
              QB: {accountLabel}
            </span>
          </div>
          {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>

        {isExpanded && (
          isLoadingBankActivity ? (
            <div className="border-t border-border bg-white flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary">
              <LoaderCircle size={15} className="animate-spin" />
              Loading QuickBooks bank activity...
            </div>
          ) : rows.length === 0 ? (
            <div className="border-t border-border bg-white px-4 py-5 text-[13px] text-text-muted">
              No data for this bank account.
            </div>
          ) : (
            <FreezeTable months={reportMonths} label={account.accountName} containerClass="border-t border-border bg-white">
              <DR label="Starting Balance" values={v("startingBalance")} bold />
              <DR label="Deposits" values={v("deposits")} />
              <DR label="Withdrawals" values={v("withdrawals")} />
              <DR label="Ending Balance" values={v("endingBalance")} bold />
              <SpacerRow colCount={colCount} />

              <DR label="Intercompany Deposits" values={v("intercompanyDeposits")} indent />
              <DR label="Intercompany Withdraws" values={v("intercompanyWithdraws")} indent />
              <SpacerRow colCount={colCount} />

              <DR label="Footing Check" values={va("footingCheck")} check />
              <DR label="Prior Month Check" values={va("priorMonthCheck")} check />
              <SpacerRow colCount={colCount} />

              <DR label="Per Balance Sheet" values={v("perBalanceSheet")} bold />
              <DR
                label="Variance"
                values={rawNums("variance")}
                rawValues={rawNums("variance")}
                rowType="variance-amt"
              />
              <SpacerRow colCount={colCount} />

              <DR label="Outstanding Checks" values={v("outstandingChecks")} />
              <DR
                label="Unreconciled $ Variance"
                values={rawNums("unreconciledDollar")}
                rawValues={rawNums("unreconciledDollar")}
                rowType="variance-amt"
              />
              <DR
                label="Unreconciled % Variance"
                values={rawNums("unreconciledPct")}
                rawValues={rawNums("unreconciledPct")}
                rowType="variance-pct"
              />
            </FreezeTable>
          )
        )}
      </div>
    );
  };

  // ── Activity Review renderer ──────────────────────────────────────────────

  const renderActivityTableCore = (rows, ttm, months) => {
    const colCount = months.length + 2;
    const av = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const avRaw = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];

    // ── Adjustment helpers ────────────────────────────────────────────────────
    const getAdj = (month, key) => reconAdjustments?.[`${month}_${key}`] ?? 0;

    // Pre-compute addback totals per month from multi-item addback rows
    const depAddbackMap = {};
    const wdrAddbackMap = {};
    addbackItems.forEach((item) => {
      const map = item.section === "deposits" ? depAddbackMap : wdrAddbackMap;
      Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => {
        map[m] = (map[m] || 0) + Number(amt);
      });
    });

    // Deposits — adjusted Unreconciled Variance
    const depositsUnrecAdj = rows.map((r) =>
      r.depositsDollarVar
      + getAdj(r.month, "changeInAR")
      + getAdj(r.month, "changeInARRetentions")
      + getAdj(r.month, "fixedAssetDisposals")
      + getAdj(r.month, "depositsOther")
      + (depAddbackMap[r.month] ?? 0),
    );
    const depositsUnrecPctAdj = rows.map((r, i) =>
      r.salesPerFinancials !== 0 ? (depositsUnrecAdj[i] / r.salesPerFinancials) * 100 : 0,
    );
    const ttmDepositsUnrecAdj = months.slice(-12).reduce(
      (sum, m) =>
        sum
        + getAdj(m, "changeInAR")
        + getAdj(m, "changeInARRetentions")
        + getAdj(m, "fixedAssetDisposals")
        + getAdj(m, "depositsOther")
        + (depAddbackMap[m] ?? 0),
      ttm.depositsDollarVar,
    );
    const ttmDepositsUnrecPctAdj =
      ttm.salesPerFinancials !== 0 ? (ttmDepositsUnrecAdj / ttm.salesPerFinancials) * 100 : 0;

    // Withdrawals — adjusted Unreconciled Variance
    const withdrawsUnrecAdj = rows.map((r) =>
      r.withdrawsDollarVar
      + getAdj(r.month, "ownerWithdraws")
      + getAdj(r.month, "changeInCurrentLiabilities")
      + getAdj(r.month, "changeInLTLiabilities")
      + getAdj(r.month, "depreciationExpense")
      + getAdj(r.month, "amortizationExpense")
      + getAdj(r.month, "badDebtExpense")
      + getAdj(r.month, "fixedAssetPurchases")
      + getAdj(r.month, "withdrawsOther")
      + (wdrAddbackMap[r.month] ?? 0),
    );
    const withdrawsUnrecPctAdj = rows.map((r, i) =>
      r.expensesPerFinancials !== 0 ? (withdrawsUnrecAdj[i] / r.expensesPerFinancials) * 100 : 0,
    );
    const ttmWithdrawsUnrecAdj = months.slice(-12).reduce(
      (sum, m) =>
        sum
        + getAdj(m, "ownerWithdraws")
        + getAdj(m, "changeInCurrentLiabilities")
        + getAdj(m, "changeInLTLiabilities")
        + getAdj(m, "depreciationExpense")
        + getAdj(m, "amortizationExpense")
        + getAdj(m, "badDebtExpense")
        + getAdj(m, "fixedAssetPurchases")
        + getAdj(m, "withdrawsOther")
        + (wdrAddbackMap[m] ?? 0),
      ttm.withdrawsDollarVar,
    );
    const ttmWithdrawsUnrecPctAdj =
      ttm.expensesPerFinancials !== 0 ? (ttmWithdrawsUnrecAdj / ttm.expensesPerFinancials) * 100 : 0;

    const adjDepURaw = [...depositsUnrecAdj, ttmDepositsUnrecAdj];
    const adjDepPctRaw = [...depositsUnrecPctAdj, ttmDepositsUnrecPctAdj];
    const adjWdrURaw = [...withdrawsUnrecAdj, ttmWithdrawsUnrecAdj];
    const adjWdrPctRaw = [...withdrawsUnrecPctAdj, ttmWithdrawsUnrecPctAdj];

    return (
      <FreezeTable months={months} label="Activity Review" containerClass="rounded-xl border border-border shadow-sm">
        <DR label="Total Deposits" values={av("totalDeposits")} bold />
        <DR label="Intercompany Transfers" values={av("withdrawIntercompanyTransfers")} indent />
        <DR label="External Deposits" values={av("externalDeposits")} bold />
        <DR label="Sales per Financials" values={av("salesPerFinancials")} />
        <DR label="$ Variance" values={avRaw("depositsDollarVar")} rawValues={avRaw("depositsDollarVar")} rowType="variance-amt" />
        <DR label="% Variance" values={avRaw("depositsPctVar")} rawValues={avRaw("depositsPctVar")} rowType="variance-pct" />
        <SpacerRow colCount={colCount} />

        <AdjRow label="Change in AR" rowKey="changeInAR" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Change in Accts Receivable- Retentions" rowKey="changeInARRetentions" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Fixed Asset Disposals" rowKey="fixedAssetDisposals" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Other" rowKey="depositsOther" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AddbacksRowGroup
          section="deposits"
          months={months}
          addbackItems={addbackItems}
          onSaveAmounts={updateAddbackItemAmounts}
          onDelete={deleteAddbackItem}
          onOpenPicker={() => {
            const [sy, sm] = bankActivityStartMonth.split("-");
            const startDate = `${sy}-${sm}-01`;
            const [ey, em] = bankActivityEndMonth.split("-");
            const lastDay = new Date(+ey, +em, 0).getDate();
            const endDate = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;
            setAddbackPickerState({ open: true, section: "deposits", startDate, endDate, months });
          }}
        />
        <DR label="Unreconciled Variance $" values={adjDepURaw} rawValues={adjDepURaw} rowType="variance-amt" />
        <DR label="Unreconciled Variance %" values={adjDepPctRaw} rawValues={adjDepPctRaw} rowType="variance-pct" />
        <SpacerRow colCount={colCount} />

        <DR label="Total Withdrawals" values={av("totalWithdrawals")} bold />
        <DR label="Intercompany Transfers" values={av("intercompanyTransfers")} indent />
        <DR label="External Withdraws" values={av("externalWithdraws")} bold />
        <DR label="Expenses per Financials" values={av("expensesPerFinancials")} />
        <DR label="$ Variance" values={avRaw("withdrawsDollarVar")} rawValues={avRaw("withdrawsDollarVar")} rowType="variance-amt" />
        <DR label="% Variance" values={avRaw("withdrawsPctVar")} rawValues={avRaw("withdrawsPctVar")} rowType="variance-pct" />
        <SpacerRow colCount={colCount} />

        <AdjRow label="Owner Withdraws" rowKey="ownerWithdraws" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Change in Current Liabilities" rowKey="changeInCurrentLiabilities" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Change in LT Liabilities" rowKey="changeInLTLiabilities" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Depreciation Expense" rowKey="depreciationExpense" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Amortization Expense" rowKey="amortizationExpense" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Bad Debt Expense" rowKey="badDebtExpense" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Fixed Asset Purchases" rowKey="fixedAssetPurchases" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AdjRow label="Other" rowKey="withdrawsOther" months={months} reconAdjustments={reconAdjustments} onSave={saveAdjustment} />
        <AddbacksRowGroup
          section="withdrawals"
          months={months}
          addbackItems={addbackItems}
          onSaveAmounts={updateAddbackItemAmounts}
          onDelete={deleteAddbackItem}
          onOpenPicker={() => {
            const [sy, sm] = bankActivityStartMonth.split("-");
            const startDate = `${sy}-${sm}-01`;
            const [ey, em] = bankActivityEndMonth.split("-");
            const lastDay = new Date(+ey, +em, 0).getDate();
            const endDate = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;
            setAddbackPickerState({ open: true, section: "withdrawals", startDate, endDate, months });
          }}
        />
        <DR label="Unreconciled Variance $" values={adjWdrURaw} rawValues={adjWdrURaw} rowType="variance-amt" />
        <DR label="Unreconciled Variance %" values={adjWdrPctRaw} rawValues={adjWdrPctRaw} rowType="variance-pct" />
      </FreezeTable>
    );
  };

  const renderActivityTable = () => {
    if (!hasData) return null;
    return renderActivityTableCore(activityRows, activityTTM, reportMonths);
  };

  // Build activity rows from extracted PDF data (manual upload / manual GL)
  const manualActivityRows = (() => {
    if (!filteredPdfMonths.length || !extractedBankPdfData) return [];
    return filteredPdfMonths.map((mk) => {
      const totalDeposits = (extractedBankPdfData.banks || []).reduce((sum, bank) => {
        const m = (bank.months || []).find((x) => x.monthKey === mk);
        return sum + (m?.deposits || 0);
      }, 0);
      const totalWithdrawals = (extractedBankPdfData.banks || []).reduce((sum, bank) => {
        const m = (bank.months || []).find((x) => x.monthKey === mk);
        return sum + (m?.withdrawals || 0);
      }, 0);
      const externalDeposits = totalDeposits;
      const salesPerFinancials = plFinancials?.totalIncome?.[mk] ?? 0;
      const depositsDollarVar = salesPerFinancials - externalDeposits;
      const depositsPctVar = salesPerFinancials !== 0 ? (depositsDollarVar / salesPerFinancials) * 100 : 0;
      const depositsUnreconciledDollar = depositsDollarVar;
      const depositsUnreconciledPct = salesPerFinancials !== 0 ? (depositsUnreconciledDollar / salesPerFinancials) * 100 : 0;
      const externalWithdraws = totalWithdrawals;
      const expensesPerFinancials = plFinancials?.totalExpenses?.[mk] ?? 0;
      const withdrawsDollarVar = externalWithdraws - expensesPerFinancials;
      const withdrawsPctVar = expensesPerFinancials !== 0 ? (withdrawsDollarVar / expensesPerFinancials) * 100 : 0;
      const withdrawsUnreconciledDollar = withdrawsDollarVar;
      const withdrawsUnreconciledPct = expensesPerFinancials !== 0 ? (withdrawsUnreconciledDollar / expensesPerFinancials) * 100 : 0;
      return {
        month: mk,
        totalDeposits, intercompanyTransfers: 0, externalDeposits,
        salesPerFinancials, depositsDollarVar, depositsPctVar,
        changeInAR: 0, changeInARRetentions: 0, fixedAssetDisposals: 0,
        depositsOther: 0, depositsUnreconciledDollar, depositsUnreconciledPct,
        totalWithdrawals, withdrawIntercompanyTransfers: 0, externalWithdraws,
        expensesPerFinancials, withdrawsDollarVar, withdrawsPctVar,
        ownerWithdraws: 0, changeInCurrentLiabilities: 0, changeInLTLiabilities: 0,
        depreciationExpense: 0, amortizationExpense: 0, badDebtExpense: 0,
        fixedAssetPurchases: 0, withdrawsOther: 0,
        withdrawsUnreconciledDollar, withdrawsUnreconciledPct,
      };
    });
  })();

  const _manualTTMBase = manualActivityRows.slice(-12).reduce(
    (acc, r) => ({
      totalDeposits: acc.totalDeposits + r.totalDeposits,
      intercompanyTransfers: 0,
      externalDeposits: acc.externalDeposits + r.externalDeposits,
      salesPerFinancials: acc.salesPerFinancials + r.salesPerFinancials,
      depositsDollarVar: acc.depositsDollarVar + r.depositsDollarVar,
      depositsPctVar: 0,
      changeInAR: 0, changeInARRetentions: 0, fixedAssetDisposals: 0, depositsOther: 0,
      depositsUnreconciledDollar: acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar,
      depositsUnreconciledPct: 0,
      totalWithdrawals: acc.totalWithdrawals + r.totalWithdrawals,
      withdrawIntercompanyTransfers: 0,
      externalWithdraws: acc.externalWithdraws + r.externalWithdraws,
      expensesPerFinancials: acc.expensesPerFinancials + r.expensesPerFinancials,
      withdrawsDollarVar: acc.withdrawsDollarVar + r.withdrawsDollarVar,
      withdrawsPctVar: 0,
      ownerWithdraws: 0, changeInCurrentLiabilities: 0, changeInLTLiabilities: 0,
      depreciationExpense: 0, amortizationExpense: 0, badDebtExpense: 0,
      fixedAssetPurchases: 0, withdrawsOther: 0,
      withdrawsUnreconciledDollar: acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct: 0,
    }),
    buildEmptyActivityReviewRow(),
  );
  const manualActivityTTM = {
    ..._manualTTMBase,
    depositsPctVar: _manualTTMBase.salesPerFinancials !== 0
      ? (_manualTTMBase.depositsDollarVar / _manualTTMBase.salesPerFinancials) * 100 : 0,
    depositsUnreconciledPct: _manualTTMBase.salesPerFinancials !== 0
      ? (_manualTTMBase.depositsUnreconciledDollar / _manualTTMBase.salesPerFinancials) * 100 : 0,
    withdrawsPctVar: _manualTTMBase.expensesPerFinancials !== 0
      ? (_manualTTMBase.withdrawsDollarVar / _manualTTMBase.expensesPerFinancials) * 100 : 0,
    withdrawsUnreconciledPct: _manualTTMBase.expensesPerFinancials !== 0
      ? (_manualTTMBase.withdrawsUnreconciledDollar / _manualTTMBase.expensesPerFinancials) * 100 : 0,
  };

  const renderManualActivityTable = () => {
    return renderActivityTableCore(manualActivityRows, manualActivityTTM, filteredPdfMonths);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Header title="Reconciliation" />
      <div className="page-content">
        <QBDisconnectedBanner pageName="Reconciliation" />
        {/* QB Bank Activity — only for QuickBooks Online */}
        {isQBOnline && (
          <section className="card-base w-full p-5">
            <h2 className="text-[18px] font-semibold text-text-primary">
              QuickBooks Bank Activity
            </h2>
            <p className="mt-1 text-[13px] text-text-secondary">
              Fetches bank account activity directly from QuickBooks for the
              selected date range.
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_220px_auto]">
              {/* Start Month */}
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                  Start Month
                </label>
                <div className="flex gap-2">
                  <select
                    className="input-base h-10"
                    value={bankActivityStartMonth.split("-")[1]}
                    onChange={(e) =>
                      setBankActivityStartMonth(
                        `${bankActivityStartMonth.split("-")[0]}-${e.target.value}`,
                      )
                    }
                  >
                    {MONTHS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input-base h-10"
                    value={bankActivityStartMonth.split("-")[0]}
                    onChange={(e) =>
                      setBankActivityStartMonth(
                        `${e.target.value}-${bankActivityStartMonth.split("-")[1]}`,
                      )
                    }
                  >
                    {YEARS.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* End Month */}
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                  End Month
                </label>
                <div className="flex gap-2">
                  <select
                    className="input-base h-10"
                    value={bankActivityEndMonth.split("-")[1]}
                    onChange={(e) =>
                      setBankActivityEndMonth(
                        `${bankActivityEndMonth.split("-")[0]}-${e.target.value}`,
                      )
                    }
                  >
                    {MONTHS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input-base h-10"
                    value={bankActivityEndMonth.split("-")[0]}
                    onChange={(e) =>
                      setBankActivityEndMonth(
                        `${e.target.value}-${bankActivityEndMonth.split("-")[1]}`,
                      )
                    }
                  >
                    {YEARS.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Accounting Method */}
              <div>
                <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                  Accounting Type
                </label>
                <select
                  value={bankActivityAccountingMethod}
                  onChange={(e) =>
                    setBankActivityAccountingMethod(e.target.value)
                  }
                  className="input-base h-10"
                >
                  <option value="Accrual">Accrual</option>
                  <option value="Cash">Cash</option>
                </select>
              </div>

              {/* Fetch Button */}
              <div className="flex items-end">
                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={() => void loadQBBankActivity()}
                  disabled={isLoadingBankActivity}
                >
                  {isLoadingBankActivity ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}{" "}
                  Fetch Activity
                </button>
              </div>
            </div>
            <StatusBanner sync={bankActivityFetchStatus} />
          </section>
        )}

        {/* Bank Account Balances */}
        <section className="card-base card-p w-full">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Bank Reconciliation
              </h2>
              <p className="text-[14px] text-text-secondary">
                {(isManualUpload || isManualGl || isQBManual)
                  ? "Per-bank balance detail extracted from uploaded bank statement PDF files."
                  : "Per-account balance detail from QuickBooks with reconciliation checks."}
              </p>
            </div>
            <div className="flex items-end gap-3">
              {/* Date Range Filter — Manual Upload, Manual GL, QuickBooks Manual */}
              {(isManualUpload || isManualGl || isQBManual) && allPdfMonths.length > 0 && (
                <>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                      Start Date
                    </label>
                    <input
                      type="date"
                      className="input-base h-10 w-auto min-w-[150px]"
                      value={manualMonthStart ? `${manualMonthStart}-01` : ""}
                      onChange={(e) => {
                        if (!e.target.value) return;
                        const isoKey = e.target.value.slice(0, 7);
                        setManualMonthStart(isoKey);
                        if (manualMonthEnd && isoKey > manualMonthEnd) setManualMonthEnd(isoKey);
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                      End Date
                    </label>
                    <input
                      type="date"
                      className="input-base h-10 w-auto min-w-[150px]"
                      value={manualMonthEnd ? `${manualMonthEnd}-01` : ""}
                      onChange={(e) => {
                        if (!e.target.value) return;
                        const isoKey = e.target.value.slice(0, 7);
                        setManualMonthEnd(isoKey);
                        if (manualMonthStart && isoKey < manualMonthStart) setManualMonthStart(isoKey);
                      }}
                    />
                  </div>
                </>
              )}
              {(isManualUpload || isManualGl || isQBManual) && (
                <button
                  type="button"
                  className="btn-outline flex h-10 items-center gap-1.5 px-3 text-[13px]"
                  disabled={isLoadingExtractedBankPdfData}
                  onClick={() => {
                    if (isQBManual) void loadQMSBankData();
                    else if (isManualUpload) void loadManualBankData();
                    else void loadExtractedBankPdfData({ datasetVersion: glSelectedVersion });
                  }}
                  title="Reload data from the active source"
                >
                  {isLoadingExtractedBankPdfData
                    ? <LoaderCircle size={14} className="animate-spin" />
                    : <RefreshCw size={14} />}
                  Refresh
                </button>
              )}
              {/* Manual GL: dataset version scoping (shared with Reports). Time
                  filtering is handled by the Start/End date pickers above. */}
              {isManualGl && glVersions.length > 0 && (
                <div className="min-w-[160px]">
                  <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                    Version
                  </label>
                  <select
                    className="input-base h-10 w-full"
                    value={glSelectedVersion ? String(glSelectedVersion) : ""}
                    onChange={(e) => setGlSelectedVersion(e.target.value || null)}
                  >
                    {glVersions.map((v) => (
                      <option key={String(v.value)} value={String(v.value)}>
                        {v.label || `Version ${v.value}`}{v.isActive ? " (active)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="min-w-[280px]">
                <label className="mb-1.5 block text-[12px] font-medium text-text-secondary">
                  Bank Account
                </label>
                {(isManualUpload || isManualGl || isQBManual) ? (
                  <select
                    className="input-base h-10 w-full"
                    value={selectedManualBankName}
                    onChange={(e) => setSelectedManualBankName(e.target.value)}
                    disabled={!manualBankOptions.length}
                  >
                    {manualBankOptions.length ? (
                      manualBankOptions.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))
                    ) : (
                      <option value="">No banks available</option>
                    )}
                  </select>
                ) : (
                  <select
                    className="input-base h-10 w-full"
                    value={selectedBalanceBankId}
                    onChange={(e) => setSelectedBalanceBankId(e.target.value)}
                    disabled={!balanceBankOptions.length}
                  >
                    {balanceBankOptions.length ? (
                      balanceBankOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))
                    ) : (
                      <option value="">No bank accounts available</option>
                    )}
                  </select>
                )}
              </div>
            </div>{/* end flex items-end gap-3 */}
          </div>

          {(isManualUpload || isManualGl || isQBManual) ? (
            extractedBankPdfData ? (
              renderManualBalanceAccountTable(
                extractedBankPdfData.banks.find((b) => b.bankName === selectedManualBankName) ||
                extractedBankPdfData.banks[0],
              )
            ) : extractedBankPdfFetchStatus.status === "success" ? (
              // Fetched successfully but active source has no bank statement files
              <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
                No bank statements found for the active source. Upload PDF or Excel files to the Bank Statement folder and sync.
              </div>
            ) : (
              renderManualBalanceAccountTable(null)
            )
          ) : hasData ? (
            visibleBalanceAccounts.map((account) =>
              renderBalanceAccountTable(account),
            )
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              Fetch bank activity to see account balances.
            </div>
          )}
        </section>

        {/* Activity Review */}
        <section className="card-base card-p w-full">
          <div className="mb-5">
            <div>
              <h2 className="text-[18px] font-semibold text-text-primary">
                Activity Review
              </h2>
              <p className="text-[14px] text-text-secondary">
                Deposits and withdrawals compared to P&amp;L financials, with
                reconciling items.
              </p>
            </div>
          </div>
          {(isManualUpload || isManualGl || isQBManual) ? (
            extractedBankPdfData?.months?.length ? (
              renderManualActivityTable()
            ) : extractedBankPdfFetchStatus.status === "success" ? (
              <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
                No bank statements found for the active source. Upload PDF or Excel files to the Bank Statement folder and sync.
              </div>
            ) : (
              renderManualActivityTable()
            )
          ) : hasData ? (
            renderActivityTable()
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted">
              Fetch bank activity to see the Activity Review.
            </div>
          )}
        </section>
      </div>

      {addbackPickerState?.open && (
        <AddbackPickerModal
          isOpen
          section={addbackPickerState.section}
          months={addbackPickerState.months || []}
          clientId={clientId}
          startDate={addbackPickerState.startDate}
          endDate={addbackPickerState.endDate}
          accountingMethod={bankActivityAccountingMethod}
          getHeaders={getHeaders}
          existingItems={addbackItems}
          reportSource={selectedReportSource}
          onAdd={(name, source, monthAmounts) =>
            createAddbackItem(addbackPickerState.section, name, source, monthAmounts)
          }
          onClose={() => setAddbackPickerState(null)}
        />
      )}
    </>
  );
}