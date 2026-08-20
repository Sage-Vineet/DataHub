import { z } from "zod";

/**
 * Data room versioning, comments and chunked upload (`DR - 0001`).
 *
 * These are the capabilities the shipped `folders` and `uploads` modules do not
 * have. They are contracted separately because they are served by a separate
 * module on a separate prefix — `uploads` answers on the paths legacy already
 * serves and must keep doing exactly that.
 *
 * snake_case on the wire throughout, matching every other contract here.
 */

const uuid = z.string().uuid();

// ── versions ────────────────────────────────────────────────────────────────

export const documentVersionResponse = z.object({
  id: uuid,
  document_id: uuid,
  version_no: z.number().int().positive(),
  upload_id: uuid.nullable(),
  file_name: z.string(),
  size_bytes: z.number().int().nonnegative(),
  content_type: z.string().nullable(),
  note: z.string().nullable(),
  created_by: uuid.nullable(),
  created_at: z.string(),
  /** True for the version the document currently resolves to. */
  is_current: z.boolean(),
});
export type DocumentVersionResponse = z.infer<typeof documentVersionResponse>;

export const documentVersionList = z.object({
  document_id: uuid,
  version_count: z.number().int().positive(),
  versions: z.array(documentVersionResponse),
});
export type DocumentVersionList = z.infer<typeof documentVersionList>;

/** Optional note recorded against the restore, not against the version restored. */
export const versionRestore = z.object({
  note: z.string().trim().max(500).optional(),
});
export type VersionRestore = z.infer<typeof versionRestore>;

// ── comments ────────────────────────────────────────────────────────────────

/**
 * Who may read a comment.
 *
 * `internal` is the deal-owning side only — broker and admin. It is the DEFAULT
 * because the failure modes are asymmetric: an internal note wrongly shown to a
 * counterparty cannot be taken back, while a shared note wrongly kept private is
 * a click away from being fixed.
 */
export const commentVisibility = z.enum(["internal", "shared"]);
export type CommentVisibility = z.infer<typeof commentVisibility>;

export const commentCreate = z.object({
  body: z.string().trim().min(1, "A comment needs a body.").max(10_000),
  visibility: commentVisibility.default("internal"),
  version_id: uuid.optional(),
  parent_id: uuid.optional(),
  page_number: z.number().int().positive().optional(),
});
export type CommentCreate = z.infer<typeof commentCreate>;

export const commentResponse = z.object({
  id: uuid,
  document_id: uuid,
  company_id: uuid,
  version_id: uuid.nullable(),
  parent_id: uuid.nullable(),
  body: z.string(),
  visibility: commentVisibility,
  page_number: z.number().int().nullable(),
  author_id: uuid,
  author_name: z.string().nullable(),
  created_at: z.string(),
});
export type CommentResponse = z.infer<typeof commentResponse>;

// ── chunked upload ──────────────────────────────────────────────────────────

/**
 * Chunk-size bounds, enforced by the schema rather than the handler.
 *
 * The ceiling is a booth-safety limit, not a protocol one: several tablets
 * inserting large `bytea` rows into one Postgres will wedge it, and the gateway
 * fails a request at 30s. The floor stops a client turning a 200 MB file into
 * forty thousand round trips.
 */
export const MIN_CHUNK_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export const uploadSessionCreate = z
  .object({
    folder_id: uuid,
    file_name: z.string().trim().min(1, "A file name is required."),
    content_type: z.string().trim().min(1).default("application/octet-stream"),
    total_bytes: z.number().int().positive(),
    chunk_size: z.number().int().min(MIN_CHUNK_BYTES).max(MAX_CHUNK_BYTES),
    /**
     * Present when this upload is a new VERSION of an existing document rather
     * than a new document. Naming it here is what turns a same-name re-upload
     * into a version without the client having to decide.
     */
    document_id: uuid.optional(),
  })
  .refine((s) => Math.ceil(s.total_bytes / s.chunk_size) <= 10_000, {
    message: "Too many chunks for this file size — use a larger chunk size.",
    path: ["chunk_size"],
  });
export type UploadSessionCreate = z.infer<typeof uploadSessionCreate>;

export const uploadSessionStatus = z.enum(["open", "completed", "aborted"]);
export type UploadSessionStatus = z.infer<typeof uploadSessionStatus>;

export const uploadSessionResponse = z.object({
  id: uuid,
  status: uploadSessionStatus,
  file_name: z.string(),
  content_type: z.string(),
  total_bytes: z.number().int(),
  chunk_size: z.number().int(),
  total_chunks: z.number().int(),
  /** Exactly which indices are already stored — this is what makes resume work. */
  received: z.array(z.number().int().nonnegative()),
  document_id: uuid.nullable(),
  upload_id: uuid.nullable(),
  expires_at: z.string(),
});
export type UploadSessionResponse = z.infer<typeof uploadSessionResponse>;

/** What completing a session produced: a document, and the version it now sits at. */
export const uploadSessionComplete = z.object({
  document_id: uuid,
  upload_id: uuid,
  version_no: z.number().int().positive(),
  version_id: uuid,
});
export type UploadSessionComplete = z.infer<typeof uploadSessionComplete>;
