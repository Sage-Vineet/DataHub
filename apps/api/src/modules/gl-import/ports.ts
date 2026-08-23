import type { ColumnMapping, MappingResult } from "./column-mapping.js";

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
