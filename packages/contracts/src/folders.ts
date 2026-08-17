import { z } from "zod";

const uuid = z.string().uuid();
const optionalColor = z.string().trim().max(32).optional();

/** A boolean query flag, tolerant of the string form a URL always delivers. */
const archivedFlag = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((v) => v === true || v === "true");

export const folderCreate = z.object({
  name: z.string().trim().min(1, "Folder name is required."),
  parent_id: uuid.nullable().optional(),
  color: optionalColor,
});
export type FolderCreate = z.infer<typeof folderCreate>;

export const folderUpdate = z
  .object({
    name: z.string().trim().min(1).optional(),
    color: optionalColor,
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: "Nothing to update.",
  });
export type FolderUpdate = z.infer<typeof folderUpdate>;

export const folderMove = z.object({
  parent_id: uuid.nullable(),
});
export type FolderMove = z.infer<typeof folderMove>;

/** A folder as returned to clients. */
export const folderResponse = z.object({
  id: uuid,
  company_id: uuid,
  parent_id: uuid.nullable(),
  name: z.string(),
  color: z.string().nullable(),
  created_by: uuid,
  archived_at: z.string().nullable(),
});
export type FolderResponse = z.infer<typeof folderResponse>;

/** A folder tree node (folderResponse + children). */
export type FolderTreeNode = FolderResponse & { children: FolderTreeNode[] };

const permissionFlags = {
  can_read: z.boolean().optional(),
  can_write: z.boolean().optional(),
  can_download: z.boolean().optional(),
};

/**
 * A folder-access grant names EXACTLY ONE subject — a user OR a group (design D4).
 * The refinement rejects both-or-neither; the DB CHECK constraint is the backstop.
 */
export const folderAccessCreate = z
  .object({
    user_id: uuid.optional(),
    group_id: uuid.optional(),
    ...permissionFlags,
  })
  .refine((v) => (v.user_id != null) !== (v.group_id != null), {
    message: "Exactly one of user_id or group_id is required.",
  });
export type FolderAccessCreate = z.infer<typeof folderAccessCreate>;

export const folderAccessUpdate = z
  .object(permissionFlags)
  .refine((v) => v.can_read !== undefined || v.can_write !== undefined || v.can_download !== undefined, {
    message: "Nothing to update.",
  });
export type FolderAccessUpdate = z.infer<typeof folderAccessUpdate>;

export const folderAccessResponse = z.object({
  id: uuid,
  folder_id: uuid,
  user_id: uuid.nullable(),
  group_id: uuid.nullable(),
  can_read: z.boolean(),
  can_write: z.boolean(),
  can_download: z.boolean(),
  created_by: uuid.nullable(),
});
export type FolderAccessResponse = z.infer<typeof folderAccessResponse>;

/**
 * Query flag for including archived folders in a list/tree.
 *
 * The wire name is `includeArchived` — that is what legacy reads
 * (`backend/src/controllers/folders.js`) and what the SPA sends
 * (`apps/web/src/lib/api.js` builds `?includeArchived=true`). Accepting only the
 * snake_case spelling used elsewhere in these contracts would leave the filter
 * silently inert after cutover: the parameter is simply absent, so the query
 * parses fine and returns the unfiltered list. The snake_case alias is still
 * accepted so callers written against the module's own naming keep working.
 */
export const folderListQuery = z.object({
  include_archived: archivedFlag,
  includeArchived: archivedFlag,
}).transform((q) => ({ include_archived: q.includeArchived || q.include_archived }));
export type FolderListQuery = z.infer<typeof folderListQuery>;
