import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { PageStateRecord, WorkspaceRepository } from "./ports.js";

const { workspacePageState } = schema;
type Row = typeof workspacePageState.$inferSelect;

const toRecord = (r: Row): PageStateRecord => ({
  companyId: r.companyId,
  pageKey: r.pageKey,
  payload: r.payload,
  updatedAt: r.updatedAt.toISOString(),
});

/** Page state over Postgres. */
export class DrizzleWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: Db) {}

  async get(companyId: string, pageKey: string): Promise<PageStateRecord | null> {
    const rows = await this.db
      .select()
      .from(workspacePageState)
      .where(
        and(eq(workspacePageState.companyId, companyId), eq(workspacePageState.pageKey, pageKey)),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async replace(companyId: string, pageKey: string, payload: unknown): Promise<PageStateRecord> {
    const now = new Date();
    const rows = await this.db
      .insert(workspacePageState)
      .values({ companyId, pageKey, payload, updatedAt: now })
      .onConflictDoUpdate({
        target: [workspacePageState.companyId, workspacePageState.pageKey],
        set: { payload, updatedAt: now },
      })
      .returning();
    return toRecord(rows[0]!);
  }

  async remove(companyId: string, pageKey: string): Promise<boolean> {
    const rows = await this.db
      .delete(workspacePageState)
      .where(
        and(eq(workspacePageState.companyId, companyId), eq(workspacePageState.pageKey, pageKey)),
      )
      .returning({ id: workspacePageState.id });
    return rows.length > 0;
  }
}
