import type { BrokerActivitySources } from "./feed.js";
import type { ActivityRepository, ActivityScope } from "./ports.js";

const EMPTY: BrokerActivitySources = {
  companies: [],
  buyers: [],
  documents: [],
  requests: [],
  narratives: [],
  activityLog: [],
  requestById: new Map(),
  companyNameById: new Map(),
  userNameById: new Map(),
};

/**
 * A stubbed source set for service tests.
 *
 * The feed's merging rules are tested directly against `buildBrokerFeed`, so
 * this only needs to prove the service asks the right question — which scope it
 * passes, and whether it queries at all.
 */
export class InMemoryActivityRepository implements ActivityRepository {
  /** The scope of the last call, for asserting what the service asked for. */
  lastScope: ActivityScope | null = null;
  lastPerSource: number | null = null;

  constructor(private sources: Partial<BrokerActivitySources> = {}) {}

  seed(sources: Partial<BrokerActivitySources>): void {
    this.sources = sources;
  }

  brokerSources(scope: ActivityScope, perSource: number): Promise<BrokerActivitySources> {
    this.lastScope = scope;
    this.lastPerSource = perSource;
    return Promise.resolve({ ...EMPTY, ...this.sources });
  }
}
