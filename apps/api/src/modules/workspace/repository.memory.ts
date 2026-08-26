import type { PageStateRecord, WorkspaceRepository } from "./ports.js";

/** In-memory page state for service tests. */
export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly rows = new Map<string, PageStateRecord>();
  private clock = Date.UTC(2024, 0, 1);

  private static key(companyId: string, pageKey: string): string {
    return `${companyId} ${pageKey}`;
  }

  /** Every stored page key, so a test can assert how state was scoped. */
  storedKeys(): string[] {
    return [...this.rows.values()].map((r) => r.pageKey);
  }

  get(companyId: string, pageKey: string): Promise<PageStateRecord | null> {
    return Promise.resolve(
      this.rows.get(InMemoryWorkspaceRepository.key(companyId, pageKey)) ?? null,
    );
  }

  replace(companyId: string, pageKey: string, payload: unknown): Promise<PageStateRecord> {
    const record: PageStateRecord = {
      companyId,
      pageKey,
      payload,
      updatedAt: new Date(this.clock++).toISOString(),
    };
    this.rows.set(InMemoryWorkspaceRepository.key(companyId, pageKey), record);
    return Promise.resolve(record);
  }

  remove(companyId: string, pageKey: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(InMemoryWorkspaceRepository.key(companyId, pageKey)));
  }
}
