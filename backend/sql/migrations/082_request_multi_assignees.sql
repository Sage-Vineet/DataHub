CREATE TABLE IF NOT EXISTS request_assignees (
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_request_assignees_user
  ON request_assignees(user_id);

CREATE INDEX IF NOT EXISTS idx_request_assignees_request_created
  ON request_assignees(request_id, created_at);

INSERT INTO request_assignees (request_id, user_id)
SELECT id, assigned_to
FROM requests
WHERE assigned_to IS NOT NULL
ON CONFLICT DO NOTHING;

SELECT pg_notify('pgrst', 'reload schema');
