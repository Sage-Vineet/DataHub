-- ============================================================================
-- Migration 068: general_ledger_entries vendor/customer/entity_type
--
-- Purpose (client spec):
--   Ensure the General Ledger stores Vendor, Customer, and Entity Type so
--   these fields can flow through to detailed reports.
--
--   Context: migration 060 dropped vendor_name/transaction_name from this
--   table as part of the raw-export → ledger schema refactor. The extraction
--   service (generalLedgerExtractionService.js) already detects a
--   vendor/customer/payee/entity column from the source file — this
--   migration adds back the columns needed to persist that value instead of
--   discarding it before insert.
--
-- Idempotent: safe to re-run. Hand-apply via the Supabase SQL editor.
-- ============================================================================

ALTER TABLE general_ledger_entries
  ADD COLUMN IF NOT EXISTS vendor      text,
  ADD COLUMN IF NOT EXISTS customer    text,
  ADD COLUMN IF NOT EXISTS entity_type text;   -- 'vendor' | 'customer' | NULL

CREATE INDEX IF NOT EXISTS idx_gl_entries_vendor
  ON general_ledger_entries(version_id, vendor) WHERE vendor IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_entries_customer
  ON general_ledger_entries(version_id, customer) WHERE customer IS NOT NULL;

COMMENT ON COLUMN general_ledger_entries.vendor IS
  'Populated from the source column detected by VENDOR_ALIASES (vendor/payee), or the ambiguous generic NAME_ALIASES fallback, at extraction time.';
COMMENT ON COLUMN general_ledger_entries.customer IS
  'Populated from the source column detected by CUSTOMER_ALIASES at extraction time.';
COMMENT ON COLUMN general_ledger_entries.entity_type IS
  'vendor | customer | NULL — which bucket the name column was classified into.';
