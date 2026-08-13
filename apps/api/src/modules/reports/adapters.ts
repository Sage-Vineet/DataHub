import { HttpError } from "../../shared/errors.js";
import type { ReportSyncPort } from "./ports.js";

/**
 * The GL sync/computation is not yet migrated (reports-domain D5): the 9,088-line
 * `manualGlMultiYearService` stays on the legacy engine and is decomposed in later
 * slices. This stub makes the seam explicit; a real engine implements the port later.
 */
export class LegacyReportSyncPort implements ReportSyncPort {
  async sync(_versionId: string): Promise<never> {
    throw new HttpError(501, "Report sync is handled by the legacy GL engine and is not yet migrated.");
  }
}
