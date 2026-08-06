// One-off verification runner: triggers a real Key Reports sync (the exact
// same syncVersion() the API route calls) against an existing test version,
// so the canonical document -> GL matching -> hierarchy -> chart_of_accounts
// flow is exercised end-to-end with live extraction + AI fallback, not just
// unit fixtures. Read from stdout; not part of the app.
require("dotenv").config();
const keyReportService = require("../src/services/keyReports/keyReportService");

const versionId = process.argv[2];
if (!versionId) {
  console.error("Usage: node _run_live_sync_verify.js <versionId>");
  process.exit(1);
}

(async () => {
  const start = Date.now();
  try {
    const result = await keyReportService.syncVersion(versionId, null, {});
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n\n=== SYNC RESULT (${elapsed}s) ===`);
    console.log(JSON.stringify({
      success: result.success,
      halted: result.result?.halted || false,
      message: result.result?.message || result.result?.summary?.message || null,
      years: result.result?.years,
      coaSummary: result.result?.coaSummary,
      warnings: result.warnings,
    }, null, 2));
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`\n\n=== SYNC THREW after ${elapsed}s ===`);
    console.error(e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
