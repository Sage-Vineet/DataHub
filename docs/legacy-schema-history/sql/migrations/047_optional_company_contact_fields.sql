ALTER TABLE companies
  ALTER COLUMN contact_name DROP NOT NULL,
  ALTER COLUMN contact_email DROP NOT NULL,
  ALTER COLUMN contact_phone DROP NOT NULL;
