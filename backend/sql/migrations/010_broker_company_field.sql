-- Add broker_company field to users table for broker firm name
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS broker_company text;
