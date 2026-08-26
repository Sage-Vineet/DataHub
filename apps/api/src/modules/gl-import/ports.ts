import type { ColumnMapping, MappingResult } from "./column-mapping.js";
import type { LedgerEntry } from "./staging.js";

/** An uploaded file, as far as the importer needs it. */
export interface UploadRecord {
  id: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

export interface StoredMapping {
  uploadId: string;
  mapping: ColumnMapping;
  detected: Partial<MappingResult>;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export interface GlImportRepository {
  /** The uploaded bytes. Null when the upload is gone. */
  getUpload(uploadId: string): Promise<UploadRecord | null>;
  getMapping(companyId: string, uploadId: string): Promise<StoredMapping | null>;
  /** Record a confirmed mapping. Replaces any previous one for the file. */
  saveMapping(input: {
    companyId: string;
    uploadId: string;
    mapping: ColumnMapping;
    detected: Partial<MappingResult>;
    confirmedBy: string | null;
  }): Promise<StoredMapping>;
  /** Does this upload belong to a document of this company? */
  uploadBelongsToCompany(companyId: string, uploadId: string): Promise<boolean>;
}

/** Which document an upload came in as — the ledger needs it as `source_file_id`. */
export interface UploadOrigin {
  documentId: string;
  companyId: string;
}

export interface WriteLedgerInput {
  companyId: string;
  /** The key-report version these rows belong to. */
  versionId: string;
  documentId: string;
  entries: readonly LedgerEntry[];
}

export interface LedgerWriter {
  /** The document an upload arrived as, or null. */
  originOf(companyId: string, uploadId: string): Promise<UploadOrigin | null>;
  /**
   * Insert ledger rows, skipping any already there.
   *
   * Returns how many were new. The unique index over
   * `(version_id, source_file_id, transaction_hash)` is what makes a second
   * import of the same file insert nothing.
   */
  writeEntries(input: WriteLedgerInput): Promise<{ inserted: number; skipped: number }>;
}
