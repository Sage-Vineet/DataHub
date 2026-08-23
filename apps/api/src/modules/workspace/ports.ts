/**
 * Server-persisted workspace UI state.
 *
 * A key-value store the server never looks inside: the payload is whatever the
 * page needs to resume where the user left it. Scoped by (company, page key),
 * with per-user state achieved by the caller scoping the key — see
 * `scopedPageKey` in `service.ts`.
 */

export interface PageStateRecord {
  companyId: string;
  pageKey: string;
  payload: unknown;
  updatedAt: string;
}

export interface WorkspaceRepository {
  get(companyId: string, pageKey: string): Promise<PageStateRecord | null>;
  /** Upsert on (company, page key), which is a unique constraint. */
  replace(companyId: string, pageKey: string, payload: unknown): Promise<PageStateRecord>;
  /** True when a row was removed; false when there was nothing to remove. */
  remove(companyId: string, pageKey: string): Promise<boolean>;
}
