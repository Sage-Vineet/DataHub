import { eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { FolderRefPort, StoragePort, StoredBlob, StoredBlobMeta, UploadMeta } from "./ports.js";
import type { FolderAccessGrant } from "./folder-access.js";

const { uploads, folders, folderAccess } = schema;

/**
 * Blob storage in Postgres `uploads.data` (bytea) — the shipped `StoragePort`
 * (design D2). Drops the legacy Supabase-Storage large-file branch; an object
 * store can implement the same port later.
 */
export class ByteaStoragePort implements StoragePort {
  constructor(private readonly db: Db) {}

  async put(bytes: Buffer, meta: StoredBlobMeta): Promise<UploadMeta> {
    const rows = await this.db
      .insert(uploads)
      .values({
        fileName: meta.fileName,
        contentType: meta.contentType,
        sizeBytes: bytes.length,
        data: bytes,
        uploadedBy: meta.uploadedBy,
      })
      .returning({ id: uploads.id });
    return { id: rows[0]!.id, fileName: meta.fileName, contentType: meta.contentType, sizeBytes: bytes.length };
  }

  async get(uploadId: string): Promise<StoredBlob | null> {
    const rows = await this.db
      .select({ fileName: uploads.fileName, contentType: uploads.contentType, data: uploads.data })
      .from(uploads)
      .where(eq(uploads.id, uploadId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { fileName: row.fileName, contentType: row.contentType, bytes: Buffer.from(row.data) };
  }
}

/** Resolve a folder's company (design D1) — a direct read now; the folders service later. */
export class DrizzleFolderRefPort implements FolderRefPort {
  constructor(private readonly db: Db) {}

  async companyIdFor(folderId: string): Promise<string | null> {
    const rows = await this.db
      .select({ companyId: folders.companyId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);
    return rows[0]?.companyId ?? null;
  }

  /**
   * The folder and its ancestors, nearest first.
   *
   * Bounded rather than `WHILE true`: a cycle in `parent_id` would otherwise spin
   * here forever, and a data room deeper than this is not a tree anyone is
   * navigating. Walked one row at a time instead of as a recursive CTE because
   * the depth is small and the query stays legible to the next reader.
   */
  async ancestryOf(folderId: string): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = folderId;
    for (let depth = 0; current && depth < MAX_FOLDER_DEPTH; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      chain.push(current);
      const rows: Array<{ parentId: string | null }> = await this.db
        .select({ parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.id, current))
        .limit(1);
      current = rows[0]?.parentId ?? null;
    }
    return chain;
  }

  async grantsFor(folderIds: readonly string[]): Promise<FolderAccessGrant[]> {
    if (folderIds.length === 0) return [];
    const rows = await this.db
      .select({
        folderId: folderAccess.folderId,
        userId: folderAccess.userId,
        groupId: folderAccess.groupId,
        canRead: folderAccess.canRead,
        canWrite: folderAccess.canWrite,
        canDownload: folderAccess.canDownload,
      })
      .from(folderAccess)
      .where(inArray(folderAccess.folderId, [...folderIds]));
    return rows;
  }

  async groupIdsFor(userId: string): Promise<string[]> {
    // buyer_group_members is legacy-owned and absent from packages/db, so this
    // reads it as raw SQL rather than pretending the model describes it.
    const result = await this.db.execute<{ group_id: string }>(
      sql`SELECT group_id FROM buyer_group_members WHERE user_id = ${userId}`,
    );
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{ group_id: string }>;
    return rows.map((row) => row.group_id);
  }
}

/** Deep enough for any real data room; shallow enough that a cycle cannot hang. */
const MAX_FOLDER_DEPTH = 64;
