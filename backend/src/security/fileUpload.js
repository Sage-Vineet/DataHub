"use strict";

/**
 * File upload validation.
 *
 * WHY every layer here is necessary:
 *   • Extension checks alone are trivially bypassed (`invoice.pdf.exe`, or just
 *     renaming a payload to `.pdf`).
 *   • Client-supplied Content-Type is attacker-controlled and means nothing.
 *   • Therefore the file's own leading bytes are inspected and must agree with
 *     both the claimed extension and the claimed MIME type. A mismatch is
 *     treated as hostile, not as a formatting quirk.
 *   • Uploaded names are discarded entirely and replaced with a random id. That
 *     removes path traversal (`../../etc/passwd`), null-byte truncation, Windows
 *     reserved device names (`CON`, `PRN`), and overwrite-by-collision in one go.
 *   • Content is scanned for embedded executables and active-content markers,
 *     because a "valid" PDF or XLSX can still carry JavaScript or a macro.
 *
 * Covers OWASP Top 10 A03 (Injection), A04 (Insecure Design), A08 (Software and
 * Data Integrity Failures).
 */

const path = require("path");
const crypto = require("crypto");
const { config } = require("../config/env");
const logger = require("./logger");

/**
 * Allowlist of accepted types. Anything not listed is rejected — a blocklist of
 * dangerous extensions is always incomplete.
 *
 * `signatures` are the magic bytes that must appear at `offset`. An empty
 * signature array means the format has no reliable magic number (CSV, plain
 * text) and is validated by content heuristics instead.
 */
const ALLOWED_TYPES = Object.freeze({
  "application/pdf": {
    extensions: [".pdf"],
    signatures: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
    maxBytes: 50 * 1024 * 1024,
  },
  "image/png": {
    extensions: [".png"],
    signatures: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
    maxBytes: 10 * 1024 * 1024,
  },
  "image/jpeg": {
    extensions: [".jpg", ".jpeg"],
    signatures: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
    maxBytes: 10 * 1024 * 1024,
  },
  "image/webp": {
    extensions: [".webp"],
    // RIFF....WEBP — the middle four bytes are the length, so check both ends.
    signatures: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
    maxBytes: 10 * 1024 * 1024,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: [".xlsx"],
    signatures: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }], // ZIP container
    maxBytes: 50 * 1024 * 1024,
    isZipContainer: true,
  },
  "application/vnd.ms-excel": {
    extensions: [".xls"],
    signatures: [{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }], // OLE2
    maxBytes: 50 * 1024 * 1024,
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    signatures: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
    maxBytes: 25 * 1024 * 1024,
    isZipContainer: true,
  },
  "text/csv": {
    extensions: [".csv"],
    signatures: [],
    maxBytes: 25 * 1024 * 1024,
    isText: true,
  },
  "text/plain": {
    extensions: [".txt"],
    signatures: [],
    maxBytes: 5 * 1024 * 1024,
    isText: true,
  },
});

/** Extension → canonical MIME, derived from the allowlist. */
const EXTENSION_TO_MIME = (() => {
  const map = new Map();
  for (const [mime, spec] of Object.entries(ALLOWED_TYPES)) {
    for (const extension of spec.extensions) map.set(extension, mime);
  }
  return map;
})();

/**
 * Executable and script signatures that are rejected outright, wherever they
 * appear as the leading bytes — regardless of the claimed type.
 */
const EXECUTABLE_SIGNATURES = [
  { name: "windows-pe", bytes: [0x4d, 0x5a] }, // MZ — .exe/.dll
  { name: "elf", bytes: [0x7f, 0x45, 0x4c, 0x46] }, // Linux ELF
  { name: "mach-o", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: "mach-o-64", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "mach-o-universal", bytes: [0xca, 0xfe, 0xba, 0xbe] }, // also Java class
  { name: "shebang", bytes: [0x23, 0x21] }, // #!
  { name: "ms-installer", bytes: [0x4d, 0x53, 0x43, 0x46] }, // MSCF — cabinet
  { name: "rar", bytes: [0x52, 0x61, 0x72, 0x21] },
  { name: "7zip", bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { name: "gzip", bytes: [0x1f, 0x8b] },
];

/** Extensions that are never accepted even if the bytes look benign. */
const FORBIDDEN_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".com", ".scr", ".msi", ".msp",
  ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".mjs", ".cjs",
  ".jse", ".wsf", ".wsh", ".jar", ".class", ".py", ".rb", ".pl", ".php",
  ".phtml", ".php3", ".php4", ".php5", ".phar", ".asp", ".aspx", ".jsp",
  ".jspx", ".cgi", ".sh", ".bash", ".zsh", ".fish", ".app", ".deb", ".rpm",
  ".dmg", ".pkg", ".apk", ".lnk", ".reg", ".hta", ".cpl", ".inf", ".scf",
  ".svg", // SVG is XML and executes script when rendered inline
  ".htm", ".html", ".xhtml", ".xml", ".xsl", ".xslt",
]);

/** Windows reserved device names — a file so named can hang or confuse tooling. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

class UploadRejected extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UploadRejected";
    this.code = code;
    this.status = 400;
    this.expose = true;
  }
}

function matchesSignature(buffer, signature) {
  const { offset, bytes } = signature;
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function startsWith(buffer, bytes) {
  return matchesSignature(buffer, { offset: 0, bytes });
}

/**
 * Normalises a client-supplied filename to just its extension, safely.
 *
 * Handles: directory components, null-byte truncation, double extensions,
 * unicode direction-override characters used to disguise `exe` as `fdp`.
 */
function safeExtension(originalName) {
  let name = String(originalName || "");

  // Null byte truncation: "shell.php\u0000.pdf" is .php to the filesystem.
  if (name.includes("\u0000")) {
    throw new UploadRejected("Filename contains an invalid character.", "NULL_BYTE");
  }
  // Right-to-left override and friends disguise the real extension visually.
  if (/[\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new UploadRejected("Filename contains an invalid character.", "BIDI_OVERRIDE");
  }

  // Strip any path component — both separators, because a Windows client may
  // send a backslash path to a Linux server.
  name = name.split(/[/\\]/).pop() || "";

  const extension = path.extname(name).toLowerCase();
  const stem = path.basename(name, extension);

  if (RESERVED_NAMES.test(stem)) {
    throw new UploadRejected("Filename is not permitted.", "RESERVED_NAME");
  }

  // Reject a dangerous inner extension too: `report.php.pdf`.
  const parts = name.toLowerCase().split(".");
  for (let i = 1; i < parts.length; i += 1) {
    if (FORBIDDEN_EXTENSIONS.has(`.${parts[i]}`)) {
      throw new UploadRejected("File type is not permitted.", "FORBIDDEN_EXTENSION");
    }
  }

  if (!extension) {
    throw new UploadRejected("File must have an extension.", "MISSING_EXTENSION");
  }
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    throw new UploadRejected("File type is not permitted.", "FORBIDDEN_EXTENSION");
  }
  return extension;
}

/**
 * Heuristic scan of an XLSX/DOCX ZIP container for active content.
 *
 * The Office XML formats are ZIPs; a macro-enabled payload smuggled inside an
 * `.xlsx` shows up as a `vbaProject.bin` entry. Filenames appear as plaintext in
 * the ZIP central directory, so a substring scan finds them without unzipping —
 * which also avoids the zip-bomb risk of decompressing untrusted archives.
 */
function scanZipContainer(buffer) {
  const haystack = buffer.toString("latin1");
  const markers = [
    { needle: "vbaProject.bin", reason: "macro" },
    { needle: "vbaData.xml", reason: "macro" },
    { needle: "/macros/", reason: "macro" },
    { needle: "oleObject", reason: "embedded-ole" },
    { needle: ".exe", reason: "embedded-executable" },
    { needle: ".dll", reason: "embedded-executable" },
    { needle: ".jar", reason: "embedded-executable" },
  ];
  for (const { needle, reason } of markers) {
    if (haystack.includes(needle)) return reason;
  }
  return null;
}

/** Scans a PDF for the constructs used to weaponise one. */
function scanPdf(buffer) {
  const haystack = buffer.toString("latin1");
  const markers = [
    { needle: "/JavaScript", reason: "pdf-javascript" },
    { needle: "/JS", reason: "pdf-javascript" },
    { needle: "/Launch", reason: "pdf-launch-action" },
    { needle: "/EmbeddedFile", reason: "pdf-embedded-file" },
    { needle: "/OpenAction", reason: "pdf-open-action" },
    { needle: "/AA", reason: "pdf-auto-action" },
  ];
  for (const { needle, reason } of markers) {
    if (haystack.includes(needle)) return reason;
  }
  return null;
}

/**
 * Detects spreadsheet formula injection in CSV.
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula when
 * the file is opened in Excel or Sheets — `=cmd|'/c calc'!A1` is remote code
 * execution on the machine of whoever opens the export.
 */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

function sanitizeCsvCell(value) {
  const text = String(value ?? "");
  return CSV_FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

function scanCsv(buffer) {
  // Reject binary content masquerading as CSV.
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return "binary-in-text";
  }
  return null;
}

/**
 * Validates an uploaded file end to end.
 *
 * @param {object} file
 * @param {Buffer} file.buffer          full file contents
 * @param {string} file.originalname    client-supplied name (never trusted)
 * @param {string} [file.mimetype]      client-supplied type (never trusted)
 * @param {object} [options]
 * @param {string[]} [options.allowedMimeTypes] narrow the allowlist per endpoint
 * @param {number}   [options.maxBytes]         override the per-type cap
 * @param {boolean}  [options.rejectActiveContent=true]
 * @returns {{ storedName: string, extension: string, mimeType: string, sizeBytes: number, sha256: string }}
 */
function validateUpload(file, options = {}) {
  const {
    allowedMimeTypes = Object.keys(ALLOWED_TYPES),
    maxBytes = null,
    rejectActiveContent = true,
  } = options;

  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new UploadRejected("No file was received.", "NO_FILE");
  }

  const buffer = file.buffer;
  const sizeBytes = buffer.length;

  if (sizeBytes === 0) {
    throw new UploadRejected("File is empty.", "EMPTY_FILE");
  }

  const globalCap = maxBytes ?? config.UPLOAD_MAX_BYTES;
  if (sizeBytes > globalCap) {
    throw new UploadRejected(
      `File exceeds the maximum size of ${Math.floor(globalCap / (1024 * 1024))} MB.`,
      "FILE_TOO_LARGE"
    );
  }

  // ── 1. Extension ─────────────────────────────────────────────────────────
  const extension = safeExtension(file.originalname);

  // ── 2. Executable content, checked before anything else ──────────────────
  for (const signature of EXECUTABLE_SIGNATURES) {
    if (startsWith(buffer, signature.bytes)) {
      // xlsx/docx are ZIPs and legitimately share no prefix with these, but a
      // gzip/rar/7z prefix on a claimed spreadsheet is definitively hostile.
      throw new UploadRejected("Executable files are not permitted.", "EXECUTABLE_REJECTED");
    }
  }

  // ── 3. Resolve the type from the extension, not the client's Content-Type ─
  const resolvedMime = EXTENSION_TO_MIME.get(extension);
  if (!resolvedMime) {
    throw new UploadRejected("File type is not permitted.", "UNSUPPORTED_TYPE");
  }
  if (!allowedMimeTypes.includes(resolvedMime)) {
    throw new UploadRejected("File type is not permitted for this upload.", "UNSUPPORTED_TYPE");
  }

  const spec = ALLOWED_TYPES[resolvedMime];

  // ── 4. Client-declared MIME must agree, when it declares one at all ──────
  const declaredMime = String(file.mimetype || "").split(";")[0].trim().toLowerCase();
  if (
    declaredMime &&
    declaredMime !== "application/octet-stream" &&
    declaredMime !== resolvedMime &&
    !(resolvedMime === "text/csv" && declaredMime === "text/plain") &&
    !(resolvedMime === "image/jpeg" && declaredMime === "image/jpg")
  ) {
    throw new UploadRejected(
      "Declared file type does not match the file extension.",
      "MIME_MISMATCH"
    );
  }

  // ── 5. Magic bytes must agree ────────────────────────────────────────────
  if (spec.signatures.length > 0) {
    const matches = spec.signatures.every((signature) => matchesSignature(buffer, signature));
    if (!matches) {
      throw new UploadRejected(
        "File contents do not match the declared file type.",
        "SIGNATURE_MISMATCH"
      );
    }
  }

  if (spec.maxBytes && sizeBytes > spec.maxBytes) {
    throw new UploadRejected(
      `File exceeds the maximum size for this type (${Math.floor(spec.maxBytes / (1024 * 1024))} MB).`,
      "FILE_TOO_LARGE"
    );
  }

  // ── 6. Content scan ──────────────────────────────────────────────────────
  if (rejectActiveContent) {
    let finding = null;
    if (spec.isZipContainer) finding = scanZipContainer(buffer);
    else if (resolvedMime === "application/pdf") finding = scanPdf(buffer);
    else if (spec.isText) finding = scanCsv(buffer);

    if (finding) {
      logger.warn("upload_active_content_rejected", {
        rejectedBy: finding,
        mimeType: resolvedMime,
        sizeBytes,
      });
      throw new UploadRejected(
        "File contains active content (scripts, macros or embedded files) and was rejected.",
        "ACTIVE_CONTENT"
      );
    }
  }

  // ── 7. Generate a safe stored name ───────────────────────────────────────
  // The original name is never used on disk or in a URL. It may be retained in
  // a database column for display, where it is output-encoded.
  const storedName = `${crypto.randomUUID()}${extension}`;

  return {
    storedName,
    extension,
    mimeType: resolvedMime,
    sizeBytes,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Resolves a stored filename to an absolute path inside `baseDir`, refusing
 * anything that escapes it.
 *
 * WHY the realpath-style prefix check rather than just stripping `..`: a
 * symlink, or an encoded separator that `path.join` normalises differently than
 * expected, can still escape. Comparing the resolved absolute path against the
 * resolved base directory is the only reliable test.
 */
function resolveWithinDirectory(baseDir, filename) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, path.basename(String(filename || "")));
  // path.sep guard prevents `/data/uploads-evil` matching a `/data/uploads` base.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new UploadRejected("Invalid file path.", "PATH_TRAVERSAL");
  }
  return resolved;
}

/**
 * Content-Disposition value for a download response.
 *
 * Forces `attachment` so the browser never renders the file in the origin's
 * context, and RFC 5987-encodes the name so quotes and newlines in it cannot
 * break out of the header.
 */
function contentDisposition(filename) {
  const fallback = String(filename || "download")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(String(filename || "download"));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  ALLOWED_TYPES,
  FORBIDDEN_EXTENSIONS,
  UploadRejected,
  validateUpload,
  safeExtension,
  resolveWithinDirectory,
  contentDisposition,
  sanitizeCsvCell,
};
