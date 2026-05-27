const { supabase } = require("../db");

const TABLE_UPLOAD_SESSIONS = "manual_gl_upload_sessions";
const STAGED_SESSION_STATUSES = new Set(["staged", "active"]);

function toPositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function mapUploadSessionRow(row) {
  if (!row) return null;

  return {
    ...row,
    fiscal_year: toPositiveInteger(row.fiscal_year, null),
    version_no: toPositiveInteger(row.version_no, null),
    row_count: Math.max(0, Number(row.row_count || 0)),
    is_active: Boolean(row.is_active),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    source_upload_ids: Array.isArray(row.source_upload_ids) ? row.source_upload_ids : [],
  };
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isStagedStatus(value) {
  return STAGED_SESSION_STATUSES.has(normalizeStatus(value));
}

async function listActiveUploadSessions(companyId) {
  if (!companyId) return [];

  const { data, error } = await supabase
    .from(TABLE_UPLOAD_SESSIONS)
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("fiscal_year", { ascending: true })
    .order("version_no", { ascending: false });

  if (error) {
    throw new Error(`Failed to load active upload sessions: ${error.message}`);
  }

  return (Array.isArray(data) ? data : []).map(mapUploadSessionRow).filter(Boolean);
}

async function getActiveUploadSessionMap(companyId) {
  const rows = await listActiveUploadSessions(companyId);
  return new Map(
    rows
      .filter((row) => Number.isInteger(row?.fiscal_year))
      .map((row) => [Number(row.fiscal_year), row]),
  );
}

async function getLatestUploadSessionVersion(companyId, fiscalYear) {
  const normalizedYear = toPositiveInteger(fiscalYear, null);
  if (!companyId || !normalizedYear) return null;

  const { data, error } = await supabase
    .from(TABLE_UPLOAD_SESSIONS)
    .select("version_no")
    .eq("company_id", companyId)
    .eq("fiscal_year", normalizedYear)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to load upload session version: ${error.message}`);
  }

  const versionNo = toPositiveInteger(data?.version_no, null);
  return versionNo || null;
}

async function replaceActiveUploadSessions({
  companyId,
  batchId,
  uploadedBy = null,
  sessions = [],
}) {
  if (!companyId || !batchId || !Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }

  const now = new Date().toISOString();

  // Each fiscal-year session is independent — run them in parallel.
  // Within each session the three operations (SELECT → UPDATE → UPSERT) remain
  // sequential because the deactivation ID feeds into replaced_session_id.
  const activateSession = async (session) => {
    const fiscalYear = toPositiveInteger(session?.fiscalYear, null);
    const versionNo = toPositiveInteger(session?.versionNo, null);
    const dataHash = String(session?.dataHash || "").trim();

    if (!fiscalYear || !versionNo || !dataHash) {
      throw new Error("Upload session activation requires fiscalYear, versionNo, and dataHash.");
    }

    const { data: currentActive, error: currentError } = await supabase
      .from(TABLE_UPLOAD_SESSIONS)
      .select("id")
      .eq("company_id", companyId)
      .eq("fiscal_year", fiscalYear)
      .eq("is_active", true)
      .maybeSingle();

    if (currentError && currentError.code !== "PGRST116") {
      throw new Error(`Failed to load active upload session: ${currentError.message}`);
    }

    if (currentActive?.id) {
      const { error: deactivateError } = await supabase
        .from(TABLE_UPLOAD_SESSIONS)
        .update({
          is_active: false,
          status: "archived",
          deactivated_at: now,
        })
        .eq("id", currentActive.id);

      if (deactivateError) {
        throw new Error(`Failed to deactivate upload session: ${deactivateError.message}`);
      }

      console.log(
        `[ManualGL][UploadSession] Deactivated prior session ${currentActive.id} ` +
        `for company ${companyId}, fiscalYear ${fiscalYear}.`,
      );
    }

    const payload = {
      company_id: companyId,
      fiscal_year: fiscalYear,
      version_no: versionNo,
      file_hash: String(session?.fileHash || "").trim() || null,
      data_hash: dataHash,
      row_count: Math.max(0, Number(session?.rowCount || 0)),
      is_active: true,
      status: "staged",
      staging_batch_id: batchId,
      source_upload_ids: Array.isArray(session?.sourceUploadIds) ? session.sourceUploadIds : [],
      metadata: session?.metadata && typeof session.metadata === "object" ? session.metadata : {},
      created_by: uploadedBy || null,
      created_at: now,
      activated_at: now,
      replaced_session_id: currentActive?.id || null,
    };

    const { data, error } = await supabase
      .from(TABLE_UPLOAD_SESSIONS)
      .upsert(payload, {
        onConflict: "company_id,fiscal_year,version_no",
        ignoreDuplicates: false,
      })
      .select("*")
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to save upload session: ${error.message}`);
    }

    console.log(
      `[ManualGL][UploadSession] Upserted session id=${data?.id || "n/a"} company=${companyId} ` +
      `fiscalYear=${fiscalYear} versionNo=${versionNo} status=staged batchId=${batchId} ` +
      `dataHash=${dataHash.slice(0, 12)}...`,
    );

    return mapUploadSessionRow(data || payload);
  };

  const created = await Promise.all(sessions.map(activateSession));
  return created.filter(Boolean);
}

async function findExistingStagedUploadSessionsByYearHash({
  companyId,
  yearHashes = [],
}) {
  if (!Array.isArray(yearHashes) || yearHashes.length === 0) {
    return { rows: [], matches: [] };
  }
  if (!companyId) {
    return { rows: [], matches: [] };
  }

  const normalizedPairs = yearHashes
    .map((item) => ({
      fiscalYear: toPositiveInteger(item?.fiscalYear, null),
      dataHash: String(item?.dataHash || "").trim().toLowerCase(),
    }))
    .filter((item) => item.fiscalYear && item.dataHash);

  if (!normalizedPairs.length) {
    return { rows: [], matches: [] };
  }

  const fiscalYears = Array.from(new Set(normalizedPairs.map((item) => item.fiscalYear)));

  let query = supabase
    .from(TABLE_UPLOAD_SESSIONS)
    .select(`
      id, company_id, fiscal_year, version_no, data_hash, status, staging_batch_id, created_at,
      manual_gl_batches!staging_batch_id (
        id,
        dataset_version,
        batch_name,
        status
      )
    `)
    .in("fiscal_year", fiscalYears);

  if (companyId) {
    query = query.eq("company_id", companyId);
  }

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to query upload session duplicates: ${error.message}`);
  }

  const rows = (Array.isArray(data) ? data : [])
    .filter((row) => isStagedStatus(row?.status))
    .map(mapUploadSessionRow)
    .filter(Boolean);

  const rowKeyMap = new Map();
  rows.forEach((row) => {
    const fiscalYear = toPositiveInteger(row?.fiscal_year, null);
    const dataHash = String(row?.data_hash || "").trim().toLowerCase();
    if (!fiscalYear || !dataHash) return;
    const key = `${fiscalYear}|${dataHash}`;
    if (!rowKeyMap.has(key)) {
      rowKeyMap.set(key, row);
    }
  });

  const matches = normalizedPairs
    .map((pair) => {
      const key = `${pair.fiscalYear}|${pair.dataHash}`;
      const matched = rowKeyMap.get(key);
      if (!matched) return null;
      return {
        fiscalYear: pair.fiscalYear,
        dataHash: pair.dataHash,
        existingSession: matched,
      };
    })
    .filter(Boolean);

  return { rows, matches };
}

module.exports = {
  TABLE_UPLOAD_SESSIONS,
  STAGED_SESSION_STATUSES,
  listActiveUploadSessions,
  getActiveUploadSessionMap,
  getLatestUploadSessionVersion,
  replaceActiveUploadSessions,
  findExistingStagedUploadSessionsByYearHash,
  isStagedStatus,
};
