import { randomUUID } from "node:crypto";
import { DEFAULT_HIERARCHY, type FolderSpec } from "./hierarchy.js";
import type {
  CreateAccessInput,
  CreateFolderInput,
  FolderAccessRecord,
  FolderRecord,
  FoldersRepository,
} from "./ports.js";

/** In-memory `FoldersRepository` for tests — same interface, no database. */
export class InMemoryFoldersRepository implements FoldersRepository {
  private readonly folders = new Map<string, FolderRecord>();
  private readonly access = new Map<string, FolderAccessRecord>();

  private key(companyId: string, parentId: string | null, name: string): string {
    return `${companyId}|${parentId ?? "root"}|${name}`;
  }

  seed(record: FolderRecord): FolderRecord {
    this.folders.set(record.id, record);
    return record;
  }

  async listByCompany(companyId: string, includeArchived: boolean): Promise<FolderRecord[]> {
    return [...this.folders.values()].filter(
      (f) => f.companyId === companyId && (includeArchived || f.archivedAt === null),
    );
  }

  async getById(id: string): Promise<FolderRecord | null> {
    return this.folders.get(id) ?? null;
  }

  async countByCompany(companyId: string): Promise<number> {
    return [...this.folders.values()].filter((f) => f.companyId === companyId).length;
  }

  async create(input: CreateFolderInput): Promise<FolderRecord> {
    // Enforce the (company, parent, name) uniqueness like the DB index.
    const existing = [...this.folders.values()].find(
      (f) => this.key(f.companyId, f.parentId, f.name) === this.key(input.companyId, input.parentId, input.name),
    );
    if (existing) return existing;
    const record: FolderRecord = { id: randomUUID(), archivedAt: null, ...input };
    this.folders.set(record.id, record);
    return record;
  }

  async update(id: string, patch: { name?: string; color?: string | null }): Promise<FolderRecord | null> {
    const f = this.folders.get(id);
    if (!f) return null;
    const updated = { ...f, ...patch };
    this.folders.set(id, updated);
    return updated;
  }

  async move(id: string, parentId: string | null): Promise<FolderRecord | null> {
    const f = this.folders.get(id);
    if (!f) return null;
    const updated = { ...f, parentId };
    this.folders.set(id, updated);
    return updated;
  }

  async setArchived(id: string, archived: boolean): Promise<FolderRecord | null> {
    const f = this.folders.get(id);
    if (!f) return null;
    const updated = { ...f, archivedAt: archived ? new Date(0).toISOString() : null };
    this.folders.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.folders.delete(id);
    for (const [aid, a] of this.access) if (a.folderId === id) this.access.delete(aid);
  }

  async ensureDefaultFolders(companyId: string, createdBy: string): Promise<FolderRecord[]> {
    const created: FolderRecord[] = [];
    const walk = async (specs: readonly FolderSpec[], parentId: string | null) => {
      for (const spec of specs) {
        const folder = await this.create({ companyId, parentId, name: spec.name, color: null, createdBy });
        created.push(folder);
        if (spec.children) await walk(spec.children, folder.id);
      }
    };
    await walk(DEFAULT_HIERARCHY, null);
    return created;
  }

  async listAccess(folderId: string): Promise<FolderAccessRecord[]> {
    return [...this.access.values()].filter((a) => a.folderId === folderId);
  }

  async getAccessById(id: string): Promise<FolderAccessRecord | null> {
    return this.access.get(id) ?? null;
  }

  async createAccess(input: CreateAccessInput): Promise<FolderAccessRecord> {
    const record: FolderAccessRecord = { id: randomUUID(), ...input };
    this.access.set(record.id, record);
    return record;
  }

  async updateAccess(
    id: string,
    patch: { canRead?: boolean; canWrite?: boolean; canDownload?: boolean },
  ): Promise<FolderAccessRecord | null> {
    const a = this.access.get(id);
    if (!a) return null;
    const updated = { ...a, ...patch };
    this.access.set(id, updated);
    return updated;
  }

  async deleteAccess(id: string): Promise<void> {
    this.access.delete(id);
  }
}
