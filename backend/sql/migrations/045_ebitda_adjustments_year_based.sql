ALTER TABLE ebitda_adjustments
  DROP COLUMN IF EXISTS allocation_mode;

ALTER TABLE ebitda_adjustment_values
  DROP COLUMN IF EXISTS allocation_mode;
