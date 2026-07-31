/**
 * COA Tree Dump — before/after regression harness for the tree-first
 * hierarchy refactor (and any future COA-generation change).
 *
 * Dumps every row's id/account_name/parent_account_id/node_type/level_1..15/
 * hierarchy_path for a version, sorted deterministically, to a JSON file —
 * so two runs (before/after a code change) can be diffed byte-for-byte.
 *
 * Usage: node scripts/dumpCoaTree.js <versionId> <outFile>
 */
require("dotenv").config();
const fs = require("fs");
const { supabase } = require("../src/db");

const MAX_LEVELS = 15;

async function dumpCoaTree(versionId) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  const cols = ["id", "account_name", "account_number", "parent_account_id", "node_type",
    "account_type", "statement_type", "normal_balance", "cf_category",
    "hierarchy_path", "base_account", "metadata", ...levelCols].join(", ");
  const { data, error } = await supabase.from("chart_of_accounts").select(cols).eq("version_id", versionId);
  if (error) throw error;
  const rows = (data || [])
    .map((r) => ({
      id: r.id,
      account_name: r.account_name,
      account_number: r.account_number,
      parent_account_id: r.parent_account_id,
      node_type: r.node_type,
      account_type: r.account_type,
      statement_type: r.statement_type,
      normal_balance: r.normal_balance,
      cf_category: r.cf_category,
      is_group: !!r.metadata?.is_group,
      base_account: r.base_account,
      hierarchy_path: r.hierarchy_path,
      levels: levelCols.map((c) => r[c] || null),
    }))
    .sort((a, b) => (a.hierarchy_path || "").localeCompare(b.hierarchy_path || "") || a.account_name.localeCompare(b.account_name));
  return rows;
}

if (require.main === module) {
  const [versionId, outFile] = process.argv.slice(2);
  if (!versionId || !outFile) {
    console.error("Usage: node scripts/dumpCoaTree.js <versionId> <outFile>");
    process.exit(1);
  }
  dumpCoaTree(versionId)
    .then((rows) => {
      fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
      console.log(`Dumped ${rows.length} rows for version ${versionId} -> ${outFile}`);
      process.exit(0);
    })
    .catch((e) => { console.error("FAILED", e); process.exit(1); });
}

module.exports = { dumpCoaTree };
