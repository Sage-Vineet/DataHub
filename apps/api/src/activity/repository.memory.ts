import type { ActivityVerification } from "@datahub/contracts";
import { contentHashOf } from "./hash.js";
import { verifyChain } from "./repository.drizzle.js";
import type {
  ActivityRecordInput,
  ActivityRepository,
  ListOptions,
  StoredActivityRecord,
} from "./types.js";

/**
 * In-memory mirror of the append-only repository, for unit tests and for running
 * the gateway without a database. It has the same absence of update/delete as the
 * Drizzle one, so a test cannot demonstrate a mutation path that production lacks.
 *
 * `appendHook` exists so tests can simulate a write-path failure without a real
 * database — the writer's behavior when storage fails is a property worth testing
 * (records must be accounted for as a gap, never silently lost).
 */
export class InMemoryActivityRepository implements ActivityRepository {
  private readonly records: StoredActivityRecord[] = [];
  private lastHash: string | null = null;
  appendHook: (() => void) | null = null;

  async append(records: readonly ActivityRecordInput[]): Promise<StoredActivityRecord[]> {
    this.appendHook?.();
    const stored: StoredActivityRecord[] = [];
    for (const record of records) {
      const seq = this.records.length + 1;
      const contentHash = contentHashOf(record, seq, this.lastHash);
      const entry: StoredActivityRecord = { ...record, seq, contentHash, prevHash: this.lastHash };
      this.records.push(entry);
      stored.push(entry);
      this.lastHash = contentHash;
    }
    return stored;
  }

  async list(options: ListOptions = {}): Promise<StoredActivityRecord[]> {
    const from = options.fromSeq ?? 0;
    return this.records.filter((r) => r.seq >= from).slice(0, options.limit ?? 1000);
  }

  async verify(options: ListOptions = {}): Promise<ActivityVerification> {
    return verifyChain(await this.list({ ...options, limit: 100_000 }), options.fromSeq);
  }

  /** Test affordance: tamper with a stored record the way an attacker with DB access would. */
  tamper(seq: number, mutate: (record: StoredActivityRecord) => void): void {
    const record = this.records.find((r) => r.seq === seq);
    if (record) mutate(record);
  }

  /** Test affordance: remove a record, simulating an out-of-band delete. */
  remove(seq: number): void {
    const index = this.records.findIndex((r) => r.seq === seq);
    if (index >= 0) this.records.splice(index, 1);
  }
}
