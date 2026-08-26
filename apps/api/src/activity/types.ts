import type {
  ActivityEngine,
  ActivityEventType,
  ActivityKind,
  ActivityVerification,
  ActorKind,
} from "@datahub/contracts";

/**
 * One activity record before it enters the chain. All three kinds share this
 * shape — the columns a kind does not use are null — so envelopes, semantic
 * events and gap markers land in one table and therefore one hash chain. A chain
 * per kind would let an entire category be removed without breaking anything.
 */
export interface ActivityRecordInput {
  kind: ActivityKind;
  occurredAt: Date;
  correlationId: string | null;
  actorId: string | null;
  actorKind: ActorKind;
  engine: ActivityEngine | null;
  method: string | null;
  rawPath: string | null;
  path: string | null;
  status: number | null;
  durationMs: number | null;
  ip: string | null;
  userAgent: string | null;
  eventType: ActivityEventType | null;
  subjectId: string | null;
  companyId: string | null;
  payload: Record<string, unknown> | null;
  droppedCount: number | null;
  gapFrom: Date | null;
  gapTo: Date | null;
  reason: string | null;
}

/** A record as stored: its chain position and hashes are assigned at append. */
export interface StoredActivityRecord extends ActivityRecordInput {
  seq: number;
  contentHash: string;
  prevHash: string | null;
}

export interface ListOptions {
  fromSeq?: number;
  limit?: number;
}

/**
 * The storage port. Deliberately has **no update and no delete method** — not as
 * a convention but as an absence, so there is no application path that could
 * mutate history even by mistake (design D4). Retention deletion runs elsewhere,
 * with different privileges, by dropping whole partitions.
 */
export interface ActivityRepository {
  append(records: readonly ActivityRecordInput[]): Promise<StoredActivityRecord[]>;
  list(options?: ListOptions): Promise<StoredActivityRecord[]>;
  verify(options?: ListOptions): Promise<ActivityVerification>;
}

/** Field defaults, so each call site sets only what its kind actually carries. */
export function blankRecord(kind: ActivityKind, occurredAt: Date): ActivityRecordInput {
  return {
    kind,
    occurredAt,
    correlationId: null,
    actorId: null,
    actorKind: "anonymous",
    engine: null,
    method: null,
    rawPath: null,
    path: null,
    status: null,
    durationMs: null,
    ip: null,
    userAgent: null,
    eventType: null,
    subjectId: null,
    companyId: null,
    payload: null,
    droppedCount: null,
    gapFrom: null,
    gapTo: null,
    reason: null,
  };
}
