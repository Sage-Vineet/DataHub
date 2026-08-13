import { eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { FolderRefPort, StoragePort, StoredBlob, StoredBlobMeta, UploadMeta } from "./ports.js";

const { uploads, folders } = schema;

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
}
