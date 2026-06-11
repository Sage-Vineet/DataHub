const { randomUUID } = require("crypto");
const { supabase } = require("../db");

const TABLES = {
  adjustmentTypes: "ebitda_adjustment_types",
  adjustments: "ebitda_adjustments",
  values: "ebitda_adjustment_values",
  attachments: "ebitda_adjustment_attachments",
  comments: "ebitda_adjustment_comments",
  auditLog: "ebitda_adjustment_audit_log",
};

const DEFAULT_ADJUSTMENT_TYPES = Object.freeze([
  {
    type_key: "personal_expense",
    label: "Personal Expense",
    description: "Expenses that are personal in nature and should be added back.",
    sort_order: 10,
    is_active: true,
  },
  {
    type_key: "non_recurring_charge",
    label: "Non-recurring Charge",
    description: "One-time or non-recurring costs that normalize earnings.",
    sort_order: 20,
    is_active: true,
  },
  {
    type_key: "officer_compensation",
    label: "Officer Compensation",
    description: "Owner/officer compensation adjustment.",
    sort_order: 30,
    is_active: true,
  },
  {
    type_key: "related_party_rent",
    label: "Related Party Rent",
    description: "Rent paid to a related party above or below market.",
    sort_order: 40,
    is_active: true,
  },
  {
    type_key: "other_non_market_wages",
    label: "Other Non-Market Wages",
    description: "Payroll or wage adjustments outside market compensation.",
    sort_order: 50,
    is_active: true,
  },
  {
    type_key: "prior_period_adjustment",
    label: "Prior Period Adjustment",
    description: "Prior period or historical corrections.",
    sort_order: 60,
    is_active: true,
  },
  {
    type_key: "accrual_adjustment",
    label: "Accrual Adjustment",
    description: "Accrual-based normalization or reversal.",
    sort_order: 70,
    is_active: true,
  },
  {
    type_key: "other_addback",
    label: "Other Addback",
    description: "Any other EBITDA normalization that does not fit a standard type.",
    sort_order: 80,
    is_active: true,
  },
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function toFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function toAbsoluteNumber(value, fallback = 0) {
  const numeric = toFiniteNumber(value, fallback);
  return Number.isFinite(numeric) ? Math.abs(numeric) : Math.abs(fallback);
}

function normalizeAdjustmentStatus(value, fallback = "approved") {
  const normalized = normalizeText(value || "", fallback).toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "active") return "approved";
  return normalized;
}

function toPositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function asJson(value, fallback) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return value;
  return fallback;
}

function extractNestedNumericValue(value, fallback = 0) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.value !== undefined || value.amount !== undefined || value.monthValue !== undefined) {
      return toAbsoluteNumber(value.value ?? value.amount ?? value.monthValue ?? value.overrideValue ?? value.userValue ?? fallback, fallback);
    }
  }
  return toAbsoluteNumber(value, fallback);
}

function clone(value) {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return value;
  }
}

function normalizeVendorScope(scope) {
  const arr = toArray(scope)
    .map((item) => {
      if (typeof item === "string") return normalizeText(item);
      if (item && typeof item === "object") {
        return normalizeText(item.vendorName || item.name || item.label || item.value);
      }
      return "";
    })
    .filter(Boolean);
  return Array.from(new Set(arr));
}

function normalizeComments(comments) {
  const items = toArray(comments)
    .map((item) => {
      if (typeof item === "string") {
        const body = normalizeText(item);
        if (!body) return null;
        return { body, comment_type: "internal", metadata: {} };
      }
      if (!item || typeof item !== "object") return null;
      const body = normalizeText(item.body || item.comment || item.text);
      if (!body) return null;
      return {
        body,
        comment_type: normalizeText(item.comment_type || item.commentType, "internal"),
        metadata: asJson(item.metadata, {}),
      };
    })
    .filter(Boolean);

  return items;
}

function normalizeAttachments(attachments) {
  return toArray(attachments)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const fileName = normalizeText(item.fileName || item.file_name || item.name);
      const fileUrl = normalizeText(item.fileUrl || item.file_url || item.url);
      if (!fileName || !fileUrl) return null;
      return {
        id: normalizeText(item.id) || null,
        upload_id: normalizeText(item.uploadId || item.upload_id) || null,
        file_name: fileName,
        file_url: fileUrl,
        content_type: normalizeText(item.contentType || item.content_type) || null,
        size_bytes: Number.isFinite(Number(item.sizeBytes ?? item.size_bytes))
          ? Number(item.sizeBytes ?? item.size_bytes)
          : null,
        metadata: asJson(item.metadata, {}),
      };
    })
    .filter(Boolean);
}

function normalizeMonthlyValues(monthValues) {
  if (!monthValues) return {};

  const entries = Array.isArray(monthValues)
    ? monthValues
    : typeof monthValues === "object"
      ? Object.entries(monthValues).map(([month, value]) => ({ month, value }))
      : [];

  const out = {};
  for (const item of entries) {
    if (!item) continue;
    const month = toPositiveInteger(item.month ?? item.monthNumber ?? item.key, null);
    if (!month || month > 12) continue;
    out[String(month)] = {
      value: extractNestedNumericValue(item.value ?? item.amount ?? item.monthValue ?? 0, 0),
      originalValue: item.originalValue !== undefined || item.original_value !== undefined
        ? toAbsoluteNumber(item.originalValue ?? item.original_value, 0)
        : null,
      overrideValue: item.overrideValue !== undefined || item.override_value !== undefined
        ? toAbsoluteNumber(item.overrideValue ?? item.override_value, 0)
        : null,
      overrideReason: normalizeText(item.overrideReason || item.override_reason || ""),
      metadata: asJson(item.metadata, {}),
    };
  }
  return out;
}

function normalizeYearValues(values) {
  const yearMap = values && typeof values === "object" ? values : {};
  const result = {};

  for (const [yearKey, raw] of Object.entries(yearMap)) {
    const year = toPositiveInteger(yearKey, null);
    if (!year) continue;

    const entry = raw && typeof raw === "object" ? raw : { userValue: raw };
    const apiValue = toAbsoluteNumber(entry.apiValue ?? entry.sourceValue ?? entry.originalValue ?? 0, 0);
    const originalValue = entry.originalValue ?? entry.apiValue ?? entry.sourceValue ?? null;
    const overrideValue = entry.overrideValue ?? entry.userValue ?? null;
    const monthlyValues = normalizeMonthlyValues(
      entry.monthlyValues ?? entry.monthValues ?? entry.months ?? entry.monthly,
    );
    const monthlySum = Object.values(monthlyValues).reduce((sum, item) => sum + toAbsoluteNumber(item.value, 0), 0);
    const computedValue = Number.isFinite(toFiniteNumber(overrideValue, NaN))
      ? toAbsoluteNumber(overrideValue, 0)
      : Number.isFinite(toFiniteNumber(entry.value, NaN))
        ? toAbsoluteNumber(entry.value, 0)
        : (Object.keys(monthlyValues).length > 0 ? monthlySum : apiValue);

    result[String(year)] = {
      apiValue,
      sourceValue: apiValue,
      originalValue: originalValue !== null && originalValue !== undefined ? toAbsoluteNumber(originalValue, apiValue) : apiValue,
      overrideValue: Number.isFinite(toFiniteNumber(overrideValue, NaN)) ? toAbsoluteNumber(overrideValue, 0) : null,
      userValue: Number.isFinite(toFiniteNumber(overrideValue, NaN)) ? toAbsoluteNumber(overrideValue, 0) : null,
      overrideReason: normalizeText(entry.overrideReason || entry.override_reason || ""),
      monthlyValues,
      metadata: asJson(entry.metadata, {}),
      value: computedValue,
    };
  }

  return result;
}

function calculateAnnualValue(yearEntry = {}) {
  if (Number.isFinite(yearEntry.overrideValue)) return toAbsoluteNumber(yearEntry.overrideValue, 0);
  if (Number.isFinite(yearEntry.userValue)) return toAbsoluteNumber(yearEntry.userValue, 0);

  const monthlyValues = yearEntry.monthlyValues && typeof yearEntry.monthlyValues === "object"
    ? Object.values(yearEntry.monthlyValues)
    : [];
  if (monthlyValues.length > 0) {
    return monthlyValues.reduce((sum, item) => sum + toAbsoluteNumber(item?.value, 0), 0);
  }

  return toAbsoluteNumber(yearEntry.apiValue ?? yearEntry.originalValue ?? yearEntry.sourceValue ?? 0, 0);
}

function generateAdjustmentId() {
  return typeof randomUUID === "function" ? randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeAdjustmentInput(input = {}) {
  const id = normalizeText(input.id) || generateAdjustmentId();
  const typeKey = normalizeText(input.typeKey || input.addbackTypeKey || input.type_key, "other_addback");
  const name = normalizeText(input.name || input.label, "Untitled Addback");
  const description = normalizeText(input.description || "");
  const linkedAccountId = normalizeText(input.linkedAccountId || input.accountId || input.account_id || "");
  const linkedAccountName = normalizeText(input.linkedAccountName || input.accountName || input.account_name || "");
  const vendorScopeMode = normalizeText(input.vendorScopeMode || input.vendor_scope_mode, "entire_account");
  const vendorScope = normalizeVendorScope(
    input.vendorScope ?? input.vendor_scope ?? input.vendorNames ?? input.vendor_names,
  );
  const isManual = Boolean(input.isManual ?? input.is_manual ?? (!linkedAccountId && !linkedAccountName));
  const overrideReason = normalizeText(input.overrideReason || input.override_reason || "");
  const internalNotes = normalizeText(input.internalNotes || input.internal_notes || "");
  const analystComments = normalizeText(input.analystComments || input.analyst_comments || "");
  const supportingExplanation = normalizeText(
    input.supportingExplanation || input.supporting_explanation || input.explanation || "",
  );
  const metadata = asJson(input.metadata, {});
  const values = normalizeYearValues(input.values || {});
  const attachments = normalizeAttachments(input.attachments || []);
  const comments = normalizeComments(input.comments || []);

  return {
    id,
    typeKey,
    name,
    description,
    linkedAccountId,
    linkedAccountName,
    vendorScopeMode,
    vendorScope,
    isManual,
    overrideReason,
    internalNotes,
    analystComments,
    supportingExplanation,
    metadata,
    status: normalizeAdjustmentStatus(input.status || input.approvalStatus || "approved", "approved"),
    values,
    attachments,
    comments,
  };
}

function normalizeAdjustmentTypes(rows = []) {
  return rows
    .map((row) => {
      if (!row) return null;
      const typeKey = normalizeText(row.type_key || row.typeKey || row.key || "");
      if (!typeKey) return null;
      return {
        id: normalizeText(row.id) || typeKey,
        typeKey,
        label: normalizeText(row.label || row.name || typeKey),
        description: normalizeText(row.description || ""),
        sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0) || 0,
        isActive: row.is_active ?? row.isActive ?? true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

async function listAdjustmentTypes() {
  const fallback = DEFAULT_ADJUSTMENT_TYPES.map((type) => ({
    id: type.type_key,
    typeKey: type.type_key,
    label: type.label,
    description: type.description,
    sortOrder: type.sort_order,
    isActive: type.is_active,
  }));

  if (!supabase) return fallback;

  try {
    const { data, error } = await supabase
      .from(TABLES.adjustmentTypes)
      .select("id, type_key, label, description, sort_order, is_active")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("label", { ascending: true });

    if (error) throw error;
    const normalized = normalizeAdjustmentTypes(data || []);
    return normalized.length ? normalized : fallback;
  } catch (error) {
    console.warn("[EBITDA][Adjustments] Falling back to built-in types:", error.message);
    return fallback;
  }
}

function buildScopeFilter(query, scope = {}) {
  if (!scope.companyId || !scope.versionId) {
    throw new Error("companyId and versionId are required for EBITDA adjustments.");
  }

  query = query
    .eq("company_id", scope.companyId)
    .eq("version_id", scope.versionId)
    .eq("source_key", scope.sourceKey || "manual_gl");

  if (scope.datasetVersionId) {
    query = query.eq("dataset_version_id", scope.datasetVersionId);
  }
  if (scope.uploadBatchId) {
    query = query.eq("upload_batch_id", scope.uploadBatchId);
  }

  return query;
}

async function listEbitdaAdjustments(scope = {}) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  const normalizedScope = {
    companyId: normalizeText(scope.companyId || ""),
    versionId: normalizeText(scope.versionId || ""),
    sourceKey: normalizeText(scope.sourceKey || "manual_gl", "manual_gl"),
    datasetVersionId: normalizeText(scope.datasetVersionId || "") || null,
    uploadBatchId: normalizeText(scope.uploadBatchId || "") || null,
  };

  let adjustmentQuery = supabase
    .from(TABLES.adjustments)
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  adjustmentQuery = buildScopeFilter(adjustmentQuery, normalizedScope);
  const { data: adjustmentRows, error } = await adjustmentQuery;
  if (error) throw new Error(`Failed to list EBITDA adjustments: ${error.message}`);

  const adjustments = Array.isArray(adjustmentRows) ? adjustmentRows : [];
  if (!adjustments.length) {
    return {
      scope: normalizedScope,
      adjustments: [],
      types: await listAdjustmentTypes(),
    };
  }

  const ids = adjustments.map((row) => row.id).filter(Boolean);
  const [valueResult, attachmentResult, commentResult, auditResult, typeRows] = await Promise.all([
    supabase.from(TABLES.values).select("*").in("adjustment_id", ids).order("year", { ascending: true }).order("month", { ascending: true }),
    supabase.from(TABLES.attachments).select("*").in("adjustment_id", ids).order("created_at", { ascending: true }),
    supabase.from(TABLES.comments).select("*").in("adjustment_id", ids).order("created_at", { ascending: true }),
    supabase.from(TABLES.auditLog).select("*").in("adjustment_id", ids).order("created_at", { ascending: false }),
    listAdjustmentTypes(),
  ]);

  if (valueResult.error) throw new Error(`Failed to list EBITDA values: ${valueResult.error.message}`);
  if (attachmentResult.error) throw new Error(`Failed to list EBITDA attachments: ${attachmentResult.error.message}`);
  if (commentResult.error) throw new Error(`Failed to list EBITDA comments: ${commentResult.error.message}`);
  if (auditResult.error) throw new Error(`Failed to list EBITDA audit records: ${auditResult.error.message}`);

  const valuesByAdjustment = new Map();
  for (const row of valueResult.data || []) {
    if (!valuesByAdjustment.has(row.adjustment_id)) valuesByAdjustment.set(row.adjustment_id, []);
    valuesByAdjustment.get(row.adjustment_id).push(row);
  }

  const attachmentsByAdjustment = new Map();
  for (const row of attachmentResult.data || []) {
    if (!attachmentsByAdjustment.has(row.adjustment_id)) attachmentsByAdjustment.set(row.adjustment_id, []);
    attachmentsByAdjustment.get(row.adjustment_id).push(row);
  }

  const commentsByAdjustment = new Map();
  for (const row of commentResult.data || []) {
    if (!commentsByAdjustment.has(row.adjustment_id)) commentsByAdjustment.set(row.adjustment_id, []);
    commentsByAdjustment.get(row.adjustment_id).push(row);
  }

  const auditsByAdjustment = new Map();
  for (const row of auditResult.data || []) {
    if (!auditsByAdjustment.has(row.adjustment_id)) auditsByAdjustment.set(row.adjustment_id, []);
    auditsByAdjustment.get(row.adjustment_id).push(row);
  }

  const typeMap = new Map((typeRows || []).map((type) => [type.typeKey || type.type_key, type]));

  const result = adjustments.map((row) => {
    const yearRows = valuesByAdjustment.get(row.id) || [];
    const yearMap = {};
    const grouped = new Map();
    for (const valueRow of yearRows) {
      if (!grouped.has(valueRow.year)) grouped.set(valueRow.year, []);
      grouped.get(valueRow.year).push(valueRow);
    }

    for (const [year, rows] of grouped.entries()) {
      const annualRow = rows.find((item) => Number(item.month) === 0) || rows[0];
      const monthlyRows = rows.filter((item) => Number(item.month) > 0);
      const monthlyValues = {};
      for (const monthRow of monthlyRows) {
        monthlyValues[String(Number(monthRow.month))] = {
          value: toAbsoluteNumber(monthRow.value, 0),
          originalValue: monthRow.original_value !== null && monthRow.original_value !== undefined
            ? toAbsoluteNumber(monthRow.original_value, 0)
            : null,
          overrideValue: monthRow.override_value !== null && monthRow.override_value !== undefined
            ? toAbsoluteNumber(monthRow.override_value, 0)
            : null,
          overrideReason: normalizeText(monthRow.override_reason || ""),
          metadata: asJson(monthRow.metadata, {}),
        };
      }

      const apiValue = annualRow
        ? toFiniteNumber(
          annualRow.source_value ??
          annualRow.original_value ??
          annualRow.value ??
          0,
          0,
        )
        : 0;
      const overrideValue = annualRow?.override_value ?? null;
      const computedValue = monthlyRows.length > 0
        ? monthlyRows.reduce((sum, monthRow) => sum + toAbsoluteNumber(monthRow.value, 0), 0)
        : toAbsoluteNumber(annualRow?.value ?? apiValue, 0);
      const normalizedOverrideValue = overrideValue !== null && overrideValue !== undefined
        ? toAbsoluteNumber(overrideValue, 0)
        : null;
      const staleZeroOverride = normalizedOverrideValue === 0 && apiValue !== 0;
      const effectiveValue = staleZeroOverride
        ? (computedValue !== 0 ? computedValue : apiValue)
        : computedValue;

      yearMap[String(year)] = {
        apiValue: toAbsoluteNumber(apiValue, 0),
        sourceValue: toAbsoluteNumber(apiValue, 0),
        originalValue: annualRow?.original_value !== null && annualRow?.original_value !== undefined
          ? toAbsoluteNumber(annualRow.original_value, apiValue)
          : toAbsoluteNumber(apiValue, 0),
        overrideValue: staleZeroOverride ? null : normalizedOverrideValue,
        userValue: staleZeroOverride ? null : normalizedOverrideValue,
        overrideReason: normalizeText(annualRow?.override_reason || ""),
        monthlyValues,
        metadata: asJson(annualRow?.metadata, {}),
        value: toAbsoluteNumber(effectiveValue, 0),
      };
    }

    const type = typeMap.get(row.type_key) || null;
    return {
      id: row.id,
      companyId: row.company_id,
      versionId: row.version_id,
      datasetVersionId: row.dataset_version_id || null,
      uploadBatchId: row.upload_batch_id || null,
      sourceKey: row.source_key,
      typeKey: row.type_key,
      type,
      name: row.name,
      description: row.description || "",
      linkedAccountId: row.linked_account_id || "",
      linkedAccountName: row.linked_account_name || "",
      vendorScopeMode: row.vendor_scope_mode || "entire_account",
      vendorScope: normalizeVendorScope(row.vendor_scope),
      isManual: Boolean(row.is_manual),
      overrideReason: row.override_reason || "",
      internalNotes: row.internal_notes || "",
      analystComments: row.analyst_comments || "",
      supportingExplanation: row.supporting_explanation || "",
      metadata: asJson(row.metadata, {}),
      status: normalizeAdjustmentStatus(row.status || row.approval_status || "approved", "approved"),
      values: yearMap,
      attachments: attachmentsByAdjustment.get(row.id) || [],
      comments: commentsByAdjustment.get(row.id) || [],
      auditLog: auditsByAdjustment.get(row.id) || [],
      createdBy: row.created_by || null,
      updatedBy: row.updated_by || null,
      deletedBy: row.deleted_by || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      deletedAt: row.deleted_at || null,
    };
  });

  return {
    scope: normalizedScope,
    adjustments: result,
    types: typeRows || await listAdjustmentTypes(),
  };
}

function normalizeScope(scope = {}) {
  return {
    companyId: normalizeText(scope.companyId || scope.company_id || ""),
    versionId: normalizeText(scope.versionId || scope.version_id || ""),
    sourceKey: normalizeText(scope.sourceKey || scope.source_key || "manual_gl", "manual_gl"),
    datasetVersionId: normalizeText(scope.datasetVersionId || scope.dataset_version_id || "") || null,
    uploadBatchId: normalizeText(scope.uploadBatchId || scope.upload_batch_id || "") || null,
  };
}

function buildValueRows(adjustment, scope) {
  const rows = [];
  const yearMap = adjustment.values && typeof adjustment.values === "object" ? adjustment.values : {};

  for (const [yearKey, yearEntryRaw] of Object.entries(yearMap)) {
    const year = toPositiveInteger(yearKey, null);
    if (!year) continue;

    const yearEntry = yearEntryRaw && typeof yearEntryRaw === "object"
      ? yearEntryRaw
      : { userValue: yearEntryRaw };
    const monthlyValues = normalizeMonthlyValues(
      yearEntry.monthlyValues ?? yearEntry.monthValues ?? yearEntry.months ?? yearEntry.monthly,
    );
    const monthlySum = Object.values(monthlyValues).reduce((sum, item) => sum + toAbsoluteNumber(item.value, 0), 0);
    const sourceValue = toAbsoluteNumber(yearEntry.apiValue ?? yearEntry.sourceValue ?? yearEntry.originalValue ?? 0, 0);
    const overrideValue = yearEntry.overrideValue ?? yearEntry.userValue ?? null;
    const annualValue = overrideValue !== null && overrideValue !== undefined
      ? toAbsoluteNumber(overrideValue, 0)
      : Object.keys(monthlyValues).length > 0
        ? monthlySum
        : sourceValue;
    const annualMetadata = asJson(yearEntry.metadata, {});

    rows.push({
      company_id: scope.companyId,
      version_id: scope.versionId,
      adjustment_id: adjustment.id,
      year,
      month: 0,
      value: annualValue,
      original_value: yearEntry.originalValue !== null && yearEntry.originalValue !== undefined
        ? toAbsoluteNumber(yearEntry.originalValue, sourceValue)
        : sourceValue,
      override_value: overrideValue !== null && overrideValue !== undefined ? toAbsoluteNumber(overrideValue, 0) : null,
      override_reason: normalizeText(yearEntry.overrideReason || adjustment.overrideReason || ""),
      source_value: sourceValue,
      metadata: annualMetadata,
    });

    for (const [monthKey, monthEntry] of Object.entries(monthlyValues)) {
      const month = toPositiveInteger(monthKey, null);
      if (!month || month < 1 || month > 12) continue;
      rows.push({
        company_id: scope.companyId,
        version_id: scope.versionId,
        adjustment_id: adjustment.id,
        year,
        month,
        value: toAbsoluteNumber(monthEntry.value, 0),
        original_value: monthEntry.originalValue !== null && monthEntry.originalValue !== undefined
          ? toAbsoluteNumber(monthEntry.originalValue, 0)
          : null,
        override_value: monthEntry.overrideValue !== null && monthEntry.overrideValue !== undefined
          ? toAbsoluteNumber(monthEntry.overrideValue, 0)
          : null,
        override_reason: normalizeText(monthEntry.overrideReason || ""),
        source_value: monthEntry.sourceValue !== null && monthEntry.sourceValue !== undefined
          ? toAbsoluteNumber(monthEntry.sourceValue, 0)
          : null,
        metadata: asJson(monthEntry.metadata, {}),
      });
    }
  }

  return rows;
}

function buildAttachmentRows(adjustment, scope, actorId = null) {
  const attachments = normalizeAttachments(adjustment.attachments || []);
  return attachments.map((attachment) => ({
    id: attachment.id || generateAdjustmentId(),
    company_id: scope.companyId,
    version_id: scope.versionId,
    adjustment_id: adjustment.id,
    upload_id: attachment.upload_id,
    file_name: attachment.file_name,
    file_url: attachment.file_url,
    content_type: attachment.content_type,
    size_bytes: attachment.size_bytes,
    metadata: attachment.metadata || {},
    created_by: actorId || null,
  }));
}

function buildCommentRows(adjustment, scope, actorId = null) {
  const comments = normalizeComments(adjustment.comments || []);
  return comments.map((comment) => ({
    id: generateAdjustmentId(),
    company_id: scope.companyId,
    version_id: scope.versionId,
    adjustment_id: adjustment.id,
    comment_type: comment.comment_type || "internal",
    body: comment.body,
    metadata: comment.metadata || {},
    created_by: actorId || null,
  }));
}

function buildMasterPayload(adjustment, scope, actorId = null) {
  return {
    id: adjustment.id,
    company_id: scope.companyId,
    version_id: scope.versionId,
    dataset_version_id: scope.datasetVersionId || null,
    upload_batch_id: scope.uploadBatchId || null,
    source_key: scope.sourceKey || "manual_gl",
    type_key: adjustment.typeKey,
    name: adjustment.name,
    description: adjustment.description || null,
    linked_account_id: adjustment.linkedAccountId || null,
    linked_account_name: adjustment.linkedAccountName || null,
    vendor_scope_mode: adjustment.vendorScopeMode || "entire_account",
    vendor_scope: adjustment.vendorScope || [],
    is_manual: Boolean(adjustment.isManual),
    override_reason: adjustment.overrideReason || null,
    internal_notes: adjustment.internalNotes || null,
    analyst_comments: adjustment.analystComments || null,
    supporting_explanation: adjustment.supportingExplanation || null,
    metadata: adjustment.metadata || {},
    status: normalizeAdjustmentStatus(adjustment.status || adjustment.approvalStatus || "approved", "approved"),
    updated_by: actorId || null,
    deleted_at: null,
    deleted_by: null,
  };
}

function detectDuplicateWarnings(adjustments = []) {
  const warnings = [];
  const seen = new Map();

  for (const adjustment of adjustments) {
    const key = [
      normalizeText(adjustment.linkedAccountId || ""),
      normalizeText(adjustment.linkedAccountName || "").toLowerCase(),
      normalizeText(adjustment.typeKey || "").toLowerCase(),
      normalizeText(adjustment.vendorScopeMode || "").toLowerCase(),
      JSON.stringify(normalizeVendorScope(adjustment.vendorScope || [])),
    ].join("|");

    if (!seen.has(key)) {
      seen.set(key, adjustment);
      continue;
    }

    const existing = seen.get(key);
    warnings.push({
      type: "duplicate_adjustment",
      message: `Potential duplicate addback detected for ${adjustment.linkedAccountName || adjustment.name}.`,
      adjustmentIds: [existing.id, adjustment.id].filter(Boolean),
    });
  }

  return warnings;
}

async function saveEbitdaAdjustmentsBatch(payload = {}, actorId = null) {
  if (!supabase) throw new Error("Supabase client is not configured.");

  const scope = normalizeScope(payload);
  if (!scope.companyId || !scope.versionId) {
    throw new Error("companyId and versionId are required to save EBITDA adjustments.");
  }

  const normalizedAdjustments = toArray(payload.adjustments).map((item) => normalizeAdjustmentInput(item));
  const incomingIds = new Set(normalizedAdjustments.map((item) => item.id));
  const now = nowIso();

  const existingResult = await supabase
    .from(TABLES.adjustments)
    .select("*")
    .eq("company_id", scope.companyId)
    .eq("version_id", scope.versionId)
    .eq("source_key", scope.sourceKey || "manual_gl");

  if (existingResult.error) {
    throw new Error(`Failed to read EBITDA adjustments before save: ${existingResult.error.message}`);
  }

  const existingRows = existingResult.data || [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const warnings = detectDuplicateWarnings(normalizedAdjustments);

  for (const adjustment of normalizedAdjustments) {
    const before = existingById.get(adjustment.id) || null;
    const masterPayload = buildMasterPayload(adjustment, scope, actorId);

    const { data: savedMaster, error: saveError } = await supabase
      .from(TABLES.adjustments)
      .upsert(masterPayload, { onConflict: "id" })
      .select("*")
      .maybeSingle();

    if (saveError) {
      throw new Error(`Failed to save EBITDA adjustment "${adjustment.name}": ${saveError.message}`);
    }

    const adjustmentId = savedMaster?.id || adjustment.id;

    const { error: deleteValuesError } = await supabase
      .from(TABLES.values)
      .delete()
      .eq("adjustment_id", adjustmentId);
    if (deleteValuesError) {
      throw new Error(`Failed to clear EBITDA values for "${adjustment.name}": ${deleteValuesError.message}`);
    }

    const valueRows = buildValueRows({ ...adjustment, id: adjustmentId }, scope, actorId);
    if (valueRows.length > 0) {
      const { error: insertValuesError } = await supabase
        .from(TABLES.values)
        .insert(valueRows.map((row) => ({ ...row, created_at: now, updated_at: now })));
      if (insertValuesError) {
        throw new Error(`Failed to save EBITDA values for "${adjustment.name}": ${insertValuesError.message}`);
      }
    }

    const { error: deleteAttachmentsError } = await supabase
      .from(TABLES.attachments)
      .delete()
      .eq("adjustment_id", adjustmentId);
    if (deleteAttachmentsError) {
      throw new Error(`Failed to clear EBITDA attachments for "${adjustment.name}": ${deleteAttachmentsError.message}`);
    }

    const attachmentRows = buildAttachmentRows({ ...adjustment, id: adjustmentId }, scope, actorId);
    if (attachmentRows.length > 0) {
      const { error: insertAttachmentsError } = await supabase
        .from(TABLES.attachments)
        .insert(attachmentRows.map((row) => ({ ...row, created_at: now })));
      if (insertAttachmentsError) {
        throw new Error(`Failed to save EBITDA attachments for "${adjustment.name}": ${insertAttachmentsError.message}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(adjustment, "comments")) {
      const { error: deleteCommentsError } = await supabase
        .from(TABLES.comments)
        .delete()
        .eq("adjustment_id", adjustmentId);
      if (deleteCommentsError) {
        throw new Error(`Failed to clear EBITDA comments for "${adjustment.name}": ${deleteCommentsError.message}`);
      }

      const commentRows = buildCommentRows({ ...adjustment, id: adjustmentId }, scope, actorId);
      if (commentRows.length > 0) {
        const { error: insertCommentsError } = await supabase
          .from(TABLES.comments)
          .insert(commentRows.map((row) => ({ ...row, created_at: now, updated_at: now })));
        if (insertCommentsError) {
          throw new Error(`Failed to save EBITDA comments for "${adjustment.name}": ${insertCommentsError.message}`);
        }
      }
    }

    const changedFields = Object.keys(masterPayload).filter((key) => key !== "id" && key !== "company_id" && key !== "version_id");
    const auditPayload = {
      company_id: scope.companyId,
      version_id: scope.versionId,
      adjustment_id: adjustmentId,
      event_type: before ? "updated" : "created",
      changed_fields: changedFields,
      before_payload: before || {},
      after_payload: {
        ...masterPayload,
        values: valueRows,
        attachments: attachmentRows,
      },
      metadata: {
        sourceKey: scope.sourceKey,
        datasetVersionId: scope.datasetVersionId || null,
        uploadBatchId: scope.uploadBatchId || null,
      },
      created_by: actorId || null,
      created_at: now,
    };

    const { error: auditError } = await supabase.from(TABLES.auditLog).insert(auditPayload);
    if (auditError) {
      throw new Error(`Failed to write EBITDA audit log for "${adjustment.name}": ${auditError.message}`);
    }
  }

  const toDelete = existingRows
    .filter((row) => !incomingIds.has(row.id))
    .map((row) => row.id);

  if (toDelete.length > 0) {
    const deleteIds = toDelete;
    const { error: valueDeleteError } = await supabase
      .from(TABLES.values)
      .delete()
      .in("adjustment_id", deleteIds);
    if (valueDeleteError) {
      throw new Error(`Failed to delete EBITDA values: ${valueDeleteError.message}`);
    }

    const { error: attachmentDeleteError } = await supabase
      .from(TABLES.attachments)
      .delete()
      .in("adjustment_id", deleteIds);
    if (attachmentDeleteError) {
      throw new Error(`Failed to delete EBITDA attachments: ${attachmentDeleteError.message}`);
    }

    const { error: commentDeleteError } = await supabase
      .from(TABLES.comments)
      .delete()
      .in("adjustment_id", deleteIds);
    if (commentDeleteError) {
      throw new Error(`Failed to delete EBITDA comments: ${commentDeleteError.message}`);
    }

    const { error: deleteError } = await supabase
      .from(TABLES.adjustments)
      .update({
        deleted_at: now,
        deleted_by: actorId || null,
        status: "deleted",
        updated_at: now,
      })
      .in("id", deleteIds);
    if (deleteError) {
      throw new Error(`Failed to soft-delete removed EBITDA adjustments: ${deleteError.message}`);
    }

    for (const deletedId of deleteIds) {
      const { error: auditError } = await supabase.from(TABLES.auditLog).insert({
        company_id: scope.companyId,
        version_id: scope.versionId,
        adjustment_id: deletedId,
        event_type: "deleted",
        changed_fields: ["deleted_at", "status"],
        before_payload: existingById.get(deletedId) || {},
        after_payload: {},
        metadata: {
          sourceKey: scope.sourceKey,
          datasetVersionId: scope.datasetVersionId || null,
          uploadBatchId: scope.uploadBatchId || null,
        },
        created_by: actorId || null,
        created_at: now,
      });
      if (auditError) {
        throw new Error(`Failed to write deletion audit log: ${auditError.message}`);
      }
    }
  }

  return {
    scope,
    warnings,
    savedCount: normalizedAdjustments.length,
    deletedCount: toDelete.length,
  };
}

async function deleteEbitdaAdjustment(adjustmentId, scope = {}, actorId = null) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  const normalizedScope = normalizeScope(scope);
  const id = normalizeText(adjustmentId || "");
  if (!id) throw new Error("adjustmentId is required.");

  const { data: existing, error: findError } = await supabase
    .from(TABLES.adjustments)
    .select("*")
    .eq("id", id)
    .eq("company_id", normalizedScope.companyId)
    .eq("version_id", normalizedScope.versionId)
    .maybeSingle();

  if (findError) throw new Error(`Failed to load EBITDA adjustment: ${findError.message}`);
  if (!existing) return { deleted: false };

  const now = nowIso();
  const [valuesResult, attachmentResult, commentResult] = await Promise.all([
    supabase.from(TABLES.values).delete().eq("adjustment_id", id),
    supabase.from(TABLES.attachments).delete().eq("adjustment_id", id),
    supabase.from(TABLES.comments).delete().eq("adjustment_id", id),
  ]);

  if (valuesResult.error) throw new Error(`Failed to delete EBITDA values: ${valuesResult.error.message}`);
  if (attachmentResult.error) throw new Error(`Failed to delete EBITDA attachments: ${attachmentResult.error.message}`);
  if (commentResult.error) throw new Error(`Failed to delete EBITDA comments: ${commentResult.error.message}`);

  const { error: updateError } = await supabase
    .from(TABLES.adjustments)
    .update({
      deleted_at: now,
      deleted_by: actorId || null,
      status: "deleted",
      updated_at: now,
    })
    .eq("id", id);

  if (updateError) throw new Error(`Failed to delete EBITDA adjustment: ${updateError.message}`);

  const { error: auditError } = await supabase.from(TABLES.auditLog).insert({
    company_id: normalizedScope.companyId,
    version_id: normalizedScope.versionId,
    adjustment_id: id,
    event_type: "deleted",
    changed_fields: ["deleted_at", "status"],
    before_payload: existing || {},
    after_payload: {},
    metadata: {
      sourceKey: normalizedScope.sourceKey,
      datasetVersionId: normalizedScope.datasetVersionId || null,
      uploadBatchId: normalizedScope.uploadBatchId || null,
    },
    created_by: actorId || null,
    created_at: now,
  });

  if (auditError) throw new Error(`Failed to log EBITDA deletion: ${auditError.message}`);

  return { deleted: true };
}

async function addEbitdaComment(adjustmentId, scope = {}, comment = {}, actorId = null) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  const normalizedScope = normalizeScope(scope);
  const id = normalizeText(adjustmentId || "");
  if (!id) throw new Error("adjustmentId is required.");

  const body = normalizeText(comment.body || comment.comment || comment.text);
  if (!body) throw new Error("Comment body is required.");

  const payload = {
    company_id: normalizedScope.companyId,
    version_id: normalizedScope.versionId,
    adjustment_id: id,
    comment_type: normalizeText(comment.commentType || comment.comment_type || "internal", "internal"),
    body,
    metadata: asJson(comment.metadata, {}),
    created_by: actorId || null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const { data, error } = await supabase
    .from(TABLES.comments)
    .insert(payload)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to save EBITDA comment: ${error.message}`);
  return data;
}

module.exports = {
  DEFAULT_ADJUSTMENT_TYPES,
  generateAdjustmentId,
  listAdjustmentTypes,
  listEbitdaAdjustments,
  saveEbitdaAdjustmentsBatch,
  deleteEbitdaAdjustment,
  addEbitdaComment,
  normalizeAdjustmentInput,
  normalizeYearValues,
  calculateAnnualValue,
  normalizeScope,
  normalizeAttachments,
  normalizeVendorScope,
};
