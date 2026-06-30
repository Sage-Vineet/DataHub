-- Consolidate exact duplicate COA leaves created while NULL account numbers were
-- treated as distinct by the original UNIQUE constraint. Group/category rows are
-- intentionally excluded because their identity is hierarchy-path based.

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY version_id,
        lower(trim(coalesce(account_number, ''))),
        lower(trim(account_name))
      ORDER BY
        CASE WHEN coalesce((metadata->>'user_modified')::boolean, false) THEN 0 ELSE 1 END,
        created_at,
        id
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY version_id,
        lower(trim(coalesce(account_number, ''))),
        lower(trim(account_name))
      ORDER BY
        CASE WHEN coalesce((metadata->>'user_modified')::boolean, false) THEN 0 ELSE 1 END,
        created_at,
        id
    ) AS duplicate_rank
  FROM chart_of_accounts
  WHERE coalesce(metadata->>'is_group', 'false') <> 'true'
), duplicate_links AS (
  SELECT id AS duplicate_id, keeper_id
  FROM ranked
  WHERE duplicate_rank > 1
)
UPDATE general_ledger_entries gl
SET coa_id = d.keeper_id
FROM duplicate_links d
WHERE gl.coa_id = d.duplicate_id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY version_id,
        lower(trim(coalesce(account_number, ''))),
        lower(trim(account_name))
      ORDER BY
        CASE WHEN coalesce((metadata->>'user_modified')::boolean, false) THEN 0 ELSE 1 END,
        created_at,
        id
    ) AS duplicate_rank
  FROM chart_of_accounts
  WHERE coalesce(metadata->>'is_group', 'false') <> 'true'
)
DELETE FROM chart_of_accounts coa
USING ranked r
WHERE coa.id = r.id
  AND r.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chart_of_accounts_leaf_identity
  ON chart_of_accounts (
    version_id,
    lower(trim(coalesce(account_number, ''))),
    lower(trim(account_name))
  )
  WHERE coalesce(metadata->>'is_group', 'false') <> 'true';

COMMENT ON INDEX uq_chart_of_accounts_leaf_identity IS
  'One normalized leaf account per version, including accounts with blank/NULL account numbers.';
