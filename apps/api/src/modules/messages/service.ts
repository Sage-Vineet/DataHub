import type {
  DirectContactsResponse,
  GroupCreate,
  GroupMessageResponse,
  GroupResponse,
  MessageResponse,
  SessionUser,
  UnreadCountResponse,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type {
  GroupMessageRecord,
  GroupRecord,
  MessageRecord,
  MessagesRepository,
} from "./ports.js";

export interface MessagesServiceDeps {
  repo: MessagesRepository;
}

export class MessagesService {
  private readonly repo: MessagesRepository;
  constructor(deps: MessagesServiceDeps) {
    this.repo = deps.repo;
  }

  // ── Company conversation ──────────────────────────────────────────────────
  async companyList(user: SessionUser, companyId: string): Promise<MessageResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listCompany(companyId)).map(toMessage);
  }
  async companySend(user: SessionUser, companyId: string, body: string): Promise<MessageResponse> {
    this.requireCompany(user, companyId);
    return toMessage(await this.repo.sendCompany(companyId, user.id, body));
  }

  // ── Direct conversation (symmetric) ───────────────────────────────────────

  /**
   * Who the caller may message on this deal.
   *
   * The caller is excluded — nobody messages themselves — and contacts are
   * ordered by most recent activity, then by name, so the list opens on whoever
   * spoke last. A contact never spoken to sorts last and still appears.
   */
  async directContacts(user: SessionUser, companyId: string): Promise<DirectContactsResponse> {
    this.requireCompany(user, companyId);
    const company = await this.repo.getCompany(companyId);
    if (!company) throw new NotFoundError("Company not found.");

    const members = (await this.repo.listCompanyMembers(companyId)).filter((m) => m.id !== user.id);
    const latest = await this.repo.latestDirectByContact(
      companyId,
      user.id,
      members.map((m) => m.id),
    );

    const contacts = members
      .map((m) => {
        const last = latest.get(m.id);
        return { ...m, last_message: last ? toMessage(last) : null };
      })
      .sort((a, b) => {
        const aAt = a.last_message?.created_at ?? "";
        const bAt = b.last_message?.created_at ?? "";
        if (aAt !== bAt) return bAt.localeCompare(aAt); // most recent first
        return (a.name ?? "").localeCompare(b.name ?? "");
      });

    return { company: { id: company.id, name: company.name }, contacts };
  }

  async directList(user: SessionUser, companyId: string, recipientId: string): Promise<MessageResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listDirect(companyId, user.id, recipientId)).map(toMessage);
  }
  async directSend(user: SessionUser, companyId: string, recipientId: string, body: string): Promise<MessageResponse> {
    this.requireCompany(user, companyId);
    return toMessage(await this.repo.sendDirect(companyId, user.id, recipientId, body));
  }

  // ── Groups + membership ───────────────────────────────────────────────────
  async groupsByCompany(user: SessionUser, companyId: string): Promise<GroupResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listGroupsByCompany(companyId)).map(toGroup);
  }
  async groupsForUser(user: SessionUser): Promise<GroupResponse[]> {
    return (await this.repo.listGroupsForUser(user.id)).map(toGroup);
  }
  async createGroup(user: SessionUser, companyId: string, input: GroupCreate): Promise<GroupResponse> {
    this.requireCompany(user, companyId);
    this.requireManager(user);
    const members = new Set<string>(input.member_ids ?? []);
    members.add(user.id); // the creator is a member
    const group = await this.repo.createGroup({
      companyId,
      name: input.name,
      groupType: input.group_type,
      buyerUserId: input.buyer_user_id ?? null,
      autoCreated: false,
      memberIds: [...members],
    });
    return toGroup(group);
  }
  async addMember(user: SessionUser, groupId: string, userId: string): Promise<string[]> {
    const group = await this.requireGroup(groupId);
    this.requireManagerOnCompany(user, group.companyId);
    await this.repo.addMember(groupId, userId);
    return this.repo.listMembers(groupId);
  }
  async removeMember(user: SessionUser, groupId: string, userId: string): Promise<void> {
    const group = await this.requireGroup(groupId);
    this.requireManagerOnCompany(user, group.companyId);
    await this.repo.removeMember(groupId, userId);
  }
  async listMembers(user: SessionUser, groupId: string): Promise<string[]> {
    await this.requireGroupAccess(user, groupId);
    return this.repo.listMembers(groupId);
  }

  // ── Group messages + reads ────────────────────────────────────────────────
  async groupMessages(user: SessionUser, groupId: string): Promise<GroupMessageResponse[]> {
    await this.requireGroupAccess(user, groupId);
    return (await this.repo.listGroupMessages(groupId)).map(toGroupMessage);
  }
  async sendGroupMessage(user: SessionUser, groupId: string, body: string): Promise<GroupMessageResponse> {
    await this.requireGroupAccess(user, groupId);
    return toGroupMessage(await this.repo.sendGroupMessage(groupId, user.id, body));
  }
  async markRead(user: SessionUser, groupId: string): Promise<void> {
    await this.requireGroupAccess(user, groupId);
    await this.repo.markRead(groupId, user.id);
  }
  async unreadCount(user: SessionUser, groupId: string): Promise<UnreadCountResponse> {
    await this.requireGroupAccess(user, groupId);
    return { group_id: groupId, unread: await this.repo.unreadCount(groupId, user.id) };
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private requireCompany(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("You do not have access to this company's messages.");
  }
  private requireManager(user: SessionUser): void {
    if (user.role !== "admin" && user.role !== "broker") throw new ForbiddenError("Only brokers or admins can manage groups.");
  }
  private requireManagerOnCompany(user: SessionUser, companyId: string): void {
    this.requireCompany(user, companyId);
    this.requireManager(user);
  }
  private async requireGroup(groupId: string): Promise<GroupRecord> {
    const group = await this.repo.getGroup(groupId);
    if (!group) throw new NotFoundError("Group not found.");
    return group;
  }
  /** A group is readable/postable by its members, or by a broker/admin on its company. */
  private async requireGroupAccess(user: SessionUser, groupId: string): Promise<GroupRecord> {
    const group = await this.requireGroup(groupId);
    if (await this.repo.isMember(groupId, user.id)) return group;
    if (canAccessCompany(user, group.companyId) && (user.role === "admin" || user.role === "broker")) return group;
    throw new ForbiddenError("You are not a member of this group.");
  }
}

function toMessage(m: MessageRecord): MessageResponse {
  return { id: m.id, company_id: m.companyId, sender_id: m.senderId, recipient_id: m.recipientId, body: m.body, created_at: m.createdAt };
}
function toGroup(g: GroupRecord): GroupResponse {
  return { id: g.id, company_id: g.companyId, name: g.name, group_type: g.groupType, buyer_user_id: g.buyerUserId, auto_created: g.autoCreated };
}
function toGroupMessage(m: GroupMessageRecord): GroupMessageResponse {
  return { id: m.id, group_id: m.groupId, sender_id: m.senderId, body: m.body, created_at: m.createdAt };
}
