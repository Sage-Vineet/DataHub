-- Migration 040: email_verifications table for OTP-based email verification
-- Run this in your Supabase SQL editor before using the OTP registration flow.

CREATE TABLE IF NOT EXISTS email_verifications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text        NOT NULL,
  otp_hash     text        NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  resend_count integer     NOT NULL DEFAULT 0,
  verified     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  verified_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_email
  ON email_verifications (email);

CREATE INDEX IF NOT EXISTS idx_email_verifications_expires
  ON email_verifications (expires_at);

-- Automatically purge verified/expired rows older than 24 hours (optional, run as a scheduled job)
-- DELETE FROM email_verifications WHERE created_at < now() - INTERVAL '24 hours';
