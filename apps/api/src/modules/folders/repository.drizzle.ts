import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import { DEFAULT_HIERARCHY, type FolderSpec } from "./hierarchy.js";
import type {
  CreateAccessInput,
  CreateFolderInput,
  FolderAccessRecord,
  FolderRecord,
  FoldersRepository,
} from "./ports.js";

const { folders, folderAccess } = schema;
type FolderRow = typeof folders.$inferSelect;
type AccessRow = typeof folderAccess.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function toFolder(row: FolderRow): FolderRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    parentId: row.parentId,
    name: row.name,
    color: row.color,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

function toAccess(row: AccessRow): FolderAccessRecord {
  return {
    id: row.id,
    folderId: row.folderId,
    userId: row.userId,
    groupId: row.groupId,
    canRead: row.canRead,
    canWrite: row.canWrite,
    canDownload: row.canDownload,
    createdBy: row.createdBy,
  };
}

export class DrizzleFoldersRepository implements FoldersRepository {
  constructor(private readonly db: Db) {}

  async listByCompany(companyId: string, includeArchived: boolean): Promise<FolderRecord[]> {
    const where = includeArchived
      ? eq(folders.companyId, companyId)
      : and(eq(folders.companyId, companyId), isNull(folders.archivedAt));
    const rows = await this.db.select().from(folders).where(where).orderBy(asc(folders.createdAt));
    return rows.map(toFolder);
  }

  async getById(id: string): Promise<FolderRecord | null> {
    const rows = await this.db.select().from(folders).where(eq(folders.id, id)).limit(1);
    return rows[0] ? toFolder(rows[0]) : null;
  }

  async countByCompany(companyId: string): Promise<number> {
    const rows = await this.db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.companyId, companyId));
    return rows.length;
  }

  /**
   * Create, or answer the folder that is already there.
   *
   * A plain insert raised the (company, parent, name) unique violation as a
   * raw driver error, which the router has no case for — so a broker typing a
   * name that already exists under the same parent got a 500. It was invisible
   * in tests because the in-memory double returns the existing folder, which
   * is what the port's non-nullable return type and `ensureDefaultFolders`
   * both say the contract is; this method was the one place that did not
   * implement it.
   *
   * Deliberately idempotent rather than a 409. That is the behaviour the rest
   * of the module already has, and answering with the folder somebody was
   * trying to make is a defensible outcome where refusing outright is a
   * product decision nobody has taken.
   */
  async create(input: CreateFolderInput): Promise<FolderRecord> {
    return this.upsertFolder(
      this.db as unknown as Tx,
      input.companyId,
      input.parentId,
      input.name,
      input.createdBy,
      input.color,
    );
  }

  async update(id: string, patch: { name?: string; color?: string | null }): Promise<FolderRecord | null> {
    const rows = await this.db.update(folders).set(patch).where(eq(folders.id, id)).returning();
    return rows[0] ? toFolder(rows[0]) : null;
  }

  async move(id: string, parentId: string | null): Promise<FolderRecord | null> {
    const rows = await this.db.update(folders).set({ parentId }).where(eq(folders.id, id)).returning();
    return rows[0] ? toFolder(rows[0]) : null;
  }

  async setArchived(id: string, archived: boolean): Promise<FolderRecord | null> {
    const rows = await this.db
      .update(folders)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(folders.id, id))
      .returning();
    return rows[0] ? toFolder(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(folders).where(eq(folders.id, id));
  }

  async ensureDefaultFolders(companyId: string, createdBy: string): Promise<FolderRecord[]> {
    return this.db.transaction(async (tx) => {
      const created: FolderRecord[] = [];
      const walk = async (specs: readonly FolderSpec[], parentId: string | null) => {
        for (const spec of specs) {
          const folder = await this.upsertFolder(tx, companyId, parentId, spec.name, createdBy);
          created.push(folder);
          if (spec.children) await walk(spec.children, folder.id);
        }
      };
      await walk(DEFAULT_HIERARCHY, null);
      return created;
    });
  }

  /** Insert a folder, or return the existing one on the unique-index conflict (D2). */
  private async upsertFolder(
    tx: Tx,
    companyId: string,
    parentId: string | null,
    name: string,
    createdBy: string,
    color: string | null = null,
  ): Promise<FolderRecord> {
    const inserted = await tx
      .insert(folders)
      .values({ companyId, parentId, name, color, createdBy })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return toFolder(inserted[0]);

    const parentWhere = parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId);
    const existing = await tx
      .select()
      .from(folders)
      .where(and(eq(folders.companyId, companyId), parentWhere, eq(folders.name, name)))
      .limit(1);
    return toFolder(existing[0]!);
  }

  async listAccess(folderId: string): Promise<FolderAccessRecord[]> {
    const rows = await this.db.select().from(folderAccess).where(eq(folderAccess.folderId, folderId));
    return rows.map(toAccess);
  }

  async getAccessById(id: string): Promise<FolderAccessRecord | null> {
    const rows = await this.db.select().from(folderAccess).where(eq(folderAccess.id, id)).limit(1);
    return rows[0] ? toAccess(rows[0]) : null;
  }

  async createAccess(input: CreateAccessInput): Promise<FolderAccessRecord> {
    const rows = await this.db
      .insert(folderAccess)
      .values({
        folderId: input.folderId,
        userId: input.userId,
        groupId: input.groupId,
        canRead: input.canRead,
        canWrite: input.canWrite,
        canDownload: input.canDownload,
        createdBy: input.createdBy,
      })
      .returning();
    return toAccess(rows[0]!);
  }

  async updateAccess(
    id: string,
    patch: { canRead?: boolean; canWrite?: boolean; canDownload?: boolean },
  ): Promise<FolderAccessRecord | null> {
    const rows = await this.db.update(folderAccess).set(patch).where(eq(folderAccess.id, id)).returning();
    return rows[0] ? toAccess(rows[0]) : null;
  }

  async deleteAccess(id: string): Promise<void> {
    await this.db.delete(folderAccess).where(eq(folderAccess.id, id));
  }
}
