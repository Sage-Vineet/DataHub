const { supabase } = require("../db");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");

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

  // Supabase/PostgREST may return bytea as "\\x<hex>" text.
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

  // Sometimes binary can come back as a serialized Buffer object.
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }

  return Buffer.from(String(data));
}

const createUpload = asyncHandler(async (req, res) => {
  const fileNameHeader = req.headers["x-file-name"];
  const fileName = typeof fileNameHeader === "string" ? fileNameHeader.trim() : "";
  const contentType = (req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
  const prefixHeader = req.headers["x-upload-prefix"];
  const prefix = typeof prefixHeader === "string" ? prefixHeader.trim() : "uploads";
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

  if (!fileName) {
    return res.status(400).json({ error: "x-file-name header is required" });
  }

  if (!body.length) {
    return res.status(400).json({ error: "Upload body is required" });
  }

  // NOTE: Supabase JS SDK handles Buffer/Uint8Array by base64 encoding them for the JSON payload.
  // PostgREST handles the decoding into a bytea column if the database schema is correct.
  const byteaLiteral = `\\x${body.toString("hex")}`;

  const { data, error } = await supabase
    .from("uploads")
    .insert({
      file_name: fileName,
      content_type: contentType || "application/octet-stream",
      size_bytes: body.length,
      data: byteaLiteral,
      prefix: prefix || "uploads",
      uploaded_by: req.user?.id || null
    })
    .select("id, file_name, content_type, size_bytes, prefix, uploaded_by, created_at")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const upload = data;
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
  const { data, error } = await supabase
    .from("uploads")
    .select("id, file_name, content_type, data")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Not found" });

  const upload = data;
  const fileName = upload.file_name || "download";
  const encodedName = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  
  const content = normalizeUploadBinary(upload.data);

  res.setHeader("Content-Type", upload.content_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodedName}`);
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
