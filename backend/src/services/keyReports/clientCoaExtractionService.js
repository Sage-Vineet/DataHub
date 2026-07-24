// ============================================================================
// Chart of Accounts (upload) — extraction adapter
//
// Wraps clientCoaImportService.importClientCoaWorkbook so an optional,
// per-company COA workbook can be dispatched by keyReportSyncService's
// generic extractDocument() alongside General Ledger / Balance Sheet /
// Profit & Loss, using the same document-linking flow.
//
// Unlike a normal ExtractionServiceBase subclass, a COA workbook isn't a
// stream of transactional rows to validate/dedupe/insert incrementally — it's
// a complete reference structure that should fully REPLACE this company's own
// prior upload each time (see clientCoaImportService for the replace
// semantics, scoped by company_id — migration 072). No caching, no row
// hashing: the whole workbook is small and simply re-parsed on every upload.
//
// This company's own uploaded rows become the HIGHEST-priority hierarchy
// source for that company (see coaMappingService.createCoaMapper) — above the
// shared global reference, above AI category selection, above needs_mapping.
// ============================================================================

"use strict";

const { importClientCoaWorkbook } = require("./clientCoaImportService");

async function extractAndStore({ companyId, fileName, fileBuffer }) {
  if (!companyId) return { success: false, fileName, rowsExtracted: 0, error: "companyId is required" };
  try {
    const result = await importClientCoaWorkbook(fileBuffer, fileName, companyId);
    return {
      success: true,
      fileName,
      rowsExtracted: result.inserted,
      rowsDetected: result.inserted,
      rowsRejected: 0,
      detectedYears: [],
      cacheHit: false,
      error: null,
    };
  } catch (err) {
    return { success: false, fileName, rowsExtracted: 0, error: err.message };
  }
}

module.exports = { extractAndStore };
