import { sql } from "drizzle-orm";
import type { Db } from "@datahub/db";
import { HttpError } from "../../shared/errors.js";
import type { FileLinkPort, GroupRefPort } from "./ports.js";

/**
 * Transitional cross-domain adapters (design D3/D4). `FileLinkPort` mirrors legacy
 * `fileReferenceService.assertFolderDeletable` — a folder linked to another module
 * (e.g. Key Reports via `report_source_records.folder_id`) cannot be deleted. The
 * group reference is a light existence check. Both become real module services later.
 */
export class DrizzleFileLinkPort implements FileLinkPort {
  constructor(private readonly db: Db) {}

  async assertFolderDeletable(folderId: string): Promise<void> {
    // Linked if any report source record points at this folder (or its subtree).
    const result = await this.db.execute(
      sql`SELECT 1 FROM report_source_records
          WHERE folder_id = ${folderId}
             OR folder_id IN (SELECT id FROM folders WHERE parent_id = ${folderId})
          LIMIT 1`,
    );
    const rows = (result as unknown as { rows: unknown[] }).rows;
    if (rows.length > 0) {
      throw new HttpError(409, "This folder is linked to a Key Report and cannot be deleted.");
    }
  }
}

export class DrizzleGroupRefPort implements GroupRefPort {
  constructor(private readonly db: Db) {}

  async exists(groupId: string): Promise<boolean> {
    const result = await this.db.execute(sql`SELECT 1 FROM buyer_groups WHERE id = ${groupId} LIMIT 1`);
    return (result as unknown as { rows: unknown[] }).rows.length > 0;
  }
}
