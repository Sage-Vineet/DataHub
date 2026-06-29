-- ============================================================================
-- Migration 053: Reseed coa_hierarchy_levels — standardized financial anchors
--
-- Purpose:
--   Replaces the legacy "Total Liabilities and Equity" top-down rollup with the
--   correct ERP-standard hierarchy whose two root nodes are:
--     • "Income Statement"  — for all P&L accounts (income / expense / cogs)
--     • "Balance Sheet"     — for all B/S accounts (asset / liability / equity)
--
--   This matches the coaHierarchyRules.js STANDARD_PREFIX exactly, so the
--   reference taxonomy and the generation engine are always in sync.
--
-- Fixed anchor levels (identical across every company):
--   P&L:  L1 Income Statement → L2 Net Income → L3 Pretax Income →
--         L4 Operating Income → L5 Gross Profit →
--         L6 Total Revenue / Total Expenses → L7 Income / Expenses →
--         L8 expense-group (rule-derived) → L9+ company-specific → base
--   B/S:  L1 Balance Sheet →
--         L2 Total Assets / Total Liabilities / Total Equity →
--         L3 sub-category (rule-derived) → L4 group (rule-derived) →
--         L5+ company-specific → base
--
-- PREREQUISITES: migrations 051 and 052 must already be applied.
-- This migration is idempotent: safe to re-run.
-- ============================================================================

-- Clear all previous standard entries so re-running replaces stale seeds.
DELETE FROM coa_hierarchy_levels WHERE is_standard = true;

INSERT INTO coa_hierarchy_levels
  (level_number, statement_type, parent_label, label, sort_order)
VALUES
  -- ── L1: Statement anchors ──────────────────────────────────────────────────
  (1, 'profit_loss',   NULL, 'Income Statement', 1),
  (1, 'balance_sheet', NULL, 'Balance Sheet',    2),

  -- ── L2: Top-level rollup nodes ─────────────────────────────────────────────
  (2, 'profit_loss',   'Income Statement', 'Net Income',        1),
  (2, 'balance_sheet', 'Balance Sheet',    'Total Assets',      2),
  (2, 'balance_sheet', 'Balance Sheet',    'Total Liabilities', 3),
  (2, 'balance_sheet', 'Balance Sheet',    'Total Equity',      4),

  -- ── L3: P&L rollup ────────────────────────────────────────────────────────
  (3, 'profit_loss',   'Net Income',        'Pretax Income',         1),
  -- B/S asset sub-categories
  (3, 'balance_sheet', 'Total Assets',      'Current Assets',        2),
  (3, 'balance_sheet', 'Total Assets',      'Fixed Assets',          3),
  (3, 'balance_sheet', 'Total Assets',      'Other Assets',          4),
  -- B/S liability sub-categories
  (3, 'balance_sheet', 'Total Liabilities', 'Current Liabilities',   5),
  (3, 'balance_sheet', 'Total Liabilities', 'Long-Term Liabilities', 6),

  -- ── L4 ────────────────────────────────────────────────────────────────────
  (4, 'profit_loss', 'Pretax Income',    'Operating Income', 1),

  -- ── L5 ────────────────────────────────────────────────────────────────────
  (5, 'profit_loss', 'Operating Income', 'Gross Profit',     1),

  -- ── L6 ────────────────────────────────────────────────────────────────────
  (6, 'profit_loss', 'Gross Profit', 'Total Revenue',  1),
  (6, 'profit_loss', 'Gross Profit', 'Total Expenses', 2),

  -- ── L7 ────────────────────────────────────────────────────────────────────
  (7, 'profit_loss', 'Total Revenue',  'Income',   1),
  (7, 'profit_loss', 'Total Expenses', 'Expenses', 2),

  -- ── L8: Standard expense groups (rule-derived, same for every company) ─────
  (8, 'profit_loss', 'Expenses', 'Payroll and Labor',          1),
  (8, 'profit_loss', 'Expenses', 'Cost of Sales',              2),
  (8, 'profit_loss', 'Expenses', 'Occupancy',                  3),
  (8, 'profit_loss', 'Expenses', 'Insurance',                  4),
  (8, 'profit_loss', 'Expenses', 'Sales and Marketing',        5),
  (8, 'profit_loss', 'Expenses', 'General and Administrative', 6),
  (8, 'profit_loss', 'Expenses', 'Vehicle and Travel',         7),
  (8, 'profit_loss', 'Expenses', 'Repairs and Maintenance',    8),
  (8, 'profit_loss', 'Expenses', 'Non-Cash and Below-Line',    9)

ON CONFLICT ON CONSTRAINT uq_coa_hierarchy_levels DO NOTHING;
