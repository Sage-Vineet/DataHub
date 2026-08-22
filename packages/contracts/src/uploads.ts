import { z } from "zod";

const uuid = z.string().uuid();

/** Document lifecycle status (parity with the `document_status` enum). */
export const documentStatus = z.enum(["active", "processing", "error"]);
export type DocumentStatus = z.infer<typeof documentStatus>;

/** Metadata for a new document (the blob is uploaded separately, then referenced). */
export const documentCreate = z.object({
  name: z.string().trim().min(1, "Document name is required."),
  upload_id: uuid,
  size: z.string().trim().min(1),
  ext: z.string().trim().min(1),
  file_url: z.string().trim().optional(),
  status: documentStatus.optional(),
});
export type DocumentCreate = z.infer<typeof documentCreate>;

/**
 * Query flag for including archived documents.
 *
 * Same wire-name rule as `folderListQuery`: legacy reads `includeArchived`
 * (`backend/src/controllers/folders.js`) and the SPA sends it, so that spelling
 * must be honoured or the filter is silently inert after cutover. The snake_case
 * alias is accepted too.
 */
const archivedFlag = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((v) => v === true || v === "true");

export const documentListQuery = z
  .object({
    include_archived: archivedFlag,
    includeArchived: archivedFlag,
  })
  .transform((q) => ({ include_archived: q.includeArchived || q.include_archived }));
export type DocumentListQuery = z.infer<typeof documentListQuery>;

export const uploadResponse = z.object({
  id: uuid,
  file_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
});
export type UploadResponse = z.infer<typeof uploadResponse>;

export const documentResponse = z.object({
  id: uuid,
  company_id: uuid,
  folder_id: uuid,
  name: z.string(),
  file_url: z.string().nullable(),
  upload_id: uuid.nullable(),
  size: z.string(),
  ext: z.string(),
  status: documentStatus,
  uploaded_by: uuid,
  /**
   * Who uploaded it, by name.
   *
   * Only the id was returned, and the file explorer has no user directory to
   * resolve it against — so every document reported "Uploaded by: Unknown" in a
   * product whose whole value proposition is provenance. Null when the uploader
   * has since been removed.
   */
  uploaded_by_name: z.string().nullable().optional(),
  archived_at: z.string().nullable(),
});
export type DocumentResponse = z.infer<typeof documentResponse>;

/**
 * The deployed `document_activity.activity_type` is a Postgres enum of exactly
 * `view | download`, and the cutover writes that column alongside the module's
 * own. A free-form string here turns an unknown action into a 500 from the
 * database instead of a 400 at the edge, so the contract carries the same
 * closed vocabulary the column does.
 */
export const documentActivityAction = z.enum(["view", "download"]);
export type DocumentActivityAction = z.infer<typeof documentActivityAction>;

export const documentActivityCreate = z.object({
  action: documentActivityAction,
});
export type DocumentActivityCreate = z.infer<typeof documentActivityCreate>;

export const documentActivityResponse = z.object({
  id: uuid,
  document_id: uuid,
  actor_id: uuid.nullable(),
  action: z.string(),
  at: z.string(),
});
export type DocumentActivityResponse = z.infer<typeof documentActivityResponse>;
