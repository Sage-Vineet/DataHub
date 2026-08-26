import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type {
  GroupMemberRecord,
  GroupRecord,
  GroupsRepository,
} from "./ports.js";

/**
 * The wire shape, which is snake_case.
 *
 * The SPA reads `id`, `name`, `member_count` and `member_ids`
 * (`FileExplorer.jsx:2495-2503`), so those names are a contract, not a
 * preference. Records stay camelCase inside the module and are converted once,
 * here, at the boundary.
 */
export interface GroupResponse {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  created_at: string;
  member_ids: string[];
  member_count: number;
}

export interface GroupMemberResponse {
  group_id: string;
  user_id: string;
  created_at: string;
}

export function toGroupResponse(group: GroupRecord, memberIds: readonly string[]): GroupResponse {
  return {
    id: group.id,
    company_id: group.companyId,
    name: group.name,
    description: group.description,
    created_at: group.createdAt,
    member_ids: [...memberIds],
    member_count: memberIds.length,
  };
}

export function toMemberResponse(member: GroupMemberRecord): GroupMemberResponse {
  return { group_id: member.groupId, user_id: member.userId, created_at: member.createdAt };
}

export interface GroupsServiceDeps {
  repo: GroupsRepository;
}

export class GroupsService {
  private readonly repo: GroupsRepository;

  constructor(deps: GroupsServiceDeps) {
    this.repo = deps.repo;
  }

  /**
   * A group's authorization is its company's authorization, so every
   * group-scoped operation resolves the group first and checks that.
   *
   * Order matters and is deliberate: a caller with no access to the company gets
   * 404 for a group that does not exist, and 403 for one that does — the same
   * order legacy used. Reversing it would let anyone probe for valid group ids.
   */
  private async authorizedGroup(user: SessionUser, groupId: string): Promise<GroupRecord> {
    const group = await this.repo.getById(groupId);
    if (!group) throw new NotFoundError("Not found");
    if (!canAccessCompany(user, group.companyId)) {
      throw new ForbiddenError("You do not have permission to access this company's groups.");
    }
    return group;
  }

  private assertCompanyAccess(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have permission to access this company's groups.");
    }
  }

  /** Groups for a company, newest first, each with its members resolved. */
  async list(user: SessionUser, companyId: string): Promise<GroupResponse[]> {
    this.assertCompanyAccess(user, companyId);

    const groups = await this.repo.listByCompany(companyId);
    if (groups.length === 0) return [];

    // One lookup for every group rather than one per group: this endpoint is on
    // the portal dashboard's first paint, alongside a folder tree walk.
    const members = await this.repo.memberIdsFor(groups.map((g) => g.id));
    return groups.map((g) => toGroupResponse(g, members.get(g.id) ?? []));
  }

  async create(user: SessionUser, companyId: string, input: unknown): Promise<GroupResponse> {
    this.assertCompanyAccess(user, companyId);

    const { name, description } = readGroupBody(input);
    const group = await this.repo.create({ companyId, name, description });
    return toGroupResponse(group, []);
  }

  async update(user: SessionUser, groupId: string, input: unknown): Promise<GroupResponse> {
    await this.authorizedGroup(user, groupId);

    const { name, description } = readGroupBody(input);
    const updated = await this.repo.update(groupId, { name, description });
    // Absent only if it was deleted between the two calls; the answer is still 404.
    if (!updated) throw new NotFoundError("Not found");

    const members = await this.repo.memberIdsFor([groupId]);
    return toGroupResponse(updated, members.get(groupId) ?? []);
  }

  async remove(user: SessionUser, groupId: string): Promise<void> {
    await this.authorizedGroup(user, groupId);
    const removed = await this.repo.remove(groupId);
    if (!removed) throw new NotFoundError("Not found");
  }

  async listMembers(user: SessionUser, groupId: string): Promise<GroupMemberResponse[]> {
    await this.authorizedGroup(user, groupId);
    return (await this.repo.listMembers(groupId)).map(toMemberResponse);
  }

  async addMember(user: SessionUser, groupId: string, input: unknown): Promise<GroupMemberResponse> {
    await this.authorizedGroup(user, groupId);

    const userId = readMemberBody(input);
    return toMemberResponse(await this.repo.addMember(groupId, userId));
  }

  async removeMember(user: SessionUser, groupId: string, userId: string): Promise<void> {
    await this.authorizedGroup(user, groupId);
    const removed = await this.repo.removeMember(groupId, userId);
    if (!removed) throw new NotFoundError("Not found");
  }
}

/** `{ name, description }`, with legacy's validation: a name is required. */
function readGroupBody(input: unknown): { name: string; description: string | null } {
  const body = (input ?? {}) as { name?: unknown; description?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") throw new BadRequestError("name required");

  // Empty string collapses to null, matching legacy's `description || null`, so
  // "cleared" and "never set" are one state rather than two.
  const description =
    typeof body.description === "string" && body.description.trim() !== ""
      ? body.description
      : null;

  return { name, description };
}

/** `{ user_id }` — the wire name, kept because the SPA and legacy both use it. */
function readMemberBody(input: unknown): string {
  const body = (input ?? {}) as { user_id?: unknown };
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (userId === "") throw new BadRequestError("user_id required");
  return userId;
}
