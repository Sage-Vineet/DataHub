/**
 * Physical DDL for the activity log (SE-0004).
 *
 * Drizzle has no declarative partitioning, and this table needs three things its
 * schema declaration cannot express:
 *
 *   1. `PARTITION BY RANGE (occurred_at)` with monthly children — the table takes
 *      a row on every request, and retrofitting partitioning to a large table is
 *      a migration nobody wants to run.
 *   2. A **DEFAULT partition**, so an insert for a month with no partition still
 *      lands. Without it, forgetting to roll a partition forward turns into
 *      dropped audit records — the exact failure this capability exists to prevent.
 *   3. A grant model where the application role can INSERT and SELECT but **not**
 *      UPDATE or DELETE (design D4). Immutability enforced by convention is not
 *      immutability; this makes a code defect unable to rewrite history.
 *
 * Retention deletion runs as a separate privileged path that drops whole
 * partitions — never through the application role.
 */

/** Zero-padded `YYYY_MM` partition suffix. */
export function partitionSuffix(year: number, month: number): string {
  return `${year}_${String(month).padStart(2, "0")}`;
}

/** `[from, to)` bounds for a month, as Postgres date literals. */
export function partitionBounds(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

/** DDL for one monthly partition. Idempotent. */
export function monthlyPartitionDdl(year: number, month: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`month must be 1-12 (got ${month})`);
  }
  const { from, to } = partitionBounds(year, month);
  return `CREATE TABLE IF NOT EXISTS activity_events_${partitionSuffix(year, month)} ` +
    `PARTITION OF activity_events FOR VALUES FROM ('${from}') TO ('${to}');`;
}

/**
 * The partitioned parent, its default partition, the chain head, and the indexes
 * reads will need. Idempotent, so it is safe to run at deploy time.
 */
export function activityTablesDdl(): string {
  return `
CREATE TABLE IF NOT EXISTS activity_events (
  seq bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  correlation_id uuid,
  actor_id text,
  actor_kind text NOT NULL,
  engine text,
  method text,
  raw_path text,
  path text,
  status integer,
  duration_ms integer,
  ip text,
  user_agent text,
  event_type text,
  subject_id text,
  company_id uuid,
  payload jsonb,
  dropped_count integer,
  gap_from timestamptz,
  gap_to timestamptz,
  reason text,
  content_hash text NOT NULL,
  prev_hash text,
  PRIMARY KEY (seq, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Always present: an insert outside every declared month lands here rather than
-- failing. A misfiled record is recoverable; a dropped one is not.
CREATE TABLE IF NOT EXISTS activity_events_default PARTITION OF activity_events DEFAULT;

CREATE TABLE IF NOT EXISTS activity_chain_head (
  id integer PRIMARY KEY,
  last_seq bigint NOT NULL,
  last_hash text
);
INSERT INTO activity_chain_head (id, last_seq, last_hash)
  VALUES (1, 0, NULL) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS activity_events_actor_idx ON activity_events (actor_id, occurred_at);
CREATE INDEX IF NOT EXISTS activity_events_correlation_idx ON activity_events (correlation_id);
CREATE INDEX IF NOT EXISTS activity_events_company_idx ON activity_events (company_id, occurred_at);
`.trim();
}

/**
 * Grants for the application role: INSERT + SELECT, never UPDATE or DELETE
 * (design D4). Applied by an operator with DDL rights, not by the application.
 */
export function activityGrantsDdl(appRole: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(appRole)) {
    throw new Error(`refusing to interpolate an unsafe role name: ${appRole}`);
  }
  return `
REVOKE ALL ON activity_events FROM ${appRole};
REVOKE ALL ON activity_chain_head FROM ${appRole};
GRANT SELECT, INSERT ON activity_events TO ${appRole};
GRANT SELECT, INSERT, UPDATE ON activity_chain_head TO ${appRole};
`.trim();
}

/** Partition DDL for the current month and the next `ahead` months. */
export function upcomingPartitionsDdl(from: Date, ahead = 3): string {
  const out: string[] = [];
  for (let i = 0; i <= ahead; i += 1) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    out.push(monthlyPartitionDdl(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return out.join("\n");
}
