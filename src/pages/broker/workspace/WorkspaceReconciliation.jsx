import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";

import { getStoredToken, setSelectedReportSource, loadSavedQBBankActivityRequest, getFinancialStatements } from "../../../lib/api";
import { readCachedFinancials, writeCachedFinancials } from "../../../lib/keyReportFinancials";
import { useDataSource } from "../../../context/DataSourceContext";
import { useDatasetVersionStore } from "../../../store/useDatasetVersionStore";
import {
  useKeyReportContextStore,
  selectKeyReportContext,
  maskKeyReportContext,
} from "../../../store/useKeyReportContextStore";
import { useShallow } from "zustand/react/shallow";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";
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
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
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

// Per-slot cache for the extracted Bank Reconciliation data, isolated by
// (company, connection mode, Key Report version). Keeping the DATA in its own
// slot key — separate from the client-level settings above — means switching
// version or connection mode restores that exact slot's table instantly and
// never shows another version/mode's numbers.
const getReconDataKey = (clientId, source, version) =>
  `${RECONCILIATION_STORAGE_PREFIX}-data:${clientId || "default"}:${source || "default"}:${version || "default"}`;

const getStoredReconData = (clientId, source, version) => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getReconDataKey(clientId, source, version));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const saveStoredReconData = (clientId, source, version, data) => {
  if (typeof window === "undefined" || !clientId || !source) return;
  try {
    window.sessionStorage.setItem(
      getReconDataKey(clientId, source, version),
      JSON.stringify(data),
    );
  } catch {
    // Ignore quota/serialization issues — this is a display cache only.
  }
};

// Derive the Activity Review's monthly P&L figures — { totalIncome, totalExpenses }
// keyed "YYYY-MM" — from a Key Reports financial-statements response. Mirrors the
// backend's computeMonthlyPlFinancials exactly:
//   Sales per Financials    ← revenue.total              (accrual revenue)
//   Expenses per Financials ← operatingExpenses.total    (total operating expenses)
// Expenses per Financials INCLUDES depreciation/amortization/bad debt on purpose:
// they are added back as separate positive reconciling rows, which only nets to
// the true cash figure when they remain in this base. (Was operatingIncome — a
// profit figure that never reconciled withdrawals to expenses.)
const computePlFinancialsFromFs = (resp) => {
  const monthly = resp?.reports?.profitAndLoss?.monthly || [];
  const totalIncome = {};
  const totalExpenses = {};
  for (const e of monthly) {
    const year = Number(e?.year);
    const monthNum = Number(e?.monthNumber);
    if (!Number.isInteger(year) || !(monthNum >= 1 && monthNum <= 12)) continue;
    const key = `${year}-${String(monthNum).padStart(2, "0")}`;
    totalIncome[key] = Number(e?.statement?.revenue?.total) || 0;
    totalExpenses[key] = Number(e?.statement?.operatingExpenses?.total) || 0;
  }
  return { totalIncome, totalExpenses };
};

// Derive per-month bank/cash book balances from a Key Reports financial-statements
// response. Unlike the single point-in-time /bs-bank-balances snapshot (one
// year-end figure per bank), the generated MONTHLY Balance Sheet
// (resp.reports.balanceSheet.monthly) carries a book balance for every
// current-asset leaf account in every month — the true source for a per-month
// "Per Balance Sheet" row.
//
// Bank/cash accounts are current-asset leaves, so we collect them from each
// month's assets.currentAssets.groups. Accounts are merged across months by
// identity (systemId → account number → name); amounts are keyed "YYYY-MM" to
// match the bank data's monthKey. Each entry keeps the { name, accountNumber }
// shape matchBsBank() expects (plus a monthAmounts map) so the SAME matcher maps
// a bank statement to its account. Returns null when no monthly BS is available.
const computeBsBankBalancesByMonthFromFs = (resp) => {
  const monthly = resp?.reports?.balanceSheet?.monthly || [];
  const byId = new Map();
  let latestYear = null;

  for (const e of monthly) {
    const year = Number(e?.year);
    const monthNum = Number(e?.monthNumber);
    if (!Number.isInteger(year) || !(monthNum >= 1 && monthNum <= 12)) continue;
    const monthKey = `${year}-${String(monthNum).padStart(2, "0")}`;
    if (latestYear == null || year > latestYear) latestYear = year;

    const groups = e?.statement?.assets?.currentAssets?.groups || {};
    for (const g of Object.values(groups)) {
      for (const acc of g?.accounts || []) {
        const name = acc?.adjustedName || acc?.name;
        if (!name) continue;
        const idKey = acc?.systemId || acc?.accountNumber || name;
        let rec = byId.get(idKey);
        if (!rec) {
          rec = {
            name,
            // Prefer a 4-digit run in the name (what matchBsBank keys on); fall
            // back to the stored account number so the number path can still fire.
            accountNumber: _bsLastFour(name) || String(acc?.accountNumber || ""),
            monthAmounts: {},
          };
          byId.set(idKey, rec);
        }
        const val = Number(acc?.amount);
        if (Number.isFinite(val)) rec.monthAmounts[monthKey] = val;
      }
    }
  }

  const bankAccounts = Array.from(byId.values());
  if (!bankAccounts.length) return null;
  return { year: latestYear, bankAccounts };
};

// ── Activity Review engine (frontend mirror of activityReviewService.js) ──────
// Derives every auto-computable Activity Review adjustment row directly from a
// Key Reports financial-statements response — no hardcoded account names, IDs,
// row/column positions, period type, or currency. Byte-for-byte the same logic
// (and the same signed cash-effect convention) as the backend authoritative
// engine, so the rendered numbers match the cached server figures exactly.
//
// SIGN CONVENTION (product Step 6 / indirect method): every value is that item's
// CASH EFFECT, so the table can SUM them straight into the Unreconciled Variance:
//   current ASSET ↑ → negative,  current ASSET ↓ → positive
//   LIABILITY     ↑ → positive,  LIABILITY     ↓ → negative
//   depreciation / amortization / bad debt → positive add-backs
//   fixed-asset purchase → negative (outflow), disposal → positive (inflow)
//
// Classification reuses the COA-assigned account_type / report_tag already on
// each leaf, refined by ONE bounded keyword pass only where the stored tag is
// coarser than a row needs (same accepted pattern as the statement builder's
// current/non-current KPI split). It never rescans or mutates anything else.
const _AR_RETENTION_RE = /retention|retainage|holdback|retain(?:ed|age)?\s+receivab/i;
const _ACCUM_DEP_RE    = /accumulated\s+(?:depreciation|amortization|depletion)|accum\.?\s*(?:dep|amort)/i;
const _AMORT_RE        = /amorti[sz]/i;
const _BAD_DEBT_RE     = /bad\s*debt|doubtful|uncollectib|allowance\s+for\s+(?:doubtful|credit)|write.?off.*receivab/i;
const _leafName = (l) => String(l?.adjustedName || l?.name || "");
const _isArRetention = (l) => l?.reportTag === "accounts_receivable" && _AR_RETENTION_RE.test(_leafName(l));
const _isAccountsReceivable = (l) => l?.reportTag === "accounts_receivable" && !_AR_RETENTION_RE.test(_leafName(l));
const _isAccumulatedDepreciation = (l) => _ACCUM_DEP_RE.test(_leafName(l));
const _depAmortKind = (l) => {
  const tagged = l?.reportTag === "depreciation_amortization";
  const name = _leafName(l);
  if (!tagged && !/depreciat|amorti[sz]|depletion/i.test(name)) return null;
  return _AMORT_RE.test(name) ? "amortization" : "depreciation";
};
const _isBadDebt = (l) => _BAD_DEBT_RE.test(_leafName(l));
const _round2 = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;
const _bucketLeaves = (bucket) => {
  const out = [];
  for (const g of Object.values(bucket?.groups || {})) {
    for (const acc of g?.accounts || []) out.push(acc);
  }
  return out;
};
const _sumLeaves = (arr) => arr.reduce((s, a) => s + (Number(a?.amount) || 0), 0);
const _bsSnapshot = (entry) => {
  const st = entry?.statement || {};
  const currentAssets = _bucketLeaves(st.assets?.currentAssets);
  const fixedAssets   = _bucketLeaves(st.assets?.fixedAssets);
  const currentLiab   = _bucketLeaves(st.liabilities?.currentLiabilities);
  const longTermLiab  = _bucketLeaves(st.liabilities?.longTermLiabilities);
  return {
    ar:           _sumLeaves(currentAssets.filter(_isAccountsReceivable)),
    arRetention:  _sumLeaves(currentAssets.filter(_isArRetention)),
    // TOTAL current assets (cash/bank + AR + inventory + prepaids + other) — drives
    // the informational "Change in Current Assets" row (raw BS movement).
    currentAssetsTotal: _sumLeaves(currentAssets),
    currentLiab:  _sumLeaves(currentLiab),
    longTermLiab: _sumLeaves(longTermLiab),
    grossFixed:   _sumLeaves(fixedAssets.filter((l) => !_isAccumulatedDepreciation(l))),
  };
};
const _plSnapshot = (entry) => {
  const groups = entry?.statement?.operatingExpenses?.groups || {};
  let depreciation = 0, amortization = 0, badDebt = 0;
  for (const g of Object.values(groups)) {
    for (const acc of g?.accounts || []) {
      const kind = _depAmortKind(acc);
      if (kind === "amortization") amortization += Number(acc?.amount) || 0;
      else if (kind === "depreciation") depreciation += Number(acc?.amount) || 0;
      else if (_isBadDebt(acc)) badDebt += Number(acc?.amount) || 0;
    }
  }
  return { depreciation, amortization, badDebt };
};
const _activityMonthKey = (e) => {
  const year = Number(e?.year), monthNum = Number(e?.monthNumber);
  if (!Number.isInteger(year) || !(monthNum >= 1 && monthNum <= 12)) return null;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
};
// Returns { [monthKey]: { changeInAR, changeInARRetentions, fixedAssetDisposals,
//   changeInCurrentLiabilities, changeInLTLiabilities, depreciationExpense,
//   amortizationExpense, badDebtExpense, fixedAssetPurchases } }.
const computeActivityReviewFromFs = (resp) => {
  const bsMonthly = [...(resp?.reports?.balanceSheet?.monthly || [])].sort(
    (a, b) => (Number(a.year) - Number(b.year)) || (Number(a.monthNumber) - Number(b.monthNumber)),
  );
  const plByKey = {};
  for (const e of resp?.reports?.profitAndLoss?.monthly || []) {
    const k = _activityMonthKey(e);
    if (k) plByKey[k] = _plSnapshot(e);
  }
  const out = {};
  let prev = null;
  for (const entry of bsMonthly) {
    const key = _activityMonthKey(entry);
    if (!key) continue;
    const cur = _bsSnapshot(entry);
    const dAR      = prev ? cur.ar - prev.ar : 0;
    const dARRet   = prev ? cur.arRetention - prev.arRetention : 0;
    // Raw movement in total current assets (current − previous). Informational only
    // (includes cash), so it is displayed but never summed into Unreconciled.
    const dCurrentAssets = prev ? cur.currentAssetsTotal - prev.currentAssetsTotal : 0;
    const dCurLiab = prev ? cur.currentLiab - prev.currentLiab : 0;
    const dLTLiab  = prev ? cur.longTermLiab - prev.longTermLiab : 0;
    const dGross   = prev ? cur.grossFixed - prev.grossFixed : 0;
    const pl = plByKey[key] || { depreciation: 0, amortization: 0, badDebt: 0 };
    out[key] = {
      changeInAR:                 _round2(-dAR),
      changeInARRetentions:       _round2(-dARRet),
      changeInCurrentAssets:      _round2(dCurrentAssets),
      fixedAssetDisposals:        _round2(dGross < 0 ? -dGross : 0),
      changeInCurrentLiabilities: _round2(dCurLiab),
      changeInLTLiabilities:      _round2(dLTLiab),
      depreciationExpense:        _round2(pl.depreciation),
      amortizationExpense:        _round2(pl.amortization),
      badDebtExpense:             _round2(pl.badDebt),
      fixedAssetPurchases:        _round2(dGross > 0 ? -dGross : 0),
    };
    prev = cur;
  }
  return out;
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
        value !== 0 ? "text-text-primary" : "text-text-muted",
      )}
      title="Click to edit"
    >
      {value !== 0 ? formatNumber(value, 2) : "-"}
    </span>
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
          ttmTotal !== 0 ? "text-text-primary" : "text-text-muted",
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
              totalPerMonth[month] !== 0 ? "text-text-primary" : "text-text-muted",
            )}
          >
            {totalPerMonth[month] !== 0 ? formatNumber(totalPerMonth[month], 2) : "-"}
          </td>
        ))}
        <td
          className={cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            TABLE_VALUE_COL_WIDTH,
            ttmTotal !== 0 ? "text-text-primary" : "text-text-muted",
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

// Parse a Key Reports financial-statements response (the payload from
// GET /key-reports/versions/:id/reports/financial-statements) into the same
// { name, source, monthAmounts } picker shape parseManualPLItems produces.
//   • Income   = revenue leaf accounts.
//   • Expenses = union of every operating-expense group's accounts + cost of sales.
// Accounts are merged across every monthly period by identity (systemId, falling
// back to name); amounts are keyed "YYYY-MM" — the same monthKey the Activity
// Review rows use — so the picker's per-month figures line up with the table.
function parseKeyReportPLItems(resp) {
  const monthly = resp?.reports?.profitAndLoss?.monthly || [];
  const income = new Map();
  const expense = new Map();

  const add = (bucket, source, acc, monthKey) => {
    const idKey = acc?.systemId || acc?.name;
    const name = acc?.adjustedName || acc?.name;
    if (!idKey || !name) return;
    let rec = bucket.get(idKey);
    if (!rec) {
      rec = { name, source, monthAmounts: {} };
      bucket.set(idKey, rec);
    }
    const val = Number(acc?.amount);
    if (Number.isFinite(val) && val !== 0) rec.monthAmounts[monthKey] = val;
  };

  for (const e of monthly) {
    const year = Number(e?.year);
    const monthNum = Number(e?.monthNumber);
    if (!Number.isInteger(year) || !(monthNum >= 1 && monthNum <= 12)) continue;
    const monthKey = `${year}-${String(monthNum).padStart(2, "0")}`;
    const s = e?.statement || {};

    for (const acc of s.revenue?.accounts || []) add(income, "pl_income", acc, monthKey);

    for (const acc of s.costOfSales?.accounts || []) add(expense, "pl_expense", acc, monthKey);
    for (const g of Object.values(s.operatingExpenses?.groups || {})) {
      for (const acc of g?.accounts || []) add(expense, "pl_expense", acc, monthKey);
    }
  }

  return {
    plIncomeItems: Array.from(income.values()),
    plExpenseItems: Array.from(expense.values()),
  };
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
  keyReportVersionId,
  onAdd,
  onClose,
}) {
  // In Key Reports mode the resolved reportSource is a manual_* value, so it
  // can't distinguish "true manual upload" from "Key Reports". The presence of a
  // Key Report version is the authoritative signal, and it takes priority: the
  // P&L pick-list must come from that version's generated financial statements,
  // not the client's raw manual-upload files.
  const isKeyReports = Boolean(keyReportVersionId);
  const isQBOnline = reportSource === "quickbooks_online";
  const isManualUpload = !isKeyReports && reportSource === "manual_upload_excel_pdf";
  const hasPLData = isKeyReports || isQBOnline || isManualUpload;

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

    if (isKeyReports) {
      // Reuse the sessionStorage cache the Reports page / Activity Review already
      // warm, so opening the picker is instant on the common path and only falls
      // back to the network when nothing is cached yet.
      (async () => {
        try {
          let resp = readCachedFinancials(clientId, keyReportVersionId);
          if (!resp) {
            resp = await getFinancialStatements(keyReportVersionId, { currency: "USD" });
            if (resp) writeCachedFinancials(clientId, keyReportVersionId, resp);
          }
          if (resp) {
            setLineItems(parseKeyReportPLItems(resp));
          } else {
            setFetchError("Could not load P&L items from Key Reports.");
          }
        } catch {
          setFetchError("Could not load P&L items from Key Reports.");
        } finally {
          setLoading(false);
        }
      })();
    } else if (isQBOnline) {
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
  }, [isOpen, reportSource, keyReportVersionId, section, clientId, startDate, endDate, accountingMethod]);

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
    changeInCurrentAssets: 0,
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
  // Key Reports drives this page ONLY when the active data source is
  // "key_reports" (activated from the Key Reports page). For the 4 connection
  // modes the KR context is masked inactive so the Connections-page selection
  // is authoritative.
  const krSelected = useMemo(
    () => normalizeReportSourceKey(contextActiveSource) === REPORT_SOURCE_KEYS.KEY_REPORTS,
    [contextActiveSource],
  );
  const rawKr = useKeyReportContextStore(useShallow(selectKeyReportContext));
  const kr = useMemo(() => maskKeyReportContext(rawKr, krSelected), [rawKr, krSelected]);
  // Shared dataset-version selection (same store Reports writes to) removed — 
  // consolidated into the unified Key Report Version selector.
  // Track the live GL scope (selected dataset version) so an in-flight bank-data
  // fetch for a previous version can be discarded if the user switches mid-fetch —
  // prevents stale-version data overwriting fresh (needs F5) data.
  const glScopeRef = useRef({ datasetVersion: kr.resolvedDatasetVersion });
  glScopeRef.current = { datasetVersion: kr.resolvedDatasetVersion };
  // Key Reports is the single source of truth: when a Key Report Version is
  // selected, the bank reconciliation resolves its documents from THAT Version
  // (via keyReportVersionId) instead of the Connections-page active source.
  const krVersionIdRef = useRef(null);
  krVersionIdRef.current = kr.krActive ? kr.selectedVersionId : null;
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
  // Live mirror of extractedBankPdfData so async loaders can read the latest value
  // without adding it to their dependency arrays.
  const extractedBankPdfDataRef = useRef(extractedBankPdfData);
  useEffect(() => {
    extractedBankPdfDataRef.current = extractedBankPdfData;
  }, [extractedBankPdfData]);
  // Apply a bank-data result WITHOUT letting an empty or failed background load
  // blank data already on screen (restored from cache, or a prior good load).
  // Replaces the table only when the new result actually has banks, when the
  // caller forces it (explicit Refresh), or when nothing is shown yet. This is
  // what guarantees "come back to the page → data stays as it is" even if a stray
  // auto-fetch races in with an empty result. Returns true when it replaced.
  const applyBankData = useCallback((next, { force = false } = {}) => {
    const hasData = !!(next && Array.isArray(next.banks) && next.banks.length > 0);
    if (hasData || force || !extractedBankPdfDataRef.current) {
      setExtractedBankPdfData(next);
      extractedBankPdfDataRef.current = next;
      return true;
    }
    return false;
  }, []);
  const [manualMonthStart, setManualMonthStart] = useState(null);
  const [manualMonthEnd, setManualMonthEnd] = useState(null);
  const [bsBankBalances, setBsBankBalances] = useState(null);
  // Per-month bank/cash book balances derived from the Key Reports MONTHLY
  // Balance Sheet. Drives a per-month "Per Balance Sheet" row; null outside Key
  // Reports mode (falls back to the point-in-time bsBankBalances snapshot).
  const [bsMonthlyBalances, setBsMonthlyBalances] = useState(null);
  const [plFinancials, setPlFinancials] = useState(null);
  // Auto-computed Activity Review adjustment rows (Change in AR, Change in
  // Current/LT Liabilities, Depreciation, Amortization, Bad Debt, Fixed Asset
  // Purchases/Disposals, AR Retentions), keyed "YYYY-MM". Populated in Key
  // Reports mode from the financial-statements payload (see effect below); null
  // otherwise. Manual per-cell overrides in reconAdjustments still win over these.
  const [activityReview, setActivityReview] = useState(null);
  const [reportSources, setReportSources] = useState([]);
  // Key Reports is the single source of truth: when the company has a selected
  // Key Report Version, the report source is derived from that Version's flow —
  // NOT from the Connections-page active data source. Falls back to the legacy
  // DataSourceContext behavior only when no Key Report versions exist.
  const [selectedReportSource, setSelectedReportSourceState] = useState(
    kr.krActive && kr.effectiveSource
      ? kr.effectiveSource
      : normalizeReportSourceKey(contextActiveSource || REPORT_SOURCE_KEYS.QUICKBOOKS)
  );
  // Keep the local source state in sync with the authoritative Key Reports flow
  useEffect(() => {
    if (!kr.krActive || !kr.effectiveSource) return;
    if (selectedReportSource !== kr.effectiveSource) {
      setSelectedReportSourceState(kr.effectiveSource);
    }
  }, [kr.krActive, kr.effectiveSource, selectedReportSource]);
  // True only after getReportSources API confirms the actual source.
  // Prevents stale storedState from triggering the wrong endpoint on mount.
  const [isSourceConfirmedByServer, setIsSourceConfirmedByServer] = useState(false);
  // Persisted adjustment values keyed by "${month}_${rowKey}", e.g. "2025-01_changeInAR".
  const [reconAdjustments, setReconAdjustments] = useState({});
  // Named addback items (multi-item rows) for deposits and withdrawals sections.
  const [addbackItems, setAddbackItems] = useState([]);
  // Controls the addback picker modal: null = closed, { open, section, startDate, endDate } = open.
  const [addbackPickerState, setAddbackPickerState] = useState(null);

  // Export dropdown state
  const [bankReconExportOpen, setBankReconExportOpen] = useState(false);
  const [bankReconIsExporting, setBankReconIsExporting] = useState(false);

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
    // Restore the saved Bank Reconciliation view selections (date range + bank).
    setManualMonthStart(nextState?.manualMonthStart ?? null);
    setManualMonthEnd(nextState?.manualMonthEnd ?? null);
    setSelectedManualBankName(nextState?.selectedManualBankName || "");
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
          // Persist the Bank Reconciliation view selections (Start/End Date range
          // and the chosen Bank Account) so returning to the page restores the
          // exact same view instead of resetting to the full range / first bank.
          manualMonthStart: manualMonthStart ?? existing.manualMonthStart ?? null,
          manualMonthEnd: manualMonthEnd ?? existing.manualMonthEnd ?? null,
          selectedManualBankName:
            selectedManualBankName || existing.selectedManualBankName || "",
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
    manualMonthStart,
    manualMonthEnd,
    selectedManualBankName,
    qbOneBankActivity,
    extractedBankPdfData,
    selectedReportSource,
  ]);

  // Slot identity for the per-version / per-connection-mode data cache. kr is
  // masked outside Key Reports mode, so the version dimension is "default" for
  // the 4 connection modes and the selected Key Report Version in KR mode.
  const reconDataVersion = kr.krActive ? String(kr.selectedVersionId || "default") : "default";

  // Persist the extracted Bank Reconciliation data for the current slot so
  // returning to this version + connection mode restores the table instantly.
  useEffect(() => {
    if (!clientId || !selectedReportSource) return;
    // Merge with the already-cached slot. On remount every data field is briefly
    // null (fresh useState) BEFORE the restore effect / loader repopulate it, and
    // this effect fires first — writing raw nulls here would WIPE the cache, so
    // the next restore finds nothing and the page re-fetches everything (the slow
    // "Loading…" on return). `value ?? existing ?? null` keeps each cached field
    // until a fresh non-null value replaces it — same guard the workspace-state
    // effect already uses for qbBankActivity.
    const existing = getStoredReconData(clientId, selectedReportSource, reconDataVersion) || {};
    saveStoredReconData(clientId, selectedReportSource, reconDataVersion, {
      extractedBankPdfData: extractedBankPdfData ?? existing.extractedBankPdfData ?? null,
      qbBankActivity: qbBankActivity ?? existing.qbBankActivity ?? null,
      qbOneBankActivity: qbOneBankActivity ?? existing.qbOneBankActivity ?? null,
      plFinancials: plFinancials ?? existing.plFinancials ?? null,
      // Auto-computed Activity Review rows — cached alongside the bank data so
      // returning to the page restores the FULL table instantly (no re-fetch /
      // re-compute of the financial statements, which is what made revisits slow).
      activityReview: activityReview ?? existing.activityReview ?? null,
      bsBankBalances: bsBankBalances ?? existing.bsBankBalances ?? null,
      bsMonthlyBalances: bsMonthlyBalances ?? existing.bsMonthlyBalances ?? null,
      savedAt: new Date().toISOString(),
    });
  }, [
    clientId,
    selectedReportSource,
    reconDataVersion,
    extractedBankPdfData,
    qbBankActivity,
    qbOneBankActivity,
    plFinancials,
    activityReview,
    bsBankBalances,
    bsMonthlyBalances,
  ]);

  // Restore the cached data for the current slot on mount and whenever the
  // version / connection mode changes — an instant, correctly-isolated view.
  // The unified loader still runs afterwards to refresh from the backend.
  useEffect(() => {
    if (!clientId || !selectedReportSource) return;
    const slot = getStoredReconData(clientId, selectedReportSource, reconDataVersion);
    if (!slot) return;
    if (slot.extractedBankPdfData) {
      setExtractedBankPdfData(slot.extractedBankPdfData);
      setExtractedBankPdfFetchStatus({ status: "success", message: "Restored saved data." });
    }
    if (slot.qbBankActivity) setQbBankActivity(slot.qbBankActivity);
    if (slot.qbOneBankActivity) setQbOneBankActivity(slot.qbOneBankActivity);
    if (slot.plFinancials) setPlFinancials(slot.plFinancials);
    if (slot.activityReview) setActivityReview(slot.activityReview);
    if (slot.bsBankBalances) setBsBankBalances(slot.bsBankBalances);
    if (slot.bsMonthlyBalances) setBsMonthlyBalances(slot.bsMonthlyBalances);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, selectedReportSource, reconDataVersion]);

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
      // Key Reports scoping (highest priority): resolve the bank statement from
      // the SELECTED Key Report Version's linked documents.
      if (opts.keyReportVersionId) params.append("keyReportVersionId", String(opts.keyReportVersionId));
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
      const replaced = applyBankData(normalized, { force: opts.force });
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: replaced
          ? `Loaded ${normalized?.banks?.length ?? 0} bank(s) across ${normalized?.months?.length ?? 0
            } month(s).`
          : "Showing saved bank data.",
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({
        status: "error",
        message: getErrMsg(e),
      });
      // Never blank data already on screen on a transient error — keep the last
      // good/restored view; only show empty if there was nothing to begin with.
      if (!extractedBankPdfDataRef.current) setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders, applyBankData]);

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
      if (krVersionIdRef.current) params.append("keyReportVersionId", String(krVersionIdRef.current));
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

  const loadManualBankData = useCallback(async (opts = {}) => {
    if (activeSourceRef.current !== REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      console.warn(`[BankData] loadManualBankData blocked — activeSource=${activeSourceRef.current} is not Manual Upload`);
      return;
    }
    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    // In Key Reports mode the P&L figures are owned by the dedicated
    // financial-statements fetch (see effect below); don't reset/clobber them here.
    if (!krVersionIdRef.current) setPlFinancials(null);
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading bank statement data from Manual Upload source...",
    });
    try {
      const params = new URLSearchParams();
      if (clientId) params.append("clientId", clientId);
      // Key Reports scoping: resolve documents from the SELECTED Version.
      if (krVersionIdRef.current) params.append("keyReportVersionId", String(krVersionIdRef.current));
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
      // Set P&L financials (Sales/Expenses per Financials for Activity Review).
      // In Key Reports mode these come from the financial-statements fetch below
      // (reliable), so only apply the bank-data-merged value outside KR mode.
      if (!krVersionIdRef.current) setPlFinancials(data.plFinancials ?? null);
      if (data.empty) {
        // Empty background result must not blank data already on screen.
        const replaced = applyBankData(null, { force: opts.force });
        setExtractedBankPdfFetchStatus({
          status: "success",
          message: replaced
            ? (data.message || "No bank statements uploaded. Upload PDF or Excel files to Manual Upload Source → Bank Statement.")
            : "Showing saved bank data.",
        });
        return;
      }
      const normalized = normalizeExtractedBankPdfData(data);
      const replaced = applyBankData(normalized, { force: opts.force });
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: replaced
          ? (normalized
            ? `Loaded ${normalized.banks?.length ?? 0} bank(s).`
            : "No bank statement data found. Upload files to Manual Upload Source → Bank Statement.")
          : "Showing saved bank data.",
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({ status: "error", message: getErrMsg(e) });
      // Keep the last good/restored view on a transient error.
      if (!extractedBankPdfDataRef.current) setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders, applyBankData]);

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
      // Key Reports scoping (highest priority): pick the Balance Sheet linked to
      // the SELECTED Key Report Version.
      if (opts.keyReportVersionId) params.append("keyReportVersionId", String(opts.keyReportVersionId));
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

  // Load persisted addback items — isolated by company AND connection mode, and
  // additionally by Key Report Version when in Key Reports mode (each version has
  // its own addbacks). kr is masked outside Key Reports mode, so addbackVersionId
  // is null for the 4 connection modes.
  const addbackVersionId = kr.krActive ? kr.selectedVersionId : null;
  useEffect(() => {
    if (!clientId || !selectedReportSource) return;
    setAddbackItems([]); // clear immediately so old mode's items never flash
    const versionParam = addbackVersionId
      ? `&keyReportVersionId=${encodeURIComponent(addbackVersionId)}`
      : "";
    fetch(
      `${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}?clientId=${clientId}&reportSource=${encodeURIComponent(selectedReportSource)}${versionParam}`,
      { headers: getHeaders() },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.success && Array.isArray(d.items)) setAddbackItems(d.items);
      })
      .catch(() => {});
  }, [clientId, getHeaders, selectedReportSource, addbackVersionId]);

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
          body: JSON.stringify({ clientId, section, name, source, monthAmounts, reportSource: selectedReportSource, keyReportVersionId: addbackVersionId }),
        });
        const data = await resp.json();
        if (data?.success && data.item) {
          setAddbackItems((prev) => [...prev, data.item]);
        }
      } catch { /* stays in local state */ }
    },
    [clientId, getHeaders, selectedReportSource, addbackVersionId],
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




  const handleBankReconExport = async (kind) => {
    setBankReconExportOpen(false);
    setBankReconIsExporting(true);
    try {
      if (kind === "excel") {
        exportBankReconToExcel();
      } else {
        exportBankReconToPdf();
      }
    } catch (err) {
      console.error("[BankRecon] Export failed:", err);
      alert(err?.message || "Export failed. Please try again.");
    } finally {
      setBankReconIsExporting(false);
    }
  };

  // Unified bank-data loader — dispatches ONLY based on server-confirmed source.
  // isSourceConfirmedByServer prevents stale storedState from triggering the wrong endpoint.
  // Never short-circuit on stored data — stored data may be from a different source.
  useEffect(() => {
    if (!clientId || !selectedReportSource || !isSourceConfirmedByServer) return;

    // Instant return: if this exact slot (company + connection mode + version) is
    // already cached in session storage, the restore effect has painted it — skip
    // the network fetch so revisiting the page is instant. The Refresh button
    // calls the loaders directly (bypassing this effect) to force a fresh fetch.
    const manualSource =
      selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD ||
      selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL ||
      selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
    if (manualSource) {
      const slot = getStoredReconData(clientId, selectedReportSource, reconDataVersion);
      if (slot && (slot.extractedBankPdfData || slot.bsBankBalances || slot.plFinancials)) {
        return;
      }
    }

    if (selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      // Manual Upload → single endpoint returns both bank data and balanceSheetBankAccounts
      void loadManualBankData();
    } else if (selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL) {
      // Manual GL → PDF/Excel extraction endpoint, scoped to the selected dataset
      // version so a different version's data never mixes in. All of the version's
      // months are fetched; the From/To date pickers narrow the view client-side.
      // keyReportVersionId (when a Version is selected) is the highest-priority
      // scope — the bank statement / balance sheet come from that Version.
      const glScope = {
        datasetVersion: kr.resolvedDatasetVersion,
        keyReportVersionId: krVersionIdRef.current,
      };
      void loadExtractedBankPdfData(glScope);
      void loadBsBankBalances("manual_upload_excel_pdf", glScope);
    } else if (selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      // QuickBooks Manual ONLY → QMS endpoint reading "Quickbooks Manual Source" folder only
      void loadQMSBankData();
      void loadBsBankBalances("quickbooks_manual", { keyReportVersionId: krVersionIdRef.current });
    }
    // QUICKBOOKS (QB Online) uses its own separate data flow — no action here
  }, [clientId, selectedReportSource, isSourceConfirmedByServer, reconDataVersion, kr.resolvedDatasetVersion, kr.selectedVersionId, loadExtractedBankPdfData, loadManualBankData, loadQMSBankData, loadBsBankBalances]);

  // Key Reports: source the Activity Review's "Sales per Financials" /
  // "Expenses per Financials" directly from the selected version's financial
  // statements — the same endpoint the Reports page uses. The bank-data endpoint
  // also computes these, but it runs the heavy generateFinancialStatements in
  // parallel with the multi-minute bank extraction and can fail under load,
  // leaving the rows blank. Fetching them separately here (reusing the Reports
  // page's sessionStorage cache, invalidated on regenerate) is reliable and cheap.
  useEffect(() => {
    const versionId = kr.krActive ? kr.selectedVersionId : null;
    if (!clientId || !versionId) {
      // Not in Key Reports mode → no monthly Balance Sheet source. Clear any stale
      // monthly balances so the point-in-time bsBankBalances snapshot (the manual /
      // QMS source of truth for "Per Balance Sheet") is authoritative.
      setBsMonthlyBalances(null);
      // No financial statements outside KR mode → no auto-computed adjustments.
      setActivityReview(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let resp = readCachedFinancials(clientId, versionId);
        if (!resp) {
          resp = await getFinancialStatements(versionId, { currency: "USD" });
          if (resp) writeCachedFinancials(clientId, versionId, resp);
        }
        if (cancelled || !resp) return;
        setPlFinancials(computePlFinancialsFromFs(resp));
        // Same response auto-populates every derivable Activity Review row.
        setActivityReview(computeActivityReviewFromFs(resp));
        // Same response feeds the per-month "Per Balance Sheet" row.
        setBsMonthlyBalances(computeBsBankBalancesByMonthFromFs(resp));
      } catch {
        /* non-fatal — leave any existing P&L figures in place */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, kr.krActive, kr.selectedVersionId]);

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
    // Key Reports (when a Version is selected) is authoritative — skip the
    // Connections-driven source here so the active data source has zero impact.
    if (kr.krActive) return;
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
  }, [contextActiveSource, contextSourceRecords, kr.krActive]);

  // Key Reports-driven source: the selected Version's flow determines the report
  // source, and its pinned dataset version scopes the books/balance-sheet side.
  // This makes Bank Reconciliation depend solely on the selected Version.
  useEffect(() => {
    if (!kr.krActive || !kr.effectiveSource) return;
    setSelectedReportSourceState(kr.effectiveSource);
    // Clear cross-version data before the unified loader refetches.
    setExtractedBankPdfData(null);
    setExtractedBankPdfFetchStatus({ status: "idle", message: "" });
    setExtractedBankPdfError("");
    setBsBankBalances(null);
    setIsSourceConfirmedByServer(true);
  }, [
    kr.krActive,
    kr.effectiveSource,
    kr.flowType,
    kr.resolvedDatasetVersion,
    kr.selectedVersionId,
  ]);

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

  // Manual GL internal version selection removed — consolidated into Key Reports.



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
    const changeInCurrentAssets = 0;
    const fixedAssetDisposals = 0;
    const depositsOther = 0;
    const depositsUnreconciledDollar =
      depositsDollarVar +
      changeInAR +
      changeInARRetentions +
      changeInCurrentAssets +
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
      changeInCurrentAssets,
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
      changeInCurrentAssets: acc.changeInCurrentAssets + r.changeInCurrentAssets,
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

  // Non-editable category header row for the Activity Review adjustment
  // section (e.g. "Changes in Assets", "P&L Account Adjustments"). Rendered
  // even when the category has no rows underneath it, so the four categories
  // always show as a consistent grouping.
  const GroupHeaderRow = ({ label, months }) => (
    <tr className="bg-slate-50">
      <td
        className={cn(
          "sticky left-0 z-[1] border border-border bg-slate-50 px-3 py-[6px] text-[12px] font-semibold text-text-primary whitespace-nowrap",
          TABLE_LABEL_COL_WIDTH,
        )}
      >
        {label}
      </td>
      {months.map((month) => (
        <td key={month} className={cn("border border-border bg-slate-50", TABLE_VALUE_COL_WIDTH)} />
      ))}
      <td className={cn("border border-border bg-slate-50", TABLE_VALUE_COL_WIDTH)} />
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

  // Resolve the "Per Balance Sheet" book balance for a bank. Preference order:
  //   1. Key Reports MONTHLY Balance Sheet — a true per-month book balance.
  //   2. The single point-in-time /bs-bank-balances snapshot — fills only its
  //      year-end month (the manual / QMS fallback, and the year-end column when
  //      the monthly BS doesn't cover it).
  // Returns { forMonth(monthKey), ttm(ttmRows) } so the on-screen table and the
  // Excel / PDF exports all compute the row identically.
  const makePerBalanceSheetResolver = (bankName) => {
    const monthlyAmounts =
      matchBsBank(bankName, bsMonthlyBalances?.bankAccounts)?.monthAmounts || null;
    const pointMatch = matchBsBank(bankName, bsBankBalances?.bankAccounts);
    const pointBalance = pointMatch != null ? pointMatch.amount : null;
    const yearEndKey = bsBankBalances?.year != null ? `${bsBankBalances.year}-12` : null;
    return {
      forMonth: (monthKey) => {
        if (monthlyAmounts && monthlyAmounts[monthKey] != null) return monthlyAmounts[monthKey];
        return pointBalance != null && monthKey === yearEndKey ? pointBalance : null;
      },
      // TTM "Per Balance Sheet" is a point-in-time figure — never a sum. Use the
      // most recent month in the TTM window that has a book balance (monthly BS),
      // else the single year-end snapshot.
      ttm: (ttmRows) =>
        monthlyAmounts
          ? ([...ttmRows].reverse().find((r) => r.perBalanceSheet != null)?.perBalanceSheet ?? null)
          : pointBalance,
    };
  };

  const renderManualBalanceAccountTable = (bank, label) => {
    const pdfMonths = filteredPdfMonths;
    const monthMap = bank
      ? Object.fromEntries((bank.months || []).map((m) => [m.monthKey, m]))
      : {};
    const bankLabel = label || bank?.bankName || "Bank Account";
    const colCount = pdfMonths.length + 2;

    // BS bank balance for this specific bank — per-month (Key Reports monthly BS)
    // with a point-in-time year-end fallback. See makePerBalanceSheetResolver.
    const perBS = makePerBalanceSheetResolver(bank?.bankName);

    // Diagnostics — report both sources so a "no match" is never ambiguous.
    if (bank?.bankName) {
      const monthlyMatch = matchBsBank(bank.bankName, bsMonthlyBalances?.bankAccounts);
      const pointMatch = matchBsBank(bank.bankName, bsBankBalances?.bankAccounts);
      if (monthlyMatch || pointMatch) {
        console.log(`[BsMatch] ${JSON.stringify({
          selectedBank: bank.bankName,
          monthlyBalanceSheet: monthlyMatch
            ? { matchedAccount: monthlyMatch.name, months: Object.keys(monthlyMatch.monthAmounts || {}).length }
            : null,
          pointInTime: pointMatch
            ? {
                detectedYear: bsBankBalances?.year,
                balanceSheetSource: bsBankBalances?.source,
                matchedBalanceSheetFile: bsBankBalances?.fileName,
                matchedAccount: pointMatch.name,
                extractedAmount: pointMatch.amount,
              }
            : null,
        })}`);
      } else {
        console.warn(
          `[BsMatch] No matching bank account found in Balance Sheet for "${bank.bankName}".`,
          `Monthly BS: ${bsMonthlyBalances?.bankAccounts?.map((b) => b.name).join(", ") || "none"}.`,
          `Point-in-time: ${bsBankBalances?.bankAccounts?.map((b) => b.name).join(", ") || "none"}.`,
        );
      }
    }

    // Build rows with all fields, compute derived values
    const baseRows = pdfMonths.map((monthKey) => {
      const m = monthMap[monthKey];
      const perBalanceSheet = perBS.forMonth(monthKey);
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

    // TTM "Per Balance Sheet" is point-in-time (the most recent month's book
    // balance), never summed across months. See makePerBalanceSheetResolver.
    const ttm = { ...ttmBase };
    const ttmPerBS = perBS.ttm(ttmSlice);
    if (ttmPerBS != null) {
      ttm.perBalanceSheet = ttmPerBS;
      ttm.variance = ttm.endingBalance - ttmPerBS;
      ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
      ttm.unreconciledPct =
        ttmPerBS !== 0 ? (ttm.unreconciledDollar / ttmPerBS) * 100 : null;
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

    // Pre-compute addback totals per month from multi-item addback rows
    const depAddbackMap = {};
    const wdrAddbackMap = {};
    addbackItems.forEach((item) => {
      const map = item.section === "deposits" ? depAddbackMap : wdrAddbackMap;
      Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => {
        map[m] = (map[m] || 0) + Number(amt);
      });
    });

    // Deposits — adjusted Unreconciled Variance.
    // Only Addbacks (under P&L Account Adjustments) feed the variance now — the
    // other auto-computed rows (Change in AR, Change in Current Assets, Fixed
    // Asset Disposals, etc.) are no longer shown under Changes in Assets /
    // Changes in Liabilities / Other Adjustments, so they no longer count here.
    const depositsUnrecAdj = rows.map((r) =>
      r.depositsDollarVar + (depAddbackMap[r.month] ?? 0),
    );
    const depositsUnrecPctAdj = rows.map((r, i) =>
      r.salesPerFinancials !== 0 ? (depositsUnrecAdj[i] / r.salesPerFinancials) * 100 : 0,
    );
    const ttmDepositsUnrecAdj = months.slice(-12).reduce(
      (sum, m) => sum + (depAddbackMap[m] ?? 0),
      ttm.depositsDollarVar,
    );
    const ttmDepositsUnrecPctAdj =
      ttm.salesPerFinancials !== 0 ? (ttmDepositsUnrecAdj / ttm.salesPerFinancials) * 100 : 0;

    // Withdrawals — adjusted Unreconciled Variance (Addbacks only, see note above).
    const withdrawsUnrecAdj = rows.map((r) =>
      r.withdrawsDollarVar + (wdrAddbackMap[r.month] ?? 0),
    );
    const withdrawsUnrecPctAdj = rows.map((r, i) =>
      r.expensesPerFinancials !== 0 ? (withdrawsUnrecAdj[i] / r.expensesPerFinancials) * 100 : 0,
    );
    const ttmWithdrawsUnrecAdj = months.slice(-12).reduce(
      (sum, m) => sum + (wdrAddbackMap[m] ?? 0),
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

        <GroupHeaderRow label="Changes in Assets" months={months} />

        <GroupHeaderRow label="Changes in Liabilities" months={months} />

        <GroupHeaderRow label="P&L Account Adjustments" months={months} />
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

        <GroupHeaderRow label="Other Adjustments" months={months} />

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

        <GroupHeaderRow label="Changes in Assets" months={months} />

        <GroupHeaderRow label="Changes in Liabilities" months={months} />

        <GroupHeaderRow label="P&L Account Adjustments" months={months} />
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

        <GroupHeaderRow label="Other Adjustments" months={months} />

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
      // Auto-computed adjustment values for this month, derived from the financial
      // statements (signed cash effects). Carried on the row for reference; not
      // currently rendered or summed into the Unreconciled Variance.
      const adj = activityReview?.[mk] || {};
      return {
        month: mk,
        totalDeposits, intercompanyTransfers: 0, externalDeposits,
        salesPerFinancials, depositsDollarVar, depositsPctVar,
        changeInAR: adj.changeInAR ?? 0,
        changeInARRetentions: adj.changeInARRetentions ?? 0,
        changeInCurrentAssets: adj.changeInCurrentAssets ?? 0,
        fixedAssetDisposals: adj.fixedAssetDisposals ?? 0,
        depositsOther: 0, depositsUnreconciledDollar, depositsUnreconciledPct,
        totalWithdrawals, withdrawIntercompanyTransfers: 0, externalWithdraws,
        expensesPerFinancials, withdrawsDollarVar, withdrawsPctVar,
        ownerWithdraws: 0,
        changeInCurrentLiabilities: adj.changeInCurrentLiabilities ?? 0,
        changeInLTLiabilities: adj.changeInLTLiabilities ?? 0,
        depreciationExpense: adj.depreciationExpense ?? 0,
        amortizationExpense: adj.amortizationExpense ?? 0,
        badDebtExpense: adj.badDebtExpense ?? 0,
        fixedAssetPurchases: adj.fixedAssetPurchases ?? 0,
        withdrawsOther: 0,
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
      changeInAR: 0, changeInARRetentions: 0, changeInCurrentAssets: 0, fixedAssetDisposals: 0, depositsOther: 0,
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

  // ── Bank Reconciliation Excel export (data-driven) ───────────────────────────
  const exportBankReconToExcel = () => {
    const isManual = isManualUpload || isManualGl || isQBManual;
    const months = isManual ? filteredPdfMonths : reportMonths;
    if (!months.length) { alert("No data to export."); return; }

    const colHeaders = ["", ...months.map(monthLabel), "TTM"];
    const wb = XLSX.utils.book_new();

    const fmtN = (val) => (val == null ? "" : Number(val) || 0);

    // Helper: build sheet rows for one bank balance table
    const bankRows = (bankName, rows, ttm) => {
      const vals = (f) => [...rows.map((r) => fmtN(r[f])), fmtN(ttm[f])];
      return [
        [bankName],
        colHeaders,
        ["Starting Balance", ...vals("startingBalance")],
        ["Deposits", ...vals("deposits")],
        ["Withdrawals", ...vals("withdrawals")],
        ["Ending Balance", ...vals("endingBalance")],
        [],
        ["Footing Check", ...vals("footingCheck")],
        ["Prior Month Check", ...vals("priorMonthCheck")],
        [],
        ["Per Balance Sheet", ...vals("perBalanceSheet")],
        ["Variance", ...vals("variance")],
        [],
        ["Outstanding Checks", ...vals("outstandingChecks")],
        ["Unreconciled $ Variance", ...vals("unreconciledDollar")],
        ["Unreconciled % Variance", ...vals("unreconciledPct")],
        [],
      ];
    };

    const allRows = [];

    if (isManual) {
      (extractedBankPdfData?.banks || []).forEach((bank) => {
        const monthMap = Object.fromEntries((bank.months || []).map((m) => [m.monthKey, m]));
        const perBS = makePerBalanceSheetResolver(bank.bankName);
        const baseRows = months.map((mk) => {
          const m = monthMap[mk];
          return { month: mk, startingBalance: m?.startingBalance ?? 0, deposits: m?.deposits ?? 0, withdrawals: m?.withdrawals ?? 0, endingBalance: m?.endingBalance ?? 0, perBalanceSheet: perBS.forMonth(mk) };
        });
        const rows = baseRows.map((r, i) => {
          const variance = r.perBalanceSheet != null ? r.endingBalance - r.perBalanceSheet : null;
          const unreconciledDollar = variance != null ? variance - 0 : null;
          const unreconciledPct = variance != null && r.perBalanceSheet !== 0 ? (unreconciledDollar / r.perBalanceSheet) * 100 : null;
          return {
            ...r,
            footingCheck: r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals),
            priorMonthCheck: i === 0 ? 0 : baseRows[i - 1].endingBalance - r.startingBalance,
            variance, outstandingChecks: 0, unreconciledDollar, unreconciledPct,
          };
        });
        const ttmSlice = rows.slice(-12);
        const ttm = ttmSlice.reduce((acc, r, i) => ({
          startingBalance: i === 0 ? r.startingBalance : acc.startingBalance,
          deposits: acc.deposits + r.deposits, withdrawals: acc.withdrawals + r.withdrawals, endingBalance: r.endingBalance,
          footingCheck: acc.footingCheck + r.footingCheck, priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
          perBalanceSheet: null, variance: null, outstandingChecks: 0, unreconciledDollar: null, unreconciledPct: null,
        }), { startingBalance: 0, deposits: 0, withdrawals: 0, endingBalance: 0, footingCheck: 0, priorMonthCheck: 0,
              perBalanceSheet: null, variance: null, outstandingChecks: 0, unreconciledDollar: null, unreconciledPct: null });
        const ttmPerBS = perBS.ttm(ttmSlice);
        if (ttmPerBS != null) {
          ttm.perBalanceSheet = ttmPerBS;
          ttm.variance = ttm.endingBalance - ttmPerBS;
          ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
          ttm.unreconciledPct = ttmPerBS !== 0 ? (ttm.unreconciledDollar / ttmPerBS) * 100 : null;
        }
        allRows.push(...bankRows(bank.bankName || "Bank Account", rows, ttm));
      });
    } else {
      for (const account of (qbBankActivity?.accounts || [])) {
        const { rows, ttm } = buildAccountBalanceDataFromQB(account);
        allRows.push(...bankRows(account.accountName, rows, ttm));
      }
    }

    // Activity Review
    const actRows = isManual ? manualActivityRows : activityRows;
    const actTTM = isManual ? manualActivityTTM : activityTTM;
    if (actRows.length) {
      // Only Addbacks (under P&L Account Adjustments) feed the variance — see
      // the matching note in renderActivityTableCore.
      const depMap = {}, wdrMap = {};
      addbackItems.forEach((item) => {
        const map = item.section === "deposits" ? depMap : wdrMap;
        Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => { map[m] = (map[m] || 0) + Number(amt); });
      });
      const depUnrec = actRows.map((r) => r.depositsDollarVar + (depMap[r.month] ?? 0));
      const ttmDepUnrec = months.slice(-12).reduce((s, m) => s + (depMap[m] ?? 0), actTTM.depositsDollarVar ?? 0);
      const wdrUnrec = actRows.map((r) => r.withdrawsDollarVar + (wdrMap[r.month] ?? 0));
      const ttmWdrUnrec = months.slice(-12).reduce((s, m) => s + (wdrMap[m] ?? 0), actTTM.withdrawsDollarVar ?? 0);
      const adjDepURaw = [...depUnrec, ttmDepUnrec];
      const adjWdrURaw = [...wdrUnrec, ttmWdrUnrec];
      const av = (f) => [...actRows.map((r) => fmtN(r[f])), fmtN(actTTM[f])];

      allRows.push(
        ["Activity Review"], colHeaders,
        ["Total Deposits", ...av("totalDeposits")],
        ["  Intercompany Transfers", ...av("withdrawIntercompanyTransfers")],
        ["External Deposits", ...av("externalDeposits")],
        ["Sales per Financials", ...av("salesPerFinancials")],
        ["$ Variance", ...adjDepURaw.map((v) => fmtN(v))],
        [],
        ["Changes in Assets"],
        ["Changes in Liabilities"],
        ["P&L Account Adjustments"],
        ...addbackItems.filter((i) => i.section === "deposits").map((item) => [
          `  ${item.name}`,
          ...actRows.map((r) => fmtN(item.monthAmounts[r.month])),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0),
        ]),
        ["Other Adjustments"],
        ["Unreconciled Variance $", ...adjDepURaw.map((v) => fmtN(v))],
        [],
        ["Total Withdrawals", ...av("totalWithdrawals")],
        ["  Intercompany Transfers", ...av("intercompanyTransfers")],
        ["External Withdrawals", ...av("externalWithdraws")],
        ["Expenses per Financials", ...av("expensesPerFinancials")],
        ["$ Variance", ...adjWdrURaw.map((v) => fmtN(v))],
        [],
        ["Changes in Assets"],
        ["Changes in Liabilities"],
        ["P&L Account Adjustments"],
        ...addbackItems.filter((i) => i.section === "withdrawals").map((item) => [
          `  ${item.name}`,
          ...actRows.map((r) => fmtN(item.monthAmounts[r.month])),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0),
        ]),
        ["Other Adjustments"],
        ["Unreconciled Variance $", ...adjWdrURaw.map((v) => fmtN(v))],
      );
    }

    const ws = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, ws, "Bank Reconciliation");
    XLSX.writeFile(wb, "Bank Reconciliation.xlsx");
  };

  // ── Bank Reconciliation PDF export (data-driven, uses jsPDF directly) ──────
  const exportBankReconToPdf = () => {
    const isManual = isManualUpload || isManualGl || isQBManual;
    const months = isManual ? filteredPdfMonths : reportMonths;
    if (!months.length) { alert("No data to export."); return; }

    const nValCols = months.length + 1;
    const isCompact = nValCols >= 9;
    const usePortrait = nValCols <= 3;
    const PW = usePortrait ? 595.28 : 841.89;
    const PH = usePortrait ? 841.89 : 595.28;
    const ML = isCompact ? 22 : 28, MR = isCompact ? 22 : 28;
    const MT = 45, MB = 38;
    const CW = PW - ML - MR;
    const ROW_H = isCompact ? 14 : 16;
    const DATA_FONT = isCompact ? 7.5 : 8.5;
    const HDR_FONT = isCompact ? 7 : 8;
    const MIN_NAME_W = 140;
    const VAL_W = Math.max(42, (CW - MIN_NAME_W) / nValCols);
    const NAME_W = Math.max(MIN_NAME_W, CW - nValCols * VAL_W);
    const CELL_PAD = 3;

    const doc = new jsPDF({ orientation: usePortrait ? "portrait" : "landscape", unit: "pt", format: "a4" });
    const valColRight = (i) => PW - MR - (nValCols - 1 - i) * VAL_W;
    const nameSepX = ML + NAME_W;

    const fmt = (val) => {
      if (val == null || val === 0) return "-";
      const n = typeof val === "number" ? val : Number(val);
      if (isNaN(n) || n === 0) return "-";
      const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return n < 0 ? `(${abs})` : abs;
    };
    const fmtVar = (val) => {
      if (val == null) return { text: "-", neg: false };
      const n = Number(val);
      if (isNaN(n) || n === 0) return { text: "-", neg: false };
      const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return { text: n < 0 ? `-${abs}` : `+${abs}`, neg: n < 0 };
    };
    const fmtPct = (val) => {
      if (val == null) return { text: "-", neg: false };
      const n = Number(val);
      if (isNaN(n) || n === 0) return { text: "-", neg: false };
      const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return { text: n < 0 ? `-${abs}%` : `+${abs}%`, neg: n < 0 };
    };
    const drawVertLines = (top, bottom) => {
      doc.setDrawColor(210, 210, 210); doc.setLineWidth(0.4);
      doc.line(nameSepX, top, nameSepX, bottom);
      for (let i = 0; i < nValCols - 1; i++) doc.line(valColRight(i), top, valColRight(i), bottom);
    };
    let y = MT;
    const checkPageBreak = () => { if (y + ROW_H > PH - MB) { doc.addPage(); y = MT; } };
    const drawSectionTitle = (title) => {
      checkPageBreak(); y += 8;
      doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 80, 30);
      doc.text(title, ML, y); y += 12;
      doc.setDrawColor(190, 190, 190); doc.setLineWidth(0.5); doc.line(ML, y, PW - MR, y); y += 6;
    };
    const drawTableHeader = (label, cols) => {
      checkPageBreak();
      const top = y, bottom = y + ROW_H + 4;
      doc.setFillColor(237, 239, 242); doc.rect(ML, top, CW, bottom - top, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(HDR_FONT); doc.setTextColor(60, 60, 60);
      doc.text(label, ML + 4, bottom - 4);
      cols.forEach((col, i) => doc.text(col, valColRight(i) - CELL_PAD, bottom - 4, { align: "right" }));
      y = bottom;
      doc.setDrawColor(30, 30, 30); doc.setLineWidth(0.8); doc.line(ML, y, PW - MR, y);
      drawVertLines(top, y); y += 3;
    };
    const drawRow = (label, values, opts = {}) => {
      checkPageBreak();
      const { bold = false, indent = 0, rowType = "normal" } = opts;
      const top = y, bottom = y + ROW_H;
      if (bold) { doc.setFillColor(232, 234, 237); doc.rect(ML, top, CW, bottom - top, "F"); }
      doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(DATA_FONT); doc.setTextColor(bold ? 15 : 45);
      const lbl = doc.splitTextToSize(String(label), NAME_W - indent * 12 - 8)[0] ?? label;
      doc.text(lbl, ML + indent * 12 + 4, bottom - 4);
      values.forEach((val, i) => {
        let text, neg = false;
        if (rowType === "variance-amt") { const r = fmtVar(val); text = r.text; neg = r.neg; }
        else if (rowType === "variance-pct") { const r = fmtPct(val); text = r.text; neg = r.neg; }
        else { text = fmt(val); neg = typeof val === "number" && val < 0; }
        if (!text || text === "") return;
        doc.setTextColor(neg ? 180 : (bold ? 15 : 45), neg ? 30 : (bold ? 15 : 45), neg ? 30 : (bold ? 15 : 45));
        doc.text(text, valColRight(i) - CELL_PAD, bottom - 4, { align: "right" });
      });
      doc.setDrawColor(218, 220, 224); doc.setLineWidth(0.3); doc.line(ML, bottom, PW - MR, bottom);
      drawVertLines(top, bottom); y += ROW_H;
    };
    const spacer = () => { y += 4; };

    // Title
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(10, 10, 10);
    doc.text("Bank Reconciliation", PW / 2, y, { align: "center" }); y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60, 60, 60);
    doc.text(`${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}`, PW / 2, y, { align: "center" }); y += 12;
    doc.setDrawColor(190, 190, 190); doc.setLineWidth(0.5); doc.line(ML, y, PW - MR, y); y += 12;

    const colHeaders = [...months.map(monthLabel), "TTM"];

    // Bank balance tables — always export ALL banks, ignoring the dropdown filter
    const drawManualBank = (bank) => {
      if (!bank) return;
      drawSectionTitle(bank.bankName || "Bank Account");
      const monthMap = Object.fromEntries((bank.months || []).map((m) => [m.monthKey, m]));
      const perBS = makePerBalanceSheetResolver(bank.bankName);
      const baseRows = months.map((mk) => {
        const m = monthMap[mk];
        return { month: mk, startingBalance: m?.startingBalance ?? 0, deposits: m?.deposits ?? 0, withdrawals: m?.withdrawals ?? 0, endingBalance: m?.endingBalance ?? 0, perBalanceSheet: perBS.forMonth(mk) };
      });
      const rows = baseRows.map((r, i) => {
        const variance = r.perBalanceSheet != null ? r.endingBalance - r.perBalanceSheet : null;
        const unreconciledDollar = variance != null ? variance - 0 : null;
        const unreconciledPct = variance != null && r.perBalanceSheet !== 0 ? (unreconciledDollar / r.perBalanceSheet) * 100 : null;
        return {
          ...r, intercompanyDeposits: 0, intercompanyWithdraws: 0,
          footingCheck: r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals),
          priorMonthCheck: i === 0 ? 0 : baseRows[i - 1].endingBalance - r.startingBalance,
          variance, outstandingChecks: 0, unreconciledDollar, unreconciledPct,
        };
      });
      const ttmSlice = rows.slice(-12);
      const ttm = ttmSlice.reduce((acc, r, i) => ({
        startingBalance: i === 0 ? r.startingBalance : acc.startingBalance,
        deposits: acc.deposits + r.deposits, withdrawals: acc.withdrawals + r.withdrawals, endingBalance: r.endingBalance,
        intercompanyDeposits: 0, intercompanyWithdraws: 0,
        footingCheck: acc.footingCheck + r.footingCheck, priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
        perBalanceSheet: null, variance: null, outstandingChecks: 0, unreconciledDollar: null, unreconciledPct: null,
      }), { startingBalance: 0, deposits: 0, withdrawals: 0, endingBalance: 0, intercompanyDeposits: 0, intercompanyWithdraws: 0,
            footingCheck: 0, priorMonthCheck: 0, perBalanceSheet: null, variance: null, outstandingChecks: 0, unreconciledDollar: null, unreconciledPct: null });
      const ttmPerBS = perBS.ttm(ttmSlice);
      if (ttmPerBS != null) {
        ttm.perBalanceSheet = ttmPerBS;
        ttm.variance = ttm.endingBalance - ttmPerBS;
        ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
        ttm.unreconciledPct = ttmPerBS !== 0 ? (ttm.unreconciledDollar / ttmPerBS) * 100 : null;
      }
      const vals = (f) => [...rows.map((r) => r[f]), ttm[f]];
      drawTableHeader(bank.bankName, colHeaders);
      drawRow("Starting Balance", vals("startingBalance"), { bold: true });
      drawRow("Deposits", vals("deposits")); drawRow("Withdrawals", vals("withdrawals"));
      drawRow("Ending Balance", vals("endingBalance"), { bold: true }); spacer();
      drawRow("Footing Check", vals("footingCheck")); drawRow("Prior Month Check", vals("priorMonthCheck")); spacer();
      drawRow("Per Balance Sheet", vals("perBalanceSheet"), { bold: true });
      drawRow("Variance", vals("variance"), { rowType: "variance-amt" }); spacer();
      drawRow("Unreconciled $ Variance", vals("unreconciledDollar"), { rowType: "variance-amt" });
      drawRow("Unreconciled % Variance", vals("unreconciledPct"), { rowType: "variance-pct" });
    };

    if (isManual) {
      (extractedBankPdfData?.banks || []).forEach(drawManualBank);
    } else {
      for (const account of (qbBankActivity?.accounts || [])) {
        drawSectionTitle(account.accountName);
        const { rows, ttm } = buildAccountBalanceDataFromQB(account);
        const vals = (f) => [...rows.map((r) => r[f]), ttm[f]];
        drawTableHeader(account.accountName, colHeaders);
        drawRow("Starting Balance", vals("startingBalance"), { bold: true });
        drawRow("Deposits", vals("deposits")); drawRow("Withdrawals", vals("withdrawals"));
        drawRow("Ending Balance", vals("endingBalance"), { bold: true }); spacer();
        drawRow("Intercompany Deposits", vals("intercompanyDeposits"), { indent: 1 });
        drawRow("Intercompany Withdrawals", vals("intercompanyWithdraws"), { indent: 1 }); spacer();
        drawRow("Footing Check", vals("footingCheck")); drawRow("Prior Month Check", vals("priorMonthCheck")); spacer();
        drawRow("Per Balance Sheet", vals("perBalanceSheet"), { bold: true });
        drawRow("Variance", vals("variance"), { rowType: "variance-amt" }); spacer();
        drawRow("Outstanding Checks", vals("outstandingChecks"));
        drawRow("Unreconciled $ Variance", vals("unreconciledDollar"), { rowType: "variance-amt" });
        drawRow("Unreconciled % Variance", vals("unreconciledPct"), { rowType: "variance-pct" });
      }
    }

    // Activity Review
    const actRows = isManual ? manualActivityRows : activityRows;
    const actTTM = isManual ? manualActivityTTM : activityTTM;
    if (actRows.length) {
      drawSectionTitle("Activity Review");
      // Only Addbacks (under P&L Account Adjustments) feed the variance — see
      // the matching note in renderActivityTableCore.
      const depMap = {}, wdrMap = {};
      addbackItems.forEach((item) => {
        const map = item.section === "deposits" ? depMap : wdrMap;
        Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => { map[m] = (map[m] || 0) + Number(amt); });
      });
      const depUnrec = actRows.map((r) => r.depositsDollarVar + (depMap[r.month] ?? 0));
      const ttmDepUnrec = months.slice(-12).reduce((s, m) => s + (depMap[m] ?? 0), actTTM.depositsDollarVar ?? 0);
      const wdrUnrec = actRows.map((r) => r.withdrawsDollarVar + (wdrMap[r.month] ?? 0));
      const ttmWdrUnrec = months.slice(-12).reduce((s, m) => s + (wdrMap[m] ?? 0), actTTM.withdrawsDollarVar ?? 0);
      const adjDepURaw = [...depUnrec, ttmDepUnrec];
      const adjWdrURaw = [...wdrUnrec, ttmWdrUnrec];
      const av = (f) => [...actRows.map((r) => r[f] ?? null), actTTM[f] ?? null];
      drawTableHeader("Activity Review", colHeaders);
      drawRow("Total Deposits", av("totalDeposits"), { bold: true });
      drawRow("Intercompany Transfers", av("withdrawIntercompanyTransfers"), { indent: 1 });
      drawRow("External Deposits", av("externalDeposits"), { bold: true });
      drawRow("Sales per Financials", av("salesPerFinancials"));
      drawRow("$ Variance", av("depositsDollarVar"), { rowType: "variance-amt" });
      drawRow("% Variance", av("depositsPctVar"), { rowType: "variance-pct" }); spacer();
      drawRow("Changes in Assets", [], { bold: true });
      drawRow("Changes in Liabilities", [], { bold: true });
      drawRow("P&L Account Adjustments", [], { bold: true });
      addbackItems.filter((i) => i.section === "deposits").forEach((item) => {
        drawRow(item.name, [...actRows.map((r) => item.monthAmounts[r.month] ?? null),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0)], { indent: 1 });
      });
      drawRow("Other Adjustments", [], { bold: true });
      drawRow("Unreconciled Variance $", adjDepURaw, { rowType: "variance-amt" }); spacer();
      drawRow("Total Withdrawals", av("totalWithdrawals"), { bold: true });
      drawRow("Intercompany Transfers", av("intercompanyTransfers"), { indent: 1 });
      drawRow("External Withdrawals", av("externalWithdraws"), { bold: true });
      drawRow("Expenses per Financials", av("expensesPerFinancials"));
      drawRow("$ Variance", av("withdrawsDollarVar"), { rowType: "variance-amt" });
      drawRow("% Variance", av("withdrawsPctVar"), { rowType: "variance-pct" }); spacer();
      drawRow("Changes in Assets", [], { bold: true });
      drawRow("Changes in Liabilities", [], { bold: true });
      drawRow("P&L Account Adjustments", [], { bold: true });
      addbackItems.filter((i) => i.section === "withdrawals").forEach((item) => {
        drawRow(item.name, [...actRows.map((r) => item.monthAmounts[r.month] ?? null),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0)], { indent: 1 });
      });
      drawRow("Other Adjustments", [], { bold: true });
      drawRow("Unreconciled Variance $", adjWdrURaw, { rowType: "variance-amt" });
    }

    // Footer
    const totalPages = doc.getNumberOfPages();
    const nowStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(150, 150, 150);
      doc.text(nowStr, ML, PH - 16); doc.text(`${p} / ${totalPages}`, PW - MR, PH - 16, { align: "right" });
    }
    doc.save("Bank Reconciliation.pdf");
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Header title="Reconciliation" />
      <div className="page-content">
        <QBDisconnectedBanner pageName="Reconciliation" />

        {kr.krActive && !kr.availability.bank && (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <span>
              Bank Reconciliation needs a <strong>Bank Statement</strong> linked in the selected Key Reports Version.
            </span>
          </div>
        )}
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

        {/* Bank Account Balances + Activity Review — wrapped for export */}
        <div id="bank-recon-table" className="flex flex-col gap-6">
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
                    // Explicit Refresh forces a full replace (can clear stale data),
                    // unlike background auto-loads which preserve on-screen data.
                    if (isQBManual) void loadQMSBankData();
                    else if (isManualUpload) void loadManualBankData({ force: true });
                    else void loadExtractedBankPdfData({ datasetVersion: kr.resolvedDatasetVersion, force: true });
                  }}
                  title="Reload data from the active source"
                >
                  {isLoadingExtractedBankPdfData
                    ? <LoaderCircle size={14} className="animate-spin" />
                    : <RefreshCw size={14} />}
                  Refresh
                </button>
              )}
              {/* Key Reports Version selector — only when Key Reports is the active source */}
              {krSelected && <KeyReportVersionSelector clientId={clientId} variant="filter" />}
              {/* Bank Account dropdown — temporarily hidden in Key Reports mode:
                  all banks are stacked below one another instead of filtering to one. */}
              {!krSelected && (
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
              )}
              {/* Export dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBankReconExportOpen((v) => !v)}
                  disabled={bankReconIsExporting}
                  className="btn-outline flex h-10 items-center gap-1.5 px-3 text-[13px]"
                >
                  <Download size={14} className={bankReconIsExporting ? "animate-pulse" : ""} />
                  {bankReconIsExporting ? "Exporting…" : "Export"}
                  <ChevronDown size={12} />
                </button>
                {bankReconExportOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setBankReconExportOpen(false)} />
                    <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-border bg-bg-card shadow-lg">
                      <button
                        type="button"
                        onClick={() => handleBankReconExport("excel")}
                        className="block w-full px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page"
                      >
                        Export to Excel (.xlsx)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBankReconExport("pdf")}
                        className="block w-full px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page"
                      >
                        Export to PDF (.pdf)
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>{/* end flex items-end gap-3 */}
          </div>

          <div>
          {(isManualUpload || isManualGl || isQBManual) ? (
            extractedBankPdfData ? (
              // Key Reports mode: dropdown is hidden, so render every bank stacked
              // below one another instead of only the selected one.
              krSelected ? (
                (extractedBankPdfData.banks || []).map((bank, i) => (
                  <div key={bank?.bankName || i}>
                    {renderManualBalanceAccountTable(bank)}
                  </div>
                ))
              ) : (
                renderManualBalanceAccountTable(
                  extractedBankPdfData.banks.find((b) => b.bankName === selectedManualBankName) ||
                  extractedBankPdfData.banks[0],
                )
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
          </div>
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
        </div>{/* end bank-recon-table export wrapper */}
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
          keyReportVersionId={addbackVersionId}
          onAdd={(name, source, monthAmounts) =>
            createAddbackItem(addbackPickerState.section, name, source, monthAmounts)
          }
          onClose={() => setAddbackPickerState(null)}
        />
      )}
    </>
  );
}