import { cleared } from "../../shared/optional-field.js";
import bcrypt from "bcryptjs";
import type {
  AssignedCompany,
  SessionUser,
  UserCreate,
  UserResponse,
  UserUpdate,
} from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  computeEffectiveRole,
  isBrokerTeamSubRole,
  type RoleUser,
} from "./roles.js";
import type {
  AuthCachePort,
  EmailerPort,
  NotificationPort,
  UserCreateInput,
  UserRecord,
  UsersRepository,
  UserUpdatePatch,
} from "./ports.js";

export interface UsersServiceDeps {
  repo: UsersRepository;
  emailer: EmailerPort;
  notifications: NotificationPort;
  authCache: AuthCachePort;
}

const BCRYPT_HASH_RE = /^\$2[aby]\$/;

/**
 * A user's companies, out of the map the repository answers with.
 *
 * The port guarantees an entry per id asked about, so this cannot actually
 * miss — but the type says `Map`, which does not. Stated once rather than at
 * each of the eight read sites, where it read as eight separate decisions and
 * no test could reach any of them.
 */
function assignedOf(
  companies: ReadonlyMap<string, AssignedCompany[]>,
  userId: string,
): AssignedCompany[] {
  return companies.get(userId) ?? [];
}

export class UsersService {
  private readonly repo: UsersRepository;
  private readonly emailer: EmailerPort;
  private readonly notifications: NotificationPort;
  private readonly authCache: AuthCachePort;

  constructor(deps: UsersServiceDeps) {
    this.repo = deps.repo;
    this.emailer = deps.emailer;
    this.notifications = deps.notifications;
    this.authCache = deps.authCache;
  }

  /** Tenant-scoped visibility: admins see all; brokers see self + team + shared-company; others see only self. */
  async list(viewer: SessionUser): Promise<UserResponse[]> {
    const records = await this.repo.listAll();
    const companies = await this.repo.assignedCompaniesFor(records.map((r) => r.id));

    if (viewer.role === "admin") {
      return records.map((r) => this.toResponse(r, assignedOf(companies, r.id)));
    }

    if (viewer.role === "broker") {
      const viewerCompanies = this.viewerCompanyIds(viewer);
      const invited = new Set(await this.repo.invitedBrokerIds(viewer.id));
      return records
        .filter((r) => {
          if (r.id === viewer.id) return true;
          if (r.role === "admin") return false;
          if (invited.has(r.id)) return true;
          return this.companyIdsOf(r, assignedOf(companies, r.id)).some((id) => viewerCompanies.has(id));
        })
        .map((r) => this.toResponse(r, assignedOf(companies, r.id), invited.has(r.id)));
    }

    // Clients/users see only themselves.
    return records
      .filter((r) => r.id === viewer.id)
      .map((r) => this.toResponse(r, assignedOf(companies, r.id)));
  }

  async get(viewer: SessionUser, id: string): Promise<UserResponse> {
    const { record, companies } = await this.requireVisible(viewer, id);
    return this.toResponse(record, companies);
  }

  async findByEmail(viewer: SessionUser, email: string): Promise<UserResponse | null> {
    const record = await this.repo.getByEmail(email.trim().toLowerCase());
    if (!record) return null;
    const companies = assignedOf(await this.repo.assignedCompaniesFor([record.id]), record.id);
    if (!this.canView(viewer, record, companies)) throw new ForbiddenError("You cannot view this user.");
    return this.toResponse(record, companies);
  }

  /** Create with role/sub-role gating (parity with the legacy controller). */
  async create(actor: SessionUser, input: UserCreate): Promise<UserResponse> {
    if (actor.role !== "admin" && actor.role !== "broker") {
      throw new ForbiddenError("Only broker or admin accounts can create users.");
    }
    if (actor.role !== "admin") {
      if (input.role === "admin") throw new ForbiddenError("Brokers cannot create admin accounts.");
      if (input.role === "broker" && !isBrokerTeamSubRole(input.sub_role ?? null)) {
        throw new ForbiddenError(
          "Brokers cannot create primary broker accounts. Use a broker team sub-role.",
        );
      }
      this.assertCompaniesInScope(actor, this.requestedCompanyIds(input.company_id, input.company_ids));
    }

    const companyIds = this.requestedCompanyIds(input.company_id, input.company_ids);
    const toInsert: UserCreateInput = {
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      passwordHash: await bcrypt.hash(input.password, 10),
      role: input.role,
      subRole: input.sub_role ?? null,
      designation: input.designation ?? null,
      buyerCompanyName: input.buyer_company_name ?? null,
      parentUserId: input.parent_user_id ?? null,
      companyId: input.company_id ?? companyIds[0] ?? null,
      status: input.status ?? "active",
    };
    const created = await this.repo.create(toInsert);
    if (companyIds.length > 0) await this.repo.addCompanies(created.id, companyIds);

    // Best-effort side effects — never fail the request.
    await this.emailer.sendWelcome(created).catch(() => {});
    await this.notifications.notifyUserCreated(created.id, actor.id).catch(() => {});

    const companies = assignedOf(await this.repo.assignedCompaniesFor([created.id]), created.id);
    return this.toResponse(created, companies);
  }

  /** Guarded update: non-admins are restricted; self password requires the current one. */
  async update(actor: SessionUser, id: string, input: UserUpdate): Promise<UserResponse> {
    const isSelf = actor.id === id;
    const canManage = actor.role === "admin" || actor.role === "broker";
    if (!isSelf && !canManage) {
      throw new ForbiddenError("You can only update your own profile or users in your company.");
    }
    if (input.current_password !== undefined && !isSelf) {
      throw new ForbiddenError("Current password changes can only be made for the signed-in account.");
    }

    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError("User not found.");
    const targetCompanies = assignedOf(await this.repo.assignedCompaniesFor([id]), id);

    if (!isSelf && actor.role !== "admin") {
      const shared = this.companyIdsOf(existing, targetCompanies).some((cid) =>
        this.viewerCompanyIds(actor).has(cid),
      );
      if (!shared) throw new ForbiddenError("You cannot update users outside your company.");
    }
    if (actor.role !== "admin") {
      if (input.role !== undefined && input.role !== "buyer") {
        throw new ForbiddenError("Brokers cannot change account roles.");
      }
      const requested = this.requestedCompanyIds(input.company_id, input.company_ids);
      if (requested.length > 0) this.assertCompaniesInScope(actor, requested);
    }

    const patch: UserUpdatePatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.email !== undefined) patch.email = input.email;
    if (input.phone !== undefined) patch.phone = cleared(input.phone);
    if (input.role !== undefined) patch.role = input.role;
    if (input.status !== undefined) patch.status = input.status;
    if (input.sub_role !== undefined) patch.subRole = cleared(input.sub_role);
    if (input.designation !== undefined) patch.designation = cleared(input.designation);
    if (input.buyer_company_name !== undefined) {
      patch.buyerCompanyName = cleared(input.buyer_company_name);
    }
    if (input.parent_user_id !== undefined) patch.parentUserId = cleared(input.parent_user_id);
    if (input.company_id !== undefined) patch.companyId = cleared(input.company_id);

    if (input.password !== undefined) {
      // Self-service password change verifies the current password first (D6).
      if (isSelf) {
        if (!input.current_password) throw new BadRequestError("Please enter your current password.");
        const ok = await bcrypt.compare(input.current_password, existing.passwordHash).catch(() => false);
        if (!ok) throw new BadRequestError("Current password is incorrect.");
      }
      patch.passwordHash = await bcrypt.hash(input.password, 10);
    }

    const updated = (await this.repo.update(id, patch)) ?? existing;
    this.authCache.invalidate(id); // next /me reflects the change
    const companies = assignedOf(await this.repo.assignedCompaniesFor([id]), id);
    return this.toResponse(updated, companies);
  }

  /** Delete with the replacement-owner invariant (D4). */
  async delete(actor: SessionUser, id: string): Promise<void> {
    const target = await this.repo.getById(id);
    if (!target) throw new NotFoundError("User not found.");
    const targetCompanies = assignedOf(await this.repo.assignedCompaniesFor([id]), id);
    const shares = this.companyIdsOf(target, targetCompanies).some((cid) =>
      this.viewerCompanyIds(actor).has(cid),
    );
    if (actor.role !== "admin" && !(actor.role === "broker" && shares)) {
      throw new ForbiddenError("Only admins or brokers sharing a company can delete users.");
    }

    const replacement = await this.resolveReplacement(actor, target, targetCompanies);
    if (!replacement) {
      throw new BadRequestError(
        "Unable to delete user because no replacement owner is available for their records.",
      );
    }
    await this.repo.reassignAndDelete(target.id, replacement);
  }

  async addCompanies(actor: SessionUser, id: string, companyIds: string[]): Promise<UserResponse> {
    await this.requireVisible(actor, id);
    if (actor.role !== "admin") this.assertCompaniesInScope(actor, companyIds);
    await this.repo.addCompanies(id, companyIds);
    return this.get(actor, id);
  }

  async removeCompanies(actor: SessionUser, id: string, companyIds: string[]): Promise<UserResponse> {
    await this.requireVisible(actor, id);
    if (actor.role !== "admin") this.assertCompaniesInScope(actor, companyIds);
    await this.repo.removeCompanies(id, companyIds);
    return this.get(actor, id);
  }

  async inviteBrokerToTeam(actor: SessionUser, invitedId: string): Promise<void> {
    if (actor.role !== "admin" && actor.role !== "broker") {
      throw new ForbiddenError("Only broker or admin can invite brokers.");
    }
    const invited = await this.repo.getById(invitedId);
    if (!invited) throw new NotFoundError("Invited broker not found.");
    if (invited.role !== "broker" && invited.role !== "admin") {
      throw new BadRequestError("The invited user is not a broker account.");
    }
    await this.repo.inviteBrokerToTeam(actor.id, invitedId);
  }

  async removeBrokerFromTeam(actor: SessionUser, invitedId: string): Promise<void> {
    if (actor.role !== "admin" && actor.role !== "broker") {
      throw new ForbiddenError("Only broker or admin can manage the team.");
    }
    await this.repo.removeBrokerFromTeam(actor.id, invitedId);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async requireVisible(
    viewer: SessionUser,
    id: string,
  ): Promise<{ record: UserRecord; companies: AssignedCompany[] }> {
    const record = await this.repo.getById(id);
    if (!record) throw new NotFoundError("User not found.");
    const companies = assignedOf(await this.repo.assignedCompaniesFor([id]), id);
    if (!this.canView(viewer, record, companies)) {
      throw new ForbiddenError("You do not have permission to view this user.");
    }
    return { record, companies };
  }

  private canView(viewer: SessionUser, target: UserRecord, targetCompanies: AssignedCompany[]): boolean {
    if (viewer.id === target.id) return true;
    if (viewer.role === "admin") return true;
    if (viewer.role !== "broker") return false;
    const viewerCompanies = this.viewerCompanyIds(viewer);
    return this.companyIdsOf(target, targetCompanies).some((cid) => viewerCompanies.has(cid));
  }

  /** Legacy `resolveReplacementUserId`: the actor, else a broker/admin (admin-first) in scope, else global. */
  private async resolveReplacement(
    actor: SessionUser,
    target: UserRecord,
    targetCompanies: AssignedCompany[],
  ): Promise<string | null> {
    if (actor.id && actor.id !== target.id) return actor.id;
    const companyIds = this.companyIdsOf(target, targetCompanies);
    const candidates = await this.repo.replacementCandidates(target.id, companyIds);
    const adminFirst = [...candidates].sort((a, _b) => (a.role === "admin" ? -1 : 1));
    return adminFirst[0]?.id ?? null;
  }

  private viewerCompanyIds(user: SessionUser): Set<string> {
    const ids = new Set<string>(user.company_ids ?? []);
    if (user.company_id) ids.add(user.company_id);
    return ids;
  }

  private companyIdsOf(record: UserRecord, companies: AssignedCompany[]): string[] {
    const ids = new Set<string>(companies.map((c) => c.id));
    if (record.companyId) ids.add(record.companyId);
    return [...ids];
  }

  private requestedCompanyIds(companyId?: string, companyIds?: string[]): string[] {
    const set = new Set<string>(companyIds ?? []);
    if (companyId) set.add(companyId);
    return [...set];
  }

  private assertCompaniesInScope(actor: SessionUser, companyIds: readonly string[]): void {
    const scope = this.viewerCompanyIds(actor);
    if (companyIds.some((id) => !scope.has(id))) {
      throw new ForbiddenError("Cannot assign users to a company outside this broker account.");
    }
  }

  private toResponse(
    record: UserRecord,
    companies: AssignedCompany[],
    isTeamInvite?: boolean,
  ): UserResponse {
    const roleUser: RoleUser = { role: record.role, subRole: record.subRole, email: record.email };
    const companyIds = this.companyIdsOf(record, companies);
    return {
      id: record.id,
      name: record.name,
      email: record.email,
      phone: record.phone,
      role: record.role,
      effective_role: computeEffectiveRole(roleUser, companies),
      sub_role: record.subRole,
      designation: record.designation,
      status: record.status,
      company_id: record.companyId,
      company_ids: companyIds,
      assigned_companies: companies,
      created_at: record.createdAt,
      ...(isTeamInvite !== undefined ? { is_team_invite: isTeamInvite } : {}),
    };
  }
}

/** Exported for reuse/testing — whether a stored hash is bcrypt (parity guard). */
export function isBcryptHash(hash: string): boolean {
  return BCRYPT_HASH_RE.test(hash);
}
