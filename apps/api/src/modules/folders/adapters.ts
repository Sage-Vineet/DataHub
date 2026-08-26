import { sql } from "drizzle-orm";
import type { Db } from "@datahub/db";
import { HttpError } from "../../shared/errors.js";
import type { FileLinkPort, GroupRefPort } from "./ports.js";

/**
 * Transitional cross-domain adapters (design D3/D4). `FileLinkPort` mirrors legacy
 * `fileReferenceService.assertFolderDeletable` — a folder holding files linked to
 * another module (Key Reports) cannot be deleted. The group reference is a light
 * existence check. Both become real module services later.
 *
 * This used to query `report_source_records.folder_id`, a column that has never
 * existed in the deployed schema: report_source_records is keyed by company and
 * source, and knows nothing about folders. Every DELETE /folders/:id therefore
 * failed with a database error rather than deleting or refusing. It passed here
 * only because the integration test declared its own DDL and invented the column.
 *
 * The real linkage is the one legacy uses: `file_references.document_id`, against
 * the documents held in the folder or its immediate children.
 */
export class DrizzleFileLinkPort implements FileLinkPort {
  constructor(private readonly db: Db) {}

  async assertFolderDeletable(folderId: string): Promise<void> {
    const result = await this.db.execute(
      sql`SELECT 1
            FROM file_references fr
            JOIN documents d ON d.id = fr.document_id
           WHERE d.folder_id = ${folderId}
              OR d.folder_id IN (SELECT id FROM folders WHERE parent_id = ${folderId})
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
