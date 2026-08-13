import type { GroupType } from "@datahub/contracts";

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

export interface MessagesRepository {
  // Company conversation.
  listCompany(companyId: string): Promise<MessageRecord[]>;
  sendCompany(companyId: string, senderId: string, body: string): Promise<MessageRecord>;

  // Direct conversation (symmetric).
  listDirect(companyId: string, a: string, b: string): Promise<MessageRecord[]>;
  sendDirect(companyId: string, senderId: string, recipientId: string, body: string): Promise<MessageRecord>;

  // Groups + membership.
  listGroupsByCompany(companyId: string): Promise<GroupRecord[]>;
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
