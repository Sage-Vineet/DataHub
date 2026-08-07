import {
  listEbitdaAdjustmentTypes,
  listEbitdaAdjustments,
  saveEbitdaAdjustmentsBatch,
  deleteEbitdaAdjustment,
  addEbitdaAdjustmentComment,
  getManualStagedProfitLossVendorDetail,
  getKeyReportVendors,
} from "../lib/api";

const FALLBACK_ADJUSTMENT_TYPES = Object.freeze([
  { typeKey: "personal_expense", label: "Personal Expense", description: "Expenses that are personal in nature and should be added back.", sortOrder: 10, isActive: true },
  { typeKey: "non_recurring_charge", label: "Non-recurring Charge", description: "One-time or non-recurring costs that normalize earnings.", sortOrder: 20, isActive: true },
  { typeKey: "officer_compensation", label: "Officer Compensation", description: "Owner/officer compensation adjustment.", sortOrder: 30, isActive: true },
  { typeKey: "related_party_rent", label: "Related Party Rent", description: "Rent paid to a related party above or below market.", sortOrder: 40, isActive: true },
  { typeKey: "other_non_market_wages", label: "Other Non-Market Wages", description: "Payroll or wage adjustments outside market compensation.", sortOrder: 50, isActive: true },
  { typeKey: "prior_period_adjustment", label: "Prior Period Adjustment", description: "Prior period or historical corrections.", sortOrder: 60, isActive: true },
  { typeKey: "accrual_adjustment", label: "Accrual Adjustment", description: "Accrual-based normalization or reversal.", sortOrder: 70, isActive: true },
  { typeKey: "other_addback", label: "Other Addback", description: "Any other EBITDA normalization that does not fit a standard type.", sortOrder: 80, isActive: true },
]);

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toAbsoluteNumber(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  return Number.isFinite(numeric) ? Math.abs(numeric) : Math.abs(fallback);
}

function resolveAdjustmentAnnualValueSnapshot(entry = {}) {
  const overrideCandidate = entry.overrideValue ?? entry.userValue ?? null;
  const currentCandidate = entry.value;
  const sourceCandidate = entry.sourceValue ?? entry.apiValue ?? entry.originalValue ?? null;

  const overrideNumber = toNumber(overrideCandidate, NaN);
  const currentNumber = toNumber(currentCandidate, NaN);
  const sourceNumber = toNumber(sourceCandidate, NaN);

  const overrideValue = Number.isFinite(overrideNumber) ? toAbsoluteNumber(overrideNumber, 0) : null;
  const currentValue = Number.isFinite(currentNumber) ? toAbsoluteNumber(currentNumber, 0) : null;
  const sourceValue = Number.isFinite(sourceNumber) ? toAbsoluteNumber(sourceNumber, 0) : null;
  const monthlyValues = entry.monthlyValues && typeof entry.monthlyValues === "object"
    ? Object.values(entry.monthlyValues)
    : [];
  const monthlyTotal = monthlyValues.length > 0
    ? monthlyValues.reduce((sum, item) => sum + toAbsoluteNumber(item?.value, 0), 0)
    : null;

  const staleZeroOverride = overrideValue === 0 && sourceValue !== null && sourceValue !== 0;

  let effectiveValue;
  if (overrideValue !== null && !staleZeroOverride) {
    effectiveValue = overrideValue;
  } else if (currentValue !== null && (!staleZeroOverride || currentValue !== 0)) {
    effectiveValue = currentValue;
  } else if (monthlyTotal !== null) {
    effectiveValue = monthlyTotal;
  } else if (sourceValue !== null) {
    effectiveValue = sourceValue;
  } else {
    effectiveValue = 0;
  }

  if (staleZeroOverride && effectiveValue === 0 && sourceValue !== null) {
    effectiveValue = sourceValue;
  }

  return {
    effectiveValue,
    overrideValue: staleZeroOverride ? null : overrideValue,
    currentValue,
    sourceValue,
    monthlyTotal,
  };
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeAdjustmentStatus(status, fallback = "approved") {
  const normalized = normalizeText(status || "", fallback).toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "active") return "approved";
  return normalized;
}

function createAdjustmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `adj_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function buildEbitdaScopeKey({ reportSource = "", selectedVersion = "", datasetVersionId = "", uploadBatchId = "" } = {}) {
  const parts = [normalizeText(reportSource, "manual_gl")];
  if (selectedVersion) parts.push(`v${normalizeText(selectedVersion)}`);
  if (datasetVersionId) parts.push(`dv${normalizeText(datasetVersionId)}`);
  if (uploadBatchId) parts.push(`b${normalizeText(uploadBatchId)}`);
  return parts.join(":");
}

export function getAdjustmentTypeOptions(types = []) {
  const source = Array.isArray(types) && types.length ? types : FALLBACK_ADJUSTMENT_TYPES;
  return source
    .map((type) => ({
      id: normalizeText(type.id || type.typeKey || type.type_key),
      typeKey: normalizeText(type.typeKey || type.type_key),
      label: normalizeText(type.label || type.name || type.typeKey || type.type_key),
      description: normalizeText(type.description || ""),
      sortOrder: Number(type.sortOrder ?? type.sort_order ?? 0) || 0,
      isActive: type.isActive ?? type.is_active ?? true,
    }))
    .filter((type) => type.typeKey)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export async function loadAdjustmentTypes(options = {}) {
  try {
    const types = await listEbitdaAdjustmentTypes(options);
    return getAdjustmentTypeOptions(types);
  } catch {
    return getAdjustmentTypeOptions(FALLBACK_ADJUSTMENT_TYPES);
  }
}

export function normalizeVendorScope(vendorScope = []) {
  return Array.from(
    new Set(
      toArray(vendorScope)
        .map((item) => {
          if (typeof item === "string") return normalizeText(item);
          if (!item || typeof item !== "object") return "";
          return normalizeText(item.vendorName || item.vendor_name || item.name || item.label || item.value);
        })
        .filter(Boolean),
    ),
  );
}

function extractTransactionRows(account = {}, fallbackVendorName = "") {
  return toArray(account.transactions)
    .map((tx) => {
      const txnDate = normalizeText(tx.txnDate || tx.txn_date || tx.date || "");
      const vendorName = normalizeText(tx.vendorName || tx.vendor_name || fallbackVendorName || "No Vendor", "No Vendor");
      const amount = toNumber(tx.signedAmount ?? tx.netAmount ?? tx.amount ?? 0, 0);
      const year = Number(tx.fiscalYear ?? tx.fiscal_year ?? (txnDate ? txnDate.slice(0, 4) : 0));
      const month = Number(tx.month ?? tx.txnMonth ?? (txnDate && /^\d{4}-\d{2}/.test(txnDate) ? txnDate.slice(5, 7) : 0));

      return {
        vendorName,
        accountName: normalizeText(account.accountName || account.account_name || ""),
        amount,
        year: Number.isFinite(year) ? year : 0,
        month: Number.isFinite(month) ? month : 0,
        txnDate,
        raw: tx,
      };
    })
    .filter((tx) => tx.accountName && Number.isFinite(tx.amount));
}

export function buildVendorReferenceIndex(payload = {}) {
  const accountMap = new Map();
  const vendorMap = new Map();
  const years = new Set();

  for (const vendor of toArray(payload.vendors)) {
    const vendorName = normalizeText(vendor.vendorName || vendor.vendor_name || vendor.name || "No Vendor", "No Vendor");
    for (const account of toArray(vendor.accounts)) {
      const accountName = normalizeText(account.accountName || account.account_name || account.name || "");
      if (!accountName) continue;
      const accountId = normalizeText(account.accountId || account.account_id || account.id || "");
      const transactions = extractTransactionRows(account, vendorName);

      if (!accountMap.has(accountName)) {
        accountMap.set(accountName, {
          accountName,
          accountId,
          total: 0,
          yearlyTotals: {},
          monthlyTotals: {},
          transactions: [],
          vendors: new Map(),
        });
      }

      const accountEntry = accountMap.get(accountName);
      if (!accountEntry.accountId && accountId) accountEntry.accountId = accountId;

      for (const tx of transactions) {
        accountEntry.transactions.push({ ...tx, vendorName });
        accountEntry.total += tx.amount;
        if (tx.year > 0) {
          years.add(tx.year);
          accountEntry.yearlyTotals[tx.year] = (accountEntry.yearlyTotals[tx.year] || 0) + tx.amount;
          if (!accountEntry.monthlyTotals[tx.year]) accountEntry.monthlyTotals[tx.year] = {};
          if (tx.month > 0 && tx.month <= 12) {
            accountEntry.monthlyTotals[tx.year][tx.month] = (accountEntry.monthlyTotals[tx.year][tx.month] || 0) + tx.amount;
          }
        }
      }

      if (!accountEntry.vendors.has(vendorName)) {
        accountEntry.vendors.set(vendorName, {
          vendorName,
          total: 0,
          yearlyTotals: {},
          monthlyTotals: {},
        });
      }

      const vendorAccountEntry = accountEntry.vendors.get(vendorName);
      for (const tx of transactions) {
        vendorAccountEntry.total += tx.amount;
        if (tx.year > 0) {
          vendorAccountEntry.yearlyTotals[tx.year] = (vendorAccountEntry.yearlyTotals[tx.year] || 0) + tx.amount;
          if (!vendorAccountEntry.monthlyTotals[tx.year]) vendorAccountEntry.monthlyTotals[tx.year] = {};
          if (tx.month > 0 && tx.month <= 12) {
            vendorAccountEntry.monthlyTotals[tx.year][tx.month] = (vendorAccountEntry.monthlyTotals[tx.year][tx.month] || 0) + tx.amount;
          }
        }
      }

      if (!vendorMap.has(vendorName)) {
        vendorMap.set(vendorName, {
          vendorName,
          total: 0,
          accounts: new Map(),
          yearlyTotals: {},
        });
      }
      const vendorEntry = vendorMap.get(vendorName);
      vendorEntry.total += transactions.reduce((sum, tx) => sum + tx.amount, 0);
      vendorEntry.accounts.set(accountName, {
        accountName,
        accountId,
        total: transactions.reduce((sum, tx) => sum + tx.amount, 0),
        yearlyTotals: clone(vendorAccountEntry.yearlyTotals),
        monthlyTotals: clone(vendorAccountEntry.monthlyTotals),
        transactions,
      });
      for (const tx of transactions) {
        if (tx.year > 0) {
          vendorEntry.yearlyTotals[tx.year] = (vendorEntry.yearlyTotals[tx.year] || 0) + tx.amount;
        }
      }
    }
  }

  const accountOptions = Array.from(accountMap.values())
    .map((account) => ({
      label: account.accountName,
      accountId: account.accountId,
      total: account.total,
      yearlyTotals: clone(account.yearlyTotals),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const vendorOptions = Array.from(vendorMap.values())
    .map((vendor) => ({
      label: vendor.vendorName,
      total: vendor.total,
      yearlyTotals: clone(vendor.yearlyTotals),
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.label.localeCompare(b.label));

  return {
    years: Array.from(years).sort((a, b) => b - a),
    accountMap,
    vendorMap,
    accountOptions,
    vendorOptions,
  };
}

function monthRangeList(startMonth = 1, endMonth = 12) {
  const start = Math.max(1, Math.min(12, Number(startMonth) || 1));
  const end = Math.max(start, Math.min(12, Number(endMonth) || 12));
  const months = [];
  for (let month = start; month <= end; month += 1) months.push(month);
  return months;
}

function distributeEvenly(total, months) {
  const selected = Array.isArray(months) && months.length ? months : monthRangeList();
  if (!selected.length) return {};
  const numericTotal = toNumber(total, 0);
  const base = numericTotal / selected.length;
  const values = {};
  let running = 0;
  selected.forEach((month, index) => {
    if (index === selected.length - 1) {
      values[month] = Number((numericTotal - running).toFixed(2));
    } else {
      const amount = Number(base.toFixed(2));
      values[month] = amount;
      running += amount;
    }
  });
  return values;
}

function totalMonthlyValues(monthlyValues = {}) {
  return Object.values(monthlyValues || {}).reduce((sum, item) => sum + toAbsoluteNumber(item?.value ?? item, 0), 0);
}

function normalizeAdjustmentYearValues(values = {}) {
  const out = {};
  const yearMap = values && typeof values === "object" ? values : {};

  Object.entries(yearMap).forEach(([yearKey, yearEntryRaw]) => {
    const year = Number(yearKey);
    if (!Number.isInteger(year) || year <= 0) return;

    const yearEntry = yearEntryRaw && typeof yearEntryRaw === "object" ? yearEntryRaw : { value: yearEntryRaw };
    const monthlyValues = yearEntry.monthlyValues || yearEntry.monthValues || yearEntry.months || {};
    const normalizedMonthlyValues = {};

    Object.entries(monthlyValues || {}).forEach(([monthKey, monthEntryRaw]) => {
      const month = Number(monthKey);
      if (!Number.isInteger(month) || month < 1 || month > 12) return;
      const monthEntry = monthEntryRaw && typeof monthEntryRaw === "object" ? monthEntryRaw : { value: monthEntryRaw };
      normalizedMonthlyValues[String(month)] = {
        value: toAbsoluteNumber(monthEntry.value ?? monthEntry.amount ?? 0, 0),
        originalValue: monthEntry.originalValue !== null && monthEntry.originalValue !== undefined
          ? toAbsoluteNumber(monthEntry.originalValue, 0)
          : null,
        overrideValue: monthEntry.overrideValue !== null && monthEntry.overrideValue !== undefined
          ? toAbsoluteNumber(monthEntry.overrideValue, 0)
          : null,
        overrideReason: normalizeText(monthEntry.overrideReason || monthEntry.override_reason || ""),
        metadata: monthEntry.metadata || {},
      };
    });

    const snapshot = resolveAdjustmentAnnualValueSnapshot({
      ...yearEntry,
      apiValue: yearEntry.apiValue,
      sourceValue: yearEntry.sourceValue ?? yearEntry.apiValue ?? yearEntry.originalValue ?? null,
      originalValue: yearEntry.originalValue,
      monthlyValues: normalizedMonthlyValues,
    });

    out[String(year)] = {
      apiValue: toAbsoluteNumber(yearEntry.apiValue ?? yearEntry.sourceValue ?? yearEntry.originalValue ?? snapshot.effectiveValue, 0),
      sourceValue: toAbsoluteNumber(yearEntry.sourceValue ?? yearEntry.apiValue ?? yearEntry.originalValue ?? snapshot.effectiveValue, 0),
      originalValue: yearEntry.originalValue !== null && yearEntry.originalValue !== undefined
        ? toAbsoluteNumber(yearEntry.originalValue, snapshot.effectiveValue)
        : null,
      overrideValue: snapshot.overrideValue,
      userValue: snapshot.overrideValue,
      overrideReason: normalizeText(yearEntry.overrideReason || yearEntry.override_reason || ""),
      monthlyValues: normalizedMonthlyValues,
      metadata: yearEntry.metadata || {},
      value: snapshot.effectiveValue,
    };
  });

  return out;
}

export function getAdjustmentYearEntry(adjustment, year) {
  if (!adjustment?.values) return {};
  return adjustment.values[String(year)] || adjustment.values[year] || {};
}

export function getAdjustmentYearValue(adjustment, year) {
  const entry = getAdjustmentYearEntry(adjustment, year);
  if (!entry || typeof entry !== "object") {
    return toAbsoluteNumber(entry, 0);
  }
  return resolveAdjustmentAnnualValueSnapshot(entry).effectiveValue;
}

export function getAdjustmentYearSourceValue(adjustment, year) {
  const entry = getAdjustmentYearEntry(adjustment, year);
  if (!entry || typeof entry !== "object") {
    return toAbsoluteNumber(entry, 0);
  }

  if (Number.isFinite(Number(entry.sourceValue))) {
    return toAbsoluteNumber(entry.sourceValue, 0);
  }
  if (Number.isFinite(Number(entry.apiValue))) {
    return toAbsoluteNumber(entry.apiValue, 0);
  }
  if (Number.isFinite(Number(entry.originalValue))) {
    return toAbsoluteNumber(entry.originalValue, 0);
  }
  if (Number.isFinite(Number(entry.value))) {
    return toAbsoluteNumber(entry.value, 0);
  }
  return 0;
}

export function filterAdjustmentsByApprovalStatus(adjustments = [], status = "approved") {
  const normalizedStatus = normalizeText(status || "approved", "approved").toLowerCase();

  // If we want "all", we only exclude actually deleted items.
  if (normalizedStatus === "all") {
    return (adjustments || []).filter((adjustment) => {
      const currentStatus = normalizeAdjustmentStatus(adjustment?.status ?? adjustment?.approvalStatus ?? "approved", "approved");
      return currentStatus !== "deleted";
    });
  }

  return (adjustments || []).filter((adjustment) => {
    const currentStatus = normalizeAdjustmentStatus(adjustment?.status ?? adjustment?.approvalStatus ?? "approved", "approved");
    return currentStatus === normalizedStatus;
  });
}

export function calculateAdjustmentTotalsByYear(adjustments = [], years = [], status = "approved") {
  // We only filter if 'status' is provided and not "all" (which is the default behavior of filterAdjustmentsByApprovalStatus)
  // If the adjustments are already pre-filtered, we should still be safe as long as they match the status.
  const filtered = filterAdjustmentsByApprovalStatus(adjustments, status);
  const totals = {};
  for (const year of years || []) {
    const yearKey = String(year);
    totals[yearKey] = filtered.reduce((sum, adjustment) => {
      const val = getAdjustmentYearValue(adjustment, year);
      return sum + toAbsoluteNumber(val, 0);
    }, 0);
  }
  return totals;
}

export function calculateAdjustedEbitdaByYear(baseEbitdaByYear = {}, totalAdjustmentsByYear = {}, years = []) {
  const totals = {};
  for (const year of years || []) {
    const base = toNumber(baseEbitdaByYear?.[year] ?? baseEbitdaByYear?.[String(year)] ?? 0, 0);
    const adjustments = toNumber(totalAdjustmentsByYear?.[year] ?? totalAdjustmentsByYear?.[String(year)] ?? 0, 0);
    totals[String(year)] = base + adjustments;
  }
  return totals;
}

export function calculateEbitdaMarginByYear(adjustedEbitdaByYear = {}, revenueByYear = {}, years = []) {
  const totals = {};
  for (const year of years || []) {
    const adjusted = toNumber(adjustedEbitdaByYear?.[year] ?? adjustedEbitdaByYear?.[String(year)] ?? 0, 0);
    const revenue = toNumber(revenueByYear?.[year] ?? revenueByYear?.[String(year)] ?? 0, 0);
    totals[String(year)] = revenue > 0 ? (adjusted / revenue) * 100 : 0;
  }
  return totals;
}

function getReferenceTransactions(referenceIndex, row) {
  const accountName = normalizeText(row.accountName || row.linkedAccountName || row.label || "");
  if (!accountName) return [];
  const accountEntry = referenceIndex?.accountMap?.get(accountName);
  if (!accountEntry) return [];

  const vendorScopeMode = normalizeText(row.vendorScopeMode || "entire_account", "entire_account");
  const selectedVendors = normalizeVendorScope(row.vendorScope || []);
  if (vendorScopeMode === "entire_account" || selectedVendors.length === 0) {
    return accountEntry.transactions || [];
  }

  const selected = new Set(selectedVendors.map((vendor) => vendor.toLowerCase()));
  return (accountEntry.transactions || []).filter((tx) => selected.has(normalizeText(tx.vendorName).toLowerCase()));
}

function buildYearValueFromTransactions(transactions, year) {
  const filtered = transactions.filter((tx) => Number(tx.year) === Number(year));
  const annual = filtered.reduce((sum, tx) => sum + toAbsoluteNumber(tx.amount, 0), 0);
  const monthlyValues = {};
  filtered.forEach((tx) => {
    if (tx.month > 0 && tx.month <= 12) {
      monthlyValues[tx.month] = (monthlyValues[tx.month] || 0) + toAbsoluteNumber(tx.amount, 0);
    }
  });
  return {
    apiValue: annual,
    sourceValue: annual,
    originalValue: annual,
    overrideValue: null,
    userValue: null,
    overrideReason: "",
    monthlyValues: Object.fromEntries(
      Object.entries(monthlyValues).map(([month, value]) => [month, { value }]),
    ),
    value: annual,
  };
}

function buildFallbackYearValue(row, year, fallbackLookup) {
  const fallback = typeof fallbackLookup === "function" ? fallbackLookup(year, row.label || row.accountName || "") : null;
  const numeric = toAbsoluteNumber(fallback, 0);
  const startMonth = Number(row.allocationStartMonth ?? row.monthStart ?? row.metadata?.startMonth ?? 1);
  const endMonth = Number(row.allocationEndMonth ?? row.monthEnd ?? row.metadata?.endMonth ?? 12);
  const allocationMonths = monthRangeList(startMonth, endMonth);
  const monthlyValues = allocationMonths.length
    ? Object.fromEntries(
      Object.entries(distributeEvenly(numeric, allocationMonths)).map(([month, value]) => [
        month,
        { value },
      ]),
    )
    : {};

  return {
    apiValue: numeric,
    sourceValue: numeric,
    originalValue: numeric,
    overrideValue: null,
    userValue: null,
    overrideReason: "",
    monthlyValues,
    value: totalMonthlyValues(monthlyValues) || numeric,
  };
}

export function applyReferenceValues(row, years = [], { referenceIndex = null, fallbackLookup = null } = {}) {
  const next = clone(row) || {};
  const selectedYears = Array.isArray(years) ? years.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0) : [];
  const transactions = referenceIndex ? getReferenceTransactions(referenceIndex, next) : [];

  next.values = next.values && typeof next.values === "object" ? clone(next.values) : {};
  selectedYears.forEach((year) => {
    const yearKey = String(year);
    const current = next.values[yearKey] || {};
    const existingOverride = current.overrideValue ?? current.userValue ?? null;
    const existingMonthly = current.monthlyValues || current.monthValues || current.months || {};
    const computed = transactions.length
      ? buildYearValueFromTransactions(transactions, year)
      : buildFallbackYearValue(next, year, fallbackLookup);

    const monthlyValues = Object.keys(existingMonthly || {}).length > 0
      ? clone(existingMonthly)
      : computed.monthlyValues;

    const annualTotal = Object.keys(monthlyValues || {}).length > 0
      ? totalMonthlyValues(monthlyValues)
      : computed.apiValue;

    next.values[yearKey] = {
      ...computed,
      ...current,
      apiValue: computed.apiValue,
      sourceValue: computed.sourceValue,
      originalValue: computed.originalValue,
      overrideValue: existingOverride !== null && existingOverride !== undefined ? toAbsoluteNumber(existingOverride, 0) : null,
      userValue: existingOverride !== null && existingOverride !== undefined ? toAbsoluteNumber(existingOverride, 0) : null,
      monthlyValues: clone(monthlyValues || {}),
      value: existingOverride !== null && existingOverride !== undefined
        ? toAbsoluteNumber(existingOverride, 0)
        : annualTotal,
    };
  });

  return next;
}

export function buildAdjustmentDraft({
  id = createAdjustmentId(),
  typeKey = "other_addback",
  name = "",
  description = "",
  linkedAccountId = "",
  linkedAccountName = "",
  vendorScopeMode = "entire_account",
  vendorScope = [],
  isManual = true,
  values = {},
  overrideReason = "",
  internalNotes = "",
  analystComments = "",
  supportingExplanation = "",
  attachments = [],
  comments = [],
  metadata = {},
  status = "approved",
} = {}) {
  return {
    id,
    typeKey,
    name,
    description,
    linkedAccountId,
    linkedAccountName,
    vendorScopeMode,
    vendorScope: normalizeVendorScope(vendorScope),
    isManual,
    overrideReason,
    internalNotes,
    analystComments,
    supportingExplanation,
    attachments,
    comments,
    metadata,
    status: normalizeAdjustmentStatus(status, "approved"),
    values: normalizeAdjustmentYearValues(values),
  };
}

export function normalizeAdjustmentRecord(record = {}) {
  const values = {};
  const yearRows = Array.isArray(record.values)
    ? record.values
    : record.values && typeof record.values === "object"
      ? Object.entries(record.values).flatMap(([year, yearValue]) => {
        const yearNum = Number(year);
        const monthlyValues = yearValue?.monthlyValues || yearValue?.monthValues || yearValue?.months || {};
        const monthlyRows = Object.entries(monthlyValues || {}).map(([month, monthValue]) => ({
          year: yearNum,
          month: Number(month),
          value: toAbsoluteNumber(monthValue?.value ?? monthValue, 0),
          original_value: monthValue?.originalValue !== null && monthValue?.originalValue !== undefined
            ? toAbsoluteNumber(monthValue.originalValue, 0)
            : monthValue?.original_value !== null && monthValue?.original_value !== undefined
              ? toAbsoluteNumber(monthValue.original_value, 0)
              : null,
          override_value: monthValue?.overrideValue !== null && monthValue?.overrideValue !== undefined
            ? toAbsoluteNumber(monthValue.overrideValue, 0)
            : monthValue?.override_value !== null && monthValue?.override_value !== undefined
              ? toAbsoluteNumber(monthValue.override_value, 0)
              : null,
          override_reason: monthValue?.overrideReason ?? monthValue?.override_reason ?? "",
        }));

        const annual = {
          year: yearNum,
          month: 0,
          value: toAbsoluteNumber(yearValue?.value ?? yearValue?.userValue ?? yearValue?.overrideValue ?? yearValue?.apiValue ?? 0, 0),
          original_value: yearValue?.originalValue !== null && yearValue?.originalValue !== undefined
            ? toAbsoluteNumber(yearValue.originalValue, 0)
            : yearValue?.apiValue !== null && yearValue?.apiValue !== undefined
              ? toAbsoluteNumber(yearValue.apiValue, 0)
              : null,
          override_value: yearValue?.overrideValue !== null && yearValue?.overrideValue !== undefined
            ? toAbsoluteNumber(yearValue.overrideValue, 0)
            : yearValue?.userValue !== null && yearValue?.userValue !== undefined
              ? toAbsoluteNumber(yearValue.userValue, 0)
              : null,
          override_reason: yearValue?.overrideReason ?? yearValue?.override_reason ?? "",
          source_value: yearValue?.sourceValue !== null && yearValue?.sourceValue !== undefined
            ? toAbsoluteNumber(yearValue.sourceValue, 0)
            : yearValue?.apiValue !== null && yearValue?.apiValue !== undefined
              ? toAbsoluteNumber(yearValue.apiValue, 0)
              : null,
        };
        return [annual, ...monthlyRows];
      })
      : [];

  const grouped = new Map();
  for (const row of yearRows) {
    if (!row) continue;
    const year = Number(row.year);
    if (!Number.isInteger(year) || year <= 0) continue;
    if (!grouped.has(year)) grouped.set(year, []);
    grouped.get(year).push(row);
  }

  grouped.forEach((rows, year) => {
    const annual = rows.find((row) => Number(row.month) === 0) || rows[0];
    const monthlyRows = rows.filter((row) => Number(row.month) > 0);
    const monthlyValues = {};
    monthlyRows.forEach((row) => {
      monthlyValues[String(row.month)] = {
        value: toAbsoluteNumber(row.value, 0),
        originalValue: row.original_value !== null && row.original_value !== undefined
          ? toAbsoluteNumber(row.original_value, 0)
          : null,
        overrideValue: row.override_value !== null && row.override_value !== undefined
          ? toAbsoluteNumber(row.override_value, 0)
          : null,
        overrideReason: row.override_reason ?? "",
      };
    });
    values[String(year)] = {
      apiValue: toAbsoluteNumber(annual?.source_value ?? annual?.original_value ?? annual?.value ?? 0, 0),
      sourceValue: toAbsoluteNumber(annual?.source_value ?? annual?.original_value ?? annual?.value ?? 0, 0),
      originalValue: annual?.original_value !== null && annual?.original_value !== undefined
        ? toAbsoluteNumber(annual.original_value, 0)
        : null,
      overrideValue: annual?.override_value !== null && annual?.override_value !== undefined
        ? toAbsoluteNumber(annual.override_value, 0)
        : null,
      userValue: annual?.override_value !== null && annual?.override_value !== undefined
        ? toAbsoluteNumber(annual.override_value, 0)
        : null,
      overrideReason: annual?.override_reason ?? "",
      monthlyValues,
      value: toAbsoluteNumber(annual?.value ?? 0, 0),
    };
  });

  const normalized = buildAdjustmentDraft({
    id: record.id || createAdjustmentId(),
    typeKey: record.typeKey || record.type_key || record.type || "other_addback",
    name: record.name || record.label || "",
    description: record.description || "",
    linkedAccountId: record.linkedAccountId || record.linked_account_id || record.accountId || record.account_id || "",
    linkedAccountName: record.linkedAccountName || record.linked_account_name || record.accountName || record.account_name || record.label || "",
    vendorScopeMode: record.vendorScopeMode || record.vendor_scope_mode || "entire_account",
    vendorScope: normalizeVendorScope(record.vendorScope || record.vendor_scope || []),
    isManual: record.isManual ?? record.is_manual ?? false,
    overrideReason: record.overrideReason || record.override_reason || "",
    internalNotes: record.internalNotes || record.internal_notes || "",
    analystComments: record.analystComments || record.analyst_comments || "",
    supportingExplanation: record.supportingExplanation || record.supporting_explanation || "",
    attachments: toArray(record.attachments).map((item) => ({
      id: item.id || createAdjustmentId(),
      uploadId: item.uploadId || item.upload_id || null,
      fileName: item.fileName || item.file_name || "",
      fileUrl: item.fileUrl || item.file_url || "",
      contentType: item.contentType || item.content_type || "",
      sizeBytes: item.sizeBytes || item.size_bytes || null,
      metadata: item.metadata || {},
    })),
    comments: toArray(record.comments).map((item) => ({
      id: item.id || createAdjustmentId(),
      body: item.body || item.comment || "",
      commentType: item.commentType || item.comment_type || "internal",
      createdAt: item.createdAt || item.created_at || null,
      metadata: item.metadata || {},
    })),
    metadata: record.metadata || {},
    status: normalizeAdjustmentStatus(record.status || record.approvalStatus || "approved", "approved"),
    values,
  });

  return normalized;
}

export function serializeAdjustmentRecord(record = {}, scope = {}) {
  const values = [];
  const yearMap = record.values && typeof record.values === "object" ? record.values : {};

  Object.entries(yearMap).forEach(([yearKey, yearEntryRaw]) => {
    const year = Number(yearKey);
    if (!Number.isInteger(year) || year <= 0) return;
    const yearEntry = yearEntryRaw && typeof yearEntryRaw === "object" ? yearEntryRaw : { userValue: yearEntryRaw };
    const monthlyValues = yearEntry.monthlyValues || yearEntry.monthValues || yearEntry.months || {};
    const annualValue = yearEntry.overrideValue ?? yearEntry.userValue ?? yearEntry.value ?? yearEntry.apiValue ?? 0;

    values.push({
      year,
      month: 0,
      value: toAbsoluteNumber(annualValue, 0),
      originalValue: yearEntry.originalValue ?? yearEntry.apiValue ?? null,
      overrideValue: yearEntry.overrideValue !== null && yearEntry.overrideValue !== undefined
        ? toAbsoluteNumber(yearEntry.overrideValue, 0)
        : yearEntry.userValue !== null && yearEntry.userValue !== undefined
          ? toAbsoluteNumber(yearEntry.userValue, 0)
          : null,
      overrideReason: yearEntry.overrideReason || "",
      sourceValue: yearEntry.sourceValue ?? yearEntry.apiValue ?? null,
      metadata: yearEntry.metadata || {},
    });

    Object.entries(monthlyValues || {}).forEach(([monthKey, monthEntry]) => {
      const month = Number(monthKey);
      if (!Number.isInteger(month) || month < 1 || month > 12) return;
      const entry = monthEntry && typeof monthEntry === "object" ? monthEntry : { value: monthEntry };
      values.push({
        year,
        month,
        value: toAbsoluteNumber(entry.value ?? 0, 0),
        originalValue: entry.originalValue ?? null,
        overrideValue: entry.overrideValue !== null && entry.overrideValue !== undefined
          ? toAbsoluteNumber(entry.overrideValue, 0)
          : null,
        overrideReason: entry.overrideReason || "",
        sourceValue: entry.sourceValue ?? null,
        metadata: entry.metadata || {},
      });
    });
  });

  return {
    id: record.id || createAdjustmentId(),
    companyId: scope.companyId || record.companyId || record.company_id || null,
    versionId: scope.versionId || record.versionId || record.version_id || null,
    datasetVersionId: scope.datasetVersionId || record.datasetVersionId || record.dataset_version_id || null,
    uploadBatchId: scope.uploadBatchId || record.uploadBatchId || record.upload_batch_id || null,
    sourceKey: scope.sourceKey || record.sourceKey || record.source_key || "manual_gl",
    typeKey: record.typeKey || record.type_key || "other_addback",
    name: record.name || "",
    description: record.description || "",
    linkedAccountId: record.linkedAccountId || record.linked_account_id || "",
    linkedAccountName: record.linkedAccountName || record.linked_account_name || "",
    vendorScopeMode: record.vendorScopeMode || record.vendor_scope_mode || "entire_account",
    vendorScope: normalizeVendorScope(record.vendorScope || record.vendor_scope || []),
    isManual: record.isManual ?? record.is_manual ?? false,
    overrideReason: record.overrideReason || record.override_reason || "",
    internalNotes: record.internalNotes || record.internal_notes || "",
    analystComments: record.analystComments || record.analyst_comments || "",
    supportingExplanation: record.supportingExplanation || record.supporting_explanation || "",
    metadata: record.metadata || {},
    status: record.status || "active",
    values,
    attachments: toArray(record.attachments).map((item) => ({
      id: item.id || createAdjustmentId(),
      uploadId: item.uploadId || item.upload_id || null,
      fileName: item.fileName || item.file_name || "",
      fileUrl: item.fileUrl || item.file_url || "",
      contentType: item.contentType || item.content_type || "",
      sizeBytes: item.sizeBytes || item.size_bytes || null,
      metadata: item.metadata || {},
    })),
    comments: toArray(record.comments).map((item) => ({
      id: item.id || createAdjustmentId(),
      body: item.body || item.comment || "",
      commentType: item.commentType || item.comment_type || "internal",
      metadata: item.metadata || {},
    })),
  };
}

export async function loadAdjustmentWorkspaceData(options = {}) {
  const [types, adjustments] = await Promise.all([
    loadAdjustmentTypes(options),
    listEbitdaAdjustments(options),
  ]);

  return {
    types,
    adjustments,
  };
}

export async function loadVendorReferenceData(options = {}) {
  const payload = await getManualStagedProfitLossVendorDetail(options);
  return buildVendorReferenceIndex(payload);
}

/**
 * Vendor reference index for a KEY REPORTS version.
 *
 * CONFIRMED ROOT CAUSE this fixes: the EBITDA page's Vendor Scope control took
 * its vendors exclusively from loadVendorReferenceData above, which reads the
 * MANUAL GL UPLOAD staging tables. A Key Reports version has no rows there, and
 * WorkspaceEbitda additionally skipped the call entirely unless the source was
 * Manual GL -- so `vendorOptions` was always `[]` and the dropdown always read
 * "No vendors found", even though the Key Reports extraction had already
 * populated general_ledger_entries.vendor (verified live: 165 distinct vendors
 * across 61 accounts on one version).
 *
 * This is a SEPARATE path, not a reuse of the manual one: it calls the Key
 * Reports vendors endpoint, which reads general_ledger_entries directly. It only
 * shares the RETURN SHAPE ({ accountOptions, vendorOptions, accountMap,
 * vendorMap, years }) because AddbackEditorModal and EbitdaAdjustmentsPanel
 * already consume exactly that shape -- so no component changes are needed and
 * the control behaves identically whichever source is selected.
 *
 * No EBITDA calculation reads any of this; it populates the editor's pickers only.
 */
export async function loadKeyReportVendorReferenceData({ versionId, account } = {}) {
  if (!versionId) return null;
  const payload = await getKeyReportVendors(versionId, account ? { account } : {});

  const accountMap = new Map();
  const vendorMap = new Map();
  const years = new Set(toArray(payload?.years).map(Number).filter(Number.isFinite));

  // The endpoint returns each account with the vendor names that posted to it,
  // which is precisely what the editor uses to narrow the dropdown to the
  // account an adjustment is linked to.
  for (const account of toArray(payload?.accounts)) {
    const accountName = normalizeText(account.label || account.accountName || "");
    if (!accountName) continue;
    accountMap.set(accountName, {
      accountName,
      accountId: "",
      total: Number(account.total) || 0,
      yearlyTotals: { ...(account.yearlyTotals || {}) },
      monthlyTotals: {},
      transactions: [],
      // Keyed by vendor name — AddbackEditorModal reads `accountEntry.vendors.keys()`.
      vendors: new Map(toArray(account.vendors).map((v) => [normalizeText(v), { vendorName: normalizeText(v) }])),
    });
  }

  for (const vendor of toArray(payload?.vendors)) {
    const vendorName = normalizeText(vendor.label || vendor.vendorName || "");
    if (!vendorName) continue;
    vendorMap.set(vendorName, {
      vendorName,
      total: Number(vendor.total) || 0,
      yearlyTotals: { ...(vendor.yearlyTotals || {}) },
      accounts: new Map(toArray(vendor.accounts).map((a) => [normalizeText(a), { accountName: normalizeText(a) }])),
    });
  }

  return {
    years: Array.from(years).sort((a, b) => b - a),
    accountMap,
    vendorMap,
    // Account -> the vendor names that posted to it. Passed to the editor as its
    // OWN prop rather than through `referenceIndex`, deliberately: applyReference
    // Values treats a non-null referenceIndex as a source of TRANSACTIONS and
    // rebuilds each year's value from them (see its `transactions.length` branch),
    // so routing this through that prop could change adjustment values. This
    // index carries no transactions and must never influence a calculation — it
    // exists purely to narrow the Vendor Scope dropdown.
    vendorsByAccount: new Map(
      [...accountMap.entries()].map(([name, entry]) => [name, [...entry.vendors.keys()]]),
    ),
    // Server already ordered these (largest exposure first, then alphabetical)
    // and guaranteed distinct, non-empty names — preserved verbatim.
    accountOptions: toArray(payload?.accounts).map((a) => ({
      label: normalizeText(a.label || ""),
      accountId: "",
      total: Number(a.total) || 0,
      yearlyTotals: { ...(a.yearlyTotals || {}) },
    })).filter((a) => a.label),
    vendorOptions: toArray(payload?.vendors).map((v) => ({
      label: normalizeText(v.label || ""),
      total: Number(v.total) || 0,
      yearlyTotals: { ...(v.yearlyTotals || {}) },
    })).filter((v) => v.label),
  };
}

export {
  FALLBACK_ADJUSTMENT_TYPES,
  listEbitdaAdjustments,
  saveEbitdaAdjustmentsBatch,
  deleteEbitdaAdjustment,
  addEbitdaAdjustmentComment,
};
