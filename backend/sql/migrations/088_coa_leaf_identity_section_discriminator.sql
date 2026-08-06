-- 088 — Chart of Accounts leaf identity: include the section discriminator.
--
-- CONFIRMED ROOT CAUSE (fixed here): migration 062 defined a leaf's identity as
--   (version_id, account_number, account_name)
-- i.e. the NAME ALONE when, as is normal for a QuickBooks-style export, no
-- account numbers are present. That is the same name-only identity that was
-- fixed in the application layer (accountKey / addLeaf's pickBucketTarget), and
-- with the code now correctly forking, this index became the last thing
-- re-merging the two rows — it rejected the second one outright:
--
--   duplicate key value violates unique constraint "uq_chart_of_accounts_leaf_identity"
--
-- WHY TWO ROWS ARE LEGITIMATE
-- One uploaded P&L genuinely lists "Business Process Outsourcing" twice — under
-- Income (100,800.00) and under Cost of goods sold (59,400.00). They are two
-- different accounts that share a leaf name, and the General Ledger prints them
-- as two separate blocks. Collapsing them into one `income` account counted
-- 59,400.00 of cost of goods as revenue, leaving the accounting equation out by
-- exactly 118,800.00 (the amount is missing from expenses AND added to income)
-- in two of three fiscal years.
--
-- WHAT CHANGES
-- `metadata->>'section_discriminator'` joins the identity. It is written ONLY on
-- a leaf the application deliberately forked, and holds the DOCUMENT's own
-- section type for that row — stable across regenerations, unlike account_type,
-- which a reclassification or a user edit can legitimately change.
--
-- Because coalesce(..., '') is used, every existing row — none of which carries
-- a discriminator — keeps a byte-identical identity. This migration therefore
-- cannot introduce a duplicate that 062 would have caught, and it needs no
-- dedupe pre-step: it only ever ADMITS rows the old index wrongly rejected.
--
-- Safe to re-run.

BEGIN;

DROP INDEX IF EXISTS uq_chart_of_accounts_leaf_identity;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chart_of_accounts_leaf_identity
  ON chart_of_accounts (
    version_id,
    lower(trim(coalesce(account_number, ''))),
    lower(trim(account_name)),
    lower(trim(coalesce(metadata->>'section_discriminator', '')))
  )
  WHERE coalesce(metadata->>'is_group', 'false') <> 'true';

COMMENT ON INDEX uq_chart_of_accounts_leaf_identity IS
  'One normalized leaf account per version, including accounts with blank/NULL '
  'account numbers. The section discriminator is part of the identity so that '
  'two accounts the source document places in sections of different types may '
  'share a name (e.g. a service line billed as revenue and also incurred as '
  'cost of goods); it is empty for every ordinary account.';

COMMIT;
