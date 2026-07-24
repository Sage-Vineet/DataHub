/**
 * Database Cleanup Script for Disallowed Patterns
 * Run with: node backend/scripts/cleanupDatabaseDisallowedRows.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { supabase } = require('../src/db');

// Pattern checker (must match base implementation exactly)
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
    select: 'id, account_name'
  },
  {
    name: 'balance_sheet_entries',
    fields: ['account_name'],
    select: 'id, account_name'
  },
  {
    name: 'profit_loss_entries',
    fields: ['account_name', 'category', 'sub_category', 'account_type'],
    select: 'id, account_name, category, sub_category, account_type'
  },
  {
    name: 'general_ledger_entries',
    fields: ['account_name', 'account_section'],
    select: 'id, account_name, account_section'
  },
  {
    name: 'tax_return_entries',
    fields: ['field_name', 'field_label'],
    select: 'id, field_name, field_label'
  },
  {
    name: 'bank_statement_entries',
    fields: ['bank_account', 'bank_name', 'description'],
    select: 'id, bank_account, bank_name, description'
  }
];

async function main() {
  console.log('Starting cleanup of database disallowed records...\n');

  for (const target of tablesToCheck) {
    console.log(`Checking table "${target.name}" for cleanup...`);
    try {
      const records = await fetchAllRecords(target.name, target.select);
      const toDelete = [];

      for (const rec of records) {
        let shouldDelete = false;
        for (const field of target.fields) {
          const val = rec[field];
          if (val && matchesFilterPatterns(val)) {
            shouldDelete = true;
            break;
          }
        }
        if (shouldDelete) {
          toDelete.push(rec.id);
        }
      }

      if (toDelete.length > 0) {
        console.log(`  Found ${toDelete.length} invalid entries in "${target.name}". Deleting...`);
        // Delete in chunks of 100 to avoid long URLs or body sizes
        const CHUNK = 100;
        for (let i = 0; i < toDelete.length; i += CHUNK) {
          const chunk = toDelete.slice(i, i + CHUNK);
          const { error } = await supabase
            .from(target.name)
            .delete()
            .in('id', chunk);

          if (error) {
            console.error(`  [ERROR] Failed to delete chunk from "${target.name}":`, error.message);
          }
        }
        console.log(`  Successfully deleted ${toDelete.length} entries from "${target.name}".`);
      } else {
        console.log(`  Table "${target.name}" has no invalid entries.`);
      }
    } catch (err) {
      console.error(`Failed to clean up table "${target.name}":`, err.message);
    }
    console.log('');
  }

  console.log('Cleanup finished.');
}

main().catch(err => {
  console.error('Unhandled error in database cleanup:', err);
  process.exit(1);
});
