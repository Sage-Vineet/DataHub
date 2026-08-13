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

export const documentListQuery = z.object({
  include_archived: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
});
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
  archived_at: z.string().nullable(),
});
export type DocumentResponse = z.infer<typeof documentResponse>;

export const documentActivityCreate = z.object({
  action: z.string().trim().min(1, "An action is required."),
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
