import type {
  DirectContactsResponse,
  GroupCreate,
  GroupType,
  GroupMessageResponse,
  GroupResponse,
  MessageResponse,
  SessionUser,
  UnreadCountResponse,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { planCompanyGroups } from "./auto-groups.js";
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

/** One row of the cross-company thread rail. */
export interface ThreadResponse {
  company: {
    id: string;
    name: string | null;
    industry: string | null;
    logo: string | null;
    contact_name: string | null;
    contact_email: string | null;
    status: string | null;
    created_at: string;
  };
  last_message: MessageResponse | null;
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
  /**
   * The cross-company thread rail: one row per company the user can see, with
   * its most recent message.
   *
   * Ordered by last activity, newest first, falling back to when the company was
   * created so a deal nobody has messaged yet still has a stable place in the
   * list rather than drifting to the bottom in arbitrary order.
   */
  async threads(user: SessionUser): Promise<ThreadResponse[]> {
    const companies = await this.repo.listAccessibleCompanies({
      role: user.role,
      companyIds: user.company_ids ?? [],
    });
    if (companies.length === 0) return [];

    const latest = await this.repo.latestCompanyMessages(companies.map((c) => c.id));

    return companies
      .map((company) => {
        const last = latest.get(company.id);
        return {
          company: {
            id: company.id,
            name: company.name,
            industry: company.industry,
            logo: company.logo,
            contact_name: company.contactName,
            contact_email: company.contactEmail,
            status: company.status,
            created_at: company.createdAt,
          },
          last_message: last ? toMessage(last) : null,
        };
      })
      .sort((a, b) => {
        const aAt = a.last_message?.created_at ?? a.company.created_at;
        const bAt = b.last_message?.created_at ?? b.company.created_at;
        if (aAt !== bAt) return bAt.localeCompare(aAt);
        return a.company.name.localeCompare(b.company.name);
      });
  }

  /**
   * Direct contacts across every company the user belongs to.
   *
   * Scoped to their own companies even for an admin — unlike `threads()` above,
   * which shows an admin everything. The asymmetry is legacy's and it is
   * defensible: a thread rail is an overview, whereas this list is "people I can
   * message", and every user in the system is not that.
   *
   * A company that cannot be resolved is skipped rather than failing the call,
   * so one bad membership row does not empty the whole contact list.
   */
  async myDirectContacts(user: SessionUser): Promise<DirectContactsResponse[]> {
    const out: DirectContactsResponse[] = [];
    for (const companyId of user.company_ids ?? []) {
      try {
        out.push(await this.directContacts(user, companyId));
      } catch {
        continue;
      }
    }
    return out;
  }

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
        return a.name.localeCompare(b.name);
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
  /**
   * Bring a company's auto-created groups in line with who is on the deal.
   *
   * Re-run whenever membership changes, so it must be idempotent: an existing
   * group is matched on (company, type, buyer) and renamed if the firm name
   * moved, never duplicated. Only the groups the plan names are touched — a
   * group somebody made by hand is left alone.
   *
   * Any member of the company may trigger it. Legacy restricted this to brokers
   * and then deliberately opened it up, because a client or buyer who cannot
   * regenerate groups simply has no rooms to talk in.
   */
  async autoCreateGroups(
    user: SessionUser,
    companyId: string,
  ): Promise<{ success: true; created: Array<{ groupId: string; groupType: GroupType }> }> {
    this.requireCompany(user, companyId);

    const company = await this.repo.getCompany(companyId);
    if (!company) throw new NotFoundError("Company not found");

    const members = await this.repo.listMembersForGrouping(companyId);
    const plan = planCompanyGroups(company.name, members);
    const existing = await this.repo.listGroupsByCompany(companyId);
    const created: Array<{ groupId: string; groupType: GroupType }> = [];

    for (const planned of plan) {
      const match = existing.find(
        (g) => g.groupType === planned.groupType && g.buyerUserId === planned.buyerUserId,
      );

      if (match) {
        if (match.name !== planned.name) await this.repo.renameGroup(match.id, planned.name);
        // Members are added, never removed: leaving a room is a decision, and
        // reconciliation must not undo it.
        for (const memberId of planned.memberIds) await this.repo.addMember(match.id, memberId);
        continue;
      }

      const group = await this.repo.createGroup({
        companyId,
        name: planned.name,
        groupType: planned.groupType,
        buyerUserId: planned.buyerUserId,
        autoCreated: true,
        memberIds: planned.memberIds,
      });
      created.push({ groupId: group.id, groupType: planned.groupType });
    }

    return { success: true, created };
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
