import { blankRecord, type ActivityRecordInput, type ActivityRepository } from "./types.js";

export interface ActivityWriterOptions {
  /** Records held in memory before the writer starts shedding. */
  maxBuffer?: number;
  /** Records per append. */
  batchSize?: number;
  /** Background flush cadence. */
  flushIntervalMs?: number;
  /** Where write-path failures are reported. Defaults to stderr. */
  onError?: (error: unknown) => void;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => Date;
}

interface PendingGap {
  from: Date;
  to: Date;
  count: number;
  reason: string;
}

/**
 * Asynchronous, bounded writer for activity records.
 *
 * Two properties matter more than throughput:
 *
 *   1. **It never blocks or fails a request.** `record()` returns immediately and
 *      cannot throw; a storage outage degrades capture, it does not degrade the
 *      product. An audit log that can take the platform down is a liability.
 *   2. **A loss is never silent.** When the buffer overflows or an append fails,
 *      the writer remembers the interval and the count, and writes a gap marker as
 *      soon as storage accepts writes again. A log with a visible hole is evidence;
 *      a log with an invisible one is misleading, which is worse than no log at all
 *      because it is trusted.
 */
export class ActivityWriter {
  private readonly buffer: ActivityRecordInput[] = [];
  private readonly maxBuffer: number;
  private readonly batchSize: number;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private pendingGap: PendingGap | null = null;
  private droppedTotal = 0;
  private closed = false;

  constructor(
    private readonly repo: ActivityRepository,
    options: ActivityWriterOptions = {},
  ) {
    this.maxBuffer = options.maxBuffer ?? 5_000;
    this.batchSize = options.batchSize ?? 200;
    this.now = options.now ?? ((): Date => new Date());
    this.onError =
      options.onError ??
      ((error): void => {
        console.error("[activity] capture write failed:", error);
      });

    const interval = options.flushIntervalMs ?? 1_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, interval);
      // Never hold the process open for the sake of the log.
      this.timer.unref?.();
    }
  }

  /** Queue a record. Never throws, never blocks, never awaits storage. */
  record(input: ActivityRecordInput): void {
    if (this.closed) return;
    if (this.buffer.length >= this.maxBuffer) {
      this.noteDropped(1, input.occurredAt, "capture buffer full");
      return;
    }
    this.buffer.push(input);
  }

  /** Records shed so far, for metrics and for tests. */
  get dropped(): number {
    return this.droppedTotal;
  }

  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Drain the buffer. Flushes serialize: a second call while one is in flight
   * awaits it rather than interleaving two appends, which would fork the chain's
   * ordering even though the repository would still serialize the writes.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return;
    }
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  private async drain(): Promise<void> {
    // The gap marker goes first, so a reader meets the notice of loss before the
    // records that followed it.
    while (this.pendingGap || this.buffer.length > 0) {
      const batch: ActivityRecordInput[] = [];

      if (this.pendingGap) {
        batch.push(this.gapRecord(this.pendingGap));
      }
      const records = this.buffer.splice(0, this.batchSize);
      batch.push(...records);
      if (batch.length === 0) return;

      const gapBeingWritten = this.pendingGap;
      this.pendingGap = null;

      try {
        await this.repo.append(batch);
      } catch (error) {
        this.onError(error);
        // The batch is gone. Account for it — including the gap marker we failed
        // to write — so the next successful flush still reports the loss.
        if (gapBeingWritten) this.pendingGap = gapBeingWritten;
        if (records.length > 0) {
          const first = records[0]?.occurredAt ?? this.now();
          const last = records[records.length - 1]?.occurredAt ?? first;
          this.noteDropped(records.length, first, "append failed", last);
        }
        return;
      }
    }
  }

  private gapRecord(gap: PendingGap): ActivityRecordInput {
    const record = blankRecord("gap", this.now());
    record.gapFrom = gap.from;
    record.gapTo = gap.to;
    record.droppedCount = gap.count;
    record.reason = gap.reason;
    return record;
  }

  private noteDropped(count: number, from: Date, reason: string, to?: Date): void {
    this.droppedTotal += count;
    const end = to ?? from;
    if (!this.pendingGap) {
      this.pendingGap = { from, to: end, count, reason };
      return;
    }
    // Merge consecutive losses into one marker rather than emitting a marker per
    // dropped record — which would itself flood the buffer it is reporting on.
    this.pendingGap.count += count;
    if (from < this.pendingGap.from) this.pendingGap.from = from;
    if (end > this.pendingGap.to) this.pendingGap.to = end;
    if (!this.pendingGap.reason.includes(reason)) {
      this.pendingGap.reason = `${this.pendingGap.reason}; ${reason}`;
    }
  }

  /** Stop the timer and flush what is buffered. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.closed = true;
  }
}
