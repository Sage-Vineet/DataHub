-- Migration: Add unique indexes on folders to prevent duplicate default folder creation
-- Cleans up any pre-existing duplicates first (keeps oldest by created_at).

-- Step 1: Remove duplicate non-root folders (same company + name + parent)
DELETE FROM folders
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY company_id, lower(name), parent_id
        ORDER BY created_at ASC
      ) AS rn
    FROM folders
    WHERE parent_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Remove duplicate root folders (same company + name, parent IS NULL)
DELETE FROM folders
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY company_id, lower(name)
        ORDER BY created_at ASC
      ) AS rn
    FROM folders
    WHERE parent_id IS NULL
  ) ranked
  WHERE rn > 1
);

-- Step 3: Add unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_company_name_parent
  ON folders (company_id, lower(name), parent_id)
  WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_company_name_root
  ON folders (company_id, lower(name))
  WHERE parent_id IS NULL;
