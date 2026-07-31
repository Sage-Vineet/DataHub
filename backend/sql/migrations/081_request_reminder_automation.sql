-- Migration 081: request reminder automation event history and in-app notifications.

ALTER TABLE request_reminders
  ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS delivery_channel text NOT NULL DEFAULT 'email_in_app',
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE request_reminders
  DROP CONSTRAINT IF EXISTS request_reminders_event_type_check;

ALTER TABLE request_reminders
  ADD CONSTRAINT request_reminders_event_type_check
  CHECK (event_type IN ('sent', 'skipped', 'overdue'));

CREATE INDEX IF NOT EXISTS idx_request_reminders_request_event_sent
  ON request_reminders(request_id, event_type, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_reminders_scheduled_for
  ON request_reminders(scheduled_for)
  WHERE scheduled_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_notifications
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Notification',
  ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_read boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
  ON user_notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications(user_id, is_read, created_at DESC);
