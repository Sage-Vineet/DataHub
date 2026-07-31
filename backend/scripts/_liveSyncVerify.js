require('dotenv').config();
const { supabase } = require('../src/db');
const keyReportService = require('../src/services/keyReports/keyReportService');

(async () => {
  const versionId = '35d8c18b-6a41-42a2-b2a3-9a9b2cc62ac8';
  const companyId = '2a0a2028-6afd-45eb-8b0e-913c823192ac';

  console.log('=== REAL LIVE SYNC (syncVersion) — Davis Signs Utah LLC ===');
  const start = Date.now();
  const result = await keyReportService.syncVersion(versionId, null);
  console.log(`\nsyncVersion completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log('result:', JSON.stringify(result, null, 2).slice(0, 3000));

  const { data: coaRows, error } = await supabase
    .from('chart_of_accounts')
    .select('id, account_name, account_type, node_type, parent_account_id, hierarchy_path, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9, level_10, level_11')
    .eq('version_id', versionId)
    .in('account_type', ['income', 'cogs', 'expense'])
    .order('account_name', { ascending: true });
  if (error) { console.error('COA query failed:', error); process.exit(1); }

  console.log(`\n=== DATABASE PROOF: ${coaRows.length} P&L accounts persisted ===`);
  const REFERENCE_ACCOUNTS = [
    'Sales of Product Income', 'Refunds', 'Unapplied Cash Payment Income',
    'COGS - Contractor', 'COGS - Job Materials Purchased', 'COGS - Job Permits',
    'COGS - Other Job Costs', 'COGS - Shop Supplies', 'COGS - Small Tools & Equip',
    'Advertising & Marketing', 'Auto Repairs & Maintenance', 'Fleet Fuel',
  ];
  for (const name of REFERENCE_ACCOUNTS) {
    const row = coaRows.find((r) => r.account_name === name && r.node_type === 'account');
    if (!row) { console.log(`  MISSING: "${name}"`); continue; }
    console.log(`  "${name}" | hierarchy_path=${row.hierarchy_path}`);
  }

  console.log('\nAll persisted P&L accounts (name | hierarchy_path):');
  for (const r of coaRows) {
    if (r.node_type === 'account') console.log(`  "${r.account_name}" | ${r.hierarchy_path}`);
  }

  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
