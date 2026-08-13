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
