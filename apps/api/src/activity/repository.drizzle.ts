import { asc, gte, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { ActivityVerification } from "@datahub/contracts";
import { contentHashOf } from "./hash.js";
import type {
  ActivityRecordInput,
  ActivityRepository,
  ListOptions,
  StoredActivityRecord,
} from "./types.js";

const { activityEvents, activityChainHead } = schema;

interface HeadRow {
  last_seq: number | string;
  last_hash: string | null;
}

type Row = typeof activityEvents.$inferSelect;

function toStored(row: Row): StoredActivityRecord {
  return {
    seq: Number(row.seq),
    kind: row.kind as StoredActivityRecord["kind"],
    occurredAt: row.occurredAt,
    correlationId: row.correlationId,
    actorId: row.actorId,
    actorKind: row.actorKind as StoredActivityRecord["actorKind"],
    engine: row.engine as StoredActivityRecord["engine"],
    method: row.method,
    rawPath: row.rawPath,
    path: row.path,
    status: row.status,
    durationMs: row.durationMs,
    ip: row.ip,
    userAgent: row.userAgent,
    eventType: row.eventType as StoredActivityRecord["eventType"],
    subjectId: row.subjectId,
    companyId: row.companyId,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    droppedCount: row.droppedCount,
    gapFrom: row.gapFrom,
    gapTo: row.gapTo,
    reason: row.reason,
    contentHash: row.contentHash,
    prevHash: row.prevHash,
  };
}

/**
 * Append-only Drizzle repository for the activity log.
 *
 * There is no `update` or `delete` here, and that is the point (design D4): the
 * class cannot mutate history, and the database role the application connects
 * with holds no UPDATE/DELETE grant on the table either, so a defect in some
 * other code path cannot do it on this class's behalf.
 *
 * `append` serializes through a `FOR UPDATE` lock on the single chain-head row.
 * Concurrent writers therefore produce ONE chain instead of forking it into two
 * branches that both look valid in isolation.
 */
export class DrizzleActivityRepository implements ActivityRepository {
  constructor(private readonly db: Db) {}

  async append(records: readonly ActivityRecordInput[]): Promise<StoredActivityRecord[]> {
    if (records.length === 0) return [];

    return this.db.transaction(async (tx) => {
      const head = await tx.execute(
        sql`SELECT last_seq, last_hash FROM activity_chain_head WHERE id = 1 FOR UPDATE`,
      );
      const headRow = (head.rows[0] ?? undefined) as HeadRow | undefined;
      if (!headRow) {
        throw new Error(
          "activity_chain_head row is missing — run activityTablesDdl() before capturing.",
        );
      }

      let seq = Number(headRow.last_seq);
      let prevHash = headRow.last_hash;
      const stored: StoredActivityRecord[] = [];

      for (const record of records) {
        seq += 1;
        const contentHash = contentHashOf(record, seq, prevHash);
        stored.push({ ...record, seq, contentHash, prevHash });
        prevHash = contentHash;
      }

      await tx.insert(activityEvents).values(
        stored.map((r) => ({
          seq: r.seq,
          occurredAt: r.occurredAt,
          kind: r.kind,
          correlationId: r.correlationId,
          actorId: r.actorId,
          actorKind: r.actorKind,
          engine: r.engine,
          method: r.method,
          rawPath: r.rawPath,
          path: r.path,
          status: r.status,
          durationMs: r.durationMs,
          ip: r.ip,
          userAgent: r.userAgent,
          eventType: r.eventType,
          subjectId: r.subjectId,
          companyId: r.companyId,
          payload: r.payload,
          droppedCount: r.droppedCount,
          gapFrom: r.gapFrom,
          gapTo: r.gapTo,
          reason: r.reason,
          contentHash: r.contentHash,
          prevHash: r.prevHash,
        })),
      );

      await tx
        .update(activityChainHead)
        .set({ lastSeq: seq, lastHash: prevHash })
        .where(sql`${activityChainHead.id} = 1`);

      return stored;
    });
  }

  async list(options: ListOptions = {}): Promise<StoredActivityRecord[]> {
    const rows = await this.db
      .select()
      .from(activityEvents)
      .where(gte(activityEvents.seq, options.fromSeq ?? 0))
      .orderBy(asc(activityEvents.seq))
      .limit(options.limit ?? 1000);
    return rows.map(toStored);
  }

  async verify(options: ListOptions = {}): Promise<ActivityVerification> {
    const records = await this.list({ ...options, limit: options.limit ?? 100_000 });
    return verifyChain(records, options.fromSeq);
  }
}

/**
 * Recompute the chain over a range and report the first record where it breaks.
 *
 * When starting mid-chain, the first record's stored `prev_hash` is taken on
 * trust — there is nothing earlier in the range to check it against — so a
 * partial verification proves the range is internally consistent, not that the
 * whole log is. Verifying from seq 1 checks everything.
 */
export function verifyChain(
  records: readonly StoredActivityRecord[],
  fromSeq?: number,
): ActivityVerification {
  let expectedPrev: string | null | undefined =
    fromSeq === undefined || fromSeq <= 1 ? null : undefined;
  let expectedSeq: number | undefined = fromSeq === undefined || fromSeq <= 1 ? 1 : undefined;

  for (const record of records) {
    if (expectedSeq !== undefined && record.seq !== expectedSeq) {
      return {
        ok: false,
        checked: records.length,
        broken_at_seq: record.seq,
        reason: `sequence gap: expected seq ${expectedSeq}, found ${record.seq} — a record was removed`,
      };
    }
    if (expectedPrev !== undefined && record.prevHash !== expectedPrev) {
      return {
        ok: false,
        checked: records.length,
        broken_at_seq: record.seq,
        reason: "prev_hash does not match the preceding record's content hash",
      };
    }
    const recomputed = contentHashOf(record, record.seq, record.prevHash);
    if (recomputed !== record.contentHash) {
      return {
        ok: false,
        checked: records.length,
        broken_at_seq: record.seq,
        reason: "content hash does not match the record — it was altered after it was written",
      };
    }
    expectedPrev = record.contentHash;
    expectedSeq = record.seq + 1;
  }

  return { ok: true, checked: records.length, broken_at_seq: null, reason: null };
}
