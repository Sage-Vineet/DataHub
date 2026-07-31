// Live DB consistency checker for the Chart of Accounts hierarchy invariants.
// Walks every persisted chart_of_accounts row for a given version (or every
// version, if none is passed) and verifies, per the "level_1..15 is a
// fixed-width schema supporting a MAXIMUM depth of 15 -- trailing levels past
// an account's real depth stay NULL, never repeated" convention:
//
//   C. parent_account_id chain agrees with hierarchy_path
//   D. hierarchy_path agrees with level_1..level_15 (populated levels joined)
//   E. Levels form a contiguous prefix (no internal NULL gap)
//   F. No leaf-name propagation (trailing levels are NULL, not the leaf's
//      own name repeated)
//   G. No broken parent references (parent_account_id points at a row that
//      doesn't exist)
//   H. No circular references
//   I. No orphan structural (group) nodes (never referenced as a parent)
//   J. No duplicate hierarchy_path within the same version+node_type
//   N/O. BS/P&L fixed anchors correct for every resolved leaf
//
// Run: node backend/scripts/validateCoaHierarchyIntegrity.js [versionId]

require("dotenv").config();
const { supabase } = require("../src/db");
const { fetchAllRows } = require("../src/services/keyReports/pagedFetch");

const MAX_LEVELS = 15;
const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);

const BS_ANCHOR = {
  asset: ["Total Assets", "Total Assets"],
  liability: ["Total Liabilities and Equity", "Total Liabilities"],
};
const PL_ANCHOR = ["Total Liabilities and Equity", "Total Equity", "Total Equity"];

function normName(s) {
  return String(s || "").trim().toLowerCase();
}

async function run(versionId) {
  const cols = ["id, version_id, company_id, account_name, account_type, node_type, parent_account_id, hierarchy_path", ...levelCols].join(", ");
  const all = await fetchAllRows(() => {
    let q = supabase.from("chart_of_accounts").select(cols);
    if (versionId) q = q.eq("version_id", versionId);
    return q.order("id", { ascending: true });
  });

  let pass = 0;
  let fail = 0;
  const failures = [];
  const check = (name, ok) => { if (ok) pass += 1; else { fail += 1; failures.push(name); } };

  const byId = new Map(all.map((r) => [r.id, r]));
  const totalAccounts = all.filter((r) => r.node_type === "account").length;

  // G. broken parent references
  const brokenParents = all.filter((r) => r.parent_account_id && !byId.has(r.parent_account_id));
  check(`G. No broken parent references (found ${brokenParents.length})`, brokenParents.length === 0);

  // H. circular references
  let circular = 0;
  for (const r of all) {
    const visited = new Set([r.id]);
    let cursor = r.parent_account_id;
    let hops = 0;
    while (cursor && hops < MAX_LEVELS + 5) {
      if (visited.has(cursor)) { circular += 1; break; }
      visited.add(cursor);
      cursor = byId.get(cursor)?.parent_account_id || null;
      hops += 1;
    }
  }
  check(`H. No circular references (found ${circular})`, circular === 0);

  // I. orphan structural nodes (group/header rows never referenced as a parent)
  const referencedIds = new Set(all.map((r) => r.parent_account_id).filter(Boolean));
  const orphanNodes = all.filter((r) => r.node_type !== "account" && !referencedIds.has(r.id));
  check(`I. No orphan structural nodes (found ${orphanNodes.length})`, orphanNodes.length === 0);

  // J. duplicate hierarchy_path within same version+node_type
  const pathCounts = new Map();
  for (const r of all) {
    if (!r.hierarchy_path) continue;
    const key = `${r.version_id}||${r.node_type}||${r.hierarchy_path}`;
    pathCounts.set(key, (pathCounts.get(key) || 0) + 1);
  }
  const duplicatePaths = Array.from(pathCounts.values()).filter((n) => n > 1).length;
  check(`J. No duplicate hierarchy_path within same version+node_type (found ${duplicatePaths})`, duplicatePaths === 0);

  function walkPath(row) {
    const names = [];
    const visited = new Set();
    let cursor = row;
    let hops = 0;
    while (cursor && !visited.has(cursor.id) && hops <= MAX_LEVELS + 5) {
      visited.add(cursor.id);
      names.push(cursor.account_name);
      cursor = cursor.parent_account_id ? byId.get(cursor.parent_account_id) : null;
      hops += 1;
    }
    return names.reverse();
  }

  let pathMismatches = 0;
  let levelMismatches = 0;
  let internalGaps = 0;
  let leafNamePropagation = 0;
  let bsAnchorMismatches = 0;
  let plAnchorMismatches = 0;

  for (const r of all) {
    const walked = walkPath(r);
    const walkedPath = walked.join(" > ");
    const realDepth = walked.length;

    // C. parent_account_id chain agrees with hierarchy_path
    if (walkedPath !== (r.hierarchy_path || "")) pathMismatches += 1;

    const levels = levelCols.map((c) => r[c]);
    const isBlank = (v) => v == null || String(v).trim() === "";
    const populated = levels.filter((v) => !isBlank(v));

    // D. hierarchy_path agrees with level_1..level_15 (populated levels joined)
    if (walkedPath !== populated.join(" > ")) levelMismatches += 1;

    // E. contiguous prefix -- no real value after a blank one
    let sawEmpty = false;
    for (const v of levels) {
      if (isBlank(v)) sawEmpty = true;
      else if (sawEmpty) { internalGaps += 1; break; }
    }

    // F. no leaf-name propagation: nothing past the real depth may equal the
    // leaf's own name.
    if (r.node_type === "account" && realDepth >= 1 && realDepth < MAX_LEVELS) {
      const ownName = walked[realDepth - 1];
      if (levels.slice(realDepth).some((v) => v === ownName)) leafNamePropagation += 1;
    }

    // N/O. fixed anchors for resolved (real depth > 1) leaves only.
    if (r.node_type === "account" && r.account_type && realDepth > 1) {
      if (["asset", "liability"].includes(r.account_type)) {
        const anchor = BS_ANCHOR[r.account_type];
        for (let i = 0; i < anchor.length; i += 1) {
          if (normName(walked[i]) !== normName(anchor[i])) { bsAnchorMismatches += 1; break; }
        }
      } else if (["income", "cogs", "expense"].includes(r.account_type) && realDepth >= 3) {
        for (let i = 0; i < PL_ANCHOR.length; i += 1) {
          if (normName(walked[i]) !== normName(PL_ANCHOR[i])) { plAnchorMismatches += 1; break; }
        }
      }
    }
  }

  check(`C. parent_account_id chain agrees with hierarchy_path (${pathMismatches} mismatch(es))`, pathMismatches === 0);
  check(`D. hierarchy_path agrees with level_1..15 (${levelMismatches} mismatch(es))`, levelMismatches === 0);
  check(`E. Levels form a contiguous prefix, no internal gaps (${internalGaps} found)`, internalGaps === 0);
  check(`F. No leaf-name propagation into trailing levels (${leafNamePropagation} found)`, leafNamePropagation === 0);
  check(`N. BS fixed anchors correct for every resolved asset/liability leaf (${bsAnchorMismatches} mismatch(es))`, bsAnchorMismatches === 0);
  check(`O. P&L fixed anchors correct for every resolved income/cogs/expense leaf (${plAnchorMismatches} mismatch(es))`, plAnchorMismatches === 0);

  console.log(`\nTotal rows checked: ${all.length} (${totalAccounts} account leaves)`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
  return fail === 0;
}

const versionArg = process.argv[2] || null;
run(versionArg)
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => { console.error("FATAL", e); process.exit(1); });
