import type {
  CompanyCreate,
  CompanyResponse,
  CompanyUpdate,
  ProfitMetric,
  SessionUser,
} from "@datahub/contracts";
import { normalizeProfitMetric } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type {
  CompaniesRepository,
  CompanyCreateInput,
  CompanyRecord,
  CompanyStats,
  CompanyStatsPort,
  CompanyUpdatePatch,
  FolderProvisioningPort,
  UserProvisioningPort,
} from "./ports.js";

export interface CompaniesServiceDeps {
  repo: CompaniesRepository;
  stats: CompanyStatsPort;
  folders: FolderProvisioningPort;
  users: UserProvisioningPort;
}

const EMPTY_STATS: CompanyStats = { total: 0, pending: 0, completed: 0 };

export class CompaniesService {
  private readonly repo: CompaniesRepository;
  private readonly stats: CompanyStatsPort;
  private readonly folders: FolderProvisioningPort;
  private readonly users: UserProvisioningPort;

  constructor(deps: CompaniesServiceDeps) {
    this.repo = deps.repo;
    this.stats = deps.stats;
    this.folders = deps.folders;
    this.users = deps.users;
  }

  /** Tenant-scoped list: admins see all; everyone else only their companies. */
  async list(user: SessionUser): Promise<CompanyResponse[]> {
    let records: CompanyRecord[];
    if (user.role === "admin") {
      records = await this.repo.listAll();
    } else {
      const ids = this.accessibleCompanyIds(user);
      if (ids.length === 0) return [];
      records = await this.repo.listByIds(ids);
    }
    return this.withStats(records);
  }

  /** Read one company the caller may access, with stats. */
  async get(user: SessionUser, id: string): Promise<CompanyResponse> {
    const record = await this.requireAccessible(user, id);
    return this.oneWithStats(record);
  }

  /** Create a company (broker/admin only), normalize, then run side effects. */
  async create(user: SessionUser, input: CompanyCreate): Promise<CompanyResponse> {
    if (user.role !== "admin" && user.role !== "broker") {
      throw new ForbiddenError("Only brokers and admins can create companies.");
    }
    const toInsert: CompanyCreateInput = {
      name: input.name,
      projectName: input.project_name ?? null,
      industry: input.industry ?? null,
      status: input.status ?? "active",
      since: input.since ?? null,
      logo: input.logo ?? null,
      contactName: input.contact_name ?? null,
      contactEmail: input.contact_email ?? null,
      contactPhone: input.contact_phone ?? null,
      profitMetric: input.profit_metric ?? "adjusted_ebitda",
    };
    const company = await this.repo.create(toInsert);

    // Post-create side effects (parity): associate the creator, provision default
    // folders, and sync the client representative when a contact email is present.
    await this.repo.linkUserCompany(user.id, company.id);
    await this.folders.ensureDefaultFolders(company.id, user.id);
    if (company.contactEmail && company.contactName) {
      await this.users.syncClientRepresentative(company);
    }
    return this.oneWithStats(company);
  }

  /** Update safe fields only; re-sync the rep when the contact email changes. */
  async update(user: SessionUser, id: string, input: CompanyUpdate): Promise<CompanyResponse> {
    const existing = await this.requireAccessible(user, id);

    const patch: CompanyUpdatePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.project_name !== undefined) patch.projectName = input.project_name ?? null;
    if (input.industry !== undefined) patch.industry = input.industry ?? null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.since !== undefined) patch.since = input.since ?? null;
    if (input.logo !== undefined) patch.logo = input.logo ?? null;
    if (input.contact_name !== undefined) patch.contactName = input.contact_name ?? null;
    if (input.contact_email !== undefined) patch.contactEmail = input.contact_email ?? null;
    if (input.contact_phone !== undefined) patch.contactPhone = input.contact_phone ?? null;
    if (input.profit_metric !== undefined) {
      patch.profitMetric = normalizeProfitMetric(input.profit_metric) as ProfitMetric;
    }

    const updated = (await this.repo.updateSafeFields(id, patch)) ?? existing;

    const emailChanged =
      input.contact_email !== undefined && (input.contact_email ?? null) !== existing.contactEmail;
    if (emailChanged && updated.contactEmail && updated.contactName) {
      await this.users.syncClientRepresentative(updated, { contactEmail: existing.contactEmail });
    }
    return this.oneWithStats(updated);
  }

  /** Delete a company (with access) and everything scoped to it, atomically. */
  async delete(user: SessionUser, id: string): Promise<void> {
    await this.requireAccessible(user, id);
    await this.repo.cascadeDelete(id);
  }

  /**
   * Fetch a company and enforce the access rule with legacy-parity status codes:
   * 404 if it doesn't exist, 403 if it exists but the caller can't access it.
   */
  private async requireAccessible(user: SessionUser, id: string): Promise<CompanyRecord> {
    const record = await this.repo.getById(id);
    if (!record) throw new NotFoundError("Company not found.");
    if (!canAccessCompany(user, record.id)) {
      throw new ForbiddenError("You do not have permission to access this company.");
    }
    return record;
  }

  /** Companies a non-admin user is associated with (primary + memberships). */
  private accessibleCompanyIds(user: SessionUser): string[] {
    const ids = new Set<string>(user.company_ids ?? []);
    if (user.company_id) ids.add(user.company_id);
    return [...ids];
  }

  private async withStats(records: CompanyRecord[]): Promise<CompanyResponse[]> {
    if (records.length === 0) return [];
    const counts = await this.stats.countsFor(records.map((r) => r.id));
    return records.map((r) => toCompanyResponse(r, counts.get(r.id) ?? EMPTY_STATS));
  }

  private async oneWithStats(record: CompanyRecord): Promise<CompanyResponse> {
    return (await this.withStats([record]))[0]!;
  }
}

/** Project a company record + its stats onto the wire response shape. */
export function toCompanyResponse(r: CompanyRecord, stats: CompanyStats): CompanyResponse {
  return {
    id: r.id,
    name: r.name,
    project_name: r.projectName,
    industry: r.industry,
    status: r.status,
    since: r.since,
    logo: r.logo,
    contact_name: r.contactName,
    contact_email: r.contactEmail,
    contact_phone: r.contactPhone,
    profit_metric: r.profitMetric,
    data_source_type: r.dataSourceType,
    quickbooks_connected: r.quickbooksConnected,
    manual_upload_active: r.manualUploadActive,
    request_count: stats.total,
    pending_request_count: stats.pending,
    completed_request_count: stats.completed,
  };
}
