import { Fragment, jsx, jsxs } from "react/jsx-runtime";
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
  maskKeyReportContext
} from "../../../store/useKeyReportContextStore";
import { useShallow } from "zustand/react/shallow";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";
import { emitWorkspaceDataSourceUpdated } from "../../../lib/dataSourceEvents";
import { cn, formatNumber, formatCurrency } from "../../../lib/utils";
import {
  REPORT_SOURCE_KEYS,
  REPORT_SOURCE_OPTIONS,
  normalizeReportSourceKey,
  getReportSourceLabel
} from "../../../lib/report-source";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
  Download
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
  { value: "12", label: "December" }
];
const YEARS = Array.from({ length: 10 }, (_, i) => 2020 + i);
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
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
const _bsNormName = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
const _bsLastFour = (name) => {
  const m = String(name || "").match(/\b(\d{4})\b/);
  return m ? m[1] : "";
};
function matchBsBank(queryName, bankAccounts) {
  if (!bankAccounts?.length || !queryName) return null;
  const qFour = _bsLastFour(queryName);
  const qNorm = _bsNormName(queryName);
  if (qFour) {
    const byFour = bankAccounts.filter((b) => b.accountNumber === qFour);
    if (byFour.length === 1) return byFour[0];
    if (byFour.length > 1) {
      const nameHit = byFour.find(
        (b) => _bsNormName(b.name) === qNorm || qNorm.includes(_bsNormName(b.name)) || _bsNormName(b.name).includes(qNorm)
      );
      if (nameHit) return nameHit;
      const qW = qNorm.split(" ").filter((w) => w.length > 2);
      if (qW.length) {
        let best = 0, bestMatch = null;
        for (const b of byFour) {
          const bW = _bsNormName(b.name).split(" ").filter((w) => w.length > 2);
          const overlap = qW.filter((w) => bW.includes(w)).length;
          const score = overlap / Math.max(qW.length, bW.length, 1);
          if (score > best) {
            best = score;
            bestMatch = b;
          }
        }
        if (bestMatch && best > 0) return bestMatch;
      }
    }
  }
  const exact = bankAccounts.find((b) => _bsNormName(b.name) === qNorm);
  if (exact) return exact;
  const contains = bankAccounts.find(
    (b) => _bsNormName(b.name).includes(qNorm) || qNorm.includes(_bsNormName(b.name))
  );
  if (contains) return contains;
  const BS_STOP = /* @__PURE__ */ new Set([
    "bank",
    "banks",
    "banking",
    "financial",
    "corp",
    "inc",
    "llc",
    "ltd",
    "national",
    "savings",
    "credit",
    "union",
    "trust",
    "services",
    "group",
    "company"
  ]);
  const allW = (s) => s.split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const sigW = (s) => allW(s).filter((w) => !BS_STOP.has(w));
  const qAll = allW(qNorm);
  const qSig = sigW(qNorm);
  if (qAll.length) {
    if (qSig.length) {
      let best2 = 0, bestMatch2 = null;
      for (const b of bankAccounts) {
        const bSig = sigW(_bsNormName(b.name));
        const overlap = qSig.filter((w) => bSig.includes(w)).length;
        const score = overlap / Math.max(qSig.length, bSig.length, 1);
        if (score > best2) {
          best2 = score;
          bestMatch2 = b;
        }
      }
      if (bestMatch2 && best2 > 0) return bestMatch2;
    }
    let best = 0, bestMatch = null;
    for (const b of bankAccounts) {
      const bWords = allW(_bsNormName(b.name));
      const overlap = qAll.filter((w) => bWords.includes(w)).length;
      const score = overlap / Math.max(qAll.length, bWords.length, 1);
      if (score > best && score > 0.3) {
        best = score;
        bestMatch = b;
      }
    }
    if (bestMatch) return bestMatch;
  }
  return null;
}
const getErrMsg = (e) => e instanceof Error ? e.message : String(e);
const getWorkspaceStorageKey = (clientId) => `${RECONCILIATION_STORAGE_PREFIX}:${clientId || "default"}`;
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
const getReconDataKey = (clientId, source, version) => `${RECONCILIATION_STORAGE_PREFIX}-data:${clientId || "default"}:${source || "default"}:${version || "default"}`;
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
      JSON.stringify(data)
    );
  } catch {
  }
};
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
const computeBsBankBalancesByMonthFromFs = (resp) => {
  const monthly = resp?.reports?.balanceSheet?.monthly || [];
  const byId = /* @__PURE__ */ new Map();
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
            monthAmounts: {}
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
const _AR_RETENTION_RE = /retention|retainage|holdback|retain(?:ed|age)?\s+receivab/i;
const _ACCUM_DEP_RE = /accumulated\s+(?:depreciation|amortization|depletion)|accum\.?\s*(?:dep|amort)/i;
const _AMORT_RE = /amorti[sz]/i;
const _BAD_DEBT_RE = /bad\s*debt|doubtful|uncollectib|allowance\s+for\s+(?:doubtful|credit)|write.?off.*receivab/i;
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
const _SECTION_BY_REPORT_TAG = {
  cash: "exclude",
  accounts_receivable: "deposits"
};
const _DEFAULT_SECTION = "withdrawals";
const _sectionForLeaf = (l) => _SECTION_BY_REPORT_TAG[l?.reportTag] || _DEFAULT_SECTION;
const _CASH_EFFECT_SIGN = { assets: -1, liabilities: 1 };
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
  const fixedAssets = _bucketLeaves(st.assets?.fixedAssets);
  const currentLiab = _bucketLeaves(st.liabilities?.currentLiabilities);
  const longTermLiab = _bucketLeaves(st.liabilities?.longTermLiabilities);
  return {
    ar: _sumLeaves(currentAssets.filter(_isAccountsReceivable)),
    arRetention: _sumLeaves(currentAssets.filter(_isArRetention)),
    // TOTAL current assets (cash/bank + AR + inventory + prepaids + other) — drives
    // the informational "Change in Current Assets" row (raw BS movement).
    currentAssetsTotal: _sumLeaves(currentAssets),
    currentLiab: _sumLeaves(currentLiab),
    longTermLiab: _sumLeaves(longTermLiab),
    grossFixed: _sumLeaves(fixedAssets.filter((l) => !_isAccumulatedDepreciation(l)))
  };
};
const _acctKey = (l) => String(l?.systemId || l?.accountNumber || _leafName(l) || "").trim().toLowerCase();
const _acctLabel = (l) => {
  const name = _leafName(l).trim() || "Unnamed account";
  const num = l?.accountNumber ? String(l.accountNumber).trim() : "";
  return num && !name.startsWith(num) ? `${num} ${name}` : name;
};
const _addBalance = (map, leaf) => {
  const key = _acctKey(leaf);
  if (!key) return;
  const existing = map.get(key);
  if (existing) existing.amount += Number(leaf?.amount) || 0;
  else map.set(key, { key, label: _acctLabel(leaf), amount: Number(leaf?.amount) || 0 });
};
const _accountBalances = (entry) => {
  const st = entry?.statement || {};
  const out = {
    deposits: { assets: /* @__PURE__ */ new Map(), liabilities: /* @__PURE__ */ new Map(), ltAssets: /* @__PURE__ */ new Map(), ltLiabilities: /* @__PURE__ */ new Map() },
    withdrawals: { assets: /* @__PURE__ */ new Map(), liabilities: /* @__PURE__ */ new Map(), ltAssets: /* @__PURE__ */ new Map(), ltLiabilities: /* @__PURE__ */ new Map() }
  };
  const route = (leaves, side, category = "current") => {
    for (const leaf of leaves) {
      const section = _sectionForLeaf(leaf);
      if (section === "exclude") continue;
      const key = category === "ltAssets" ? "ltAssets" : category === "ltLiabilities" ? "ltLiabilities" : side;
      _addBalance(out[section][key], leaf);
    }
  };
  route(_bucketLeaves(st.assets?.currentAssets), "assets", "current");
  route(_bucketLeaves(st.liabilities?.currentLiabilities), "liabilities", "current");
  const ltAssetLeaves = [
    ..._bucketLeaves(st.assets?.fixedAssets).filter((l) => !_isAccumulatedDepreciation(l)),
    ..._bucketLeaves(st.assets?.otherAssets)
  ];
  route(ltAssetLeaves, "assets", "ltAssets");
  const ltLiabLeaves = _bucketLeaves(st.liabilities?.longTermLiabilities);
  route(ltLiabLeaves, "liabilities", "ltLiabilities");
  return out;
};
const _accountDeltas = (curMap, prevMap, sign) => {
  if (!prevMap) return [];
  const rows = [];
  for (const key of /* @__PURE__ */ new Set([...curMap.keys(), ...prevMap.keys()])) {
    const cur = curMap.get(key);
    const prior = prevMap.get(key);
    const amount = _round2(sign * ((Number(cur?.amount) || 0) - (Number(prior?.amount) || 0)));
    if (amount === 0) continue;
    rows.push({ key, label: cur?.label || prior?.label || key, amount });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
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
const computeActivityReviewFromFs = (resp) => {
  const bsMonthly = [...resp?.reports?.balanceSheet?.monthly || []].sort(
    (a, b) => Number(a.year) - Number(b.year) || Number(a.monthNumber) - Number(b.monthNumber)
  );
  const plByKey = {};
  for (const e of resp?.reports?.profitAndLoss?.monthly || []) {
    const k = _activityMonthKey(e);
    if (k) plByKey[k] = _plSnapshot(e);
  }
  const out = {};
  let prev = null;
  let prevAcc = null;
  for (const entry of bsMonthly) {
    const key = _activityMonthKey(entry);
    if (!key) continue;
    const cur = _bsSnapshot(entry);
    const curAcc = _accountBalances(entry);
    const dAR = prev ? cur.ar - prev.ar : 0;
    const dARRet = prev ? cur.arRetention - prev.arRetention : 0;
    const dCurrentAssets = prev ? cur.currentAssetsTotal - prev.currentAssetsTotal : 0;
    const dCurLiab = prev ? cur.currentLiab - prev.currentLiab : 0;
    const dLTLiab = prev ? cur.longTermLiab - prev.longTermLiab : 0;
    const dGross = prev ? cur.grossFixed - prev.grossFixed : 0;
    const pl = plByKey[key] || { depreciation: 0, amortization: 0, badDebt: 0 };
    out[key] = {
      changeInAR: _round2(-dAR),
      changeInARRetentions: _round2(-dARRet),
      changeInCurrentAssets: _round2(dCurrentAssets),
      fixedAssetDisposals: _round2(dGross < 0 ? -dGross : 0),
      changeInCurrentLiabilities: _round2(dCurLiab),
      changeInLTLiabilities: _round2(dLTLiab),
      depreciationExpense: _round2(pl.depreciation),
      amortizationExpense: _round2(pl.amortization),
      badDebtExpense: _round2(pl.badDebt),
      fixedAssetPurchases: _round2(dGross > 0 ? -dGross : 0),
      // Per-account "Changes in Assets" / "Changes in Liabilities" / "Long-Term Assets" / "Long-Term Liabilities" line items.
      depositsAssetChanges: _accountDeltas(curAcc.deposits.assets, prevAcc?.deposits?.assets, _CASH_EFFECT_SIGN.assets),
      depositsLiabilityChanges: _accountDeltas(curAcc.deposits.liabilities, prevAcc?.deposits?.liabilities, _CASH_EFFECT_SIGN.liabilities),
      depositsLongTermAssetChanges: _accountDeltas(curAcc.deposits.ltAssets, prevAcc?.deposits?.ltAssets, _CASH_EFFECT_SIGN.assets),
      depositsLongTermLiabilityChanges: _accountDeltas(curAcc.deposits.ltLiabilities, prevAcc?.deposits?.ltLiabilities, _CASH_EFFECT_SIGN.liabilities),
      withdrawalsAssetChanges: _accountDeltas(curAcc.withdrawals.assets, prevAcc?.withdrawals?.assets, _CASH_EFFECT_SIGN.assets),
      withdrawalsLiabilityChanges: _accountDeltas(curAcc.withdrawals.liabilities, prevAcc?.withdrawals?.liabilities, _CASH_EFFECT_SIGN.liabilities),
      withdrawalsLongTermAssetChanges: _accountDeltas(curAcc.withdrawals.ltAssets, prevAcc?.withdrawals?.ltAssets, _CASH_EFFECT_SIGN.assets),
      withdrawalsLongTermLiabilityChanges: _accountDeltas(curAcc.withdrawals.ltLiabilities, prevAcc?.withdrawals?.ltLiabilities, _CASH_EFFECT_SIGN.liabilities)
    };
    prev = cur;
    prevAcc = curAcc;
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
const VARIANCE_ZERO_EPSILON = 5e-3;
const VARIANCE_PCT_ZERO_EPSILON = 0.05;
const fmtVarianceAmt = (val) => {
  if (val == null) return { display: "-", colorClass: "text-text-muted" };
  if (Math.abs(val) < VARIANCE_ZERO_EPSILON)
    return { display: "0.00", colorClass: "text-text-primary" };
  const formatted = formatNumber(Math.abs(val), 2);
  if (val < 0)
    return { display: `-${formatted}`, colorClass: "text-red-600 font-medium" };
  return { display: `+${formatted}`, colorClass: "text-green-600 font-medium" };
};
const fmtVariancePct = (val) => {
  if (val == null) return { display: "-", colorClass: "text-text-muted" };
  if (Math.abs(val) < VARIANCE_PCT_ZERO_EPSILON)
    return { display: "0.0%", colorClass: "text-text-primary" };
  const formatted = formatNumber(val, 1);
  if (val < 0)
    return { display: `${formatted}%`, colorClass: "text-red-600 font-medium" };
  return { display: `+${formatted}%`, colorClass: "text-green-600 font-medium" };
};
const monthLabel = (ym) => {
  const [y, m] = ym.split("-");
  return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", {
    year: "2-digit",
    month: "short"
  });
};
function FreezeTable({ months, label, containerClass, children }) {
  const headScrollRef = useRef(null);
  const onBodyScroll = useCallback((e) => {
    if (headScrollRef.current) headScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
  }, []);
  const colGroup = /* @__PURE__ */ jsxs("colgroup", { children: [
    /* @__PURE__ */ jsx("col", { style: { width: 280, minWidth: 280 } }),
    months.map((m) => /* @__PURE__ */ jsx("col", { style: { width: 150, minWidth: 150 } }, m)),
    /* @__PURE__ */ jsx("col", { style: { width: 150, minWidth: 150 } })
  ] });
  return /* @__PURE__ */ jsxs("div", { className: containerClass, children: [
    /* @__PURE__ */ jsx("div", { className: "sticky top-0 z-20", children: /* @__PURE__ */ jsx("div", { ref: headScrollRef, className: "no-scrollbar overflow-x-auto", children: /* @__PURE__ */ jsxs("table", { className: "w-full table-fixed border-collapse text-[13px]", children: [
      colGroup,
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "bg-[#F8FBF1]", children: [
        /* @__PURE__ */ jsx("th", { className: "sticky left-0 z-30 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary", children: label }),
        months.map((m) => /* @__PURE__ */ jsx(
          "th",
          {
            className: cn(
              "whitespace-nowrap border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
              TABLE_VALUE_COL_WIDTH
            ),
            children: monthLabel(m)
          },
          m
        )),
        /* @__PURE__ */ jsx("th", { className: cn(
          "border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
          TABLE_VALUE_COL_WIDTH
        ), children: "TTM" })
      ] }) })
    ] }) }) }),
    /* @__PURE__ */ jsx("div", { className: "overflow-x-auto rounded-b-[var(--radius-card)]", onScroll: onBodyScroll, children: /* @__PURE__ */ jsxs("table", { className: "w-full table-fixed border-collapse bg-white text-[13px]", children: [
      colGroup,
      /* @__PURE__ */ jsx("tbody", { children })
    ] }) })
  ] });
}
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
    return /* @__PURE__ */ jsx(
      "input",
      {
        ref: inputRef,
        type: "text",
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        },
        className: "w-full bg-blue-50 border border-blue-400 rounded px-2 py-0 text-right text-[12px] tabular-nums outline-none focus:ring-1 focus:ring-blue-400"
      }
    );
  }
  return /* @__PURE__ */ jsx(
    "span",
    {
      onClick: startEdit,
      className: cn(
        "block w-full text-right text-[12px] tabular-nums rounded px-1 py-[3px] min-h-[20px]",
        "cursor-pointer hover:bg-blue-50/80 transition-colors select-none",
        value !== 0 ? "text-text-primary" : "text-text-muted"
      ),
      title: "Click to edit",
      children: value !== 0 ? formatNumber(value, 2) : "-"
    }
  );
}
function AddbackItemRow({ item, months, onSaveAmounts, onDelete }) {
  const getAmt = (month) => Number(item.monthAmounts?.[month] ?? 0);
  const ttmTotal = months.slice(-12).reduce((sum, m) => sum + getAmt(m), 0);
  const handleSave = (month, val) => {
    const updated = { ...item.monthAmounts || {}, [month]: val };
    if (val === 0) delete updated[month];
    onSaveAmounts(item.id, updated);
  };
  return /* @__PURE__ */ jsxs("tr", { className: "hover:bg-blue-50/20", children: [
    /* @__PURE__ */ jsx(
      "td",
      {
        className: cn(
          "sticky left-0 z-[1] border border-border px-3 py-[5px] text-[12px]",
          "text-text-primary whitespace-nowrap bg-white pl-10",
          TABLE_LABEL_COL_WIDTH
        ),
        children: /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-1 pr-1", children: [
          /* @__PURE__ */ jsx("span", { className: "truncate", children: item.name }),
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: () => {
                if (window.confirm(`Remove "${item.name}" from addbacks?`)) onDelete(item.id);
              },
              title: "Remove",
              className: "flex-shrink-0 text-text-muted hover:text-red-500 transition-colors text-[15px] leading-none font-medium",
              children: "\xD7"
            }
          )
        ] })
      }
    ),
    months.map((month) => /* @__PURE__ */ jsx("td", { className: cn("border border-border px-1 py-[2px]", TABLE_VALUE_COL_WIDTH), children: /* @__PURE__ */ jsx(EditableCell, { value: getAmt(month), onSave: (val) => handleSave(month, val) }) }, month)),
    /* @__PURE__ */ jsx(
      "td",
      {
        className: cn(
          "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
          TABLE_VALUE_COL_WIDTH,
          ttmTotal !== 0 ? "text-text-primary" : "text-text-muted"
        ),
        children: ttmTotal !== 0 ? formatNumber(ttmTotal, 2) : "-"
      }
    )
  ] });
}
function AddbacksRowGroup({ section, months, addbackItems, onSaveAmounts, onDelete, onOpenPicker }) {
  const sectionItems = addbackItems.filter((i) => i.section === section);
  const totalPerMonth = months.reduce((acc, month) => {
    acc[month] = sectionItems.reduce(
      (sum, item) => sum + Number(item.monthAmounts?.[month] ?? 0),
      0
    );
    return acc;
  }, {});
  const ttmTotal = months.slice(-12).reduce((sum, m) => sum + (totalPerMonth[m] ?? 0), 0);
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs("tr", { className: "bg-white hover:bg-blue-50/20", children: [
      /* @__PURE__ */ jsx(
        "td",
        {
          className: cn(
            "sticky left-0 z-[1] border border-border px-3 py-[5px] text-[12px]",
            "text-text-primary whitespace-nowrap bg-white pl-7 font-medium",
            TABLE_LABEL_COL_WIDTH
          ),
          children: /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
            /* @__PURE__ */ jsx("span", { children: "Addbacks" }),
            /* @__PURE__ */ jsx(
              "button",
              {
                onClick: onOpenPicker,
                title: "Add addback item",
                className: "flex items-center justify-center w-[18px] h-[18px] rounded-full bg-green-500 text-white hover:bg-green-600 transition-colors text-[13px] leading-none font-bold",
                children: "+"
              }
            )
          ] })
        }
      ),
      months.map((month) => /* @__PURE__ */ jsx(
        "td",
        {
          className: cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            TABLE_VALUE_COL_WIDTH,
            totalPerMonth[month] !== 0 ? "text-text-primary" : "text-text-muted"
          ),
          children: totalPerMonth[month] !== 0 ? formatNumber(totalPerMonth[month], 2) : "-"
        },
        month
      )),
      /* @__PURE__ */ jsx(
        "td",
        {
          className: cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            TABLE_VALUE_COL_WIDTH,
            ttmTotal !== 0 ? "text-text-primary" : "text-text-muted"
          ),
          children: ttmTotal !== 0 ? formatNumber(ttmTotal, 2) : "-"
        }
      )
    ] }),
    sectionItems.map((item) => /* @__PURE__ */ jsx(
      AddbackItemRow,
      {
        item,
        months,
        onSaveAmounts,
        onDelete
      },
      item.id
    ))
  ] });
}
function fmtML(mk) {
  const MONTHS2 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m] = mk.split("-");
  return `${MONTHS2[+m - 1]} '${String(y).slice(-2)}`;
}
function parsePeriodLabel(label) {
  const MM = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12"
  };
  const m = String(label || "").trim().match(/^([A-Za-z]{3})\s+(\d{2,4})$/);
  if (!m) return null;
  const mm = MM[m[1]];
  if (!mm) return null;
  const yr = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${yr}-${mm}`;
}
function parseManualPLItems(files) {
  const plIncomeItems = [];
  const plExpenseItems = [];
  if (!Array.isArray(files) || files.length === 0) return { plIncomeItems, plExpenseItems };
  const file = files[0];
  const { rows, periods } = file?.data || {};
  if (!rows || !periods) return { plIncomeItems, plExpenseItems };
  const periodKeys = periods.map(parsePeriodLabel);
  function extractItems(rowList, target, source) {
    for (const row of rowList || []) {
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
function parseKeyReportPLItems(resp) {
  const monthly = resp?.reports?.profitAndLoss?.monthly || [];
  const income = /* @__PURE__ */ new Map();
  const expense = /* @__PURE__ */ new Map();
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
    plExpenseItems: Array.from(expense.values())
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
  onClose
}) {
  const isKeyReports = Boolean(keyReportVersionId);
  const isQBOnline = reportSource === "quickbooks_online";
  const isManualUpload = !isKeyReports && reportSource === "manual_upload_excel_pdf";
  const hasPLData = isKeyReports || isQBOnline || isManualUpload;
  const defaultTab = hasPLData ? section === "withdrawals" ? "expense" : "income" : "manual";
  const [tab, setTab] = useState(defaultTab);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [lineItems, setLineItems] = useState({ plIncomeItems: [], plExpenseItems: [] });
  const [fetchError, setFetchError] = useState(null);
  const [manualName, setManualName] = useState("");
  useEffect(() => {
    if (!isOpen) return;
    setSearch("");
    setTab(hasPLData ? section === "withdrawals" ? "expense" : "income" : "manual");
    setFetchError(null);
    setLineItems({ plIncomeItems: [], plExpenseItems: [] });
    if (!hasPLData || !clientId) return;
    setLoading(true);
    if (isKeyReports) {
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
        accounting_method: accountingMethod || "Accrual"
      });
      fetch(`${BANK_RECON_LINE_ITEMS_ENDPOINT}?${params}`, { headers: getHeaders() }).then((r) => r.ok ? r.json() : null).then((d) => {
        if (d?.success) {
          setLineItems({ plIncomeItems: d.plIncomeItems || [], plExpenseItems: d.plExpenseItems || [] });
        } else {
          setFetchError("Could not load P&L items from QuickBooks.");
        }
      }).catch(() => setFetchError("Could not load P&L items from QuickBooks.")).finally(() => setLoading(false));
    } else if (isManualUpload) {
      fetch(`${MANUAL_PL_ALL_ENDPOINT}?clientId=${clientId}`, { headers: getHeaders() }).then((r) => r.ok ? r.json() : null).then((d) => {
        if (d?.success && Array.isArray(d.files)) {
          setLineItems(parseManualPLItems(d.files));
        } else {
          setFetchError("Could not load P&L items from manual upload.");
        }
      }).catch(() => setFetchError("Could not load P&L items from manual upload.")).finally(() => setLoading(false));
    }
  }, [isOpen, reportSource, keyReportVersionId, section, clientId, startDate, endDate, accountingMethod]);
  if (!isOpen) return null;
  const existingNames = new Set(
    existingItems.filter((i) => i.section === section).map((i) => i.name)
  );
  const sourceItems = tab === "income" ? lineItems.plIncomeItems : lineItems.plExpenseItems;
  const filtered = sourceItems.filter(
    (i) => !existingNames.has(i.name) && i.name.toLowerCase().includes(search.toLowerCase())
  );
  const handleAddItem = (name, source, monthAmounts) => {
    onAdd(name, source, monthAmounts);
    onClose();
  };
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: "fixed inset-0 z-50 flex items-center justify-center bg-black/40",
      onClick: onClose,
      children: /* @__PURE__ */ jsxs(
        "div",
        {
          className: "bg-white rounded-xl shadow-2xl w-[520px] max-h-[520px] flex flex-col overflow-hidden",
          onClick: (e) => e.stopPropagation(),
          children: [
            /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-border", children: [
              /* @__PURE__ */ jsxs("h3", { className: "text-[14px] font-semibold text-text-primary", children: [
                "Add Addback \u2014 ",
                section === "deposits" ? "Deposits" : "Withdrawals"
              ] }),
              /* @__PURE__ */ jsx(
                "button",
                {
                  onClick: onClose,
                  className: "text-text-muted hover:text-text-primary text-[20px] leading-none w-6 h-6 flex items-center justify-center",
                  children: "\xD7"
                }
              )
            ] }),
            /* @__PURE__ */ jsx("div", { className: "flex border-b border-border", children: (hasPLData ? [["income", "P&L Income"], ["expense", "P&L Expenses"], ["manual", "Manual"]] : [["manual", "Manual"]]).map(([key, label]) => /* @__PURE__ */ jsx(
              "button",
              {
                onClick: () => setTab(key),
                className: cn(
                  "px-4 py-2 text-[12px] font-medium border-b-2 transition-colors",
                  tab === key ? "border-blue-500 text-blue-600" : "border-transparent text-text-muted hover:text-text-primary"
                ),
                children: label
              },
              key
            )) }),
            tab === "manual" ? /* @__PURE__ */ jsxs("div", { className: "p-5 flex flex-col gap-3", children: [
              /* @__PURE__ */ jsx("p", { className: "text-[12px] text-text-muted", children: "Enter a name for the addback item. Edit monthly amounts directly in the table." }),
              /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: manualName,
                  onChange: (e) => setManualName(e.target.value),
                  placeholder: "e.g. Owner Distributions",
                  autoFocus: true,
                  onKeyDown: (e) => {
                    if (e.key === "Enter" && manualName.trim()) {
                      handleAddItem(manualName.trim(), "manual", {});
                      setManualName("");
                    }
                    if (e.key === "Escape") onClose();
                  },
                  className: "border border-border rounded-lg px-3 py-2 text-[13px] outline-none focus:ring-2 focus:ring-blue-400"
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  onClick: () => {
                    if (!manualName.trim()) return;
                    handleAddItem(manualName.trim(), "manual", {});
                    setManualName("");
                  },
                  disabled: !manualName.trim(),
                  className: "self-start px-4 py-2 bg-blue-600 text-white text-[12px] font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors",
                  children: "Add Item"
                }
              )
            ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx("div", { className: "px-4 pt-3 pb-2", children: /* @__PURE__ */ jsx(
                "input",
                {
                  type: "text",
                  value: search,
                  onChange: (e) => setSearch(e.target.value),
                  placeholder: "Search accounts...",
                  className: "w-full border border-border rounded-lg px-3 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-blue-400"
                }
              ) }),
              /* @__PURE__ */ jsx("div", { className: "flex-1 overflow-y-auto px-2 pb-3", children: loading ? /* @__PURE__ */ jsx("div", { className: "flex items-center justify-center py-8 text-[12px] text-text-muted", children: "Loading P&L items\u2026" }) : fetchError ? /* @__PURE__ */ jsx("div", { className: "mx-2 my-3 px-3 py-3 bg-orange-50 border border-orange-200 rounded-lg text-[12px] text-orange-700", children: fetchError }) : filtered.length === 0 ? /* @__PURE__ */ jsx("div", { className: "flex items-center justify-center py-8 text-[12px] text-text-muted", children: search ? "No items match your search." : "No items available." }) : filtered.map((item) => {
                const filterMonths = months || [];
                const monthsWithData = filterMonths.filter(
                  (m) => item.monthAmounts?.[m] != null
                );
                const outsideRange = Object.keys(item.monthAmounts || {}).filter(
                  (m) => !filterMonths.includes(m)
                );
                return /* @__PURE__ */ jsxs(
                  "button",
                  {
                    onClick: () => handleAddItem(item.name, item.source, item.monthAmounts),
                    className: "w-full flex flex-col px-3 py-2.5 rounded-lg hover:bg-blue-50 text-left transition-colors group border-b border-border/40 last:border-0",
                    children: [
                      /* @__PURE__ */ jsx("span", { className: "text-[12px] text-text-primary font-medium group-hover:text-blue-700", children: item.name }),
                      monthsWithData.length > 0 ? /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-x-3 gap-y-0.5 mt-1", children: [
                        monthsWithData.map((m) => {
                          const val = Number(item.monthAmounts[m]);
                          return /* @__PURE__ */ jsxs("span", { className: "text-[10px] text-text-muted", children: [
                            fmtML(m),
                            ":",
                            " ",
                            /* @__PURE__ */ jsx(
                              "span",
                              {
                                className: val < 0 ? "text-red-500 font-medium" : "text-green-700 font-medium",
                                children: formatNumber(val, 0)
                              }
                            )
                          ] }, m);
                        }),
                        outsideRange.length > 0 && /* @__PURE__ */ jsxs("span", { className: "text-[10px] text-text-muted/50 italic", children: [
                          "+",
                          outsideRange.length,
                          " outside range"
                        ] })
                      ] }) : /* @__PURE__ */ jsx("span", { className: "text-[10px] text-text-muted/60 mt-0.5 italic", children: "No data in selected range" })
                    ]
                  },
                  item.name
                );
              }) })
            ] })
          ]
        }
      )
    }
  );
}
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
const normMonth = (m) => {
  if (typeof m === "string") return { key: displayMonthToIso(m), label: m };
  if (m?.key) return m;
  if (m?.monthKey) return { key: m.monthKey, label: isoToDisplayMonth(m.monthKey) };
  return null;
};
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
        statementEndDate: m.statement_end_date || ""
      })),
      totals: {
        startingBalance: acct?.totals?.startingBalance ?? (acct?.months || []).reduce((sum, m) => sum + (m.startingBalance || 0), 0),
        deposits: acct?.totals?.deposits ?? (acct?.months || []).reduce((sum, m) => sum + (m.deposits || 0), 0),
        withdrawals: acct?.totals?.withdrawals ?? (acct?.months || []).reduce((sum, m) => sum + (m.withdrawals || 0), 0),
        endingBalance: acct?.totals?.endingBalance ?? (acct?.months || []).reduce((sum, m) => sum + (m.endingBalance || 0), 0)
      }
    };
  });
  return {
    months,
    banks,
    totals: (payload.totals || []).map(normTotal),
    syncedAt: payload.syncedAt || null,
    documentCount: payload.documentCount || banks.length
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
    // Null, not 0 — nothing has been compared yet. A 0 variance now renders as an
    // explicit 0 meaning "bank agrees with books" (see fmtVarianceAmt), so these
    // must stay null to keep showing "-" until there is something to compare.
    variance: null,
    outstandingChecks: 0,
    unreconciledDollar: null,
    unreconciledPct: null
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
    withdrawsUnreconciledPct: 0
  };
}
export default function WorkspaceReconciliation() {
  const { clientId } = useParams();
  const { activeSource: contextActiveSource, sourceRecords: contextSourceRecords } = useDataSource();
  const krSelected = useMemo(
    () => normalizeReportSourceKey(contextActiveSource) === REPORT_SOURCE_KEYS.KEY_REPORTS,
    [contextActiveSource]
  );
  const rawKr = useKeyReportContextStore(useShallow(selectKeyReportContext));
  const kr = useMemo(() => maskKeyReportContext(rawKr, krSelected), [rawKr, krSelected]);
  const glScopeRef = useRef({ datasetVersion: kr.resolvedDatasetVersion });
  glScopeRef.current = { datasetVersion: kr.resolvedDatasetVersion };
  const krVersionIdRef = useRef(null);
  krVersionIdRef.current = kr.krActive ? kr.selectedVersionId : null;
  const storedState = getStoredWorkspaceState(clientId);
  const [expandedAccounts, setExpandedAccounts] = useState(
    storedState?.expandedAccounts || getDefaultExpandedAccounts()
  );
  const [bankActivityStartMonth, setBankActivityStartMonth] = useState(
    storedState?.bankActivityStartMonth || "2026-01"
  );
  const [bankActivityEndMonth, setBankActivityEndMonth] = useState(
    storedState?.bankActivityEndMonth || "2026-04"
  );
  const [bankActivityAccountingMethod, setBankActivityAccountingMethod] = useState(storedState?.bankActivityAccountingMethod || "Accrual");
  const [qbBankActivity, setQbBankActivity] = useState(
    storedState?.qbBankActivity || null
  );
  const [isLoadingBankActivity, setIsLoadingBankActivity] = useState(false);
  const [bankActivityError, setBankActivityError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState(storedState?.lastSyncedAt || null);
  const [bankActivityFetchStatus, setBankActivityFetchStatus] = useState({
    status: storedState?.qbBankActivity ? "success" : "idle",
    message: storedState?.qbBankActivity ? "Restored saved QuickBooks bank activity." : ""
  });
  const [selectedBalanceBankId, setSelectedBalanceBankId] = useState(
    storedState?.selectedBalanceBankId || ""
  );
  const [selectedManualBankName, setSelectedManualBankName] = useState("");
  const [oneBankAccountId, setOneBankAccountId] = useState(
    storedState?.oneBankAccountId || ""
  );
  const [qbOneBankActivity, setQbOneBankActivity] = useState(
    storedState?.qbOneBankActivity || null
  );
  const [isLoadingOneBankActivity, setIsLoadingOneBankActivity] = useState(false);
  const [oneBankActivityError, setOneBankActivityError] = useState("");
  const [oneBankActivityFetchStatus, setOneBankActivityFetchStatus] = useState({
    status: storedState?.qbOneBankActivity ? "success" : "idle",
    message: storedState?.qbOneBankActivity ? "Restored saved single-account QuickBooks activity." : ""
  });
  const [extractedBankPdfData, setExtractedBankPdfData] = useState(null);
  const [isLoadingExtractedBankPdfData, setIsLoadingExtractedBankPdfData] = useState(false);
  const [extractedBankPdfError, setExtractedBankPdfError] = useState("");
  const [extractedBankPdfFetchStatus, setExtractedBankPdfFetchStatus] = useState({
    status: "idle",
    message: ""
  });
  const extractedBankPdfDataRef = useRef(extractedBankPdfData);
  useEffect(() => {
    extractedBankPdfDataRef.current = extractedBankPdfData;
  }, [extractedBankPdfData]);
  const applyBankData = useCallback((next, { force = false } = {}) => {
    const hasData2 = !!(next && Array.isArray(next.banks) && next.banks.length > 0);
    if (hasData2 || force || !extractedBankPdfDataRef.current) {
      setExtractedBankPdfData(next);
      extractedBankPdfDataRef.current = next;
      return true;
    }
    return false;
  }, []);
  const [manualMonthStart, setManualMonthStart] = useState(null);
  const [manualMonthEnd, setManualMonthEnd] = useState(null);
  const [bsBankBalances, setBsBankBalances] = useState(null);
  const [bsMonthlyBalances, setBsMonthlyBalances] = useState(null);
  const [plFinancials, setPlFinancials] = useState(null);
  const [activityReview, setActivityReview] = useState(null);
  const [reportSources, setReportSources] = useState([]);
  const [selectedReportSource, setSelectedReportSourceState] = useState(
    kr.krActive && kr.effectiveSource ? kr.effectiveSource : normalizeReportSourceKey(contextActiveSource || REPORT_SOURCE_KEYS.QUICKBOOKS)
  );
  useEffect(() => {
    if (!kr.krActive || !kr.effectiveSource) return;
    if (selectedReportSource !== kr.effectiveSource) {
      setSelectedReportSourceState(kr.effectiveSource);
    }
  }, [kr.krActive, kr.effectiveSource, selectedReportSource]);
  const [isSourceConfirmedByServer, setIsSourceConfirmedByServer] = useState(false);
  const [reconAdjustments, setReconAdjustments] = useState({});
  const [addbackItems, setAddbackItems] = useState([]);
  const [addbackPickerState, setAddbackPickerState] = useState(null);
  const [bankReconExportOpen, setBankReconExportOpen] = useState(false);
  const [bankReconIsExporting, setBankReconIsExporting] = useState(false);
  const activeSourceRef = useRef(selectedReportSource);
  activeSourceRef.current = selectedReportSource;
  const getHeaders = useCallback(
    () => {
      const token = getStoredToken();
      return {
        ...token ? {
          Authorization: `Bearer ${token}`,
          "X-Access-Token": token,
          "X-Auth-Token": token,
          "X-Token": token
        } : {},
        ...clientId ? { "X-Client-Id": clientId } : {}
      };
    },
    [clientId]
  );
  useEffect(() => {
    setIsSourceConfirmedByServer(false);
    const nextState = getStoredWorkspaceState(clientId);
    setExpandedAccounts(
      nextState?.expandedAccounts || getDefaultExpandedAccounts()
    );
    setBankActivityStartMonth(nextState?.bankActivityStartMonth || "2026-01");
    setBankActivityEndMonth(nextState?.bankActivityEndMonth || "2026-04");
    setBankActivityAccountingMethod(
      nextState?.bankActivityAccountingMethod || "Accrual"
    );
    setQbBankActivity(nextState?.qbBankActivity || null);
    setBankActivityFetchStatus({
      status: nextState?.qbBankActivity ? "success" : "idle",
      message: nextState?.qbBankActivity ? "Restored saved QuickBooks bank activity." : ""
    });
    setBankActivityError("");
    setLastSyncedAt(nextState?.lastSyncedAt || null);
    setSelectedBalanceBankId(nextState?.selectedBalanceBankId || "");
    setOneBankAccountId(nextState?.oneBankAccountId || "");
    setManualMonthStart(nextState?.manualMonthStart ?? null);
    setManualMonthEnd(nextState?.manualMonthEnd ?? null);
    setSelectedManualBankName(nextState?.selectedManualBankName || "");
    setQbOneBankActivity(nextState?.qbOneBankActivity || null);
    setOneBankActivityFetchStatus({
      status: nextState?.qbOneBankActivity ? "success" : "idle",
      message: nextState?.qbOneBankActivity ? "Restored saved single-account QuickBooks activity." : ""
    });
    setOneBankActivityError("");
    const restoredSource = normalizeReportSourceKey(
      nextState?.selectedReportSource || REPORT_SOURCE_KEYS.QUICKBOOKS
    );
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
          selectedManualBankName: selectedManualBankName || existing.selectedManualBankName || "",
          qbOneBankActivity: qbOneBankActivity ?? existing.qbOneBankActivity ?? null,
          // NOTE: extractedBankPdfData is deliberately NOT persisted here. This key
          // is scoped by company only, so bank data written to it is not isolated by
          // connection mode or Version. It lives in the source+version-scoped slot
          // cache instead (getReconDataKey / saveStoredReconData). The restore path
          // discarded this copy unconditionally anyway, so writing it only
          // duplicated a large payload under an unsafe key and risked the
          // sessionStorage quota.
          selectedReportSource
        })
      );
    } catch {
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
    selectedReportSource
  ]);
  const reconDataVersion = kr.krActive ? String(kr.selectedVersionId || "default") : "default";
  useEffect(() => {
    if (!clientId || !selectedReportSource) return;
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
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
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
    bsMonthlyBalances
  ]);
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
  }, [clientId, selectedReportSource, reconDataVersion]);
  const loadSavedQBBankActivity = useCallback(async () => {
    if (!clientId) return;
    try {
      const params = new URLSearchParams({ clientId });
      const resp = await fetch(`${QB_BANK_ACTIVITY_SAVED_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders()
      });
      if (!resp.ok) return;
      const result = await resp.json();
      if (!result?.found || !result?.data) return;
      setQbBankActivity(result.data);
      setLastSyncedAt(result.updatedAt || null);
      const syncLabel = result.updatedAt ? new Date(result.updatedAt).toLocaleString() : "previously";
      setBankActivityFetchStatus({
        status: "success",
        message: `Restored saved data (last synced: ${syncLabel}).`
      });
    } catch {
    }
  }, [clientId, getHeaders]);
  const loadQBBankActivity = async () => {
    setIsLoadingBankActivity(true);
    setBankActivityError("");
    setBankActivityFetchStatus({
      status: "loading",
      message: "Fetching QuickBooks bank activity..."
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
        accounting_method: bankActivityAccountingMethod
      });
      if (clientId) params.append("clientId", clientId);
      const resp = await fetch(`${QB_BANK_ACTIVITY_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders()
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      setQbBankActivity(data);
      setLastSyncedAt(now);
      setBankActivityFetchStatus({
        status: "success",
        message: `Fetched ${data?.months?.length ?? 0} month(s) across ${data?.accounts?.length ?? 0} account(s). Last synced: ${new Date(now).toLocaleString()}.`
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
      message: "Fetching selected QuickBooks bank activity..."
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
        end_date
      });
      if (clientId) params.append("clientId", clientId);
      const resp = await fetch(`${QB_ONE_BANK_ACTIVITY_ENDPOINT}?${params}`, {
        cache: "no-store",
        headers: getHeaders()
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      setQbOneBankActivity(data);
      setOneBankActivityFetchStatus({
        status: "success",
        message: `Loaded ${data?.monthlyData?.length ?? 0} month(s) for ${data?.account?.bankName || "selected account"}.`
      });
    } catch (e) {
      setOneBankActivityError(getErrMsg(e));
      setOneBankActivityFetchStatus({
        status: "error",
        message: getErrMsg(e)
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
      message: "Loading extracted bank PDF records..."
    });
    try {
      const params = new URLSearchParams();
      if (clientId) params.append("clientId", clientId);
      if (selectedReportSource) params.append("source", selectedReportSource);
      if (opts.datasetVersion) params.append("datasetVersion", String(opts.datasetVersion));
      if (opts.keyReportVersionId) params.append("keyReportVersionId", String(opts.keyReportVersionId));
      const url = `${EXTRACT_BANK_PDF_RECORDS_ENDPOINT}?${params.toString()}`;
      const resp = await fetch(url, {
        cache: "no-store",
        headers: getHeaders()
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      const normalized = normalizeExtractedBankPdfData(data);
      if (activeSourceRef.current !== selectedReportSource) return;
      if (opts.datasetVersion != null && String(glScopeRef.current.datasetVersion) !== String(opts.datasetVersion)) return;
      const replaced = applyBankData(normalized, { force: opts.force });
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: replaced ? `Loaded ${normalized?.banks?.length ?? 0} bank(s) across ${normalized?.months?.length ?? 0} month(s).` : "Showing saved bank data."
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({
        status: "error",
        message: getErrMsg(e)
      });
      if (!extractedBankPdfDataRef.current) setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders, applyBankData]);
  const loadQMSBankData = useCallback(async (opts = {}) => {
    if (activeSourceRef.current !== REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      console.warn(`[BankData] loadQMSBankData blocked \u2014 activeSource=${activeSourceRef.current} is not QuickBooks Manual`);
      return;
    }
    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    setPlFinancials(null);
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading bank statement data from QuickBooks Manual source..."
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
      if (activeSourceRef.current !== selectedReportSource) return;
      const replaced = applyBankData(normalized, { force: opts.force });
      setPlFinancials(data.plFinancials ?? null);
      setExtractedBankPdfFetchStatus({
        status: normalized ? "success" : "idle",
        message: !replaced ? "Showing saved bank data." : normalized ? `Loaded ${normalized.banks?.length ?? 0} bank(s) across ${normalized.months?.length ?? 0} month(s).` : "No bank statement data found. Please sync your QuickBooks Manual Source folder first."
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({ status: "error", message: getErrMsg(e) });
      if (!extractedBankPdfDataRef.current) setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders, applyBankData]);
  const loadManualBankData = useCallback(async (opts = {}) => {
    if (activeSourceRef.current !== REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      console.warn(`[BankData] loadManualBankData blocked \u2014 activeSource=${activeSourceRef.current} is not Manual Upload`);
      return;
    }
    setIsLoadingExtractedBankPdfData(true);
    setExtractedBankPdfError("");
    if (!krVersionIdRef.current) setPlFinancials(null);
    setExtractedBankPdfFetchStatus({
      status: "loading",
      message: "Loading bank statement data from Manual Upload source..."
    });
    try {
      const params = new URLSearchParams();
      if (clientId) params.append("clientId", clientId);
      if (krVersionIdRef.current) params.append("keyReportVersionId", String(krVersionIdRef.current));
      const url = `${MANUAL_BANK_DATA_ENDPOINT}?${params.toString()}`;
      const resp = await fetch(url, { cache: "no-store", headers: getHeaders() });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
      if (activeSourceRef.current !== selectedReportSource) return;
      if (data.balanceSheetBankAccounts?.bankAccounts?.length > 0) {
        setBsBankBalances({ success: true, ...data.balanceSheetBankAccounts });
      } else {
        setBsBankBalances(null);
      }
      if (!krVersionIdRef.current) setPlFinancials(data.plFinancials ?? null);
      if (data.empty) {
        const replaced2 = applyBankData(null, { force: opts.force });
        setExtractedBankPdfFetchStatus({
          status: "success",
          message: replaced2 ? data.message || "No bank statements uploaded. Upload PDF or Excel files to Manual Upload Source \u2192 Bank Statement." : "Showing saved bank data."
        });
        return;
      }
      const normalized = normalizeExtractedBankPdfData(data);
      const replaced = applyBankData(normalized, { force: opts.force });
      setExtractedBankPdfFetchStatus({
        status: "success",
        message: replaced ? normalized ? `Loaded ${normalized.banks?.length ?? 0} bank(s).` : "No bank statement data found. Upload files to Manual Upload Source \u2192 Bank Statement." : "Showing saved bank data."
      });
    } catch (e) {
      if (activeSourceRef.current !== selectedReportSource) return;
      setExtractedBankPdfError(getErrMsg(e));
      setExtractedBankPdfFetchStatus({ status: "error", message: getErrMsg(e) });
      if (!extractedBankPdfDataRef.current) setExtractedBankPdfData(null);
    } finally {
      if (activeSourceRef.current === selectedReportSource) {
        setIsLoadingExtractedBankPdfData(false);
      }
    }
  }, [clientId, selectedReportSource, getHeaders, applyBankData]);
  const loadBsBankBalances = useCallback(async (sourceKey, opts = {}) => {
    if (!clientId) return;
    console.log(`[BsBankBalances] Fetching for clientId=${clientId} source=${sourceKey}`);
    try {
      const params = new URLSearchParams();
      params.append("clientId", clientId);
      if (sourceKey) params.append("source", sourceKey);
      if (opts.datasetVersion) params.append("datasetVersion", String(opts.datasetVersion));
      if (opts.keyReportVersionId) params.append("keyReportVersionId", String(opts.keyReportVersionId));
      const resp = await fetch(`${BS_BANK_BALANCES_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
        headers: getHeaders()
      });
      if (!resp.ok) {
        console.warn(`[BsBankBalances] HTTP ${resp.status} from backend`);
        setBsBankBalances(null);
        return;
      }
      const data = await resp.json();
      console.log(`[BsBankBalances] Response: source=${data.source} year=${data.year} accounts=${data.bankAccounts?.length ?? 0}`);
      if (opts.datasetVersion != null && String(glScopeRef.current.datasetVersion) !== String(opts.datasetVersion)) return;
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
  useEffect(() => {
    if (!clientId) return;
    fetch(`${BANK_RECON_ADJ_ENDPOINT}?clientId=${clientId}`, { headers: getHeaders() }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.success && Array.isArray(d.adjustments)) {
        const map = {};
        d.adjustments.forEach((a) => {
          map[`${a.month}_${a.rowKey}`] = Number(a.amount) || 0;
        });
        setReconAdjustments(map);
      }
    }).catch(() => {
    });
  }, [clientId, getHeaders]);
  const addbackVersionId = kr.krActive ? kr.selectedVersionId : null;
  useEffect(() => {
    if (!clientId || !selectedReportSource) return;
    setAddbackItems([]);
    const versionParam = addbackVersionId ? `&keyReportVersionId=${encodeURIComponent(addbackVersionId)}` : "";
    fetch(
      `${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}?clientId=${clientId}&reportSource=${encodeURIComponent(selectedReportSource)}${versionParam}`,
      { headers: getHeaders() }
    ).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.success && Array.isArray(d.items)) setAddbackItems(d.items);
    }).catch(() => {
    });
  }, [clientId, getHeaders, selectedReportSource, addbackVersionId]);
  const saveAdjustment = useCallback(
    async (month, rowKey, amount) => {
      const key = `${month}_${rowKey}`;
      setReconAdjustments((prev) => ({ ...prev, [key]: amount }));
      try {
        await fetch(BANK_RECON_ADJ_ENDPOINT, {
          method: "POST",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, month, rowKey, amount })
        });
      } catch {
      }
    },
    [clientId, getHeaders]
  );
  const createAddbackItem = useCallback(
    async (section, name, source, monthAmounts) => {
      try {
        const resp = await fetch(BANK_RECON_ADDBACK_ITEMS_ENDPOINT, {
          method: "POST",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, section, name, source, monthAmounts, reportSource: selectedReportSource, keyReportVersionId: addbackVersionId })
        });
        const data = await resp.json();
        if (data?.success && data.item) {
          setAddbackItems((prev) => [...prev, data.item]);
        }
      } catch {
      }
    },
    [clientId, getHeaders, selectedReportSource, addbackVersionId]
  );
  const updateAddbackItemAmounts = useCallback(
    async (id, monthAmounts) => {
      setAddbackItems(
        (prev) => prev.map((i) => i.id === id ? { ...i, monthAmounts } : i)
      );
      try {
        await fetch(`${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}/${id}`, {
          method: "PUT",
          headers: { ...getHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, monthAmounts })
        });
      } catch {
      }
    },
    [clientId, getHeaders]
  );
  const deleteAddbackItem = useCallback(
    async (id) => {
      setAddbackItems((prev) => prev.filter((i) => i.id !== id));
      try {
        await fetch(
          `${BANK_RECON_ADDBACK_ITEMS_ENDPOINT}/${id}?clientId=${encodeURIComponent(clientId)}`,
          { method: "DELETE", headers: getHeaders() }
        );
      } catch {
      }
    },
    [clientId, getHeaders]
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
  useEffect(() => {
    if (!clientId || !selectedReportSource || !isSourceConfirmedByServer) return;
    const manualSource = selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL || selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
    if (manualSource) {
      const slot = getStoredReconData(clientId, selectedReportSource, reconDataVersion);
      if (slot && (slot.extractedBankPdfData || slot.bsBankBalances || slot.plFinancials)) {
        return;
      }
    }
    const loadOpts = { force: true };
    if (selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
      void loadManualBankData(loadOpts);
    } else if (selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL) {
      const glScope = {
        datasetVersion: kr.resolvedDatasetVersion,
        keyReportVersionId: krVersionIdRef.current
      };
      void loadExtractedBankPdfData({ ...glScope, ...loadOpts });
      void loadBsBankBalances("manual_upload_excel_pdf", glScope);
    } else if (selectedReportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      void loadQMSBankData(loadOpts);
      void loadBsBankBalances("quickbooks_manual", { keyReportVersionId: krVersionIdRef.current });
    }
  }, [clientId, selectedReportSource, isSourceConfirmedByServer, reconDataVersion, kr.resolvedDatasetVersion, kr.selectedVersionId, loadExtractedBankPdfData, loadManualBankData, loadQMSBankData, loadBsBankBalances]);
  useEffect(() => {
    const versionId = kr.krActive ? kr.selectedVersionId : null;
    if (!clientId || !versionId) {
      setBsMonthlyBalances(null);
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
        setActivityReview(computeActivityReviewFromFs(resp));
        setBsMonthlyBalances(computeBsBankBalancesByMonthFromFs(resp));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, kr.krActive, kr.selectedVersionId]);
  useEffect(() => {
    if (!isSourceConfirmedByServer) return;
    if (selectedReportSource !== REPORT_SOURCE_KEYS.QUICKBOOKS) return;
    if (qbBankActivity) return;
    void loadSavedQBBankActivity();
  }, [isSourceConfirmedByServer, selectedReportSource, qbBankActivity, loadSavedQBBankActivity]);
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
      accounting_method: bankActivityAccountingMethod || "Accrual"
    });
    fetch(`${BANK_RECON_LINE_ITEMS_ENDPOINT}?${params}`, { headers: getHeaders() }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (!d?.success) return;
      setQbBankActivity(
        (prev) => prev ? { ...prev, plFinancials: { totalIncome: d.plTotalIncome || {}, totalExpenses: d.plTotalExpenses || {} } } : prev
      );
    }).catch(() => {
    });
  }, [qbBankActivity, selectedReportSource, clientId, bankActivityAccountingMethod, getHeaders]);
  useEffect(() => {
    if (kr.krActive) return;
    if (!contextActiveSource) return;
    const confirmed = normalizeReportSourceKey(contextActiveSource);
    if (!confirmed) return;
    setSelectedReportSourceState(confirmed);
    setReportSources(
      Array.isArray(contextSourceRecords) ? contextSourceRecords.map((s) => ({
        key: normalizeReportSourceKey(s.sourceKey),
        label: s.sourceLabel || getReportSourceLabel(s.sourceKey)
      })) : []
    );
    setExtractedBankPdfData(null);
    setExtractedBankPdfFetchStatus({ status: "idle", message: "" });
    setExtractedBankPdfError("");
    setBsBankBalances(null);
    setPlFinancials(null);
    setIsSourceConfirmedByServer(true);
  }, [contextActiveSource, contextSourceRecords, kr.krActive]);
  useEffect(() => {
    if (!kr.krActive || !kr.effectiveSource) return;
    setSelectedReportSourceState(kr.effectiveSource);
    setExtractedBankPdfData(null);
    setExtractedBankPdfFetchStatus({ status: "idle", message: "" });
    setExtractedBankPdfError("");
    setBsBankBalances(null);
    setPlFinancials(null);
    setActivityReview(null);
    setBsMonthlyBalances(null);
    setIsSourceConfirmedByServer(true);
  }, [
    kr.krActive,
    kr.effectiveSource,
    kr.flowType,
    kr.resolvedDatasetVersion,
    kr.selectedVersionId
  ]);
  const handleReportSourceChange = async (sourceKey) => {
    const normalized = normalizeReportSourceKey(sourceKey);
    const previous = selectedReportSource;
    setSelectedReportSourceState(normalized);
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
    setPlFinancials(null);
    setActivityReview(null);
    setBsMonthlyBalances(null);
    try {
      const payload = await setSelectedReportSource(normalized, { clientId });
      const confirmedKey = normalizeReportSourceKey(payload?.selectedSource) || normalized;
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
        label: s.sourceLabel || getReportSourceLabel(s.sourceKey)
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
    [extractedBankPdfData]
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
  const reportMonths = qbBankActivity?.months?.length ? qbBankActivity.months : [];
  const hasData = reportMonths.length > 0;
  const balanceBankOptions = useMemo(() => {
    if (!qbBankActivity?.accounts?.length) return [];
    return qbBankActivity.accounts.map((account) => ({
      value: account.accountId,
      label: `${account.accountName} (${getLastFourDigits(account.accountNumber)})`
    }));
  }, [qbBankActivity]);
  const manualBankOptions = useMemo(
    () => (extractedBankPdfData?.banks || []).map((b) => b.bankName),
    [extractedBankPdfData]
  );
  useEffect(() => {
    if (manualBankOptions.length > 0 && !manualBankOptions.includes(selectedManualBankName)) {
      setSelectedManualBankName(manualBankOptions[0]);
    }
  }, [manualBankOptions, selectedManualBankName]);
  const oneBankAccountOptions = useMemo(() => {
    if (!qbBankActivity?.accounts?.length) return [];
    return qbBankActivity.accounts.filter(
      (account, idx, all) => all.findIndex((item) => item.accountId === account.accountId) === idx
    ).map((account) => ({
      value: account.accountId,
      label: `${account.accountName}${account.accountNumber ? ` (${account.accountNumber})` : ""}`
    }));
  }, [qbBankActivity]);
  useEffect(() => {
    const accounts = qbBankActivity?.accounts || [];
    if (!accounts.length) return;
    setExpandedAccounts((prev) => {
      const next = Object.fromEntries(
        accounts.map((account, index) => [
          account.accountId,
          prev?.[account.accountId] ?? index === 0
        ])
      );
      const hasSameKeys = Object.keys(next).length === Object.keys(prev || {}).length && Object.keys(next).every((key) => key in (prev || {}));
      const hasSameValues = Object.keys(next).every(
        (key) => next[key] === prev?.[key]
      );
      return hasSameKeys && hasSameValues ? prev : next;
    });
  }, [qbBankActivity]);
  useEffect(() => {
    if (balanceBankOptions.length > 0 && !balanceBankOptions.some((option) => option.value === selectedBalanceBankId)) {
      setSelectedBalanceBankId(balanceBankOptions[0].value);
    }
  }, [balanceBankOptions, selectedBalanceBankId]);
  useEffect(() => {
    if (!selectedBalanceBankId) return;
    setExpandedAccounts((prev) => ({
      ...prev,
      [selectedBalanceBankId]: true
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
      (account.monthlyData || []).map((row) => [row.month, row])
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
        _perBSCount: row?.perBalanceSheet != null ? 1 : 0
      };
    });
    const withDerived = rows.map((r, i) => {
      const footingCheck = r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals);
      const priorMonthCheck = i === 0 ? 0 : rows[i - 1].endingBalance - r.startingBalance;
      const variance = r._perBSCount > 0 ? r.endingBalance - r.perBalanceSheet : null;
      const outstandingChecks = 0;
      const unreconciledDollar = variance != null ? variance - outstandingChecks : null;
      const unreconciledPct = unreconciledDollar != null && r.perBalanceSheet !== 0 ? unreconciledDollar / r.perBalanceSheet * 100 : null;
      return {
        ...r,
        footingCheck,
        priorMonthCheck,
        variance,
        outstandingChecks,
        unreconciledDollar,
        unreconciledPct
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
        intercompanyWithdraws: acc.intercompanyWithdraws + r.intercompanyWithdraws,
        footingCheck: acc.footingCheck + r.footingCheck,
        priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
        perBalanceSheet: r.perBalanceSheet,
        // TTM Per Balance Sheet is point-in-time (the latest month's book balance),
        // so its variance is too. Null when that month had no book balance.
        variance: r._perBSCount > 0 ? r.endingBalance - r.perBalanceSheet : null,
        outstandingChecks: acc.outstandingChecks + r.outstandingChecks,
        // Sum only months that actually had a book balance, and stay null when
        // none did — otherwise an all-missing window would read as a false 0.
        unreconciledDollar: r.unreconciledDollar == null ? acc.unreconciledDollar : (acc.unreconciledDollar ?? 0) + r.unreconciledDollar,
        unreconciledPct: r.unreconciledPct
      }),
      buildEmptyTTM()
    );
    return { rows: withDerived, ttm };
  };
  const visibleBalanceAccounts = selectedBalanceBankId ? qbBankActivity?.accounts?.filter(
    (account) => account.accountId === selectedBalanceBankId
  ) || [] : qbBankActivity?.accounts || [];
  const allBankMonthlyMaps = qbBankActivity?.accounts?.map(
    (account) => Object.fromEntries((account.monthlyData || []).map((row) => [row.month, row]))
  ) || [];
  const activityRows = reportMonths.map((month) => {
    const totalDeposits = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.deposits || 0),
      0
    );
    const totalWithdrawals = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.withdrawals || 0),
      0
    );
    const intercompanyDeposits = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.intercompanyDeposits || 0),
      0
    );
    const intercompanyWithdraws = allBankMonthlyMaps.reduce(
      (sum, monthlyMap) => sum + (monthlyMap[month]?.intercompanyWithdraws || 0),
      0
    );
    const intercompanyTransfers = intercompanyDeposits + intercompanyWithdraws;
    const externalDeposits = totalDeposits - intercompanyTransfers;
    const salesPerFinancials = qbBankActivity?.plFinancials?.totalIncome?.[month] ?? 0;
    const depositsDollarVar = salesPerFinancials - externalDeposits;
    const depositsPctVar = salesPerFinancials !== 0 ? depositsDollarVar / salesPerFinancials * 100 : 0;
    const changeInAR = 0;
    const changeInARRetentions = 0;
    const changeInCurrentAssets = 0;
    const fixedAssetDisposals = 0;
    const depositsOther = 0;
    const depositsUnreconciledDollar = depositsDollarVar + changeInAR + changeInARRetentions + changeInCurrentAssets + fixedAssetDisposals + depositsOther;
    const depositsUnreconciledPct = salesPerFinancials !== 0 ? depositsUnreconciledDollar / salesPerFinancials * 100 : 0;
    const withdrawIntercompanyTransfers = intercompanyWithdraws;
    const externalWithdraws = totalWithdrawals - withdrawIntercompanyTransfers;
    const expensesPerFinancials = qbBankActivity?.plFinancials?.totalExpenses?.[month] ?? 0;
    const withdrawsDollarVar = externalWithdraws - expensesPerFinancials;
    const withdrawsPctVar = expensesPerFinancials !== 0 ? withdrawsDollarVar / expensesPerFinancials * 100 : 0;
    const ownerWithdraws = 0;
    const changeInCurrentLiabilities = 0;
    const changeInLTLiabilities = 0;
    const depreciationExpense = 0;
    const amortizationExpense = 0;
    const badDebtExpense = 0;
    const fixedAssetPurchases = 0;
    const withdrawsOther = 0;
    const withdrawsUnreconciledDollar = withdrawsDollarVar + ownerWithdraws + changeInCurrentLiabilities + changeInLTLiabilities + depreciationExpense + amortizationExpense + badDebtExpense + fixedAssetPurchases + withdrawsOther;
    const withdrawsUnreconciledPct = expensesPerFinancials !== 0 ? withdrawsUnreconciledDollar / expensesPerFinancials * 100 : 0;
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
      withdrawsUnreconciledPct
    };
  });
  const activityTTM = activityRows.slice(-12).reduce(
    (acc, r) => ({
      totalDeposits: acc.totalDeposits + r.totalDeposits,
      intercompanyTransfers: acc.intercompanyTransfers + r.intercompanyTransfers,
      externalDeposits: acc.externalDeposits + r.externalDeposits,
      salesPerFinancials: acc.salesPerFinancials + r.salesPerFinancials,
      depositsDollarVar: acc.depositsDollarVar + r.depositsDollarVar,
      depositsPctVar: acc.salesPerFinancials + r.salesPerFinancials !== 0 ? (acc.depositsDollarVar + r.depositsDollarVar) / (acc.salesPerFinancials + r.salesPerFinancials) * 100 : 0,
      changeInAR: acc.changeInAR + r.changeInAR,
      changeInARRetentions: acc.changeInARRetentions + r.changeInARRetentions,
      changeInCurrentAssets: acc.changeInCurrentAssets + r.changeInCurrentAssets,
      fixedAssetDisposals: acc.fixedAssetDisposals + r.fixedAssetDisposals,
      depositsOther: acc.depositsOther + r.depositsOther,
      depositsUnreconciledDollar: acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar,
      depositsUnreconciledPct: acc.salesPerFinancials + r.salesPerFinancials !== 0 ? (acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar) / (acc.salesPerFinancials + r.salesPerFinancials) * 100 : 0,
      totalWithdrawals: acc.totalWithdrawals + r.totalWithdrawals,
      withdrawIntercompanyTransfers: acc.withdrawIntercompanyTransfers + r.withdrawIntercompanyTransfers,
      externalWithdraws: acc.externalWithdraws + r.externalWithdraws,
      expensesPerFinancials: acc.expensesPerFinancials + r.expensesPerFinancials,
      withdrawsDollarVar: acc.withdrawsDollarVar + r.withdrawsDollarVar,
      withdrawsPctVar: acc.expensesPerFinancials + r.expensesPerFinancials !== 0 ? (acc.withdrawsDollarVar + r.withdrawsDollarVar) / (acc.expensesPerFinancials + r.expensesPerFinancials) * 100 : 0,
      ownerWithdraws: acc.ownerWithdraws + r.ownerWithdraws,
      changeInCurrentLiabilities: acc.changeInCurrentLiabilities + r.changeInCurrentLiabilities,
      changeInLTLiabilities: acc.changeInLTLiabilities + r.changeInLTLiabilities,
      depreciationExpense: acc.depreciationExpense + r.depreciationExpense,
      amortizationExpense: acc.amortizationExpense + r.amortizationExpense,
      badDebtExpense: acc.badDebtExpense + r.badDebtExpense,
      fixedAssetPurchases: acc.fixedAssetPurchases + r.fixedAssetPurchases,
      withdrawsOther: acc.withdrawsOther + r.withdrawsOther,
      withdrawsUnreconciledDollar: acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct: acc.expensesPerFinancials + r.expensesPerFinancials !== 0 ? (acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar) / (acc.expensesPerFinancials + r.expensesPerFinancials) * 100 : 0
    }),
    buildEmptyActivityReviewRow()
  );
  const SpacerRow = ({ colCount }) => /* @__PURE__ */ jsx("tr", { children: /* @__PURE__ */ jsx(
    "td",
    {
      colSpan: colCount,
      className: "border-x border-border bg-slate-100 py-[3px]"
    }
  ) });
  const GroupHeaderRow = ({ label, months }) => /* @__PURE__ */ jsxs("tr", { className: "bg-slate-50", children: [
    /* @__PURE__ */ jsx(
      "td",
      {
        className: cn(
          "sticky left-0 z-[1] border border-border bg-slate-50 px-3 py-[6px] text-[12px] font-semibold text-text-primary whitespace-nowrap",
          TABLE_LABEL_COL_WIDTH
        ),
        children: label
      }
    ),
    months.map((month) => /* @__PURE__ */ jsx("td", { className: cn("border border-border bg-slate-50", TABLE_VALUE_COL_WIDTH) }, month)),
    /* @__PURE__ */ jsx("td", { className: cn("border border-border bg-slate-50", TABLE_VALUE_COL_WIDTH) })
  ] });
  const TableColGroup = ({ months }) => /* @__PURE__ */ jsxs("colgroup", { children: [
    /* @__PURE__ */ jsx("col", { className: TABLE_LABEL_COL_WIDTH }),
    months.map((month) => /* @__PURE__ */ jsx("col", { className: TABLE_VALUE_COL_WIDTH }, month)),
    /* @__PURE__ */ jsx("col", { className: TABLE_VALUE_COL_WIDTH })
  ] });
  const TableHeader = ({ label, months }) => /* @__PURE__ */ jsxs("tr", { className: "border-b border-primary/15 bg-[#F8FBF1]", children: [
    /* @__PURE__ */ jsx(
      "th",
      {
        className: cn(
          "sticky left-0 top-0 z-30 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary",
          TABLE_LABEL_COL_WIDTH
        ),
        children: label
      }
    ),
    months.map((m) => /* @__PURE__ */ jsx(
      "th",
      {
        className: cn(
          "sticky top-0 z-20 whitespace-nowrap border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
          TABLE_VALUE_COL_WIDTH
        ),
        children: monthLabel(m)
      },
      m
    )),
    /* @__PURE__ */ jsx(
      "th",
      {
        className: cn(
          "sticky top-0 z-20 border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
          TABLE_VALUE_COL_WIDTH
        ),
        children: "TTM"
      }
    )
  ] });
  const DR = ({
    label,
    values,
    rawValues,
    bold,
    indent,
    check,
    rowType = "normal"
  }) => {
    const isVarianceRow = rowType === "variance-amt" || rowType === "variance-pct";
    const renderCell = (val, rawVal, i) => {
      if (isVarianceRow) {
        const numVal = rawVal != null ? rawVal : typeof val === "number" ? val : null;
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
        return /* @__PURE__ */ jsx(
          "td",
          {
            className: cn(
              "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
              colorClass
            ),
            children: formatted
          },
          i
        );
      }
      return /* @__PURE__ */ jsx(
        "td",
        {
          className: cn(
            "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums",
            bold ? "font-semibold text-text-primary" : "text-text-primary",
            check ? "text-amber-700 italic" : ""
          ),
          children: val
        },
        i
      );
    };
    return /* @__PURE__ */ jsxs(
      "tr",
      {
        className: cn(
          bold ? "bg-white" : check ? "bg-amber-50/40" : isVarianceRow ? "bg-white" : "bg-white hover:bg-slate-50/60"
        ),
        children: [
          /* @__PURE__ */ jsx(
            "td",
            {
              className: cn(
                "sticky left-0 z-[1] border border-border px-3 py-[7px] text-[12px] text-text-primary whitespace-nowrap",
                TABLE_LABEL_COL_WIDTH,
                bold ? "bg-white" : check ? "bg-amber-50/40" : "bg-white",
                indent && "pl-7",
                bold && "font-semibold",
                check && "text-amber-700 italic"
              ),
              children: label
            }
          ),
          values.map(
            (val, i) => renderCell(val, rawValues ? rawValues[i] : null, i)
          )
        ]
      }
    );
  };
  const StatusBanner = ({ sync }) => sync.status === "idle" ? null : /* @__PURE__ */ jsxs(
    "div",
    {
      className: cn(
        "mt-4 flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-[13px]",
        sync.status === "error" ? "border-negative/20 text-negative" : sync.status === "success" ? "border-primary/20 text-primary" : "border-border text-text-secondary"
      ),
      children: [
        sync.status === "loading" ? /* @__PURE__ */ jsx(LoaderCircle, { size: 16, className: "animate-spin" }) : sync.status === "error" ? /* @__PURE__ */ jsx(AlertCircle, { size: 16 }) : /* @__PURE__ */ jsx(CheckCircle2, { size: 16 }),
        sync.message
      ]
    }
  );
  const renderExtractedBankPdfTable = () => {
    const { months, banks, totals } = extractedBankPdfData;
    if (!banks?.length || !months?.length) return null;
    const METRICS = [
      { key: "startingBalance", label: "Starting Balance", bold: true },
      { key: "deposits", label: "Deposits", bold: false },
      { key: "withdrawals", label: "Withdrawals", bold: false },
      { key: "endingBalance", label: "Ending Balance", bold: true }
    ];
    const monthIndexMap = Object.fromEntries(months.map((m, i) => [m.key, i]));
    return /* @__PURE__ */ jsx("div", { className: "overflow-auto max-h-[600px] rounded-xl border border-border shadow-sm", children: /* @__PURE__ */ jsxs("table", { className: "min-w-full border-collapse bg-white text-[13px]", children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "border-b border-primary/15 bg-[#F8FBF1]", children: [
        /* @__PURE__ */ jsx("th", { className: "sticky left-0 top-0 z-30 w-40 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary", children: "Bank" }),
        /* @__PURE__ */ jsx("th", { className: "sticky left-[160px] top-0 z-20 w-36 border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary", children: "Metric" }),
        months.map((m) => /* @__PURE__ */ jsx(
          "th",
          {
            className: "sticky top-0 z-20 min-w-[110px] whitespace-nowrap border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary",
            children: m.label
          },
          m.key
        )),
        /* @__PURE__ */ jsx("th", { className: "sticky top-0 z-20 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-center text-[12px] font-semibold text-primary", children: "Total" })
      ] }) }),
      /* @__PURE__ */ jsxs("tbody", { children: [
        banks.map((bank, bi) => {
          const bankMonthMap = Object.fromEntries(
            (bank.months || []).map((m) => [m.monthKey, m])
          );
          return METRICS.map((metric, mi) => /* @__PURE__ */ jsxs(
            "tr",
            {
              className: metric.bold ? "bg-white" : "bg-white hover:bg-slate-50/60",
              children: [
                mi === 0 && /* @__PURE__ */ jsx(
                  "td",
                  {
                    rowSpan: METRICS.length,
                    className: "sticky left-0 z-[1] bg-white border border-border px-3 py-[7px] text-[12px] font-semibold text-text-primary align-middle",
                    children: bank.bankName
                  }
                ),
                /* @__PURE__ */ jsx(
                  "td",
                  {
                    className: cn(
                      "sticky left-[160px] z-[1] bg-white border border-border px-3 py-[7px] text-[12px] text-text-primary whitespace-nowrap",
                      metric.bold && "font-semibold"
                    ),
                    children: metric.label
                  }
                ),
                months.map((m) => {
                  const val = bankMonthMap[m.key]?.[metric.key] ?? null;
                  return /* @__PURE__ */ jsx(
                    "td",
                    {
                      className: cn(
                        "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                        metric.bold && "font-semibold"
                      ),
                      children: fmtAmt(val)
                    },
                    m.key
                  );
                }),
                /* @__PURE__ */ jsx(
                  "td",
                  {
                    className: cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary",
                      metric.bold && "font-semibold"
                    ),
                    children: fmtAmt(bank.totals?.[metric.key] ?? null)
                  }
                )
              ]
            },
            `${bi}-${metric.key}`
          ));
        }),
        /* @__PURE__ */ jsx("tr", { children: /* @__PURE__ */ jsx(
          "td",
          {
            colSpan: months.length + 3,
            className: "border-x border-border bg-slate-100 py-[3px]"
          }
        ) }),
        METRICS.map((metric) => {
          const monthValues = months.map((m) => {
            const entry = (totals || []).find((t) => t.monthKey === m.key);
            return entry?.[metric.key] ?? null;
          });
          const grandTotal = monthValues.reduce(
            (sum, v) => sum + (v ?? 0),
            0
          );
          return /* @__PURE__ */ jsxs(
            "tr",
            {
              className: metric.bold ? "bg-[#F8FBF1]" : "bg-[#F8FBF1] hover:bg-[#F2F8E7]",
              children: [
                metric.key === "startingBalance" && /* @__PURE__ */ jsx(
                  "td",
                  {
                    rowSpan: METRICS.length,
                    className: "sticky left-0 z-[1] bg-[#F8FBF1] border border-border px-3 py-[7px] text-[12px] font-semibold text-primary align-middle",
                    children: "All Banks"
                  }
                ),
                metric.key !== "startingBalance" ? null : null,
                /* @__PURE__ */ jsx(
                  "td",
                  {
                    className: cn(
                      "sticky left-[160px] z-[1] bg-[#F8FBF1] border border-border px-3 py-[7px] text-[12px] text-primary whitespace-nowrap",
                      metric.bold && "font-semibold"
                    ),
                    children: metric.label
                  }
                ),
                monthValues.map((val, i) => /* @__PURE__ */ jsx(
                  "td",
                  {
                    className: cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                      metric.bold && "font-semibold"
                    ),
                    children: fmtAmt(val)
                  },
                  i
                )),
                /* @__PURE__ */ jsx(
                  "td",
                  {
                    className: cn(
                      "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-primary",
                      metric.bold && "font-semibold"
                    ),
                    children: fmtAmt(grandTotal)
                  }
                )
              ]
            },
            `total-${metric.key}`
          );
        })
      ] })
    ] }) });
  };
  const renderOneBankActivityTable = () => {
    const rows = qbOneBankActivity?.monthlyData || [];
    if (!rows.length) return null;
    return /* @__PURE__ */ jsx("div", { className: "mt-4 overflow-auto max-h-[600px] rounded-xl border border-border shadow-sm", children: /* @__PURE__ */ jsxs("table", { className: "min-w-full border-collapse bg-white text-[13px]", children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "border-b border-primary/15 bg-[#F8FBF1]", children: [
        /* @__PURE__ */ jsx("th", { className: "sticky left-0 top-0 z-30 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-left text-[12px] font-semibold text-primary", children: "Month" }),
        /* @__PURE__ */ jsx("th", { className: "sticky top-0 z-20 min-w-[140px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary", children: "Starting Balance" }),
        /* @__PURE__ */ jsx("th", { className: "sticky top-0 z-20 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary", children: "Deposits" }),
        /* @__PURE__ */ jsx("th", { className: "sticky top-0 z-20 min-w-[110px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary", children: "Withdrawals" }),
        /* @__PURE__ */ jsx("th", { className: "sticky top-0 z-20 min-w-[130px] border border-border bg-[#F8FBF1] px-4 py-3 text-right text-[12px] font-semibold text-primary", children: "Ending Balance" })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: rows.map((row) => /* @__PURE__ */ jsxs("tr", { className: "bg-white hover:bg-slate-50/60", children: [
        /* @__PURE__ */ jsx("td", { className: "sticky left-0 z-[1] bg-white border border-border px-3 py-[7px] text-[12px] text-text-primary", children: monthLabel(row.month) }),
        /* @__PURE__ */ jsx("td", { className: "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary", children: fmtAmt(row.startingBalance) }),
        /* @__PURE__ */ jsx("td", { className: "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary", children: fmtAmt(row.deposits) }),
        /* @__PURE__ */ jsx("td", { className: "border border-border px-3 py-[7px] text-right text-[12px] tabular-nums text-text-primary", children: fmtAmt(row.withdrawals) }),
        /* @__PURE__ */ jsx("td", { className: "border border-border px-3 py-[7px] text-right text-[12px] font-semibold tabular-nums text-text-primary", children: fmtAmt(row.endingBalance) })
      ] }, row.month)) })
    ] }) });
  };
  const makePerBalanceSheetResolver = (bankName) => {
    const monthlyAmounts = matchBsBank(bankName, bsMonthlyBalances?.bankAccounts)?.monthAmounts || null;
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
      ttm: (ttmRows) => monthlyAmounts ? [...ttmRows].reverse().find((r) => r.perBalanceSheet != null)?.perBalanceSheet ?? null : pointBalance
    };
  };
  const renderManualBalanceAccountTable = (bank, label) => {
    const pdfMonths = filteredPdfMonths;
    const monthMap = bank ? Object.fromEntries((bank.months || []).map((m) => [m.monthKey, m])) : {};
    const bankLabel = label || bank?.bankName || "Bank Account";
    const colCount = pdfMonths.length + 2;
    const perBS = makePerBalanceSheetResolver(bank?.bankName);
    if (bank?.bankName) {
      const monthlyMatch = matchBsBank(bank.bankName, bsMonthlyBalances?.bankAccounts);
      const pointMatch = matchBsBank(bank.bankName, bsBankBalances?.bankAccounts);
      if (monthlyMatch || pointMatch) {
        console.log(`[BsMatch] ${JSON.stringify({
          selectedBank: bank.bankName,
          monthlyBalanceSheet: monthlyMatch ? { matchedAccount: monthlyMatch.name, months: Object.keys(monthlyMatch.monthAmounts || {}).length } : null,
          pointInTime: pointMatch ? {
            detectedYear: bsBankBalances?.year,
            balanceSheetSource: bsBankBalances?.source,
            matchedBalanceSheetFile: bsBankBalances?.fileName,
            matchedAccount: pointMatch.name,
            extractedAmount: pointMatch.amount
          } : null
        })}`);
      } else {
        console.warn(
          `[BsMatch] No matching bank account found in Balance Sheet for "${bank.bankName}".`,
          `Monthly BS: ${bsMonthlyBalances?.bankAccounts?.map((b) => b.name).join(", ") || "none"}.`,
          `Point-in-time: ${bsBankBalances?.bankAccounts?.map((b) => b.name).join(", ") || "none"}.`
        );
      }
    }
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
        outstandingChecks: 0
      };
    });
    const rows = baseRows.map((r, i) => {
      const footingCheck = r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals);
      const priorMonthCheck = i === 0 ? 0 : baseRows[i - 1].endingBalance - r.startingBalance;
      const outstandingChecks = 0;
      const variance = r.perBalanceSheet != null ? r.endingBalance - r.perBalanceSheet : null;
      const unreconciledDollar = variance != null ? variance - outstandingChecks : null;
      const unreconciledPct = variance != null && r.perBalanceSheet !== 0 ? unreconciledDollar / r.perBalanceSheet * 100 : null;
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
        unreconciledPct: null
      }),
      buildEmptyTTM()
    );
    const ttm = { ...ttmBase };
    const ttmPerBS = perBS.ttm(ttmSlice);
    if (ttmPerBS != null) {
      ttm.perBalanceSheet = ttmPerBS;
      ttm.variance = ttm.endingBalance - ttmPerBS;
      ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
      ttm.unreconciledPct = ttmPerBS !== 0 ? ttm.unreconciledDollar / ttmPerBS * 100 : null;
    }
    const v = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const va = (f) => [...rows.map((r) => fmtAcct(r[f])), fmtAcct(ttm[f])];
    const rawNums = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];
    const overallStatus = bank?.status || (rows.every((r) => Math.abs(r.footingCheck) <= 1) ? "Verified" : "Needs Review");
    return /* @__PURE__ */ jsxs("div", { className: "mb-4 rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex w-full items-center justify-between overflow-clip rounded-t-[var(--radius-card)] border-b border-primary/15 bg-[#F8FBF1] px-4 py-3", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 flex-wrap", children: [
          /* @__PURE__ */ jsx("span", { className: "text-[14px] font-semibold text-primary", children: bankLabel }),
          bank?.accountName && /* @__PURE__ */ jsx("span", { className: "text-[12px] text-text-secondary", children: bank.accountName }),
          bank?.accountNumber && /* @__PURE__ */ jsxs("span", { className: "rounded-full bg-bg-page px-2 py-0.5 text-[11px] font-mono text-text-muted border border-border", children: [
            "\xB7\xB7\xB7",
            String(bank.accountNumber).slice(-4)
          ] })
        ] }),
        bank && /* @__PURE__ */ jsx("span", { className: `rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${overallStatus === "Verified" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`, children: overallStatus })
      ] }),
      isLoadingExtractedBankPdfData || extractedBankPdfFetchStatus.status === "loading" ? /* @__PURE__ */ jsxs("div", { className: "border-t border-border bg-white flex items-center justify-center gap-2.5 px-4 py-8 text-[13px] font-medium text-text-secondary", children: [
        /* @__PURE__ */ jsx(LoaderCircle, { size: 16, className: "animate-spin text-primary" }),
        "Loading bank statement data from backend..."
      ] }) : pdfMonths.length === 0 ? /* @__PURE__ */ jsx("div", { className: "border-t border-border bg-white px-4 py-5 text-[13px] text-text-muted", children: "No data available." }) : /* @__PURE__ */ jsxs(FreezeTable, { months: pdfMonths, label: bankLabel, containerClass: "border-t border-border bg-white", children: [
        /* @__PURE__ */ jsx(DR, { label: "Starting Balance", values: v("startingBalance"), bold: true }),
        /* @__PURE__ */ jsx(DR, { label: "Deposits", values: v("deposits") }),
        /* @__PURE__ */ jsx(DR, { label: "Withdrawals", values: v("withdrawals") }),
        /* @__PURE__ */ jsx(DR, { label: "Ending Balance", values: v("endingBalance"), bold: true }),
        /* @__PURE__ */ jsx(SpacerRow, { colCount }),
        /* @__PURE__ */ jsx(DR, { label: "Intercompany Deposits", values: v("intercompanyDeposits"), indent: true }),
        /* @__PURE__ */ jsx(DR, { label: "Intercompany Withdraws", values: v("intercompanyWithdraws"), indent: true }),
        /* @__PURE__ */ jsx(SpacerRow, { colCount }),
        /* @__PURE__ */ jsx(DR, { label: "Footing Check", values: va("footingCheck"), check: true }),
        /* @__PURE__ */ jsx(DR, { label: "Prior Month Check", values: va("priorMonthCheck"), check: true }),
        /* @__PURE__ */ jsx(SpacerRow, { colCount }),
        /* @__PURE__ */ jsx(DR, { label: "Per Balance Sheet", values: v("perBalanceSheet"), bold: true }),
        /* @__PURE__ */ jsx(
          DR,
          {
            label: "Variance",
            values: rawNums("variance"),
            rawValues: rawNums("variance"),
            rowType: "variance-amt"
          }
        ),
        /* @__PURE__ */ jsx(SpacerRow, { colCount }),
        /* @__PURE__ */ jsx(DR, { label: "Outstanding Checks", values: v("outstandingChecks") }),
        /* @__PURE__ */ jsx(
          DR,
          {
            label: "Unreconciled $ Variance",
            values: rawNums("unreconciledDollar"),
            rawValues: rawNums("unreconciledDollar"),
            rowType: "variance-amt"
          }
        ),
        /* @__PURE__ */ jsx(
          DR,
          {
            label: "Unreconciled % Variance",
            values: rawNums("unreconciledPct"),
            rawValues: rawNums("unreconciledPct"),
            rowType: "variance-pct"
          }
        )
      ] })
    ] });
  };
  const renderBalanceAccountTable = (account) => {
    const { rows, ttm } = buildAccountBalanceDataFromQB(account);
    const isExpanded = expandedAccounts[account.accountId];
    const colCount = reportMonths.length + 2;
    const accountLabel = `${account.accountName} (${account.accountNumber ?? ""})`;
    const v = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const va = (f) => [...rows.map((r) => fmtAcct(r[f])), fmtAcct(ttm[f])];
    const rawNums = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];
    return /* @__PURE__ */ jsxs(
      "div",
      {
        className: "mb-4 rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]",
        children: [
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "flex w-full items-center justify-between overflow-clip rounded-t-[var(--radius-card)] border-b border-primary/15 bg-[#F8FBF1] px-4 py-3 font-semibold text-primary transition-colors hover:bg-[#F2F8E7]",
              onClick: () => setExpandedAccounts((p) => ({
                ...p,
                [account.accountId]: !p?.[account.accountId]
              })),
              children: [
                /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
                  /* @__PURE__ */ jsx("span", { className: "text-[14px] font-semibold", children: account.accountName }),
                  /* @__PURE__ */ jsxs("span", { className: "rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-primary", children: [
                    "QB: ",
                    accountLabel
                  ] })
                ] }),
                isExpanded ? /* @__PURE__ */ jsx(ChevronDown, { size: 18 }) : /* @__PURE__ */ jsx(ChevronRight, { size: 18 })
              ]
            }
          ),
          isExpanded && (isLoadingBankActivity ? /* @__PURE__ */ jsxs("div", { className: "border-t border-border bg-white flex items-center gap-2 px-4 py-5 text-[13px] text-text-secondary", children: [
            /* @__PURE__ */ jsx(LoaderCircle, { size: 15, className: "animate-spin" }),
            "Loading QuickBooks bank activity..."
          ] }) : rows.length === 0 ? /* @__PURE__ */ jsx("div", { className: "border-t border-border bg-white px-4 py-5 text-[13px] text-text-muted", children: "No data for this bank account." }) : /* @__PURE__ */ jsxs(FreezeTable, { months: reportMonths, label: account.accountName, containerClass: "border-t border-border bg-white", children: [
            /* @__PURE__ */ jsx(DR, { label: "Starting Balance", values: v("startingBalance"), bold: true }),
            /* @__PURE__ */ jsx(DR, { label: "Deposits", values: v("deposits") }),
            /* @__PURE__ */ jsx(DR, { label: "Withdrawals", values: v("withdrawals") }),
            /* @__PURE__ */ jsx(DR, { label: "Ending Balance", values: v("endingBalance"), bold: true }),
            /* @__PURE__ */ jsx(SpacerRow, { colCount }),
            /* @__PURE__ */ jsx(DR, { label: "Intercompany Deposits", values: v("intercompanyDeposits"), indent: true }),
            /* @__PURE__ */ jsx(DR, { label: "Intercompany Withdraws", values: v("intercompanyWithdraws"), indent: true }),
            /* @__PURE__ */ jsx(SpacerRow, { colCount }),
            /* @__PURE__ */ jsx(DR, { label: "Footing Check", values: va("footingCheck"), check: true }),
            /* @__PURE__ */ jsx(DR, { label: "Prior Month Check", values: va("priorMonthCheck"), check: true }),
            /* @__PURE__ */ jsx(SpacerRow, { colCount }),
            /* @__PURE__ */ jsx(DR, { label: "Per Balance Sheet", values: v("perBalanceSheet"), bold: true }),
            /* @__PURE__ */ jsx(
              DR,
              {
                label: "Variance",
                values: rawNums("variance"),
                rawValues: rawNums("variance"),
                rowType: "variance-amt"
              }
            ),
            /* @__PURE__ */ jsx(SpacerRow, { colCount }),
            /* @__PURE__ */ jsx(DR, { label: "Outstanding Checks", values: v("outstandingChecks") }),
            /* @__PURE__ */ jsx(
              DR,
              {
                label: "Unreconciled $ Variance",
                values: rawNums("unreconciledDollar"),
                rawValues: rawNums("unreconciledDollar"),
                rowType: "variance-amt"
              }
            ),
            /* @__PURE__ */ jsx(
              DR,
              {
                label: "Unreconciled % Variance",
                values: rawNums("unreconciledPct"),
                rawValues: rawNums("unreconciledPct"),
                rowType: "variance-pct"
              }
            )
          ] }))
        ]
      },
      account.accountId
    );
  };
  const buildAccountChangeRows = (field, months) => {
    const byKey = /* @__PURE__ */ new Map();
    months.forEach((month) => {
      for (const item of activityReview?.[month]?.[field] || []) {
        if (!item?.key) continue;
        if (!byKey.has(item.key)) byKey.set(item.key, { key: item.key, label: item.label, byMonth: {} });
        const entry = byKey.get(item.key);
        entry.byMonth[month] = (entry.byMonth[month] || 0) + (Number(item.amount) || 0);
      }
    });
    const ttmMonths = months.slice(-12);
    return [...byKey.values()].map((e) => ({
      key: e.key,
      label: e.label,
      values: [
        ...months.map((m) => e.byMonth[m] ?? 0),
        ttmMonths.reduce((sum, m) => sum + (e.byMonth[m] ?? 0), 0)
      ]
    })).filter((e) => e.values.some((v) => v !== 0)).sort((a, b) => a.label.localeCompare(b.label));
  };
  const renderActivityTableCore = (rows, ttm, months) => {
    const colCount = months.length + 2;
    const av = (f) => [...rows.map((r) => fmtAmt(r[f])), fmtAmt(ttm[f])];
    const avRaw = (f) => [...rows.map((r) => r[f] ?? null), ttm[f] ?? null];
    const depAssetRows = buildAccountChangeRows("depositsAssetChanges", months);
    const depLiabRows = buildAccountChangeRows("depositsLiabilityChanges", months);
    const depLTAssetRows = buildAccountChangeRows("depositsLongTermAssetChanges", months);
    const depLTLiabRows = buildAccountChangeRows("depositsLongTermLiabilityChanges", months);
    const wdrAssetRows = buildAccountChangeRows("withdrawalsAssetChanges", months);
    const wdrLiabRows = buildAccountChangeRows("withdrawalsLiabilityChanges", months);
    const wdrLTAssetRows = buildAccountChangeRows("withdrawalsLongTermAssetChanges", months);
    const wdrLTLiabRows = buildAccountChangeRows("withdrawalsLongTermLiabilityChanges", months);
    const acctRows = (list) => list.map((r) => /* @__PURE__ */ jsx(DR, { label: r.label, values: r.values.map(fmtAmt), indent: true }, r.key));
    const depAddbackMap = {};
    const wdrAddbackMap = {};
    addbackItems.forEach((item) => {
      const map = item.section === "deposits" ? depAddbackMap : wdrAddbackMap;
      Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => {
        map[m] = (map[m] || 0) + Number(amt);
      });
    });
    const depositsUnrecAdj = rows.map(
      (r) => r.depositsDollarVar + (depAddbackMap[r.month] ?? 0)
    );
    const depositsUnrecPctAdj = rows.map(
      (r, i) => r.salesPerFinancials !== 0 ? depositsUnrecAdj[i] / r.salesPerFinancials * 100 : 0
    );
    const ttmDepositsUnrecAdj = months.slice(-12).reduce(
      (sum, m) => sum + (depAddbackMap[m] ?? 0),
      ttm.depositsDollarVar
    );
    const ttmDepositsUnrecPctAdj = ttm.salesPerFinancials !== 0 ? ttmDepositsUnrecAdj / ttm.salesPerFinancials * 100 : 0;
    const withdrawsUnrecAdj = rows.map(
      (r) => r.withdrawsDollarVar + (wdrAddbackMap[r.month] ?? 0)
    );
    const withdrawsUnrecPctAdj = rows.map(
      (r, i) => r.expensesPerFinancials !== 0 ? withdrawsUnrecAdj[i] / r.expensesPerFinancials * 100 : 0
    );
    const ttmWithdrawsUnrecAdj = months.slice(-12).reduce(
      (sum, m) => sum + (wdrAddbackMap[m] ?? 0),
      ttm.withdrawsDollarVar
    );
    const ttmWithdrawsUnrecPctAdj = ttm.expensesPerFinancials !== 0 ? ttmWithdrawsUnrecAdj / ttm.expensesPerFinancials * 100 : 0;
    const adjDepURaw = [...depositsUnrecAdj, ttmDepositsUnrecAdj];
    const adjDepPctRaw = [...depositsUnrecPctAdj, ttmDepositsUnrecPctAdj];
    const adjWdrURaw = [...withdrawsUnrecAdj, ttmWithdrawsUnrecAdj];
    const adjWdrPctRaw = [...withdrawsUnrecPctAdj, ttmWithdrawsUnrecPctAdj];
    return /* @__PURE__ */ jsxs(FreezeTable, { months, label: "Activity Review", containerClass: "rounded-xl border border-border shadow-sm", children: [
      /* @__PURE__ */ jsx(DR, { label: "Total Deposits", values: av("totalDeposits"), bold: true }),
      /* @__PURE__ */ jsx(DR, { label: "Intercompany Transfers", values: av("withdrawIntercompanyTransfers"), indent: true }),
      /* @__PURE__ */ jsx(DR, { label: "External Deposits", values: av("externalDeposits"), bold: true }),
      /* @__PURE__ */ jsx(DR, { label: "Sales per Financials", values: av("salesPerFinancials") }),
      /* @__PURE__ */ jsx(DR, { label: "$ Variance", values: avRaw("depositsDollarVar"), rawValues: avRaw("depositsDollarVar"), rowType: "variance-amt" }),
      /* @__PURE__ */ jsx(DR, { label: "% Variance", values: avRaw("depositsPctVar"), rawValues: avRaw("depositsPctVar"), rowType: "variance-pct" }),
      /* @__PURE__ */ jsx(SpacerRow, { colCount }),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Changes in Assets", months }),
      acctRows(depAssetRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Changes in Liabilities", months }),
      acctRows(depLiabRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Long-Term Assets", months }),
      acctRows(depLTAssetRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Long-Term Liabilities", months }),
      acctRows(depLTLiabRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "P&L Account Adjustments", months }),
      /* @__PURE__ */ jsx(
        AddbacksRowGroup,
        {
          section: "deposits",
          months,
          addbackItems,
          onSaveAmounts: updateAddbackItemAmounts,
          onDelete: deleteAddbackItem,
          onOpenPicker: () => {
            const [sy, sm] = bankActivityStartMonth.split("-");
            const startDate = `${sy}-${sm}-01`;
            const [ey, em] = bankActivityEndMonth.split("-");
            const lastDay = new Date(+ey, +em, 0).getDate();
            const endDate = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;
            setAddbackPickerState({ open: true, section: "deposits", startDate, endDate, months });
          }
        }
      ),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Other Adjustments", months }),
      /* @__PURE__ */ jsx(DR, { label: "Unreconciled Variance $", values: adjDepURaw, rawValues: adjDepURaw, rowType: "variance-amt" }),
      /* @__PURE__ */ jsx(DR, { label: "Unreconciled Variance %", values: adjDepPctRaw, rawValues: adjDepPctRaw, rowType: "variance-pct" }),
      /* @__PURE__ */ jsx(SpacerRow, { colCount }),
      /* @__PURE__ */ jsx(DR, { label: "Total Withdrawals", values: av("totalWithdrawals"), bold: true }),
      /* @__PURE__ */ jsx(DR, { label: "Intercompany Transfers", values: av("intercompanyTransfers"), indent: true }),
      /* @__PURE__ */ jsx(DR, { label: "External Withdraws", values: av("externalWithdraws"), bold: true }),
      /* @__PURE__ */ jsx(DR, { label: "Expenses per Financials", values: av("expensesPerFinancials") }),
      /* @__PURE__ */ jsx(DR, { label: "$ Variance", values: avRaw("withdrawsDollarVar"), rawValues: avRaw("withdrawsDollarVar"), rowType: "variance-amt" }),
      /* @__PURE__ */ jsx(DR, { label: "% Variance", values: avRaw("withdrawsPctVar"), rawValues: avRaw("withdrawsPctVar"), rowType: "variance-pct" }),
      /* @__PURE__ */ jsx(SpacerRow, { colCount }),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Changes in Assets", months }),
      acctRows(wdrAssetRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Changes in Liabilities", months }),
      acctRows(wdrLiabRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Long-Term Assets", months }),
      acctRows(wdrLTAssetRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Long-Term Liabilities", months }),
      acctRows(wdrLTLiabRows),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "P&L Account Adjustments", months }),
      /* @__PURE__ */ jsx(
        AddbacksRowGroup,
        {
          section: "withdrawals",
          months,
          addbackItems,
          onSaveAmounts: updateAddbackItemAmounts,
          onDelete: deleteAddbackItem,
          onOpenPicker: () => {
            const [sy, sm] = bankActivityStartMonth.split("-");
            const startDate = `${sy}-${sm}-01`;
            const [ey, em] = bankActivityEndMonth.split("-");
            const lastDay = new Date(+ey, +em, 0).getDate();
            const endDate = `${ey}-${em}-${String(lastDay).padStart(2, "0")}`;
            setAddbackPickerState({ open: true, section: "withdrawals", startDate, endDate, months });
          }
        }
      ),
      /* @__PURE__ */ jsx(GroupHeaderRow, { label: "Other Adjustments", months }),
      /* @__PURE__ */ jsx(DR, { label: "Unreconciled Variance $", values: adjWdrURaw, rawValues: adjWdrURaw, rowType: "variance-amt" }),
      /* @__PURE__ */ jsx(DR, { label: "Unreconciled Variance %", values: adjWdrPctRaw, rawValues: adjWdrPctRaw, rowType: "variance-pct" })
    ] });
  };
  const renderActivityTable = () => {
    if (!hasData) return null;
    return renderActivityTableCore(activityRows, activityTTM, reportMonths);
  };
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
      const depositsPctVar = salesPerFinancials !== 0 ? depositsDollarVar / salesPerFinancials * 100 : 0;
      const depositsUnreconciledDollar = depositsDollarVar;
      const depositsUnreconciledPct = salesPerFinancials !== 0 ? depositsUnreconciledDollar / salesPerFinancials * 100 : 0;
      const externalWithdraws = totalWithdrawals;
      const expensesPerFinancials = plFinancials?.totalExpenses?.[mk] ?? 0;
      const withdrawsDollarVar = externalWithdraws - expensesPerFinancials;
      const withdrawsPctVar = expensesPerFinancials !== 0 ? withdrawsDollarVar / expensesPerFinancials * 100 : 0;
      const withdrawsUnreconciledDollar = withdrawsDollarVar;
      const withdrawsUnreconciledPct = expensesPerFinancials !== 0 ? withdrawsUnreconciledDollar / expensesPerFinancials * 100 : 0;
      const adj = activityReview?.[mk] || {};
      return {
        month: mk,
        totalDeposits,
        intercompanyTransfers: 0,
        externalDeposits,
        salesPerFinancials,
        depositsDollarVar,
        depositsPctVar,
        changeInAR: adj.changeInAR ?? 0,
        changeInARRetentions: adj.changeInARRetentions ?? 0,
        changeInCurrentAssets: adj.changeInCurrentAssets ?? 0,
        fixedAssetDisposals: adj.fixedAssetDisposals ?? 0,
        depositsOther: 0,
        depositsUnreconciledDollar,
        depositsUnreconciledPct,
        totalWithdrawals,
        withdrawIntercompanyTransfers: 0,
        externalWithdraws,
        expensesPerFinancials,
        withdrawsDollarVar,
        withdrawsPctVar,
        ownerWithdraws: 0,
        changeInCurrentLiabilities: adj.changeInCurrentLiabilities ?? 0,
        changeInLTLiabilities: adj.changeInLTLiabilities ?? 0,
        depreciationExpense: adj.depreciationExpense ?? 0,
        amortizationExpense: adj.amortizationExpense ?? 0,
        badDebtExpense: adj.badDebtExpense ?? 0,
        fixedAssetPurchases: adj.fixedAssetPurchases ?? 0,
        withdrawsOther: 0,
        withdrawsUnreconciledDollar,
        withdrawsUnreconciledPct
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
      changeInAR: 0,
      changeInARRetentions: 0,
      changeInCurrentAssets: 0,
      fixedAssetDisposals: 0,
      depositsOther: 0,
      depositsUnreconciledDollar: acc.depositsUnreconciledDollar + r.depositsUnreconciledDollar,
      depositsUnreconciledPct: 0,
      totalWithdrawals: acc.totalWithdrawals + r.totalWithdrawals,
      withdrawIntercompanyTransfers: 0,
      externalWithdraws: acc.externalWithdraws + r.externalWithdraws,
      expensesPerFinancials: acc.expensesPerFinancials + r.expensesPerFinancials,
      withdrawsDollarVar: acc.withdrawsDollarVar + r.withdrawsDollarVar,
      withdrawsPctVar: 0,
      ownerWithdraws: 0,
      changeInCurrentLiabilities: 0,
      changeInLTLiabilities: 0,
      depreciationExpense: 0,
      amortizationExpense: 0,
      badDebtExpense: 0,
      fixedAssetPurchases: 0,
      withdrawsOther: 0,
      withdrawsUnreconciledDollar: acc.withdrawsUnreconciledDollar + r.withdrawsUnreconciledDollar,
      withdrawsUnreconciledPct: 0
    }),
    buildEmptyActivityReviewRow()
  );
  const manualActivityTTM = {
    ..._manualTTMBase,
    depositsPctVar: _manualTTMBase.salesPerFinancials !== 0 ? _manualTTMBase.depositsDollarVar / _manualTTMBase.salesPerFinancials * 100 : 0,
    depositsUnreconciledPct: _manualTTMBase.salesPerFinancials !== 0 ? _manualTTMBase.depositsUnreconciledDollar / _manualTTMBase.salesPerFinancials * 100 : 0,
    withdrawsPctVar: _manualTTMBase.expensesPerFinancials !== 0 ? _manualTTMBase.withdrawsDollarVar / _manualTTMBase.expensesPerFinancials * 100 : 0,
    withdrawsUnreconciledPct: _manualTTMBase.expensesPerFinancials !== 0 ? _manualTTMBase.withdrawsUnreconciledDollar / _manualTTMBase.expensesPerFinancials * 100 : 0
  };
  const renderManualActivityTable = () => {
    return renderActivityTableCore(manualActivityRows, manualActivityTTM, filteredPdfMonths);
  };
  const exportBankReconToExcel = () => {
    const isManual = isManualUpload || isManualGl || isQBManual;
    const months = isManual ? filteredPdfMonths : reportMonths;
    if (!months.length) {
      alert("No data to export.");
      return;
    }
    const colHeaders = ["", ...months.map(monthLabel), "TTM"];
    const wb = XLSX.utils.book_new();
    const fmtN = (val) => val == null ? "" : Number(val) || 0;
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
        []
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
          const unreconciledPct = variance != null && r.perBalanceSheet !== 0 ? unreconciledDollar / r.perBalanceSheet * 100 : null;
          return {
            ...r,
            footingCheck: r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals),
            priorMonthCheck: i === 0 ? 0 : baseRows[i - 1].endingBalance - r.startingBalance,
            variance,
            outstandingChecks: 0,
            unreconciledDollar,
            unreconciledPct
          };
        });
        const ttmSlice = rows.slice(-12);
        const ttm = ttmSlice.reduce((acc, r, i) => ({
          startingBalance: i === 0 ? r.startingBalance : acc.startingBalance,
          deposits: acc.deposits + r.deposits,
          withdrawals: acc.withdrawals + r.withdrawals,
          endingBalance: r.endingBalance,
          footingCheck: acc.footingCheck + r.footingCheck,
          priorMonthCheck: acc.priorMonthCheck + r.priorMonthCheck,
          perBalanceSheet: null,
          variance: null,
          outstandingChecks: 0,
          unreconciledDollar: null,
          unreconciledPct: null
        }), {
          startingBalance: 0,
          deposits: 0,
          withdrawals: 0,
          endingBalance: 0,
          footingCheck: 0,
          priorMonthCheck: 0,
          perBalanceSheet: null,
          variance: null,
          outstandingChecks: 0,
          unreconciledDollar: null,
          unreconciledPct: null
        });
        const ttmPerBS = perBS.ttm(ttmSlice);
        if (ttmPerBS != null) {
          ttm.perBalanceSheet = ttmPerBS;
          ttm.variance = ttm.endingBalance - ttmPerBS;
          ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
          ttm.unreconciledPct = ttmPerBS !== 0 ? ttm.unreconciledDollar / ttmPerBS * 100 : null;
        }
        allRows.push(...bankRows(bank.bankName || "Bank Account", rows, ttm));
      });
    } else {
      for (const account of qbBankActivity?.accounts || []) {
        const { rows, ttm } = buildAccountBalanceDataFromQB(account);
        allRows.push(...bankRows(account.accountName, rows, ttm));
      }
    }
    const actRows = isManual ? manualActivityRows : activityRows;
    const actTTM = isManual ? manualActivityTTM : activityTTM;
    if (actRows.length) {
      const depMap = {}, wdrMap = {};
      addbackItems.forEach((item) => {
        const map = item.section === "deposits" ? depMap : wdrMap;
        Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => {
          map[m] = (map[m] || 0) + Number(amt);
        });
      });
      const depUnrec = actRows.map((r) => r.depositsDollarVar + (depMap[r.month] ?? 0));
      const ttmDepUnrec = months.slice(-12).reduce((s, m) => s + (depMap[m] ?? 0), actTTM.depositsDollarVar ?? 0);
      const wdrUnrec = actRows.map((r) => r.withdrawsDollarVar + (wdrMap[r.month] ?? 0));
      const ttmWdrUnrec = months.slice(-12).reduce((s, m) => s + (wdrMap[m] ?? 0), actTTM.withdrawsDollarVar ?? 0);
      const adjDepURaw = [...depUnrec, ttmDepUnrec];
      const adjWdrURaw = [...wdrUnrec, ttmWdrUnrec];
      const av = (f) => [...actRows.map((r) => fmtN(r[f])), fmtN(actTTM[f])];
      const acctCsv = (field) => buildAccountChangeRows(field, months).map((r) => [`  ${r.label}`, ...r.values.map((v) => fmtN(v))]);
      allRows.push(
        ["Activity Review"],
        colHeaders,
        ["Total Deposits", ...av("totalDeposits")],
        ["  Intercompany Transfers", ...av("withdrawIntercompanyTransfers")],
        ["External Deposits", ...av("externalDeposits")],
        ["Sales per Financials", ...av("salesPerFinancials")],
        ["$ Variance", ...adjDepURaw.map((v) => fmtN(v))],
        [],
        ["Changes in Assets"],
        ...acctCsv("depositsAssetChanges"),
        ["Changes in Liabilities"],
        ...acctCsv("depositsLiabilityChanges"),
        ["Long-Term Assets"],
        ...acctCsv("depositsLongTermAssetChanges"),
        ["Long-Term Liabilities"],
        ...acctCsv("depositsLongTermLiabilityChanges"),
        ["P&L Account Adjustments"],
        ...addbackItems.filter((i) => i.section === "deposits").map((item) => [
          `  ${item.name}`,
          ...actRows.map((r) => fmtN(item.monthAmounts[r.month])),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0)
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
        ...acctCsv("withdrawalsAssetChanges"),
        ["Changes in Liabilities"],
        ...acctCsv("withdrawalsLiabilityChanges"),
        ["Long-Term Assets"],
        ...acctCsv("withdrawalsLongTermAssetChanges"),
        ["Long-Term Liabilities"],
        ...acctCsv("withdrawalsLongTermLiabilityChanges"),
        ["P&L Account Adjustments"],
        ...addbackItems.filter((i) => i.section === "withdrawals").map((item) => [
          `  ${item.name}`,
          ...actRows.map((r) => fmtN(item.monthAmounts[r.month])),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0)
        ]),
        ["Other Adjustments"],
        ["Unreconciled Variance $", ...adjWdrURaw.map((v) => fmtN(v))]
      );
    }
    const ws = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, ws, "Bank Reconciliation");
    XLSX.writeFile(wb, "Bank Reconciliation.xlsx");
  };
  const exportBankReconToPdf = () => {
    const isManual = isManualUpload || isManualGl || isQBManual;
    const months = isManual ? filteredPdfMonths : reportMonths;
    if (!months.length) {
      alert("No data to export.");
      return;
    }
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
      if (isNaN(n)) return { text: "-", neg: false };
      if (Math.abs(n) < VARIANCE_ZERO_EPSILON) return { text: "0.00", neg: false };
      const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return { text: n < 0 ? `-${abs}` : `+${abs}`, neg: n < 0 };
    };
    const fmtPct = (val) => {
      if (val == null) return { text: "-", neg: false };
      const n = Number(val);
      if (isNaN(n)) return { text: "-", neg: false };
      if (Math.abs(n) < VARIANCE_PCT_ZERO_EPSILON) return { text: "0.0%", neg: false };
      const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return { text: n < 0 ? `-${abs}%` : `+${abs}%`, neg: n < 0 };
    };
    const drawVertLines = (top, bottom) => {
      doc.setDrawColor(210, 210, 210);
      doc.setLineWidth(0.4);
      doc.line(nameSepX, top, nameSepX, bottom);
      for (let i = 0; i < nValCols - 1; i++) doc.line(valColRight(i), top, valColRight(i), bottom);
    };
    let y = MT;
    const checkPageBreak = () => {
      if (y + ROW_H > PH - MB) {
        doc.addPage();
        y = MT;
      }
    };
    const drawSectionTitle = (title) => {
      checkPageBreak();
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(30, 80, 30);
      doc.text(title, ML, y);
      y += 12;
      doc.setDrawColor(190, 190, 190);
      doc.setLineWidth(0.5);
      doc.line(ML, y, PW - MR, y);
      y += 6;
    };
    const drawTableHeader = (label, cols) => {
      checkPageBreak();
      const top = y, bottom = y + ROW_H + 4;
      doc.setFillColor(237, 239, 242);
      doc.rect(ML, top, CW, bottom - top, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(HDR_FONT);
      doc.setTextColor(60, 60, 60);
      doc.text(label, ML + 4, bottom - 4);
      cols.forEach((col, i) => doc.text(col, valColRight(i) - CELL_PAD, bottom - 4, { align: "right" }));
      y = bottom;
      doc.setDrawColor(30, 30, 30);
      doc.setLineWidth(0.8);
      doc.line(ML, y, PW - MR, y);
      drawVertLines(top, y);
      y += 3;
    };
    const drawRow = (label, values, opts = {}) => {
      checkPageBreak();
      const { bold = false, indent = 0, rowType = "normal" } = opts;
      const top = y, bottom = y + ROW_H;
      if (bold) {
        doc.setFillColor(232, 234, 237);
        doc.rect(ML, top, CW, bottom - top, "F");
      }
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(DATA_FONT);
      doc.setTextColor(bold ? 15 : 45);
      const lbl = doc.splitTextToSize(String(label), NAME_W - indent * 12 - 8)[0] ?? label;
      doc.text(lbl, ML + indent * 12 + 4, bottom - 4);
      values.forEach((val, i) => {
        let text, neg = false;
        if (rowType === "variance-amt") {
          const r = fmtVar(val);
          text = r.text;
          neg = r.neg;
        } else if (rowType === "variance-pct") {
          const r = fmtPct(val);
          text = r.text;
          neg = r.neg;
        } else {
          text = fmt(val);
          neg = typeof val === "number" && val < 0;
        }
        if (!text || text === "") return;
        doc.setTextColor(neg ? 180 : bold ? 15 : 45, neg ? 30 : bold ? 15 : 45, neg ? 30 : bold ? 15 : 45);
        doc.text(text, valColRight(i) - CELL_PAD, bottom - 4, { align: "right" });
      });
      doc.setDrawColor(218, 220, 224);
      doc.setLineWidth(0.3);
      doc.line(ML, bottom, PW - MR, bottom);
      drawVertLines(top, bottom);
      y += ROW_H;
    };
    const spacer = () => {
      y += 4;
    };
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(10, 10, 10);
    doc.text("Bank Reconciliation", PW / 2, y, { align: "center" });
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(60, 60, 60);
    doc.text(`${monthLabel(months[0])} \u2013 ${monthLabel(months[months.length - 1])}`, PW / 2, y, { align: "center" });
    y += 12;
    doc.setDrawColor(190, 190, 190);
    doc.setLineWidth(0.5);
    doc.line(ML, y, PW - MR, y);
    y += 12;
    const colHeaders = [...months.map(monthLabel), "TTM"];
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
        const unreconciledPct = variance != null && r.perBalanceSheet !== 0 ? unreconciledDollar / r.perBalanceSheet * 100 : null;
        return {
          ...r,
          intercompanyDeposits: 0,
          intercompanyWithdraws: 0,
          footingCheck: r.endingBalance - (r.startingBalance + r.deposits - r.withdrawals),
          priorMonthCheck: i === 0 ? 0 : baseRows[i - 1].endingBalance - r.startingBalance,
          variance,
          outstandingChecks: 0,
          unreconciledDollar,
          unreconciledPct
        };
      });
      const ttmSlice = rows.slice(-12);
      const ttm = ttmSlice.reduce((acc, r, i) => ({
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
        unreconciledPct: null
      }), {
        startingBalance: 0,
        deposits: 0,
        withdrawals: 0,
        endingBalance: 0,
        intercompanyDeposits: 0,
        intercompanyWithdraws: 0,
        footingCheck: 0,
        priorMonthCheck: 0,
        perBalanceSheet: null,
        variance: null,
        outstandingChecks: 0,
        unreconciledDollar: null,
        unreconciledPct: null
      });
      const ttmPerBS = perBS.ttm(ttmSlice);
      if (ttmPerBS != null) {
        ttm.perBalanceSheet = ttmPerBS;
        ttm.variance = ttm.endingBalance - ttmPerBS;
        ttm.unreconciledDollar = ttm.variance - ttm.outstandingChecks;
        ttm.unreconciledPct = ttmPerBS !== 0 ? ttm.unreconciledDollar / ttmPerBS * 100 : null;
      }
      const vals = (f) => [...rows.map((r) => r[f]), ttm[f]];
      drawTableHeader(bank.bankName, colHeaders);
      drawRow("Starting Balance", vals("startingBalance"), { bold: true });
      drawRow("Deposits", vals("deposits"));
      drawRow("Withdrawals", vals("withdrawals"));
      drawRow("Ending Balance", vals("endingBalance"), { bold: true });
      spacer();
      drawRow("Footing Check", vals("footingCheck"));
      drawRow("Prior Month Check", vals("priorMonthCheck"));
      spacer();
      drawRow("Per Balance Sheet", vals("perBalanceSheet"), { bold: true });
      drawRow("Variance", vals("variance"), { rowType: "variance-amt" });
      spacer();
      drawRow("Unreconciled $ Variance", vals("unreconciledDollar"), { rowType: "variance-amt" });
      drawRow("Unreconciled % Variance", vals("unreconciledPct"), { rowType: "variance-pct" });
    };
    if (isManual) {
      (extractedBankPdfData?.banks || []).forEach(drawManualBank);
    } else {
      for (const account of qbBankActivity?.accounts || []) {
        drawSectionTitle(account.accountName);
        const { rows, ttm } = buildAccountBalanceDataFromQB(account);
        const vals = (f) => [...rows.map((r) => r[f]), ttm[f]];
        drawTableHeader(account.accountName, colHeaders);
        drawRow("Starting Balance", vals("startingBalance"), { bold: true });
        drawRow("Deposits", vals("deposits"));
        drawRow("Withdrawals", vals("withdrawals"));
        drawRow("Ending Balance", vals("endingBalance"), { bold: true });
        spacer();
        drawRow("Intercompany Deposits", vals("intercompanyDeposits"), { indent: 1 });
        drawRow("Intercompany Withdrawals", vals("intercompanyWithdraws"), { indent: 1 });
        spacer();
        drawRow("Footing Check", vals("footingCheck"));
        drawRow("Prior Month Check", vals("priorMonthCheck"));
        spacer();
        drawRow("Per Balance Sheet", vals("perBalanceSheet"), { bold: true });
        drawRow("Variance", vals("variance"), { rowType: "variance-amt" });
        spacer();
        drawRow("Outstanding Checks", vals("outstandingChecks"));
        drawRow("Unreconciled $ Variance", vals("unreconciledDollar"), { rowType: "variance-amt" });
        drawRow("Unreconciled % Variance", vals("unreconciledPct"), { rowType: "variance-pct" });
      }
    }
    const actRows = isManual ? manualActivityRows : activityRows;
    const actTTM = isManual ? manualActivityTTM : activityTTM;
    if (actRows.length) {
      drawSectionTitle("Activity Review");
      const depMap = {}, wdrMap = {};
      addbackItems.forEach((item) => {
        const map = item.section === "deposits" ? depMap : wdrMap;
        Object.entries(item.monthAmounts || {}).forEach(([m, amt]) => {
          map[m] = (map[m] || 0) + Number(amt);
        });
      });
      const depUnrec = actRows.map((r) => r.depositsDollarVar + (depMap[r.month] ?? 0));
      const ttmDepUnrec = months.slice(-12).reduce((s, m) => s + (depMap[m] ?? 0), actTTM.depositsDollarVar ?? 0);
      const wdrUnrec = actRows.map((r) => r.withdrawsDollarVar + (wdrMap[r.month] ?? 0));
      const ttmWdrUnrec = months.slice(-12).reduce((s, m) => s + (wdrMap[m] ?? 0), actTTM.withdrawsDollarVar ?? 0);
      const adjDepURaw = [...depUnrec, ttmDepUnrec];
      const adjWdrURaw = [...wdrUnrec, ttmWdrUnrec];
      const av = (f) => [...actRows.map((r) => r[f] ?? null), actTTM[f] ?? null];
      const drawAcctRows = (field) => buildAccountChangeRows(field, months).forEach((r) => drawRow(r.label, r.values, { indent: 1 }));
      drawTableHeader("Activity Review", colHeaders);
      drawRow("Total Deposits", av("totalDeposits"), { bold: true });
      drawRow("Intercompany Transfers", av("withdrawIntercompanyTransfers"), { indent: 1 });
      drawRow("External Deposits", av("externalDeposits"), { bold: true });
      drawRow("Sales per Financials", av("salesPerFinancials"));
      drawRow("$ Variance", av("depositsDollarVar"), { rowType: "variance-amt" });
      drawRow("% Variance", av("depositsPctVar"), { rowType: "variance-pct" });
      spacer();
      drawRow("Changes in Assets", [], { bold: true });
      drawAcctRows("depositsAssetChanges");
      drawRow("Changes in Liabilities", [], { bold: true });
      drawAcctRows("depositsLiabilityChanges");
      drawRow("Long-Term Assets", [], { bold: true });
      drawAcctRows("depositsLongTermAssetChanges");
      drawRow("Long-Term Liabilities", [], { bold: true });
      drawAcctRows("depositsLongTermLiabilityChanges");
      drawRow("P&L Account Adjustments", [], { bold: true });
      addbackItems.filter((i) => i.section === "deposits").forEach((item) => {
        drawRow(item.name, [
          ...actRows.map((r) => item.monthAmounts[r.month] ?? null),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0)
        ], { indent: 1 });
      });
      drawRow("Other Adjustments", [], { bold: true });
      drawRow("Unreconciled Variance $", adjDepURaw, { rowType: "variance-amt" });
      spacer();
      drawRow("Total Withdrawals", av("totalWithdrawals"), { bold: true });
      drawRow("Intercompany Transfers", av("intercompanyTransfers"), { indent: 1 });
      drawRow("External Withdrawals", av("externalWithdraws"), { bold: true });
      drawRow("Expenses per Financials", av("expensesPerFinancials"));
      drawRow("$ Variance", av("withdrawsDollarVar"), { rowType: "variance-amt" });
      drawRow("% Variance", av("withdrawsPctVar"), { rowType: "variance-pct" });
      spacer();
      drawRow("Changes in Assets", [], { bold: true });
      drawAcctRows("withdrawalsAssetChanges");
      drawRow("Changes in Liabilities", [], { bold: true });
      drawAcctRows("withdrawalsLiabilityChanges");
      drawRow("Long-Term Assets", [], { bold: true });
      drawAcctRows("withdrawalsLongTermAssetChanges");
      drawRow("Long-Term Liabilities", [], { bold: true });
      drawAcctRows("withdrawalsLongTermLiabilityChanges");
      drawRow("P&L Account Adjustments", [], { bold: true });
      addbackItems.filter((i) => i.section === "withdrawals").forEach((item) => {
        drawRow(item.name, [
          ...actRows.map((r) => item.monthAmounts[r.month] ?? null),
          actRows.slice(-12).reduce((s, r) => s + (Number(item.monthAmounts[r.month]) || 0), 0)
        ], { indent: 1 });
      });
      drawRow("Other Adjustments", [], { bold: true });
      drawRow("Unreconciled Variance $", adjWdrURaw, { rowType: "variance-amt" });
    }
    const totalPages = doc.getNumberOfPages();
    const nowStr = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(150, 150, 150);
      doc.text(nowStr, ML, PH - 16);
      doc.text(`${p} / ${totalPages}`, PW - MR, PH - 16, { align: "right" });
    }
    doc.save("Bank Reconciliation.pdf");
  };
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(Header, { title: "Reconciliation" }),
    /* @__PURE__ */ jsxs("div", { className: "page-content", children: [
      /* @__PURE__ */ jsx(QBDisconnectedBanner, { pageName: "Reconciliation" }),
      kr.krActive && !kr.availability.bank && /* @__PURE__ */ jsxs("div", { className: "mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800", children: [
        /* @__PURE__ */ jsx(AlertCircle, { size: 18, className: "mt-0.5 shrink-0 text-amber-600" }),
        /* @__PURE__ */ jsxs("span", { children: [
          "Bank Reconciliation needs a ",
          /* @__PURE__ */ jsx("strong", { children: "Bank Statement" }),
          " linked in the selected Key Reports Version."
        ] })
      ] }),
      isQBOnline && /* @__PURE__ */ jsxs("section", { className: "card-base w-full p-5", children: [
        /* @__PURE__ */ jsx("h2", { className: "text-[18px] font-semibold text-text-primary", children: "QuickBooks Bank Activity" }),
        /* @__PURE__ */ jsx("p", { className: "mt-1 text-[13px] text-text-secondary", children: "Fetches bank account activity directly from QuickBooks for the selected date range." }),
        /* @__PURE__ */ jsxs("div", { className: "mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_220px_auto]", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("label", { className: "mb-1.5 block text-[12px] font-medium text-text-secondary", children: "Start Month" }),
            /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
              /* @__PURE__ */ jsx(
                "select",
                {
                  className: "input-base h-10",
                  value: bankActivityStartMonth.split("-")[1],
                  onChange: (e) => setBankActivityStartMonth(
                    `${bankActivityStartMonth.split("-")[0]}-${e.target.value}`
                  ),
                  children: MONTHS.map((m) => /* @__PURE__ */ jsx("option", { value: m.value, children: m.label }, m.value))
                }
              ),
              /* @__PURE__ */ jsx(
                "select",
                {
                  className: "input-base h-10",
                  value: bankActivityStartMonth.split("-")[0],
                  onChange: (e) => setBankActivityStartMonth(
                    `${e.target.value}-${bankActivityStartMonth.split("-")[1]}`
                  ),
                  children: YEARS.map((y) => /* @__PURE__ */ jsx("option", { value: y, children: y }, y))
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("label", { className: "mb-1.5 block text-[12px] font-medium text-text-secondary", children: "End Month" }),
            /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
              /* @__PURE__ */ jsx(
                "select",
                {
                  className: "input-base h-10",
                  value: bankActivityEndMonth.split("-")[1],
                  onChange: (e) => setBankActivityEndMonth(
                    `${bankActivityEndMonth.split("-")[0]}-${e.target.value}`
                  ),
                  children: MONTHS.map((m) => /* @__PURE__ */ jsx("option", { value: m.value, children: m.label }, m.value))
                }
              ),
              /* @__PURE__ */ jsx(
                "select",
                {
                  className: "input-base h-10",
                  value: bankActivityEndMonth.split("-")[0],
                  onChange: (e) => setBankActivityEndMonth(
                    `${e.target.value}-${bankActivityEndMonth.split("-")[1]}`
                  ),
                  children: YEARS.map((y) => /* @__PURE__ */ jsx("option", { value: y, children: y }, y))
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("label", { className: "mb-1.5 block text-[12px] font-medium text-text-secondary", children: "Accounting Type" }),
            /* @__PURE__ */ jsxs(
              "select",
              {
                value: bankActivityAccountingMethod,
                onChange: (e) => setBankActivityAccountingMethod(e.target.value),
                className: "input-base h-10",
                children: [
                  /* @__PURE__ */ jsx("option", { value: "Accrual", children: "Accrual" }),
                  /* @__PURE__ */ jsx("option", { value: "Cash", children: "Cash" })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsx("div", { className: "flex items-end", children: /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "btn-primary w-full",
              onClick: () => void loadQBBankActivity(),
              disabled: isLoadingBankActivity,
              children: [
                isLoadingBankActivity ? /* @__PURE__ */ jsx(LoaderCircle, { size: 16, className: "animate-spin" }) : /* @__PURE__ */ jsx(RefreshCw, { size: 16 }),
                " ",
                "Fetch Activity"
              ]
            }
          ) })
        ] }),
        /* @__PURE__ */ jsx(StatusBanner, { sync: bankActivityFetchStatus })
      ] }),
      /* @__PURE__ */ jsxs("div", { id: "bank-recon-table", className: "flex flex-col gap-6", children: [
        /* @__PURE__ */ jsxs("section", { className: "card-base card-p w-full", children: [
          /* @__PURE__ */ jsxs("div", { className: "mb-5 flex flex-wrap items-end justify-between gap-4", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("h2", { className: "text-[18px] font-semibold text-text-primary", children: "Bank Reconciliation" }),
              /* @__PURE__ */ jsx("p", { className: "text-[14px] text-text-secondary", children: isManualUpload || isManualGl || isQBManual ? "Per-bank balance detail extracted from uploaded bank statement PDF files." : "Per-account balance detail from QuickBooks with reconciliation checks." })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "flex items-end gap-3", children: [
              (isManualUpload || isManualGl || isQBManual) && allPdfMonths.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "mb-1.5 block text-[12px] font-medium text-text-secondary", children: "Start Date" }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "date",
                      className: "input-base h-10 w-auto min-w-[150px]",
                      value: manualMonthStart ? `${manualMonthStart}-01` : "",
                      onChange: (e) => {
                        if (!e.target.value) return;
                        const isoKey = e.target.value.slice(0, 7);
                        setManualMonthStart(isoKey);
                        if (manualMonthEnd && isoKey > manualMonthEnd) setManualMonthEnd(isoKey);
                      }
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs("div", { children: [
                  /* @__PURE__ */ jsx("label", { className: "mb-1.5 block text-[12px] font-medium text-text-secondary", children: "End Date" }),
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "date",
                      className: "input-base h-10 w-auto min-w-[150px]",
                      value: manualMonthEnd ? `${manualMonthEnd}-01` : "",
                      onChange: (e) => {
                        if (!e.target.value) return;
                        const isoKey = e.target.value.slice(0, 7);
                        setManualMonthEnd(isoKey);
                        if (manualMonthStart && isoKey < manualMonthStart) setManualMonthStart(isoKey);
                      }
                    }
                  )
                ] })
              ] }),
              krSelected && /* @__PURE__ */ jsx(KeyReportVersionSelector, { clientId, variant: "filter" }),
              !krSelected && /* @__PURE__ */ jsxs("div", { className: "min-w-[280px]", children: [
                /* @__PURE__ */ jsx("label", { className: "mb-1.5 block text-[12px] font-medium text-text-secondary", children: "Bank Account" }),
                isManualUpload || isManualGl || isQBManual ? /* @__PURE__ */ jsx(
                  "select",
                  {
                    className: "input-base h-10 w-full",
                    value: selectedManualBankName,
                    onChange: (e) => setSelectedManualBankName(e.target.value),
                    disabled: !manualBankOptions.length,
                    children: manualBankOptions.length ? manualBankOptions.map((name) => /* @__PURE__ */ jsx("option", { value: name, children: name }, name)) : /* @__PURE__ */ jsx("option", { value: "", children: "No banks available" })
                  }
                ) : /* @__PURE__ */ jsx(
                  "select",
                  {
                    className: "input-base h-10 w-full",
                    value: selectedBalanceBankId,
                    onChange: (e) => setSelectedBalanceBankId(e.target.value),
                    disabled: !balanceBankOptions.length,
                    children: balanceBankOptions.length ? balanceBankOptions.map((option) => /* @__PURE__ */ jsx("option", { value: option.value, children: option.label }, option.value)) : /* @__PURE__ */ jsx("option", { value: "", children: "No bank accounts available" })
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "relative", children: [
                /* @__PURE__ */ jsxs(
                  "button",
                  {
                    type: "button",
                    onClick: () => setBankReconExportOpen((v) => !v),
                    disabled: bankReconIsExporting,
                    className: "btn-outline flex h-10 items-center gap-1.5 px-3 text-[13px]",
                    children: [
                      /* @__PURE__ */ jsx(Download, { size: 14, className: bankReconIsExporting ? "animate-pulse" : "" }),
                      bankReconIsExporting ? "Exporting\u2026" : "Export",
                      /* @__PURE__ */ jsx(ChevronDown, { size: 12 })
                    ]
                  }
                ),
                bankReconExportOpen && /* @__PURE__ */ jsxs(Fragment, { children: [
                  /* @__PURE__ */ jsx("div", { className: "fixed inset-0 z-10", onClick: () => setBankReconExportOpen(false) }),
                  /* @__PURE__ */ jsxs("div", { className: "absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-border bg-bg-card shadow-lg", children: [
                    /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        onClick: () => handleBankReconExport("excel"),
                        className: "block w-full px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page",
                        children: "Export to Excel (.xlsx)"
                      }
                    ),
                    /* @__PURE__ */ jsx(
                      "button",
                      {
                        type: "button",
                        onClick: () => handleBankReconExport("pdf"),
                        className: "block w-full px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page",
                        children: "Export to PDF (.pdf)"
                      }
                    )
                  ] })
                ] })
              ] })
            ] })
          ] }),
          /* @__PURE__ */ jsx("div", { children: isManualUpload || isManualGl || isQBManual ? isLoadingExtractedBankPdfData || extractedBankPdfFetchStatus.status === "loading" ? /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-center gap-3 rounded-2xl border border-border bg-white p-8 text-[14px] font-medium text-text-secondary shadow-sm", children: [
            /* @__PURE__ */ jsx(LoaderCircle, { size: 18, className: "animate-spin text-primary" }),
            /* @__PURE__ */ jsx("span", { children: "Loading bank reconciliation data from backend..." })
          ] }) : extractedBankPdfData ? (
            // Key Reports mode: dropdown is hidden, so render every bank stacked
            // below one another instead of only the selected one.
            krSelected ? (extractedBankPdfData.banks || []).map((bank, i) => /* @__PURE__ */ jsx("div", { children: renderManualBalanceAccountTable(bank) }, bank?.bankName || i)) : renderManualBalanceAccountTable(
              extractedBankPdfData.banks.find((b) => b.bankName === selectedManualBankName) || extractedBankPdfData.banks[0]
            )
          ) : extractedBankPdfFetchStatus.status === "success" ? (
            // Fetched successfully but active source has no bank statement files
            /* @__PURE__ */ jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted", children: "No bank statements found for the active source. Upload PDF or Excel files to the Bank Statement folder and sync." })
          ) : /* @__PURE__ */ jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted", children: "No bank statement data available." }) : isLoadingBankActivity || isLoadingOneBankActivity ? /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-center gap-3 rounded-2xl border border-border bg-white p-8 text-[14px] font-medium text-text-secondary shadow-sm", children: [
            /* @__PURE__ */ jsx(LoaderCircle, { size: 18, className: "animate-spin text-primary" }),
            /* @__PURE__ */ jsx("span", { children: "Loading QuickBooks bank activity from backend..." })
          ] }) : hasData ? visibleBalanceAccounts.map(
            (account) => renderBalanceAccountTable(account)
          ) : /* @__PURE__ */ jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted", children: "Fetch bank activity to see account balances." }) })
        ] }),
        /* @__PURE__ */ jsxs("section", { className: "card-base card-p w-full", children: [
          /* @__PURE__ */ jsx("div", { className: "mb-5", children: /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("h2", { className: "text-[18px] font-semibold text-text-primary", children: "Activity Review" }),
            /* @__PURE__ */ jsx("p", { className: "text-[14px] text-text-secondary", children: "Deposits and withdrawals compared to P&L financials, with reconciling items." })
          ] }) }),
          isManualUpload || isManualGl || isQBManual ? isLoadingExtractedBankPdfData || extractedBankPdfFetchStatus.status === "loading" ? /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-center gap-3 rounded-2xl border border-border bg-white p-8 text-[14px] font-medium text-text-secondary shadow-sm", children: [
            /* @__PURE__ */ jsx(LoaderCircle, { size: 18, className: "animate-spin text-primary" }),
            /* @__PURE__ */ jsx("span", { children: "Loading Activity Review data from backend..." })
          ] }) : extractedBankPdfData?.months?.length ? renderManualActivityTable() : extractedBankPdfFetchStatus.status === "success" ? /* @__PURE__ */ jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted", children: "No bank statements found for the active source. Upload PDF or Excel files to the Bank Statement folder and sync." }) : /* @__PURE__ */ jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted", children: "No Activity Review data available." }) : isLoadingBankActivity || isLoadingOneBankActivity ? /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-center gap-3 rounded-2xl border border-border bg-white p-8 text-[14px] font-medium text-text-secondary shadow-sm", children: [
            /* @__PURE__ */ jsx(LoaderCircle, { size: 18, className: "animate-spin text-primary" }),
            /* @__PURE__ */ jsx("span", { children: "Loading Activity Review data from backend..." })
          ] }) : hasData ? renderActivityTable() : /* @__PURE__ */ jsx("div", { className: "rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-[14px] text-text-muted", children: "Fetch bank activity to see the Activity Review." })
        ] })
      ] })
    ] }),
    addbackPickerState?.open && /* @__PURE__ */ jsx(
      AddbackPickerModal,
      {
        isOpen: true,
        section: addbackPickerState.section,
        months: addbackPickerState.months || [],
        clientId,
        startDate: addbackPickerState.startDate,
        endDate: addbackPickerState.endDate,
        accountingMethod: bankActivityAccountingMethod,
        getHeaders,
        existingItems: addbackItems,
        reportSource: selectedReportSource,
        keyReportVersionId: addbackVersionId,
        onAdd: (name, source, monthAmounts) => createAddbackItem(addbackPickerState.section, name, source, monthAmounts),
        onClose: () => setAddbackPickerState(null)
      }
    )
  ] });
}
