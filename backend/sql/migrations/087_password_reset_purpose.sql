-- Migration 087: add purpose column to email_verifications so signup-OTP and
-- password-reset-OTP for the same email cannot collide/be interchangeable.

ALTER TABLE email_verifications
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'email_verification';

CREATE INDEX IF NOT EXISTS idx_email_verifications_email_purpose
  ON email_verifications (email, purpose);
