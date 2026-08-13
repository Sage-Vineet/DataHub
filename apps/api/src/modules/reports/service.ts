import type {
  ReportVersionCreate,
  ReportVersionResponse,
  ReportVersionUpdate,
  SessionUser,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { ReportSyncPort, ReportsRepository, VersionRecord } from "./ports.js";

export interface ReportsServiceDeps {
  repo: ReportsRepository;
  sync: ReportSyncPort;
}

export class ReportsService {
  private readonly repo: ReportsRepository;
  private readonly syncPort: ReportSyncPort;
  constructor(deps: ReportsServiceDeps) {
    this.repo = deps.repo;
    this.syncPort = deps.sync;
  }

  async list(user: SessionUser, companyId: string): Promise<ReportVersionResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listByCompany(companyId)).map(toResponse);
  }

  async get(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    return toResponse(await this.requireAccessible(user, id));
  }

  async create(user: SessionUser, input: ReportVersionCreate): Promise<ReportVersionResponse> {
    this.requireCompany(user, input.company_id);
    return toResponse(
      await this.repo.create({
        companyId: input.company_id,
        versionName: input.version_name ?? null,
        metadata: input.metadata ?? {},
        createdBy: user.id,
      }),
    );
  }

  async update(user: SessionUser, id: string, input: ReportVersionUpdate): Promise<ReportVersionResponse> {
    await this.requireAccessible(user, id);
    const updated = await this.repo.update(id, {
      versionName: input.version_name,
      status: input.status,
      metadata: input.metadata,
    });
    return toResponse(updated!);
  }

  async duplicate(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    await this.requireAccessible(user, id);
    return toResponse((await this.repo.duplicate(id, user.id))!);
  }

  async activate(user: SessionUser, id: string): Promise<ReportVersionResponse> {
    await this.requireAccessible(user, id);
    return toResponse((await this.repo.activate(id))!);
  }

  async delete(user: SessionUser, id: string): Promise<void> {
    await this.requireAccessible(user, id);
    await this.repo.delete(id);
  }

  /** The GL sync is not yet migrated — the port reports it's on the legacy engine (D5). */
  async sync(user: SessionUser, id: string): Promise<never> {
    await this.requireAccessible(user, id);
    return this.syncPort.sync(id);
  }

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("You do not have access to this company's reports.");
  }
  private async requireAccessible(user: SessionUser, id: string): Promise<VersionRecord> {
    const record = await this.repo.getById(id);
    if (!record) throw new NotFoundError("Report version not found.");
    if (!canAccessCompany(user, record.companyId)) throw new ForbiddenError("You do not have access to this report version.");
    return record;
  }
}

export function toResponse(r: VersionRecord): ReportVersionResponse {
  return {
    id: r.id,
    company_id: r.companyId,
    version_number: r.versionNumber,
    version_name: r.versionName,
    status: r.status,
    is_active: r.isActive,
    resolved_batch_id: r.resolvedBatchId,
    last_synced_at: r.lastSyncedAt,
    metadata: r.metadata,
    created_by: r.createdBy,
  };
}
