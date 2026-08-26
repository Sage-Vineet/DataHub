import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { TaxOverride, TaxOverrideInput, TaxOverridesRepository } from "./ports.js";

export interface TaxOverridesServiceDeps {
  repo: TaxOverridesRepository;
}

/**
 * How many corrections one company may hold.
 *
 * The page sends the whole map on every edit, so a runaway client would grow
 * the payload without bound and each save would rewrite every row. Twenty
 * years of a Schedule K's worth of lines is nowhere near this; a request that
 * exceeds it is a bug somewhere, and refusing it plainly beats writing tens of
 * thousands of rows in one transaction.
 */
const MAX_OVERRIDES = 5_000;

export class TaxOverridesService {
  constructor(private readonly deps: TaxOverridesServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  async list(user: SessionUser, companyId: string): Promise<TaxOverride[]> {
    this.requireCompany(user, companyId);
    return this.deps.repo.list(companyId);
  }

  /**
   * Make the company's corrections exactly these.
   *
   * A replace, not a merge: the page sends the whole map, and a merge could
   * never delete — a line somebody removed on screen would come back on the
   * next load, and removing it again would not help.
   */
  async replaceAll(
    user: SessionUser,
    companyId: string,
    overrides: readonly TaxOverrideInput[],
  ): Promise<TaxOverride[]> {
    this.requireCompany(user, companyId);
    if (overrides.length > MAX_OVERRIDES) {
      throw new BadRequestError(
        `Too many overrides: ${overrides.length}. At most ${MAX_OVERRIDES} can be saved at once.`,
      );
    }

    // The page can send the same cell twice — a label edited into one that
    // already exists produces two entries under one key. Last wins, which is
    // what somebody looking at the screen would expect, and the alternative is
    // a unique violation the page cannot explain.
    const byCell = new Map<string, TaxOverrideInput>();
    for (const override of overrides) {
      byCell.set(`${override.fiscalYear} ${override.lineLabel}`, override);
    }

    return this.deps.repo.replaceAll(companyId, [...byCell.values()], user.id);
  }
}
