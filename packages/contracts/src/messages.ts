import { z } from "zod";

const uuid = z.string().uuid();
const body = z.string().trim().min(1, "message body is required");

export const messageSend = z.object({ body });
export type MessageSend = z.infer<typeof messageSend>;

export const groupType = z.enum([
  "broker_internal",
  "deal_team",
  "broker_client",
  "broker_buyer",
  "client_internal",
  "buyer_internal",
]);
export type GroupType = z.infer<typeof groupType>;

export const groupCreate = z.object({
  name: z.string().trim().min(1, "group name is required"),
  group_type: groupType,
  buyer_user_id: uuid.optional(),
  member_ids: z.array(uuid).optional(),
});
export type GroupCreate = z.infer<typeof groupCreate>;

export const groupMemberAdd = z.object({ user_id: uuid });
export type GroupMemberAdd = z.infer<typeof groupMemberAdd>;

export const messageResponse = z.object({
  id: uuid,
  company_id: uuid.nullable(),
  sender_id: uuid,
  recipient_id: uuid.nullable(),
  body: z.string(),
  created_at: z.string(),
});
export type MessageResponse = z.infer<typeof messageResponse>;

export const groupMessageResponse = z.object({
  id: uuid,
  group_id: uuid,
  sender_id: uuid,
  body: z.string(),
  created_at: z.string(),
});
export type GroupMessageResponse = z.infer<typeof groupMessageResponse>;

export const groupResponse = z.object({
  id: uuid,
  company_id: uuid,
  name: z.string(),
  group_type: groupType,
  buyer_user_id: uuid.nullable(),
  auto_created: z.boolean(),
});
export type GroupResponse = z.infer<typeof groupResponse>;

export const unreadCountResponse = z.object({ group_id: uuid, unread: z.number().int() });
export type UnreadCountResponse = z.infer<typeof unreadCountResponse>;

/**
 * One person the caller may message on a deal, with the most recent thing said
 * either way so the list can be ordered by recency without a second round trip.
 *
 * `last_message` is null for a contact never spoken to — a real state, not an
 * error, and the list still shows them.
 */
export const directContact = z.object({
  id: uuid,
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string().nullable(),
  last_message: messageResponse.nullable(),
});
export type DirectContact = z.infer<typeof directContact>;

/**
 * The contacts listing for one company.
 *
 * This is the entry point to direct messaging: every messaging view requests it
 * before it can render anything, so losing it takes the whole capability out.
 * It did exactly that — the TypeScript rewrite defined only
 * `/direct-messages/:recipientId`, so `contacts` was parsed as a recipient id
 * and the conversation query failed with a 500 on every load.
 */
export const directContactsResponse = z.object({
  company: z.object({ id: uuid, name: z.string().nullable() }),
  contacts: z.array(directContact),
});
export type DirectContactsResponse = z.infer<typeof directContactsResponse>;
