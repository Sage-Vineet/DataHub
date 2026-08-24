ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS profit_metric text NOT NULL DEFAULT 'adjusted_ebitda';

UPDATE companies
SET profit_metric = 'adjusted_ebitda'
WHERE profit_metric IS NULL OR btrim(profit_metric) = '';

