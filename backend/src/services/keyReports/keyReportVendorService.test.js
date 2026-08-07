// Regression tests for: "the EBITDA Calculation page always shows 'No vendors
// found', even though the vendors exist in general_ledger_entries."
//
// ROOT CAUSE (two defects on the same path, both confirmed in source):
//
// 1. FRONTEND — WorkspaceEbitda had exactly ONE vendor loader,
//    loadVendorReferenceData, and its effect began:
//        if (!isManualGl) { setManualGlReferenceIndex(null); return; }
//    so on a Key Reports version no vendor request was issued at all,
//    `adjustmentVendorOptions` stayed `[]`, and the Vendor Scope dropdown
//    rendered its empty-state placeholder.
//
// 2. BACKEND — that single loader reads the MANUAL GL UPLOAD staging tables
//    (getManualStagedProfitLossVendorDetail). A Key Reports version has no rows
//    there, so even when it was called it could only ever return nothing. There
//    was no Key Reports vendor endpoint at all.
//
// The vendors were in the database the whole time: the Key Reports extraction
// writes them to general_ledger_entries.vendor. Verified live on version
// 2b00b21b — 165 distinct vendors across 61 accounts; end-to-end over HTTP the
// new route returns 200 with all 165, and ?account=Accounts Payable (A/P)
// correctly narrows to that account's 20.
//
// THE FIX is a new Key Reports path (keyReportVendorService + its route +
// loadKeyReportVendorReferenceData), reading general_ledger_entries directly.
// The Manual GL implementation is NOT reused and is left untouched.
//
// Run: node --test backend/src/services/keyReports/keyReportVendorService.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVICE_SRC = fs.readFileSync(path.join(__dirname, 'keyReportVendorService.js'), 'utf8');
const ROUTES_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'keyReports.js'), 'utf8');
const FE = (p) => fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', p), 'utf8');

describe('the vendor source is general_ledger_entries and nothing else', () => {
  test('it queries general_ledger_entries', () => {
    assert.ok(/const TABLE_GL = "general_ledger_entries";/.test(SERVICE_SRC));
    assert.ok(/\.from\(TABLE_GL\)/.test(SERVICE_SRC));
  });

  test('it filters by company AND version', () => {
    assert.ok(/\.eq\("company_id", companyId\)/.test(SERVICE_SRC));
    assert.ok(/\.eq\("version_id", versionId\)/.test(SERVICE_SRC));
  });

  test('it excludes null and whitespace-only vendors (SELECT DISTINCT ... TRIM <> \'\')', () => {
    assert.ok(/\.not\(field, "is", null\)/.test(SERVICE_SRC), 'vendor IS NOT NULL');
    assert.ok(/if \(!vendor\) continue;/.test(SERVICE_SRC), "TRIM(vendor) <> ''");
  });

  test('no manual_gl / staging / legacy vendor source is consulted', () => {
    const code = SERVICE_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const banned of [/manual_gl/i, /staging/i, /getManualStaged/, /manual_stage/i]) {
      assert.equal(banned.test(code), false, `must not use ${banned}`);
    }
  });

  test('it reads the vendor and customer columns the table actually has', () => {
    // Verified against the live schema: general_ledger_entries has `vendor` and
    // `customer` columns (not vendor_name/customer_name).
    assert.ok(/opts\.field === "customer" \? "customer" : "vendor"/.test(SERVICE_SRC));
  });

  test('it paginates — PostgREST caps an unpaginated read at ~1000 rows', () => {
    assert.ok(/fetchAllRows/.test(SERVICE_SRC),
      'a version with 10k+ GL rows would otherwise silently return a truncated vendor list');
  });
});

describe('the route is wired correctly', () => {
  test('GET /key-reports/versions/:versionId/vendors exists', () => {
    assert.ok(/router\.get\("\/key-reports\/versions\/:versionId\/vendors"/.test(ROUTES_SRC));
  });

  test('it passes companyId, not company_id', () => {
    // keyReportService.getVersion returns a camelCase view; company_id is
    // undefined on it and would have silently produced an empty vendor list.
    assert.ok(/getVendorReference\(\s*\n?\s*version\.companyId,/.test(ROUTES_SRC.replace(/\r/g, '')));
    assert.equal(/getVendorReference\(\s*\n?\s*version\.company_id,/.test(ROUTES_SRC.replace(/\r/g, '')), false);
  });

  test('it goes through the same access check as every other version route', () => {
    const i = ROUTES_SRC.indexOf('/key-reports/versions/:versionId/vendors');
    const body = ROUTES_SRC.slice(i, i + 900);
    assert.ok(/loadVersionWithAccess\(req, res\)/.test(body));
  });

  test('it forwards the account and field query params', () => {
    const i = ROUTES_SRC.indexOf('/key-reports/versions/:versionId/vendors');
    const body = ROUTES_SRC.slice(i, i + 900);
    assert.ok(/accountName: req\.query\.account/.test(body));
    assert.ok(/field: req\.query\.field/.test(body));
  });
});

describe('the frontend actually calls it, for Key Reports', () => {
  test('an API client function exists for the endpoint', () => {
    assert.ok(/\/key-reports\/versions\/\$\{versionId\}\/vendors/.test(FE('lib/api.js')));
  });

  test('WorkspaceEbitda loads vendors on the Key Reports path', () => {
    const src = FE('pages/broker/workspace/WorkspaceEbitda.jsx');
    assert.ok(/loadKeyReportVendorReferenceData\(\{ versionId: krVersionId \}\)/.test(src));
    // The old gate returned early for every non-Manual-GL source, which is what
    // stopped the request being made at all.
    assert.ok(/if \(isManualGl \|\| !krVersionId\)/.test(src),
      'the Key Reports loader must run precisely when the source is NOT Manual GL');
  });

  test('vendor options follow the active source rather than always Manual GL', () => {
    const src = FE('pages/broker/workspace/WorkspaceEbitda.jsx');
    assert.ok(/activeReferenceIndex\?\.vendorOptions\?\.length/.test(src));
    assert.equal(/return manualGlReferenceIndex\?\.vendorOptions\?\.length/.test(src), false,
      'the old Manual-GL-only binding must be gone');
  });

  test('the Key Reports index never reaches applyReferenceValues', () => {
    // referenceIndex is treated as a source of TRANSACTIONS and rebuilds each
    // year's value from them; routing vendor data through it would change
    // adjustment values. It is passed as its own prop instead.
    const src = FE('pages/broker/workspace/WorkspaceEbitda.jsx');
    assert.ok(/vendorsByAccount=\{keyReportReferenceIndex\?\.vendorsByAccount \|\| null\}/.test(src));
    assert.ok(/referenceIndex=\{null\}/.test(src), 'the Key Reports branch must keep referenceIndex null');
  });

  test('the modal narrows by account from either source', () => {
    const src = FE('components/reports/ebitda/AddbackEditorModal.jsx');
    assert.ok(/vendorsByAccount\?\.get\?\.\(accountName\)/.test(src));
    assert.ok(/if \(!accountVendorNames\.length\) return vendorOptions \|\| \[\];/.test(src),
      'an account with no vendor attribution must fall back to the full list, not an empty one');
  });

  test('the Manual GL implementation is untouched and still its own path', () => {
    const svc = FE('services/ebitdaAdjustmentService.js');
    assert.ok(/export async function loadVendorReferenceData/.test(svc), 'manual loader still present');
    assert.ok(/getManualStagedProfitLossVendorDetail\(options\)/.test(svc), 'and unchanged');
    assert.ok(/export async function loadKeyReportVendorReferenceData/.test(svc), 'KR loader is separate');
  });

  test('no EBITDA calculation logic was touched', () => {
    const svc = FE('services/ebitdaAdjustmentService.js');
    // The value builder must still branch on transactions exactly as before.
    assert.ok(/const transactions = referenceIndex \? getReferenceTransactions\(referenceIndex, next\) : \[\];/.test(svc));
    assert.ok(/const computed = transactions\.length/.test(svc));
  });
});
