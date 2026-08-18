import { createHash } from "node:crypto";
import type { ActivityRecordInput } from "./types.js";

/**
 * Canonical JSON: object keys sorted at every depth, so two structurally equal
 * values always serialize identically. Without this the hash would depend on
 * property insertion order and a re-serialized record could fail verification
 * despite being unaltered.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A record's hash covers its own content, its sequence number **and the previous
 * record's hash** — that last part is what makes the records a chain rather than
 * a pile: altering or removing any record invalidates every hash after it.
 *
 * Scope, stated plainly: this detects alteration and removal by anyone who cannot
 * rewrite the whole chain. It is not proof against an attacker with full write
 * access to the table, which needs external anchoring (design D5).
 */
export function contentHashOf(
  record: ActivityRecordInput,
  seq: number,
  prevHash: string | null,
): string {
  const canonical = canonicalize({
    seq,
    prev_hash: prevHash,
    kind: record.kind,
    occurred_at: record.occurredAt,
    correlation_id: record.correlationId,
    actor_id: record.actorId,
    actor_kind: record.actorKind,
    engine: record.engine,
    method: record.method,
    raw_path: record.rawPath,
    path: record.path,
    status: record.status,
    duration_ms: record.durationMs,
    ip: record.ip,
    user_agent: record.userAgent,
    event_type: record.eventType,
    subject_id: record.subjectId,
    company_id: record.companyId,
    payload: record.payload,
    dropped_count: record.droppedCount,
    gap_from: record.gapFrom,
    gap_to: record.gapTo,
    reason: record.reason,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
