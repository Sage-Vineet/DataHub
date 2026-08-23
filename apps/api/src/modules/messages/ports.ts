import type { GroupType } from "@datahub/contracts";
import type { GroupingMember } from "./auto-groups.js";

export interface MessageRecord {
  id: string;
  companyId: string;
  senderId: string;
  recipientId: string | null;
  body: string;
  createdAt: string;
}

export interface GroupRecord {
  id: string;
  companyId: string;
  name: string;
  groupType: GroupType;
  buyerUserId: string | null;
  autoCreated: boolean;
}

export interface GroupMessageRecord {
  id: string;
  groupId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface CreateGroupInput {
  companyId: string;
  name: string;
  groupType: GroupType;
  buyerUserId: string | null;
  autoCreated: boolean;
  memberIds: string[];
}

/** A person on the deal who can be messaged, plus the company they were resolved against. */
export interface DirectContactRecord {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface CompanyRecord {
  id: string;
  name: string | null;
}

/**
 * A company as the cross-company thread list renders it. Wider than
 * `CompanyRecord` because the thread rail shows the industry, and `createdAt` is
 * the tiebreak for a company nobody has messaged yet.
 */
export interface ThreadCompanyRecord {
  id: string;
  name: string | null;
  industry: string | null;
  logo: string | null;
  contactName: string | null;
  contactEmail: string | null;
  status: string | null;
  createdAt: string;
}

export interface MessagesRepository {
  // Company conversation.
  listCompany(companyId: string): Promise<MessageRecord[]>;
  sendCompany(companyId: string, senderId: string, body: string): Promise<MessageRecord>;

  /**
   * Who the caller may message on this deal, and the deal itself.
   *
   * `users.company_id` union `user_companies` — the same association
   * `canAccessCompany` reads, so "may see this deal" and "may be messaged on
   * this deal" cannot drift apart.
   */
  getCompany(companyId: string): Promise<CompanyRecord | null>;
  /**
   * Companies whose conversations the user may see, by name.
   *
   * An admin sees every company; everyone else sees the ones they are
   * associated with. That asymmetry is legacy's and is deliberate here — the
   * sibling `/my-direct-contacts` scopes an admin to their own companies, so the
   * two endpoints genuinely answer different questions.
   */
  listAccessibleCompanies(user: {
    role: string;
    companyIds: readonly string[];
  }): Promise<ThreadCompanyRecord[]>;
  /** The most recent message in each company, keyed by company id. */
  latestCompanyMessages(companyIds: readonly string[]): Promise<Map<string, MessageRecord>>;
  listCompanyMembers(companyId: string): Promise<DirectContactRecord[]>;

  /** The most recent message either way between `userId` and each of `contactIds`. */
  latestDirectByContact(
    companyId: string,
    userId: string,
    contactIds: string[],
  ): Promise<Map<string, MessageRecord>>;

  // Direct conversation (symmetric).
  listDirect(companyId: string, a: string, b: string): Promise<MessageRecord[]>;
  sendDirect(companyId: string, senderId: string, recipientId: string, body: string): Promise<MessageRecord>;

  // Groups + membership.
  listGroupsByCompany(companyId: string): Promise<GroupRecord[]>;
  /**
   * Company members with the fields `auto-groups.ts` classifies them by.
   * Separate from `listCompanyMembers` because that one answers "who can be
   * messaged", which does not need sub-roles or parentage.
   */
  listMembersForGrouping(companyId: string): Promise<GroupingMember[]>;
  /** Rename a group in place — auto-creation re-runs when a firm name changes. */
  renameGroup(groupId: string, name: string): Promise<void>;
  listGroupsForUser(userId: string): Promise<GroupRecord[]>;
  createGroup(input: CreateGroupInput): Promise<GroupRecord>;
  getGroup(id: string): Promise<GroupRecord | null>;
  addMember(groupId: string, userId: string): Promise<void>;
  removeMember(groupId: string, userId: string): Promise<void>;
  listMembers(groupId: string): Promise<string[]>;
  isMember(groupId: string, userId: string): Promise<boolean>;

  // Group messages + reads.
  listGroupMessages(groupId: string): Promise<GroupMessageRecord[]>;
  sendGroupMessage(groupId: string, senderId: string, body: string): Promise<GroupMessageRecord>;
  markRead(groupId: string, userId: string): Promise<void>;
  unreadCount(groupId: string, userId: string): Promise<number>;
}
