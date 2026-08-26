import type { BrokerActivitySources } from "./feed.js";

/**
 * What the caller may see.
 *
 * An admin is unscoped; everyone else is limited to their associated companies.
 * Passed as data rather than as a `SessionUser` so the repository never has to
 * know what a session is.
 */
export interface ActivityScope {
  isAdmin: boolean;
  companyIds: readonly string[];
}

export interface ActivityRepository {
  /**
   * Every source the broker feed merges, already scoped and capped.
   *
   * One method rather than six because the sources are only useful together and
   * the name maps must be resolved against all of them at once — splitting it
   * would mean either six round trips of resolution or a second pass here.
   */
  brokerSources(scope: ActivityScope, perSource: number): Promise<BrokerActivitySources>;
}
