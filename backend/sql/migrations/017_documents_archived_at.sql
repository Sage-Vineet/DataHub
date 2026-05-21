-- Migration: Add archived_at column to documents table
-- Purpose: Support document archiving feature

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
