import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { DatasetVersionRecord, DatasetsRepository } from "./ports.js";

export interface DatasetsServiceDeps {
  repo: DatasetsRepository;
}

export class DatasetsService {
  constructor(private readonly deps: DatasetsServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  async list(
    user: SessionUser,
    companyId: string,
    filter: { sourceKey?: string; limit?: number } = {},
  ): Promise<DatasetVersionRecord[]> {
    this.requireCompany(user, companyId);
    const limit = Number.isFinite(filter.limit)
      ? Math.min(Math.max(Math.trunc(filter.limit as number), 1), 200)
      : 50;
    return this.deps.repo.list(companyId, {
      ...(filter.sourceKey ? { sourceKey: filter.sourceKey } : {}),
      limit,
    });
  }

  /**
   * Switch which import the reports read.
   *
   * The version stood down is marked `rolled_back` — "this was current and was
   * replaced", which is a different fact from "this was never activated" and
   * the only way to read the list and understand what happened.
   */
  async activate(
    user: SessionUser,
    companyId: string,
    id: string,
  ): Promise<DatasetVersionRecord> {
    this.requireCompany(user, companyId);
    const target = await this.requireVersion(companyId, id);

    if (target.isActive) return target;
    if (target.status !== "finalized") {
      throw new BadRequestError(
        `Version ${target.versionNumber} is ${target.status}, not finalized. ` +
          `Activating it would point every report at data that is not finished being written.`,
      );
    }

    const activated = await this.deps.repo.activate(companyId, id, true);
    if (!activated) throw new NotFoundError("That dataset version could not be activated.");
    return activated;
  }

  /**
   * Go back to an earlier import.
   *
   * Mechanically the same as activating it — the distinction is what the user
   * meant, and refusing to roll forward under the name "rollback" is what keeps
   * the two honest. Rolling back to a failed version is refused outright: it
   * was abandoned part-written, and pointing the reports at it would show
   * figures nobody ever signed off.
   */
  async rollback(
    user: SessionUser,
    companyId: string,
    id: string,
  ): Promise<DatasetVersionRecord> {
    this.requireCompany(user, companyId);
    const target = await this.requireVersion(companyId, id);

    if (target.status === "failed") {
      throw new BadRequestError(
        `Version ${target.versionNumber} failed part-way through. ` +
          `Rolling back to it would show figures that were never complete.`,
      );
    }

    const current = await this.deps.repo.active(companyId);
    if (current && target.versionNumber > current.versionNumber) {
      throw new BadRequestError(
        `Version ${target.versionNumber} is newer than the current v${current.versionNumber}. ` +
          `Use activate to move forward.`,
      );
    }

    // A rolled-back version being re-activated returns to `finalized` — it is
    // usable again, and leaving it marked rolled_back would say otherwise.
    if (target.status === "rolled_back") {
      await this.deps.repo.finalize(id, {
        rowCount: target.rowCount,
        fiscalYears: target.fiscalYears,
      });
    }

    const activated = await this.deps.repo.activate(companyId, id, true);
    if (!activated) throw new NotFoundError("That dataset version could not be activated.");
    return activated;
  }

  private async requireVersion(companyId: string, id: string): Promise<DatasetVersionRecord> {
    if (!id) throw new BadRequestError("Missing version id.");
    const version = await this.deps.repo.getById(companyId, id);
    if (!version) throw new NotFoundError("No dataset version found for that id.");
    return version;
  }
}
