import { z } from "zod";

const uuid = z.string().uuid();

export const reportVersionStatus = z.enum(["draft", "synced", "archived"]);
export type ReportVersionStatus = z.infer<typeof reportVersionStatus>;

const metadata = z.record(z.string(), z.unknown());

export const reportVersionCreate = z.object({
  company_id: uuid,
  version_name: z.string().trim().optional(),
  metadata: metadata.optional(),
});
export type ReportVersionCreate = z.infer<typeof reportVersionCreate>;

export const reportVersionUpdate = z
  .object({
    version_name: z.string().trim().optional(),
    status: reportVersionStatus.optional(),
    metadata: metadata.optional(),
  })
  .refine((v) => v.version_name !== undefined || v.status !== undefined || v.metadata !== undefined, {
    message: "Nothing to update.",
  });
export type ReportVersionUpdate = z.infer<typeof reportVersionUpdate>;

export const reportVersionResponse = z.object({
  id: uuid,
  company_id: uuid,
  version_number: z.number().int(),
  version_name: z.string().nullable(),
  status: reportVersionStatus,
  is_active: z.boolean(),
  resolved_batch_id: uuid.nullable(),
  last_synced_at: z.string().nullable(),
  metadata: metadata,
  created_by: uuid.nullable(),
});
export type ReportVersionResponse = z.infer<typeof reportVersionResponse>;
