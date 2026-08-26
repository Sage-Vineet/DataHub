import type { SessionUser } from "@datahub/contracts";
import { ForbiddenError } from "../../shared/errors.js";
import { buildBrokerFeed, clampLimit, PER_SOURCE_LIMIT, type ActivityEvent } from "./feed.js";
import type { ActivityRepository } from "./ports.js";

export interface ActivityServiceDeps {
  repo: ActivityRepository;
}

export class ActivityService {
  private readonly repo: ActivityRepository;

  constructor(deps: ActivityServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * The broker dashboard's activity feed.
   *
   * Broker or admin only. A client or buyer has no business reading a
   * cross-company stream of who uploaded what, so this is a role check rather
   * than a per-company one — and it happens before any query runs.
   */
  async brokerFeed(user: SessionUser, limit: unknown): Promise<ActivityEvent[]> {
    const role = String(user.role ?? "").toLowerCase();
    if (role !== "broker" && role !== "admin") {
      throw new ForbiddenError(
        "Broker or admin access is required to view the broker activity feed.",
      );
    }

    const isAdmin = role === "admin";
    const companyIds = user.company_ids ?? [];
    // A non-admin with no companies has nothing to aggregate; querying six
    // tables with an empty `IN ()` to prove it would be six wasted round trips.
    if (!isAdmin && companyIds.length === 0) return [];

    const sources = await this.repo.brokerSources({ isAdmin, companyIds }, PER_SOURCE_LIMIT);
    return buildBrokerFeed(sources, { isAdmin, limit: clampLimit(limit) });
  }
}
