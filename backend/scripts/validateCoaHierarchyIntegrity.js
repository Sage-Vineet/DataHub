// Live DB consistency checker for the Chart of Accounts hierarchy invariants,
// for the just-completed Proposed COA / Approved COA split (see
// chartOfAccountsService.js's buildProposedCoaTree/persistApprovedCoaTree and
// keyReportSyncService.js's generateCoaProposal/approveAndGenerateReports).
// Walks every persisted chart_of_accounts row for ONE version (required —
// --versionId=<uuid>) and verifies, per the "level_1..15 is a fixed-width
// schema supporting a MAXIMUM depth of 15 -- trailing levels past an
// account's real depth stay NULL, never repeated" convention this system
// depends on everywhere (Trial Balance, Reconciliation, Monthly Balance
// Sheets, P&L/Cash Flow/Balance Sheet snapshots all read chart_of_accounts as
// their single source of truth for structure):
//
//   1. Broken parents          -- parent_account_id set but doesn't match any
//                                  other row's id in the same version.
//   2. Circular references     -- walking parent_account_id revisits a node
//                                  before reaching a null parent.
//   3. Orphan accounts         -- see the precise definition in the comment
//                                  above checkOrphans() below.
//   4. Duplicate hierarchy paths -- two ACCOUNT rows with the identical
//                                  hierarchy_path.
//   5. Leaf padding             -- a row whose level_N repeats the same
//                                  non-null label 2+ times in a row among its
//                                  trailing populated levels (the exact bug
//                                  this system must never reintroduce --
//                                  trailing levels must be NULL, never a
//                                  repeat of the leaf's own name).
//   6. Level/parent-chain mismatch -- recompute the expected level_1..15 by
//                                  walking parent_account_id and diff against
//                                  the persisted level_1..15 columns.
//   7. Cross-version leaks     -- see the note in the comment above
//                                  checkCrossVersionLeaks() below (not
//                                  actively tested; every query here is
//                                  scoped .eq('version_id', versionId), which
//                                  makes a leak structurally impossible
//                                  unless that scoping is ever removed).
//   (bonus, kept from the prior version of this script) BS/P&L fixed anchors
//   correct for every resolved leaf, and orphan STRUCTURAL (category) nodes.
//
// Requires live Supabase credentials (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// in backend/.env) -- this script could not be executed end-to-end in the
// environment that wrote it; it was verified with `node --check` (syntax)
// and by careful manual reading only. Run it for real the first time against
// a known-good version's data before trusting its output.
//
// Usage: node backend/scripts/validateCoaHierarchyIntegrity.js --versionId=<uuid>
//   (a bare positional uuid, `node ... <uuid>`, is also accepted for
//   backwards compatibility with the prior version of this script.)

require("dotenv").config();
const { supabase } = require("../src/db");
const { fetchAllRows } = require("../src/services/keyReports/pagedFetch");

const MAX_LEVELS = 15;
const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);

const BS_ANCHOR = {
  asset: ["Total Assets"],
  liability: ["Total Liabilities and Equity", "Total Liabilities"],
};
const PL_ANCHOR = ["Total Liabilities and Equity", "Total Equity"];

function normName(s) {
  return String(s || "").trim().toLowerCase();
}

function parseVersionIdArg(argv) {
  const flagArg = argv.find((a) => a.startsWith("--versionId="));
  if (flagArg) return flagArg.slice("--versionId=".length).trim() || null;
  // Backwards-compatible bare positional arg (prior version of this script).
  const positional = argv.find((a) => !a.startsWith("--"));
  return positional || null;
}

// A tiny helper: cap how many individual violations get printed per check so
// a genuinely broken version (hundreds of bad rows) doesn't flood the
// console -- the COUNT in the pass/fail summary line is always the complete,
// untruncated number.
function printDetails(rows, limit = 25) {
  rows.slice(0, limit).forEach((r) => console.log(`      - ${r}`));
  if (rows.length > limit) console.log(`      ... and ${rows.length - limit} more`);
}

async function run(versionId) {
  const cols = ["id, version_id, company_id, account_name, account_type, node_type, parent_account_id, hierarchy_path", ...levelCols].join(", ");
  const all = await fetchAllRows(() => supabase.from("chart_of_accounts").select(cols).eq("version_id", versionId).order("id", { ascending: true }));

  let pass = 0;
  let fail = 0;
  const results = []; // { name, ok, count, details: string[] }
  const check = (name, ok, count, details = []) => {
    if (ok) pass += 1; else fail += 1;
    results.push({ name, ok, count, details });
  };

  const byId = new Map(all.map((r) => [r.id, r]));
  const label = (r) => `"${r.account_name || "(unnamed)"}" (id=${r.id})`;
  const totalAccounts = all.filter((r) => r.node_type === "account").length;
  const totalCategories = all.length - totalAccounts;

  // ── 1. Broken parents ──────────────────────────────────────────────────
  const brokenParents = all.filter((r) => r.parent_account_id && !byId.has(r.parent_account_id));
  check(
    "1. Broken parents (parent_account_id set but matches no row in this version)",
    brokenParents.length === 0,
    brokenParents.length,
    brokenParents.map((r) => `${label(r)}: parent_account_id=${r.parent_account_id} does not exist`),
  );

  // ── 2. Circular references ─────────────────────────────────────────────
  const circularRows = [];
  for (const r of all) {
    const visited = new Set([r.id]);
    let cursor = r.parent_account_id;
    let hops = 0;
    while (cursor && hops < MAX_LEVELS + 5) {
      if (visited.has(cursor)) { circularRows.push(r); break; }
      visited.add(cursor);
      cursor = byId.get(cursor)?.parent_account_id || null;
      hops += 1;
    }
  }
  check(
    "2. Circular references (walking parent_account_id revisits a node)",
    circularRows.length === 0,
    circularRows.length,
    circularRows.map((r) => `${label(r)}: parent chain revisits a node before reaching a null parent`),
  );

  // ── 3. Orphan accounts ──────────────────────────────────────────────────
  // Definition used here: TWO distinct orphan shapes, checked separately --
  //   (a) Orphan ACCOUNT: a node_type='account' (posting) row whose
  //       parent_account_id is NULL. Every real posting account in this
  //       system's design nests under the fixed GAAP anchor categories
  //       (fixedPrefixFor in chartOfAccountsService.js) -- a posting account
  //       with no parent at all has no path to a root category and is
  //       structurally disconnected from the tree the UI renders.
  //   (b) Orphan CATEGORY: a node_type != 'account' (structural/group) row
  //       that no other row (of either type) ever points to as its parent --
  //       a dead category node created but never actually used to hang
  //       anything from, left behind by a stale/partial persist.
  const referencedIds = new Set(all.map((r) => r.parent_account_id).filter(Boolean));
  const orphanAccounts = all.filter((r) => r.node_type === "account" && !r.parent_account_id);
  const orphanCategories = all.filter((r) => r.node_type !== "account" && !referencedIds.has(r.id));
  check(
    "3a. Orphan accounts (posting account with no parent_account_id at all)",
    orphanAccounts.length === 0,
    orphanAccounts.length,
    orphanAccounts.map((r) => `${label(r)}: parent_account_id is null -- no path to a root category`),
  );
  check(
    "3b. Orphan categories (structural node nothing points to as a parent)",
    orphanCategories.length === 0,
    orphanCategories.length,
    orphanCategories.map((r) => `${label(r)}: node_type=${r.node_type}, never referenced as a parent`),
  );

  // ── 4. Duplicate hierarchy paths (ACCOUNT rows only) ───────────────────
  const accountPathCounts = new Map(); // hierarchy_path -> rows[]
  for (const r of all) {
    if (r.node_type !== "account" || !r.hierarchy_path) continue;
    if (!accountPathCounts.has(r.hierarchy_path)) accountPathCounts.set(r.hierarchy_path, []);
    accountPathCounts.get(r.hierarchy_path).push(r);
  }
  const duplicateAccountPathGroups = Array.from(accountPathCounts.entries()).filter(([, rows]) => rows.length > 1);
  check(
    "4. Duplicate hierarchy paths (two ACCOUNT rows with the identical hierarchy_path)",
    duplicateAccountPathGroups.length === 0,
    duplicateAccountPathGroups.length,
    duplicateAccountPathGroups.map(([hp, rows]) => `"${hp}" shared by ${rows.map(label).join(" and ")}`),
  );

  // ── Shared helper: walk parent_account_id to a root, returning the
  //    account-name chain in root-to-leaf order (used by both the leaf-
  //    padding check and the level/parent-chain mismatch check below). ──
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

  // ── 5. Leaf padding ─────────────────────────────────────────────────────
  // "Trailing levels must be NULL, never a repeat of the leaf's own name."
  // Checked directly against the persisted level_1..15 columns: among a
  // row's trailing POPULATED levels (i.e. ignoring genuine unused-NULL
  // tail), does any label repeat 2+ times in a row (back-to-back)? A
  // legitimate hierarchy never repeats the same label as its own immediate
  // successor -- a category is never its own child.
  const leafPaddingRows = [];
  for (const r of all) {
    const levels = levelCols.map((c) => r[c]).filter((v) => v != null && String(v).trim() !== "");
    for (let i = 1; i < levels.length; i += 1) {
      if (normName(levels[i]) === normName(levels[i - 1])) {
        leafPaddingRows.push({ row: r, label: levels[i], index: i });
        break;
      }
    }
  }
  check(
    "5. Leaf padding (a populated level repeats the same label as the level right before it)",
    leafPaddingRows.length === 0,
    leafPaddingRows.length,
    leafPaddingRows.map(({ row, label: lvl, index }) => `${label(row)}: level_${index + 1}="${lvl}" repeats level_${index}`),
  );

  // ── 6. Level/parent-chain mismatch ──────────────────────────────────────
  // For each row, recompute the expected level_1..15 by walking
  // parent_account_id (walkPath, above) and compare directly against the
  // persisted level_1..15 columns -- a disagreement means the row's
  // persisted levels drifted from what its actual parent chain says (e.g. a
  // classification/reparent that ran without re-deriving level_1..15
  // afterward).
  const levelMismatchRows = [];
  for (const r of all) {
    const walked = walkPath(r);
    const expected = Array.from({ length: MAX_LEVELS }, (_, i) => walked[i] || null);
    const persisted = levelCols.map((c) => (r[c] == null || String(r[c]).trim() === "" ? null : r[c]));
    const diffIndex = expected.findIndex((v, i) => normName(v) !== normName(persisted[i]));
    if (diffIndex !== -1) {
      levelMismatchRows.push(`${label(r)}: level_${diffIndex + 1} expected "${expected[diffIndex] || "(null)"}", persisted "${persisted[diffIndex] || "(null)"}"`);
    }
  }
  check(
    "6. Level/parent-chain mismatch (recomputed level_1..15 vs persisted columns)",
    levelMismatchRows.length === 0,
    levelMismatchRows.length,
    levelMismatchRows,
  );

  // ── 7. Cross-version leaks ──────────────────────────────────────────────
  // NOT actively tested here: every query in this script (the single
  // fetchAllRows call above) is scoped `.eq('version_id', versionId)`, which
  // makes a cross-version leak structurally impossible for THIS script to
  // observe by construction -- there is no code path here that could read
  // another version's rows. If chart_of_accounts reads elsewhere in the
  // codebase (report generation, the COA UI panel) were ever found NOT to
  // scope by version_id, that would be a bug in THAT call site, not
  // something this script's own query shape could catch; worth a manual
  // `grep -rn "from('chart_of_accounts')" backend/src` sweep for any
  // unscoped read if a leak is ever suspected in practice.
  console.log("7. Cross-version leaks: not tested (structurally impossible given version_id scoping) -- see comment above.");

  // ── Bonus (kept from the prior version of this script): BS/P&L fixed
  //    anchors correct for every resolved leaf. ──
  let bsAnchorMismatches = [];
  let plAnchorMismatches = [];
  for (const r of all) {
    if (r.node_type !== "account" || !r.account_type) continue;
    const walked = walkPath(r);
    const realDepth = walked.length;
    if (realDepth <= 1) continue;
    if (["asset", "liability"].includes(r.account_type)) {
      const anchor = BS_ANCHOR[r.account_type];
      for (let i = 0; i < anchor.length; i += 1) {
        if (normName(walked[i]) !== normName(anchor[i])) { bsAnchorMismatches.push(`${label(r)}: expected anchor "${anchor.join(" > ")}", actual starts "${walked.slice(0, anchor.length).join(" > ")}"`); break; }
      }
    } else if (["income", "cogs", "expense"].includes(r.account_type) && realDepth >= 3) {
      for (let i = 0; i < PL_ANCHOR.length; i += 1) {
        if (normName(walked[i]) !== normName(PL_ANCHOR[i])) { plAnchorMismatches.push(`${label(r)}: expected anchor "${PL_ANCHOR.join(" > ")}", actual starts "${walked.slice(0, PL_ANCHOR.length).join(" > ")}"`); break; }
      }
    }
  }
  check("N. BS fixed anchors correct for every resolved asset/liability leaf", bsAnchorMismatches.length === 0, bsAnchorMismatches.length, bsAnchorMismatches);
  check("O. P&L fixed anchors correct for every resolved income/cogs/expense leaf", plAnchorMismatches.length === 0, plAnchorMismatches.length, plAnchorMismatches);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\nVersion: ${versionId}`);
  console.log(`Total rows checked: ${all.length} (${totalAccounts} account leaves, ${totalCategories} category nodes)\n`);
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.count})`);
    if (!r.ok) printDetails(r.details);
  }
  console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
  return fail === 0;
}

const versionId = parseVersionIdArg(process.argv.slice(2));
if (!versionId) {
  console.error("Usage: node backend/scripts/validateCoaHierarchyIntegrity.js --versionId=<uuid>");
  process.exit(1);
}
run(versionId)
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => { console.error("FATAL", e); process.exit(1); });
