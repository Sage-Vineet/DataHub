const { supabase } = require("../db");
const { Pool } = require("pg");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");
const permissionService = require("../services/permissionService");
const { buildSslOptions } = require("../db/pgPool");
const {
  validateUpload,
  UploadRejected,
  contentDisposition,
} = require("../security/fileUpload");
const securityEvents = require("../services/securityEventService");
const { config } = require("../config/env");

// Supabase Storage bucket for file uploads (create this bucket in your Supabase project)
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || "documents";
// Files larger than this go to Storage; smaller ones are stored as bytea
const STORAGE_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: buildSslOptions(process.env.DATABASE_URL),
      max: 5,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });
    _pool.on("error", (err) => console.error("[uploads] pg pool error:", err.message));
  }
  return _pool;
}

async function pgQuery(sql, params = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const { rows } = await pool.query(sql, params);
  return rows;
}

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);

  const decodeSerializedBufferJson = (buffer) => {
    if (!buffer || buffer.length < 2) return null;
    const text = buffer.toString("utf8").trim();
    if (!text.startsWith("{") || !text.includes('"type":"Buffer"')) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === "Buffer" && Array.isArray(parsed.data)) {
        return Buffer.from(parsed.data);
      }
    } catch (_error) {
      return null;
    }
    return null;
  };

  if (typeof data === "string") {
    const value = data.trim();
    if (!value) return Buffer.alloc(0);
    if (/^\\x[0-9a-f]+$/i.test(value)) {
      const decoded = Buffer.from(value.slice(2), "hex");
      return decodeSerializedBufferJson(decoded) || decoded;
    }
    if (/^0x[0-9a-f]+$/i.test(value)) {
      const decoded = Buffer.from(value.slice(2), "hex");
      return decodeSerializedBufferJson(decoded) || decoded;
    }
    const base64Decoded = Buffer.from(value, "base64");
    return decodeSerializedBufferJson(base64Decoded) || base64Decoded;
  }

  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }

  return Buffer.from(String(data));
}

// Upload file buffer to Supabase Storage, return storage path or null on failure
async function uploadToStorage(buffer, storagePath, contentType) {
  if (!supabase) return null;
  try {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: false });
    if (error) {
      console.warn("[uploads] Supabase Storage upload failed:", error.message);
      return null;
    }
    return storagePath;
  } catch (err) {
    console.warn("[uploads] Supabase Storage upload error:", err.message);
    return null;
  }
}

// Download file from Supabase Storage, return Buffer or null
async function downloadFromStorage(storagePath) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .download(storagePath);
    if (error || !data) return null;
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.warn("[uploads] Supabase Storage download error:", err.message);
    return null;
  }
}

/**
 * Storage prefixes a client may write into.
 *
 * WHY an allowlist: the prefix arrived from a client header and was
 * concatenated straight into the object path, so `x-upload-prefix: ../../public`
 * wrote outside the intended folder. A closed set removes the traversal
 * primitive entirely rather than trying to filter it.
 */
const ALLOWED_UPLOAD_PREFIXES = new Set([
  "uploads",
  "documents",
  "reports",
  "statements",
  "avatars",
  "attachments",
]);

const createUpload = asyncHandler(async (req, res) => {
  const fileNameHeader = req.headers["x-file-name"];
  const rawFileName = typeof fileNameHeader === "string" ? fileNameHeader.trim() : "";
  const declaredType = (req.headers["content-type"] || "application/octet-stream")
    .split(";")[0]
    .trim();
  const prefixHeader = req.headers["x-upload-prefix"];
  const requestedPrefix = typeof prefixHeader === "string" ? prefixHeader.trim() : "uploads";
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

  if (!rawFileName) return res.status(400).json({ error: "x-file-name header is required" });
  if (!body.length) return res.status(400).json({ error: "Upload body is required" });

  const prefix = ALLOWED_UPLOAD_PREFIXES.has(requestedPrefix) ? requestedPrefix : "uploads";

  // ── Validate before anything touches storage or the database ──────────────
  // Checks extension, declared MIME, magic bytes, size, executable signatures
  // and embedded active content (macros, PDF JavaScript, OLE objects), and
  // returns a random stored name so the client-supplied one never reaches a
  // filesystem path or object key.
  let validated;
  try {
    validated = validateUpload(
      { buffer: body, originalname: rawFileName, mimetype: declaredType },
      { maxBytes: config.UPLOAD_MAX_BYTES }
    );
  } catch (error) {
    if (error instanceof UploadRejected) {
      await securityEvents.record({
        eventType: "upload_rejected",
        severity: securityEvents.SEVERITY.WARNING,
        ...securityEvents.fromRequest(req),
        metadata: { rejectedBy: error.code, sizeBytes: body.length },
      });
      return res.status(400).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  // The display name is retained for the UI but stripped of path components and
  // control characters; it is never used to build a path.
  const fileName = String(rawFileName).split(/[/\\]/).pop().slice(0, 255);
  const contentType = validated.mimeType;

  const uploadedBy = req.user?.id || null;
  const useLargeStorage = body.length > STORAGE_THRESHOLD_BYTES;

  // For large files, try Supabase Storage first
  let storagePath = null;
  if (useLargeStorage) {
    // storedName is a UUID plus the validated extension — no attacker input.
    const candidate = `${prefix}/${validated.storedName}`;
    storagePath = await uploadToStorage(body, candidate, contentType);
    if (!storagePath) {
      // Storage not available — enforce a hard limit to prevent broken bytea inserts
      const maxBytea = parseInt(process.env.MAX_BYTEA_BYTES || String(10 * 1024 * 1024), 10);
      if (body.length > maxBytea) {
        return res.status(413).json({
          error: `File too large. Maximum size is ${Math.round(maxBytea / 1024 / 1024)} MB when storage is unavailable. Please configure STORAGE_BUCKET in Supabase.`,
        });
      }
    }
  }

  let upload = null;

  if (storagePath) {
    // Store record with storage path, no bytea data
    try {
      const rows = await pgQuery(
        `INSERT INTO uploads (file_name, content_type, size_bytes, storage_path, prefix, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, file_name, content_type, size_bytes, storage_path, prefix, uploaded_by, created_at`,
        [fileName, contentType, body.length, storagePath, prefix, uploadedBy],
      );
      upload = rows[0];
    } catch {
      const { data, error } = await supabase
        .from("uploads")
        .insert({
          file_name: fileName,
          content_type: contentType,
          size_bytes: body.length,
          storage_path: storagePath,
          prefix,
          uploaded_by: uploadedBy,
        })
        .select("id, file_name, content_type, size_bytes, storage_path, prefix, uploaded_by, created_at")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      upload = data;
    }
  } else {
    // Small file — store as bytea
    try {
      const rows = await pgQuery(
        `INSERT INTO uploads (file_name, content_type, size_bytes, data, prefix, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, file_name, content_type, size_bytes, prefix, uploaded_by, created_at`,
        [fileName, contentType, body.length, body, prefix, uploadedBy],
      );
      upload = rows[0];
    } catch {
      const byteaLiteral = `\\x${body.toString("hex")}`;
      const { data, error } = await supabase
        .from("uploads")
        .insert({
          file_name: fileName,
          content_type: contentType,
          size_bytes: body.length,
          data: byteaLiteral,
          prefix,
          uploaded_by: uploadedBy,
        })
        .select("id, file_name, content_type, size_bytes, prefix, uploaded_by, created_at")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      upload = data;
    }
  }

  res.status(201).json({
    id: upload.id,
    fileName: upload.file_name,
    contentType: upload.content_type,
    sizeBytes: upload.size_bytes,
    prefix: upload.prefix,
    fileUrl: buildUploadContentUrl(req, upload.id),
    createdAt: upload.created_at,
  });
});

const getUploadContent = asyncHandler(async (req, res) => {
  let upload = null;

  try {
    const rows = await pgQuery(
      "SELECT id, file_name, content_type, data, storage_path, uploaded_by FROM uploads WHERE id = $1 LIMIT 1",
      [req.params.id],
    );
    upload = rows[0] || null;
  } catch {
    const { data, error } = await supabase
      .from("uploads")
      .select("id, file_name, content_type, data, storage_path, uploaded_by")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    upload = data;
  }

  if (!upload) return res.status(404).json({ error: "Not found" });

  const { data: documentRows, error: documentsError } = await supabase
    .from("documents")
    .select("company_id")
    .eq("upload_id", req.params.id)
    .limit(25);

  if (documentsError) return res.status(500).json({ error: documentsError.message });

  if (!permissionService.isBroker(req.user)) {
    const linkedCompanyIds = Array.from(new Set((documentRows || []).map((row) => row.company_id).filter(Boolean)));
    if (linkedCompanyIds.length) {
      const allowed = linkedCompanyIds.some((companyId) => permissionService.canAccessCompany(req.user, companyId));
      if (!allowed) return res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
    } else if (String(upload.uploaded_by || "") !== String(req.user?.id || "")) {
      // Fail CLOSED on an orphaned upload. The previous condition was
      // `upload.uploaded_by && ...`, so a row with a NULL uploader — which is
      // what a failed or partial insert leaves behind — was downloadable by
      // any authenticated user regardless of tenant.
      return res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
    }
  }

  const fileName = upload.file_name || "download";
  const storedType = String(upload.content_type || "").toLowerCase();

  /**
   * Types safe to render in the browser. Everything else downloads.
   *
   * WHY: `inline` on an arbitrary stored content type lets a file uploaded as
   * `text/html` or `image/svg+xml` execute script in the API's origin. The API
   * origin holds no cookies a script could steal today, but it is a needless
   * foothold — and `nosniff` plus a narrow allowlist costs nothing.
   */
  const INLINE_SAFE = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);
  const isInlineSafe = INLINE_SAFE.has(storedType);

  res.setHeader("Content-Type", isInlineSafe ? storedType : "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    isInlineSafe
      ? `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
      : contentDisposition(fileName)
  );
  // Belt and braces against content sniffing overriding the type above.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");

  // Serve from Supabase Storage if available
  if (upload.storage_path) {
    const buffer = await downloadFromStorage(upload.storage_path);
    if (buffer) {
      res.setHeader("Content-Length", buffer.length);
      return res.send(buffer);
    }
    return res.status(500).json({ error: "Failed to retrieve file from storage" });
  }

  // Fall back to bytea data column (legacy / small files)
  const content = normalizeUploadBinary(upload.data);
  res.send(content);
});

const legacyPresignUpload = asyncHandler(async (_req, res) => {
  res.status(410).json({
    error: "S3 presigned uploads have been removed. Use POST /uploads for direct database-backed uploads.",
  });
});

module.exports = {
  createUpload,
  getUploadContent,
  legacyPresignUpload,
};
