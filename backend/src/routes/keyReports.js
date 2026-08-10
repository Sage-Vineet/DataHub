const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");
const keyReportService = require("../services/keyReports/keyReportService");
const keyReportProgress = require("../services/keyReports/keyReportProgress");
const fileReferenceService = require("../services/fileReferenceService");
const userPreferenceService = require("../services/userPreferenceService");
const chartOfAccountsService = require("../services/chartOfAccountsService");
const keyReportReportService = require("../services/keyReports/keyReportReportService");
const keyReportVendorService = require("../services/keyReports/keyReportVendorService");
const { generateFinancialStatements, getAvailablePeriods } = require("../services/keyReports/financialStatementService");
const { exportKeyReportData } = require("../services/keyReports/keyReportExportService");
const { normalizeError, isConnectionError } = require("../utils/dbErrorHandler");
// Reconciliation extraction helpers â€” used to pre-warm the Bank & Tax
// Reconciliation caches immediately after a version is generated, so those pages
// load instantly (cache hit) instead of running a multi-minute live extraction on
// first visit. These are the SAME functions (and cache keys) the pages use.
const { runBankExtraction, runBsBankBalancesExtraction } = require("./quickbooks/reconciliation/bankVsBooks");
const { runTaxExtraction } = require("./manualReportUploads");
const { MANUAL_REPORT_UPLOAD_SOURCE } = require("../services/manualReportUploadService");

const router = express.Router();
router.use(requireAuth);

const POPUP_PREF_KEY = "key_reports_popup_dismissed";

function resolveClientId(req) {
  let clientId =
    req.headers["x-client-id"] ||
    req.query.clientId ||
    req.body?.companyId ||
    req.body?.clientId;
  if (!clientId && req.headers.referer) {
    const match =
      req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }
  return clientId;
}

function requireCompanyAccess(req, res, companyId) {
  if (!companyId) {
    res.status(400).json({ success: false, error: "Missing companyId / clientId." });
    return false;
  }
  if (!canAccessCompany(req.user, companyId)) {
    res.status(403).json({ success: false, error: "You do not have permission for this company's Key Reports." });
    return false;
  }
  return true;
}

// Resolve a version and verify the caller can access its company.
async function loadVersionWithAccess(req, res) {
  const version = await keyReportService.getVersion(req.params.versionId);
  if (!version) {
    res.status(404).json({ success: false, error: "Key Report version not found." });
    return null;
  }
  if (!requireCompanyAccess(req, res, version.companyId)) return null;
  return version;
}

// Server-side report gate. Every financial report must be derived from a
// Chart of Accounts the user has explicitly reviewed and Saved/Approved
// (key_report_versions.coa_approved_at, migration 086 -- the single approval
// signal, cleared again on every fresh sync).
//
// CONFIRMED GAP this closes: this gate previously existed ONLY on the
// PATCH /chart-of-accounts/:accountId route and in the frontend ("Open
// Reports" is hidden until coaApprovedAt is set). Every report GET was
// reachable directly -- and because those handlers lazily RECOMPUTE when a
// snapshot is missing or stale, hitting one before approval would generate a
// full report set from an unapproved Chart of Accounts and, for
// /financial-statements, write it into the result cache. Any caller that
// wasn't the UI (a bookmarked URL, a refresh mid-review, an integration)
// bypassed the guarantee that reports only ever reflect an approved COA.
//
// Deliberately responds 200 with an EMPTY, `missingData`-shaped payload rather
// than a 4xx. This is the shape the Reports page already handles for exactly
// this situation (financialStatementService returns the same
// `{ reports:{...empty}, validation, missingData }` when a version's COA has no
// leaf accounts), and WorkspaceReports' `isKrCoaNotApproved` is derived from a
// SUCCESSFUL response carrying `missingData` -- so it renders the existing
// "approve the Chart of Accounts first" guidance. Returning a 409 here would
// make that fetch throw, replacing the helpful empty state with a generic
// error banner: a UI regression. `coaNotApproved` + `code` are included for
// non-UI/API consumers that want an explicit machine-readable signal.
//
// Returns true when the caller may proceed; otherwise it has already responded
// and the handler must return immediately.
const COA_NOT_APPROVED_MESSAGE =
  "This version's Chart of Accounts has not been Saved/Approved yet. Review and approve the " +
  "proposed Chart of Accounts to generate reports.";

async function requireApprovedCoa(res, version) {
  const { supabase } = require("../db");
  let approvedAt = null;
  let readFailed = false;
  try {
    const { data: row, error } = await supabase
      .from("key_report_versions")
      .select("coa_approved_at")
      .eq("id", version.id)
      .maybeSingle();
    if (error) readFailed = true;
    else approvedAt = row?.coa_approved_at || null;
  } catch {
    readFailed = true;
  }
  // Fail closed: if approval state can't be read, do not serve a report.
  if (approvedAt && !readFailed) return true;
  const message = readFailed
    ? "Could not verify whether this version's Chart of Accounts has been approved; no report was generated."
    : COA_NOT_APPROVED_MESSAGE;
  res.json({
    success: true,
    coaNotApproved: true,
    code: "COA_NOT_APPROVED",
    rows: [],
    years: [],
    reports: {
      profitAndLoss: { monthly: [], yearly: [] },
      balanceSheet: { monthly: [], yearly: [] },
      cashFlow: { monthly: [], yearly: [] },
    },
    validation: [message],
    missingData: [message],
  });
  return false;
}

function handleError(res, error, label) {
  const normalizedError = normalizeError(error);
  const status =
    normalizedError.status ||
    (normalizedError.code === "FILE_LINKED"
      ? 409
      : isConnectionError(normalizedError)
        ? 503
        : 500);
  if (status >= 500) {
    console.error(`[KeyReports] ${label} failed`, {
      error: normalizedError.message,
      stack: normalizedError.stack,
    });
  }
  return res.status(status).json({
    success: false,
    code: normalizedError.code || undefined,
    error: normalizedError.message || "Key Reports request failed.",
  });
}

// ---- Versions --------------------------------------------------------------

router.get("/key-reports/versions", async (req, res) => {
  try {
    const companyId = resolveClientId(req);
    if (!requireCompanyAccess(req, res, companyId)) return;
    const versions = await keyReportService.listVersions(companyId);
    const active = versions.find((v) => v.isActive) || null;
    return res.json({ success: true, versions, activeVersionId: active?.id || null });
  } catch (error) {
    return handleError(res, error, "GET /key-reports/versions");
  }
});

router.post("/key-reports/versions", async (req, res) => {
  try {
    const companyId = resolveClientId(req);
    if (!requireCompanyAccess(req, res, companyId)) return;
    const version = await keyReportService.createVersion(
      companyId,
      { versionName: req.body?.versionName, copyFromVersionId: req.body?.copyFromVersionId },
      req.user?.id
    );
    return res.status(201).json({ success: true, version });
  } catch (error) {
    return handleError(res, error, "POST /key-reports/versions");
  }
});

router.get("/key-reports/versions/:versionId", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const [mappingsByCategory, syncLogs, validationResults] = await Promise.all([
      keyReportService.getMappingsByCategory(version.id),
      keyReportService.listSyncLogs(version.id),
      keyReportService.listValidationResults(version.id),
    ]);
    return res.json({ success: true, version, mappingsByCategory, syncLogs, validationResults });
  } catch (error) {
    return handleError(res, error, "GET /key-reports/versions/:versionId");
  }
});

router.put("/key-reports/versions/:versionId", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const updated = await keyReportService.updateVersion(
      version.id,
      { versionName: req.body?.versionName, status: req.body?.status },
      req.user?.id
    );
    return res.json({ success: true, version: updated });
  } catch (error) {
    return handleError(res, error, "PUT /key-reports/versions/:versionId");
  }
});

router.post("/key-reports/versions/:versionId/duplicate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const dup = await keyReportService.duplicateVersion(
      version.id,
      { versionName: req.body?.versionName },
      req.user?.id
    );
    return res.status(201).json({ success: true, version: dup });
  } catch (error) {
    return handleError(res, error, "POST /key-reports/versions/:versionId/duplicate");
  }
});

router.post("/key-reports/versions/:versionId/activate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const activated = await keyReportService.switchActiveVersion(
      version.companyId,
      version.id,
      req.user?.id
    );
    return res.json({ success: true, version: activated });
  } catch (error) {
    return handleError(res, error, "POST /key-reports/versions/:versionId/activate");
  }
});

router.delete("/key-reports/versions/:versionId", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    await keyReportService.deleteVersion(version.id);
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "DELETE /key-reports/versions/:versionId");
  }
});

// ---- Mappings --------------------------------------------------------------

router.get("/key-reports/versions/:versionId/mappings", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const mappingsByCategory = await keyReportService.getMappingsByCategory(version.id);
    return res.json({ success: true, mappingsByCategory });
  } catch (error) {
    return handleError(res, error, "GET mappings");
  }
});

router.post("/key-reports/versions/:versionId/mappings", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { reportCategory, documentId, documentIds } = req.body || {};
    const ids = Array.isArray(documentIds) ? documentIds : documentId ? [documentId] : [];
    if (!ids.length) {
      return res.status(400).json({ success: false, error: "documentId(s) required." });
    }
    const created = [];
    for (const id of ids) {
      created.push(await keyReportService.addMapping(version.id, { reportCategory, documentId: id }, req.user?.id));
    }
    return res.status(201).json({ success: true, mappings: created });
  } catch (error) {
    return handleError(res, error, "POST mappings");
  }
});

router.delete("/key-reports/mappings/:mappingId", async (req, res) => {
  try {
    // Access is enforced via the parent version's company. Look it up first.
    const { supabase } = require("../db");
    const { data: row } = await supabase
      .from("key_report_file_mappings")
      .select("company_id")
      .eq("id", req.params.mappingId)
      .maybeSingle();
    if (!row) return res.status(404).json({ success: false, error: "Mapping not found." });
    if (!requireCompanyAccess(req, res, row.company_id)) return;
    await keyReportService.removeMapping(req.params.mappingId);
    return res.status(204).send();
  } catch (error) {
    return handleError(res, error, "DELETE mapping");
  }
});

// Pre-warm the Bank & Tax Reconciliation caches for a freshly generated version.
//
// Generate extracts the linked bank/tax files into the entry tables, but the
// Bank/Tax Reconciliation pages run their OWN (summary-level) Gemini extraction,
// cached lazily on first page visit â€” which is why that first visit took minutes.
// Here we run that same extraction now, using the identical functions and
// cache-key path the pages use, so by the time Generate reports success the pages
// are a guaranteed cache hit and load instantly.
//
// Fully non-fatal: every branch is settled and swallowed, so a warm-up failure
// never fails the generate â€” the page simply falls back to its lazy extraction.
async function warmReconciliationCaches(companyId, versionId) {
  if (!companyId || !versionId) return;
  try {
    const results = await Promise.allSettled([
      // Bank statement summary (report_type "bank_reconciliation_kr_v3")
      runBankExtraction(companyId, MANUAL_REPORT_UPLOAD_SOURCE, "Manual Upload Source", null, versionId),
      // Balance-Sheet bank balances (report_type "bs_bank_balances_cache_v2")
      runBsBankBalancesExtraction(companyId, MANUAL_REPORT_UPLOAD_SOURCE, "Manual Upload Source", null, null, versionId),
      // Tax return summary (report_type "tax_return_kr_v2")
      runTaxExtraction(companyId, { keyReportVersionId: versionId }),
    ]);
    const labels = ["bank", "bs-bank-balances", "tax"];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.warn(`[KeyReports] Reconciliation warm-up (${labels[i]}) failed (non-fatal): ${r.reason?.message || r.reason}`);
      }
    });
    console.log(`[KeyReports] Reconciliation caches warmed for version ${versionId} (company ${companyId}).`);
  } catch (err) {
    // Defensive: allSettled shouldn't throw, but never let warm-up break generate.
    console.warn(`[KeyReports] Reconciliation warm-up error (non-fatal): ${err?.message || err}`);
  }
}

// Background-warm the financial-statements RESULT cache after a generate/sync.
// generateFinancialStatements is expensive (many GL scans); warming it now â€” with
// the COA the sync just built â€” means the Reports page (and the Reconciliation
// P&L fetch) hit a warm cache and load instantly instead of paying the full
// compute on first visit. Fire-and-forget (not awaited), so it never delays the
// generate response or risks a request timeout; skipped when the workflow halted
// (no COA was generated). Fully non-fatal.
// CONFIRMED ROOT CAUSE (fixed here): the halt guard used to read
// `result?.halted`, but keyReportService.syncVersion resolves to
// `{ success, version, warnings, validationResults, result }` -- the halt flag
// lives one level deeper, at `result.result.halted`. `result?.halted` was
// therefore ALWAYS undefined and the guard never fired, so every PROPOSE-mode
// sync (which halts at 'coa_review_required' with no COA persisted, having
// just cleared coa_approved_at and deleted the generated balance_sheet_entries)
// still kicked off a full generateFinancialStatements run and wrote its result
// cache -- computing and caching a complete statement set from an unapproved,
// stale COA. That is exactly the "no reports before Save" guarantee this
// function was written to respect.
//
// Now: accept the flag at either depth, and additionally refuse to warm any
// version whose Chart of Accounts is not currently approved -- the same signal
// the report routes gate on -- so a warm can never be the thing that
// resurrects reports for an unapproved version.
function isHaltedSyncResult(result) {
  return Boolean(result?.halted || result?.result?.halted);
}

async function warmFinancialStatementsCache(versionId, result) {
  if (!versionId || isHaltedSyncResult(result)) return;
  try {
    const { supabase } = require("../db");
    const { data: row } = await supabase
      .from("key_report_versions")
      .select("coa_approved_at")
      .eq("id", versionId)
      .maybeSingle();
    if (!row?.coa_approved_at) {
      console.log(`[KeyReports] Skipped financial-statements cache warm for version ${versionId} — Chart of Accounts not approved yet.`);
      return;
    }
  } catch (e) {
    console.warn(`[KeyReports] Could not verify COA approval before cache warm (skipping): ${e?.message || e}`);
    return;
  }
  generateFinancialStatements(versionId, { currency: "USD" })
    .then(() => console.log(`[KeyReports] Financial-statements cache warmed for version ${versionId}.`))
    .catch((e) => console.warn(`[KeyReports] Financial-statements cache warm failed (non-fatal): ${e?.message || e}`));
}

// ---- Sync ------------------------------------------------------------------

router.post("/key-reports/versions/:versionId/sync", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    // Run the sync pipeline AND warm the Bank/Tax Reconciliation caches
    // concurrently. Warm-up reads the raw linked files (independent of the
    // pipeline's generated tables), so it overlaps the pipeline and adds ~no
    // wall-clock â€” yet the reconciliation pages are a guaranteed cache hit
    // (instant) once this returns instead of running a multi-minute extraction on
    // first visit. Warm-up is fully non-fatal (see warmReconciliationCaches).
    const [result] = await Promise.all([
      keyReportService.syncVersion(version.id, req.user?.id),
      warmReconciliationCaches(version.companyId, version.id),
    ]);
    res.json({ success: true, ...result });
    warmFinancialStatementsCache(version.id, result);
    return;
  } catch (error) {
    return handleError(res, error, "POST sync");
  }
});

// ---- Generate (semantic alias for /sync â€” single-click full workflow) ------
// Calls the identical syncVersion pipeline: AI extraction â†’ COA â†’ Financial
// Reports â†’ Snapshots â†’ Validation. Kept as a separate route so the new UI
// can use clean "Generate" language while the existing /sync endpoint remains
// fully backward-compatible for any existing integrations.

router.post("/key-reports/versions/:versionId/generate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    // Run the sync pipeline AND warm the Bank/Tax Reconciliation caches
    // concurrently. Warm-up reads the raw linked files (independent of the
    // pipeline's generated tables), so it overlaps the pipeline and adds ~no
    // wall-clock â€” yet the reconciliation pages are a guaranteed cache hit
    // (instant) once this returns instead of running a multi-minute extraction on
    // first visit. Warm-up is fully non-fatal (see warmReconciliationCaches).
    const [result] = await Promise.all([
      keyReportService.syncVersion(version.id, req.user?.id),
      warmReconciliationCaches(version.companyId, version.id),
    ]);
    res.json({ success: true, ...result });
    warmFinancialStatementsCache(version.id, result);
    return;
  } catch (error) {
    return handleError(res, error, "POST generate");
  }
});

router.get("/key-reports/versions/:versionId/extracted-data", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { dataType, year, page, pageSize, search } = req.query;
    const result = await keyReportService.getExtractedData(version.id, {
      dataType,
      year,
      page,
      pageSize,
      search,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET extracted-data");
  }
});

router.get("/key-reports/versions/:versionId/sync-logs", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const logs = await keyReportService.listSyncLogs(version.id);
    return res.json({ success: true, syncLogs: logs });
  } catch (error) {
    return handleError(res, error, "GET sync-logs");
  }
});

// ---- Generate progress (live, in-memory) -----------------------------------
// Lightweight poll target for the Generate Workflow progress bar. Returns the
// stage the sync pipeline is currently on (derived from its log markers, from
// "=== Sync started ===" to "=== Sync complete ==="). In-memory only â€” no DB
// table; `progress` is null when no run is tracked for this version.
router.get("/key-reports/versions/:versionId/generate-progress", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const progress = keyReportProgress.getProgress(version.id);
    return res.json({ success: true, progress });
  } catch (error) {
    return handleError(res, error, "GET generate-progress");
  }
});

// ---- Chart of Accounts -----------------------------------------------------

// Helper: verify the caller can access the company that owns a COA account.
async function loadAccountWithAccess(req, res) {
  const { supabase } = require("../db");
  const { data: row } = await supabase
    .from("chart_of_accounts")
    .select("company_id, version_id")
    .eq("id", req.params.accountId)
    .maybeSingle();
  if (!row) {
    res.status(404).json({ success: false, error: "Account not found." });
    return null;
  }
  if (!requireCompanyAccess(req, res, row.company_id)) return null;
  return row;
}

// Fetch a version's COA as a deep tree + flat list (15-level hierarchy).
router.get("/key-reports/versions/:versionId/chart-of-accounts", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const coa = await chartOfAccountsService.getChartOfAccounts(version.id);
    return res.json({ success: true, ...coa });
  } catch (error) {
    return handleError(res, error, "GET chart-of-accounts");
  }
});

// Classification + adjustment audit history for a version.
router.get("/key-reports/versions/:versionId/chart-of-accounts/history", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const history = await chartOfAccountsService.getHistory(version.id);
    return res.json({ success: true, ...history });
  } catch (error) {
    return handleError(res, error, "GET chart-of-accounts/history");
  }
});

// Regenerate a version's Proposed COA from its entry tables (general_ledger_entries
// + balance_sheet_entries). Proposal-only: builds the in-memory tree and returns
// it for review -- performs ZERO writes to chart_of_accounts. The prior
// behavior (immediate persist) moved to POST .../chart-of-accounts/save, which
// is the only place a reviewed COA is ever written.
router.post("/key-reports/versions/:versionId/chart-of-accounts/regenerate", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    console.log(`[KeyReports][Audit] COA proposal regenerate versionId=${version.id}`);
    const proposal = await chartOfAccountsService.buildProposedCoaTree(
      version.companyId,
      version.id,
      version.resolvedBatchId || null,
    );
    const nodes = chartOfAccountsService.serializeProposedTree(proposal.hierarchical || []);
    res.json({
      success: true,
      proposedTree: { nodes },
      matchSummary: proposal.matchSummary,
      structuralValidation: proposal.structuralValidation,
    });
    return;
  } catch (error) {
    return handleError(res, error, "POST chart-of-accounts/regenerate");
  }
});

// Update a single COA account: rename (adjustedName), move/reclassify (levels +
// accountType/statementType), activate/deactivate. Writes adjustment + history
// audit; never touches the original AI classification.
router.patch("/key-reports/chart-of-accounts/:accountId", async (req, res) => {
  try {
    const row = await loadAccountWithAccess(req, res);
    if (!row) return;
    // A single-account hand-edit is only meaningful against an already-
    // Approved COA -- before the first Save, review/edit belongs to the
    // frontend's in-memory Proposed COA, not a persisted row (there is no
    // persisted row to safely mutate in isolation from the rest of the
    // proposal review).
    const { supabase } = require("../db");
    const { data: versionRow } = await supabase
      .from("key_report_versions")
      .select("coa_approved_at")
      .eq("id", row.version_id)
      .maybeSingle();
    if (!versionRow?.coa_approved_at) {
      return res.status(409).json({
        success: false,
        code: "COA_NOT_APPROVED",
        error: "This version's Chart of Accounts has not been Saved/Approved yet. Review and Save the proposal before editing individual accounts.",
      });
    }
    const account = await chartOfAccountsService.updateAccountHierarchy(
      req.params.accountId, req.body || {}, req.user?.id || null,
    );
    res.json({ success: true, account });
    warmFinancialStatementsCache(row.version_id, {});
    return;
  } catch (error) {
    return handleError(res, error, "PATCH chart-of-accounts");
  }
});

// Restore a single account to its original AI classification.
router.post("/key-reports/chart-of-accounts/:accountId/reset", async (req, res) => {
  try {
    const row = await loadAccountWithAccess(req, res);
    if (!row) return;
    const account = await chartOfAccountsService.resetAccount(req.params.accountId, req.user?.id || null);
    res.json({ success: true, account });
    warmFinancialStatementsCache(row.version_id, {});
    return;
  } catch (error) {
    return handleError(res, error, "POST chart-of-accounts/reset");
  }
});

// Save/Approve the user's COMPLETE reviewed Chart of Accounts tree
// (chartOfAccountsService.serializeProposedTree's flat wire-node shape --
// the same shape GET .../chart-of-accounts and .../regenerate return).
// Validates the whole tree, persists it transactionally, and -- ONLY on
// success -- continues into Trial Balance/Reconciliation/Monthly Balance
// Sheets/report snapshot generation. No report generation happens on
// failure; no partial persistence is left behind (persistApprovedCoaTree's
// compensating-rollback guard).
router.post("/key-reports/versions/:versionId/chart-of-accounts/save", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const nodes = Array.isArray(req.body?.tree?.nodes) ? req.body.tree.nodes : [];
    if (!nodes.length) {
      return res.status(422).json({
        success: false,
        code: "EMPTY_TREE",
        error: "The submitted Chart of Accounts tree is empty -- nothing to save.",
        violations: ["The submitted Chart of Accounts tree is empty."],
      });
    }
    const approveResult = await keyReportService.approveCoa(version.id, nodes, req.user?.id || null);
    if (!approveResult.success) {
      const haltReason = approveResult.result?.summary?.haltReason;
      const violations = approveResult.result?.summary?.violations
        || [approveResult.result?.message || "This change would create an invalid hierarchy."];
      return res.status(422).json({
        success: false,
        code: haltReason ? haltReason.toUpperCase() : "HIERARCHY_INVALID",
        error: violations[0],
        violations,
      });
    }
    const coa = await chartOfAccountsService.getChartOfAccounts(version.id);
    res.json({ success: true, ...approveResult, ...coa });
    warmFinancialStatementsCache(version.id, {});
    return;
  } catch (error) {
    return handleError(res, error, "POST chart-of-accounts/save");
  }
});

// Restore the entire version's hierarchy to the original AI classification.
router.post("/key-reports/versions/:versionId/chart-of-accounts/reset", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const result = await chartOfAccountsService.resetVersion(version.id, req.user?.id || null);
    const coa = await chartOfAccountsService.getChartOfAccounts(version.id);
    res.json({ success: true, ...result, ...coa });
    warmFinancialStatementsCache(version.id, {});
    return;
  } catch (error) {
    return handleError(res, error, "POST chart-of-accounts/reset-version");
  }
});

// ---- AI Hierarchy Recommendations (advisory-only; never auto-applied) ------

// Resolve a recommendation row and verify the caller can access its company.
async function loadRecommendationWithAccess(req, res) {
  const { supabase } = require("../db");
  const { data: row } = await supabase
    .from("key_report_coa_hierarchy_recommendations")
    .select("id, company_id, version_id, status")
    .eq("id", req.params.recommendationId)
    .maybeSingle();
  if (!row) {
    res.status(404).json({ success: false, error: "Recommendation not found." });
    return null;
  }
  if (!requireCompanyAccess(req, res, row.company_id)) return null;
  return row;
}

// List all AI hierarchy recommendations for a version (pending + decided).
router.get("/key-reports/versions/:versionId/hierarchy-recommendations", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { listRecommendations } = require("../services/keyReports/aiHierarchyRecommendationService");
    const recommendations = await listRecommendations(version.id);
    return res.json({ success: true, recommendations });
  } catch (error) {
    return handleError(res, error, "GET hierarchy-recommendations");
  }
});

// Accept a recommendation â€” inserts the suggested roll-up via the same
// updateAccountHierarchy() path the manual COA editor uses. Never a direct write.
router.post("/key-reports/hierarchy-recommendations/:recommendationId/accept", async (req, res) => {
  try {
    const recommendation = await loadRecommendationWithAccess(req, res);
    if (!recommendation) return;
    const { acceptRecommendation } = require("../services/keyReports/aiHierarchyRecommendationService");
    const result = await acceptRecommendation(recommendation.id, req.user?.id || null);
    const coa = await chartOfAccountsService.getChartOfAccounts(recommendation.version_id);
    res.json({ success: true, ...result, ...coa });
    warmFinancialStatementsCache(recommendation.version_id, {});
    return;
  } catch (error) {
    return handleError(res, error, "POST hierarchy-recommendations/accept");
  }
});

// Ignore a recommendation â€” marks it decided, no hierarchy change.
router.post("/key-reports/hierarchy-recommendations/:recommendationId/ignore", async (req, res) => {
  try {
    const recommendation = await loadRecommendationWithAccess(req, res);
    if (!recommendation) return;
    const { ignoreRecommendation } = require("../services/keyReports/aiHierarchyRecommendationService");
    const result = await ignoreRecommendation(recommendation.id, req.user?.id || null, req.body?.reason);
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "POST hierarchy-recommendations/ignore");
  }
});

// Apply an AI reasonableness recommendation. Distinct from /accept only in
// that it reports a STALE recommendation as a 409 conflict instead of an
// error: if the account has changed since the recommendation was generated,
// the proposal was reasoned about a Chart of Accounts that no longer exists
// and must be regenerated rather than applied over a newer user edit.
router.post("/key-reports/hierarchy-recommendations/:recommendationId/apply", async (req, res) => {
  try {
    const recommendation = await loadRecommendationWithAccess(req, res);
    if (!recommendation) return;
    const { applyRecommendation } = require("../services/keyReports/aiHierarchyRecommendationService");
    const result = await applyRecommendation(recommendation.id, req.user?.id || null);
    if (!result.ok) {
      return res.status(result.conflict ? 409 : 422).json({ success: false, ...result });
    }
    const coa = await chartOfAccountsService.getChartOfAccounts(recommendation.version_id);
    res.json({ success: true, ...result, ...coa });
    // Reports are regenerated off the updated COA exactly as they are after a
    // manual edit — the recommendation layer adds no separate report path.
    warmFinancialStatementsCache(recommendation.version_id, {});
    return;
  } catch (error) {
    return handleError(res, error, "POST hierarchy-recommendations/apply");
  }
});

// Reject a recommendation â€” the COA is left untouched; the decision and an
// optional reason are stored for audit.
router.post("/key-reports/hierarchy-recommendations/:recommendationId/reject", async (req, res) => {
  try {
    const recommendation = await loadRecommendationWithAccess(req, res);
    if (!recommendation) return;
    const { rejectRecommendation } = require("../services/keyReports/aiHierarchyRecommendationService");
    const result = await rejectRecommendation(recommendation.id, req.user?.id || null, req.body?.reason);
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "POST hierarchy-recommendations/reject");
  }
});

// ---- File references (deletion guard / "linked" badges) --------------------

router.get("/key-reports/file-references", async (req, res) => {
  try {
    const companyId = resolveClientId(req);
    if (!requireCompanyAccess(req, res, companyId)) return;
    const idsParam = req.query.documentIds || req.query.documentId;
    const ids = String(idsParam || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const counts = await fileReferenceService.getReferenceCountsForDocuments(ids);
    return res.json({ success: true, counts });
  } catch (error) {
    return handleError(res, error, "GET file-references");
  }
});

// ---- Educational popup preference (per user) -------------------------------

router.get("/key-reports/popup-preference", async (req, res) => {
  try {
    const value = await userPreferenceService.getPreference(req.user?.id, POPUP_PREF_KEY);
    return res.json({ success: true, dismissed: Boolean(value?.dismissed) });
  } catch (error) {
    return handleError(res, error, "GET popup-preference");
  }
});

router.put("/key-reports/popup-preference", async (req, res) => {
  try {
    const dismissed = req.body?.dismissed === true || req.body?.dismissed === "true";
    await userPreferenceService.setPreference(req.user?.id, POPUP_PREF_KEY, { dismissed });
    return res.json({ success: true, dismissed });
  } catch (error) {
    return handleError(res, error, "PUT popup-preference");
  }
});

// ---- Reports (read ONLY from Key Reports entry tables) ---------------------
// These endpoints are the single authoritative report source for Key Reports.
// They NEVER touch Manual GL staging, active batches, or snapshots.

function parseReportQuery(q = {}) {
  // `year` accepts a single fiscal year. A comma list (e.g. "2022,2023") is NOT a
  // single year â€” collapse it to a date range so spec #12/#13 still resolve the
  // full year set rather than silently using only the first value.
  const rawYear = q.year != null ? String(q.year).trim() : "";
  const isSingleYear = /^\d{4}$/.test(rawYear);
  return {
    year: isSingleYear ? parseInt(rawYear, 10) : null,
    startDate: q.startDate ? String(q.startDate) : null,
    endDate: q.endDate ? String(q.endDate) : null,
    // "month" â†’ monthly columns (Janâ€¦Dec); anything else â†’ fiscal-year columns.
    period: String(q.period || "").toLowerCase() === "month" ? "month" : "year",
    page: parseInt(String(q.page || 1), 10) || 1,
    pageSize: parseInt(String(q.pageSize || 500), 10) || 500,
  };
}

router.get("/key-reports/versions/:versionId/reports/profit-loss", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year, startDate, endDate, period } = parseReportQuery(req.query);
    const result = await keyReportReportService.getProfitLossReport(version.id, { year, startDate, endDate, period });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/profit-loss");
  }
});

router.get("/key-reports/versions/:versionId/reports/trial-balance", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year } = parseReportQuery(req.query);
    const result = await keyReportReportService.getTrialBalanceReport(version.id, { year });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/trial-balance");
  }
});

router.get("/key-reports/versions/:versionId/reports/reconciliation", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year } = parseReportQuery(req.query);
    const result = await keyReportReportService.getReconciliationReport(version.id, { year });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/reconciliation");
  }
});

router.get("/key-reports/versions/:versionId/reports/cashflow", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year, startDate, endDate } = parseReportQuery(req.query);
    const result = await keyReportReportService.getCashflowReport(version.id, { year, startDate, endDate });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/cashflow");
  }
});

// Snapshot-served Balance Sheet (generated_report_snapshots) — mirrors the
// P&L/Cash Flow endpoints above. The main Reports page still reads Balance
// Sheet via /reports/financial-statements; this exists so BS is available
// through the same persisted-snapshot path as the other two statements.
router.get("/key-reports/versions/:versionId/reports/balance-sheet", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year } = parseReportQuery(req.query);
    const result = await keyReportReportService.getBalanceSheetReport(version.id, { year });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/balance-sheet");
  }
});

router.get("/key-reports/versions/:versionId/reports/general-ledger", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { year, startDate, endDate, page, pageSize } = parseReportQuery(req.query);
    const result = await keyReportReportService.getGeneralLedgerReport(version.id, { year, startDate, endDate, page, pageSize });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/general-ledger");
  }
});

// Vendor reference data for the EBITDA adjustment editor's Vendor Scope
// control. Reads general_ledger_entries directly (see keyReportVendorService) --
// the EBITDA page previously sourced this from the Manual GL Upload staging
// tables, which a Key Reports version has no rows in, so the dropdown always
// showed "No vendors found".
//
// ?account=<name>  restricts to the vendors that posted to one account.
// ?field=customer  returns customers instead (same shape; the column exists and
//                  is populated by the same extraction pass).
// Deliberately NOT gated behind requireApprovedCoa: vendors come from the raw
// GL, not from a generated report, so they are available as soon as the GL is
// extracted -- which is exactly when the adjustment editor needs them.
router.get("/key-reports/versions/:versionId/vendors", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    // keyReportService.getVersion returns a camelCase view (companyId), not the
    // raw row — using version.company_id here would silently pass undefined and
    // return an empty vendor list.
    const result = await keyReportVendorService.getVendorReference(
      version.companyId,
      version.id,
      { accountName: req.query.account || null, field: req.query.field || "vendor" },
    );
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET vendors");
  }
});

router.get("/key-reports/versions/:versionId/reports/bank-statement", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { year, page, pageSize } = parseReportQuery(req.query);
    const result = await keyReportReportService.getBankStatementReport(version.id, { year, page, pageSize });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/bank-statement");
  }
});

router.get("/key-reports/versions/:versionId/reports/tax-return", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const { year } = parseReportQuery(req.query);
    const result = await keyReportReportService.getTaxReturnReport(version.id, { year });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/tax-return");
  }
});

// â”€â”€ COA-mapped Financial Statements (P&L + Balance Sheet, monthly + yearly) â”€â”€â”€
// GET /key-reports/versions/:versionId/reports/financial-statements?year=2024&currency=USD
router.get("/key-reports/versions/:versionId/reports/financial-statements", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year, currency, companyName } = req.query;
    const result = await generateFinancialStatements(version.id, {
      year: year ? parseInt(String(year), 10) : undefined,
      currency: currency || "USD",
      companyName: companyName || "",
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/financial-statements");
  }
});

// Lightweight, version-scoped period metadata for the Reports page's Monthly/
// Yearly filter defaults — a handful of order-by-limit-1 queries, never the
// full report payload. See financialStatementService.getAvailablePeriods.
// GET /key-reports/versions/:versionId/available-periods
router.get("/key-reports/versions/:versionId/available-periods", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    const result = await getAvailablePeriods(version.id);
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET available-periods");
  }
});

// â”€â”€ Quality of Earnings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /key-reports/versions/:versionId/reports/qoe?year=2024
router.get("/key-reports/versions/:versionId/reports/qoe", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year } = req.query;
    const result = await keyReportReportService.getQoeReport(version.id, {
      year: year ? parseInt(String(year), 10) : undefined,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/qoe");
  }
});

// â”€â”€ KPI Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /key-reports/versions/:versionId/reports/kpi?year=2024
router.get("/key-reports/versions/:versionId/reports/kpi", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;
    if (!(await requireApprovedCoa(res, version))) return;
    const { year } = req.query;
    const result = await keyReportReportService.getKpiReport(version.id, {
      year: year ? parseInt(String(year), 10) : undefined,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return handleError(res, error, "GET reports/kpi");
  }
});

// â”€â”€ Export Data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /key-reports/versions/:versionId/export
// Exports all raw synced data for the selected version as an Excel workbook
router.get("/key-reports/versions/:versionId/export", async (req, res) => {
  try {
    const version = await loadVersionWithAccess(req, res);
    if (!version) return;

    const { fileName, buffer } = await exportKeyReportData(version.id);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", buffer.length);

    return res.send(buffer);
  } catch (error) {
    return handleError(res, error, "GET export");
  }
});

module.exports = router;