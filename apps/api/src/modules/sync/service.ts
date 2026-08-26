import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { STALE_AFTER_MS, toProgress, type SyncProgress } from "./progress.js";
import type { FinishInput, ProgressPatch, SyncRepository, SyncRunRecord } from "./ports.js";

export interface SyncServiceDeps {
  repo: SyncRepository;
}

/**
 * Sync runs — starting one, watching it, and reading what happened.
 *
 * Every read reaps first. A run whose process died would otherwise hold its
 * company's source hostage forever: the partial unique index refuses a second
 * unfinished run, so a corpse means the button never works again. Reaping on
 * read rather than on a timer means it heals the moment somebody looks, with
 * nothing scheduled to go wrong on its own.
 */
export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  private async reap(companyId: string, now: Date): Promise<void> {
    await this.deps.repo.reapStalled(companyId, new Date(now.getTime() - STALE_AFTER_MS));
  }

  async progress(
    user: SessionUser,
    companyId: string,
    filter: { sourceKey?: string } = {},
    now = new Date(),
  ): Promise<SyncProgress> {
    this.requireCompany(user, companyId);
    await this.reap(companyId, now);
    return toProgress(await this.deps.repo.current(companyId, filter), now);
  }

  /** Recent runs, newest first — "did last night's sync finish?" */
  async history(
    user: SessionUser,
    companyId: string,
    limit = 20,
  ): Promise<SyncRunRecord[]> {
    this.requireCompany(user, companyId);
    const capped = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    return this.deps.repo.history(companyId, capped);
  }

  /**
   * Begin a run.
   *
   * A second one for the same source is a 409, not a queue: two syncs of one
   * source race each other into the same tables and the later writer wins by
   * accident of timing. The caller's answer is to watch the first, and the
   * response says which one.
   */
  async start(
    user: SessionUser,
    companyId: string,
    input: { sourceKey: string; kind?: string; totalFiles?: number },
    now = new Date(),
  ): Promise<SyncRunRecord> {
    this.requireCompany(user, companyId);
    if (!input.sourceKey) throw new BadRequestError("Missing sourceKey.");

    await this.reap(companyId, now);

    const existing = await this.deps.repo.current(companyId, { sourceKey: input.sourceKey });
    if (existing && (existing.status === "queued" || existing.status === "running")) {
      throw new HttpError(
        409,
        `A sync of ${input.sourceKey} is already running for this company (run ${existing.id}).`,
      );
    }

    return this.deps.repo.start({
      companyId,
      sourceKey: input.sourceKey,
      kind: input.kind || "documents",
      totalFiles: Number.isFinite(input.totalFiles) ? Number(input.totalFiles) : 0,
      startedBy: user.id,
    });
  }

  /** Report progress against a run. */
  async advance(
    user: SessionUser,
    companyId: string,
    runId: string,
    patch: ProgressPatch,
  ): Promise<void> {
    this.requireCompany(user, companyId);
    const run = await this.requireRun(companyId, runId);
    // Advancing a finished run would resurrect it past its own finish time, and
    // the page would show a completed sync creeping forward.
    if (run.status !== "queued" && run.status !== "running") {
      throw new BadRequestError(`That sync already ${run.status}.`);
    }
    await this.deps.repo.advance(runId, patch);
  }

  async finish(
    user: SessionUser,
    companyId: string,
    runId: string,
    input: FinishInput,
  ): Promise<void> {
    this.requireCompany(user, companyId);
    const run = await this.requireRun(companyId, runId);
    // Finishing twice is not an error worth raising — the second caller wanted
    // it finished and it is — but it must not overwrite the first outcome.
    if (run.status !== "queued" && run.status !== "running") return;
    await this.deps.repo.finish(runId, input);
  }

  private async requireRun(companyId: string, runId: string): Promise<SyncRunRecord> {
    if (!runId) throw new BadRequestError("Missing runId.");
    const run = await this.deps.repo.getById(companyId, runId);
    if (!run) throw new NotFoundError("No sync run found for that id.");
    return run;
  }
}
