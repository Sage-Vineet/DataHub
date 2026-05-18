-- Add project_name field to companies for M&A confidentiality (codename for each deal)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS project_name text;
