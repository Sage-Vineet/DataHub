/**
 * Profit & Loss Report Service (REFACTORED)
 *
 * Changed Data Source:
 * OLD: reporting_snapshots (pre-computed)
 * NEW: profit_loss_entries (raw extracted data)
 *
 * This allows:
 * - Row-level detail and drilling
 * - Audit trail of every line item
 * - Custom filtering and analysis
 * - Consistency with source documents
 */

const { supabase } = require('../../db');

/**
 * Get Profit & Loss report for a specific version and year
 */
async function getProfitAndLossReport(versionId, year, options = {}) {
  if (!versionId || !year) {
    throw new Error('versionId and year are required');
  }

  try {
    // Get all P&L entries for this version and year
    const { data: entries, error } = await supabase
      .from('profit_loss_entries')
      .select('*')
      .eq('version_id', versionId)
      .eq('fiscal_year', year)
      .order('sort_order', { ascending: true });

    if (error) throw error;

    // Get COA hierarchy for formatting
    const { data: coaHierarchy } = await supabase
      .from('chart_of_accounts')
      .select('*')
      .eq('version_id', versionId)
      .eq('statement_type', 'profit_loss');

    // Build hierarchy report
    const report = buildPLHierarchy(entries, coaHierarchy);

    return {
      versionId,
      fiscalYear: year,
      reportType: 'profit_loss',
      rowCount: entries?.length || 0,
      hierarchy: report,
      summary: calculatePLSummary(report),
    };
  } catch (error) {
    throw new Error(`Failed to generate P&L report: ${error.message}`);
  }
}

/**
 * Get P&L summary for multiple years (comparative)
 */
async function getProfitAndLossSummary(versionId, years, options = {}) {
  try {
    const summaries = {};

    for (const year of years) {
      const { data: entries, error } = await supabase
        .from('profit_loss_entries')
        .select('*')
        .eq('version_id', versionId)
        .eq('fiscal_year', year)
        .eq('is_total', true);

      if (error) throw error;

      summaries[year] = calculatePLSummary(entries || []);
    }

    return {
      versionId,
      reportType: 'profit_loss_summary',
      years,
      summaries,
    };
  } catch (error) {
    throw new Error(`Failed to generate P&L summary: ${error.message}`);
  }
}

/**
 * Get P&L detail (all line items) for a year
 */
async function getProfitAndLossDetail(versionId, year, options = {}) {
  try {
    const { data: entries, error } = await supabase
      .from('profit_loss_entries')
      .select('*')
      .eq('version_id', versionId)
      .eq('fiscal_year', year)
      .order('sort_order', { ascending: true });

    if (error) throw error;

    return {
      versionId,
      fiscalYear: year,
      reportType: 'profit_loss_detail',
      rows: entries || [],
      rowCount: entries?.length || 0,
    };
  } catch (error) {
    throw new Error(`Failed to generate P&L detail: ${error.message}`);
  }
}

/**
 * Get P&L by month (monthly detail)
 */
async function getProfitAndLossMonthlyDetail(versionId, year, options = {}) {
  try {
    // NOTE: P&L typically doesn't have month granularity in entry table
    // For now, return summary by account type

    const { data: entries, error } = await supabase
      .from('profit_loss_entries')
      .select('account_type, category, amount')
      .eq('version_id', versionId)
      .eq('fiscal_year', year)
      .not('is_total', 'eq', true);

    if (error) throw error;

    // Group by category
    const byCategory = {};
    (entries || []).forEach((entry) => {
      const cat = entry.category || 'Uncategorized';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(entry);
    });

    return {
      versionId,
      fiscalYear: year,
      reportType: 'profit_loss_monthly_detail',
      byCategory,
    };
  } catch (error) {
    throw new Error(`Failed to generate P&L monthly detail: ${error.message}`);
  }
}

/**
 * Utility: Build hierarchical P&L structure
 */
function buildPLHierarchy(entries, coaHierarchy) {
  if (!entries || entries.length === 0) return [];

  // Group by parent account
  const grouped = {};

  entries.forEach((entry) => {
    const parent = entry.parent_account_id || 'root';
    if (!grouped[parent]) grouped[parent] = [];
    grouped[parent].push(entry);
  });

  // Build tree
  const root = grouped['root'] || [];

  return root.map((entry) => ({
    ...entry,
    children: grouped[entry.id] || [],
  }));
}

/**
 * Utility: Calculate P&L summary metrics
 */
function calculatePLSummary(data) {
  if (!Array.isArray(data)) return null;

  let totalRevenue = 0;
  let totalCogs = 0;
  let totalGrossProfit = 0;
  let totalOperatingExpenses = 0;
  let totalNetIncome = 0;

  data.forEach((row) => {
    const amount = row.amount || 0;
    const type = (row.account_type || '').toLowerCase();
    const cat = (row.category || '').toLowerCase();

    if (cat.includes('revenue') || cat.includes('income')) {
      totalRevenue += amount;
    } else if (cat.includes('cogs') || cat.includes('cost of goods')) {
      totalCogs += amount;
    } else if (cat.includes('gross profit')) {
      totalGrossProfit += amount;
    } else if (cat.includes('expense') || cat.includes('operating')) {
      totalOperatingExpenses += amount;
    }
  });

  totalNetIncome = totalRevenue - totalCogs - totalOperatingExpenses;

  return {
    totalRevenue,
    totalCogs,
    totalGrossProfit: totalRevenue - totalCogs,
    totalOperatingExpenses,
    totalNetIncome,
    grossProfitMargin: totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue * 100).toFixed(2) : 0,
    netProfitMargin: totalRevenue > 0 ? (totalNetIncome / totalRevenue * 100).toFixed(2) : 0,
  };
}

/**
 * Utility: Filter entries by account type
 */
function filterByAccountType(entries, accountType) {
  return entries.filter((e) => e.account_type === accountType);
}

/**
 * Utility: Export P&L to CSV
 */
function exportToCSV(entries) {
  if (!entries || entries.length === 0) return '';

  const headers = ['Account Name', 'Account Number', 'Amount', 'Category', 'Type'];
  const rows = entries.map((e) => [
    e.account_name,
    e.account_number || '',
    e.amount,
    e.category || '',
    e.account_type || '',
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(','))
    .join('\n');

  return csv;
}

module.exports = {
  getProfitAndLossReport,
  getProfitAndLossSummary,
  getProfitAndLossDetail,
  getProfitAndLossMonthlyDetail,
  exportToCSV,
};
