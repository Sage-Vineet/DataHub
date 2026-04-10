const db = require("../db");
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

  const { rows } = await db.query(
    `INSERT INTO uploads (file_name, content_type, size_bytes, data, prefix, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, file_name, content_type, size_bytes, prefix, uploaded_by, created_at`,
    [fileName, contentType || "application/octet-stream", body.length, body, prefix || "uploads", req.user?.id || null]
  );

  const upload = rows[0];
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
  const { rows } = await db.query(
    "SELECT id, file_name, content_type, data FROM uploads WHERE id = $1",
    [req.params.id]
  );

  const upload = rows[0];
  if (!upload) {
    return res.status(404).json({ error: "Not found" });
  }

  const fileName = upload.file_name || "download";
  const encodedName = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader("Content-Type", upload.content_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodedName}`);
  res.send(upload.data);
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
