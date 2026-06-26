/**
 * Database Validation Script for Key Reports Document Extraction Filtering Layer
 * Run with: node backend/scripts/validateDatabaseFiltering.js
 */

const path = require('path');
// Load environment variables with service role key
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { supabase } = require('../src/db');

// Filtering patterns matching logic (must match the implementation exactly)
const matchesFilterPatterns = (val) => {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  const lowerStr = str.toLowerCase();
  
  // Normalize multiple spaces to single spaces
  const normalizedStr = lowerStr.replace(/\s+/g, ' ');

  // Headers
  if (normalizedStr.startsWith('accrual basis')) {
    return 'Accrual Basis* pattern';
  }
  if (normalizedStr.startsWith('cash basis')) {
    return 'Cash Basis* pattern';
  }
  if (normalizedStr.startsWith('report generated')) {
    return 'Report Generated* pattern';
  }
  if (normalizedStr.startsWith('generated on')) {
    return 'Generated On* pattern';
  }

  // Totals
  if (normalizedStr.startsWith('total for ')) {
    return 'Total for * pattern';
  }
  
  const exactTotals = [
    'total assets',
    'total liabilities',
    'total equity',
    'total income',
    'total expenses'
  ];
  if (exactTotals.includes(normalizedStr)) {
    return `Exact total pattern: "${str}"`;
  }

  // Section Headers
  const exactSectionHeaders = [
    'assets',
    'current assets',
    'other current assets',
    'fixed assets',
    'liabilities',
    'current liabilities',
    'long-term liabilities',
    'long term liabilities',
    'equity',
    'income',
    'expenses'
  ];
  if (exactSectionHeaders.includes(normalizedStr)) {
    return `Exact section header pattern: "${str}"`;
  }

  return null;
};

// Paginate and fetch all records from a table
async function fetchAllRecords(table, selectFields) {
  const out = [];
  let from = 0;
  const PAGE_SIZE = 1000;

  for (let page = 0; page < 1000; page++) {
    const { data, error } = await supabase
      .from(table)
      .select(selectFields)
      .range(from, from + PAGE_SIZE - 1)
      .order('id', { ascending: true });

    if (error) {
      console.error(`Error fetching from ${table}:`, error.message);
      throw error;
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

const tablesToCheck = [
  {
    name: 'chart_of_accounts',
    fields: ['account_name'],
    select: 'id, account_name, version_id, metadata',
    // Skip group (parent) nodes — they are intentional hierarchy nodes created by
    // chartOfAccountsService.js with account_name = 'Assets', 'Liabilities', etc.
    // Only leaf accounts (is_group: false) should be validated.
    skipRow: (rec) => rec.metadata && rec.metadata.is_group === true,
  },
  {
    name: 'balance_sheet_entries',
    fields: ['account_name'],
    select: 'id, account_name, version_id, source_file_id'
  },
  {
    name: 'profit_loss_entries',
    fields: ['account_name', 'category', 'sub_category', 'account_type'],
    select: 'id, account_name, category, sub_category, account_type, version_id, source_file_id'
  },
  {
    name: 'general_ledger_entries',
    fields: ['distribution_account', 'account_section'],
    select: 'id, distribution_account, account_section, version_id, source_file_id'
  },
  {
    name: 'tax_return_entries',
    fields: ['field_name', 'field_label'],
    select: 'id, field_name, field_label, version_id, source_file_id'
  },
  {
    name: 'bank_statement_entries',
    fields: ['bank_account', 'bank_name', 'description'],
    select: 'id, bank_account, bank_name, description, version_id, source_file_id'
  }
];

async function main() {
  console.log('Starting database validation for disallowed patterns...\n');
  let invalidCount = 0;

  for (const target of tablesToCheck) {
    console.log(`Checking table "${target.name}"...`);
    try {
      const records = await fetchAllRecords(target.name, target.select);
      console.log(`Retrieved ${records.length} records from "${target.name}".`);

      let tableInvalidCount = 0;
      for (const rec of records) {
        // Skip intentionally-excluded rows (e.g. COA group/parent nodes)
        if (target.skipRow && target.skipRow(rec)) continue;

        for (const field of target.fields) {
          const val = rec[field];
          if (val) {
            const matchedPattern = matchesFilterPatterns(val);
            if (matchedPattern) {
              console.error(`  [INVALID ENTRY FOUND] Table: ${target.name} | ID: ${rec.id} | Field: "${field}" | Value: "${val}" | Matched: ${matchedPattern}`);
              tableInvalidCount++;
              invalidCount++;
            }
          }
        }
      }

      if (tableInvalidCount === 0) {
        console.log(`✅ Table "${target.name}" is clean.`);
      } else {
        console.log(`❌ Table "${target.name}" has ${tableInvalidCount} invalid entries.`);
      }
    } catch (err) {
      console.error(`Failed to validate table "${target.name}":`, err.message);
    }
    console.log('');
  }

  console.log(`Validation complete. Total invalid entries found: ${invalidCount}`);
  if (invalidCount > 0) {
    console.error('❌ Database contains disallowed records. Filtering layer validation failed.');
    process.exit(1);
  } else {
    console.log('✅ Database is fully clean! No disallowed records exist.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Unhandled error in database validation:', err);
  process.exit(1);
});
