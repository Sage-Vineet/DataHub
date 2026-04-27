const { supabase } = require("../db");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");

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
  const { data, error } = await supabase
    .from("uploads")
    .insert({
      file_name: fileName,
      content_type: contentType || "application/octet-stream",
      size_bytes: body.length,
      data: body,
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
  
  let content = upload.data;
  // If it's a base64 string from Supabase (sometimes SDK returns it as such if not auto-converted)
  if (typeof content === "string") {
    content = Buffer.from(content, "base64");
  }

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
