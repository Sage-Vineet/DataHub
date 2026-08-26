import { z } from "zod";
import { userRole, userStatus, password as strongPassword } from "./auth.js";

/** Sub-roles stored in `users.sub_role` (migration 041 parity). */
export const subRole = z.enum([
  "broker_primary",
  "broker_team_member",
  "banker",
  "loan_broker",
  "company_owner",
  "client_team_member",
  "client_accountant",
  "buyer_primary",
  "buyer_team_member",
  "buyer_accountant",
]);
export type SubRole = z.infer<typeof subRole>;

/** Sub-roles that belong to the broker side. */
export const BROKER_SUB_ROLES: readonly SubRole[] = [
  "broker_primary",
  "broker_team_member",
  "banker",
  "loan_broker",
];
/** Broker-*team* sub-roles a broker may create (DB role stays `broker`). */
export const BROKER_TEAM_SUB_ROLES: readonly SubRole[] = ["broker_team_member", "banker", "loan_broker"];
/** Sub-roles that make a buyer resolve to `effective_role = "client"`. */
export const CLIENT_SIDE_SUB_ROLES: readonly SubRole[] = [
  "company_owner",
  "client_team_member",
  "client_accountant",
];
/** Client-team sub-roles whose visibility is request-restricted. */
export const CLIENT_TEAM_SUB_ROLES: readonly SubRole[] = ["client_team_member", "client_accountant"];
/**
 * Sub-roles on the buying side — the third side of a deal.
 *
 * Distinct from `CLIENT_SIDE_SUB_ROLES` despite the `buyer` DB role overlapping:
 * a user whose `role` is "buyer" but who has no sub-role is the *seller's*
 * client in legacy's reckoning, whereas these sub-roles mark an actual bidder.
 */
export const BUYER_SIDE_SUB_ROLES: readonly SubRole[] = [
  "buyer_primary",
  "buyer_team_member",
  "buyer_accountant",
];

/** The computed role clients/UI reason about. */
export const effectiveRole = z.enum(["admin", "broker", "client", "user"]);
export type EffectiveRole = z.infer<typeof effectiveRole>;

const email = z.string().trim().toLowerCase().email("A valid email address is required.");
const optionalText = z.string().trim().optional();
const companyIdList = z.array(z.string().uuid()).optional();

export const userCreate = z.object({
  name: z.string().trim().min(1, "Name is required."),
  email,
  password: strongPassword,
  role: userRole,
  sub_role: subRole.optional(),
  designation: optionalText,
  buyer_company_name: optionalText,
  parent_user_id: z.string().uuid().optional(),
  phone: optionalText,
  status: userStatus.optional(),
  company_id: z.string().uuid().optional(),
  company_ids: companyIdList,
});
export type UserCreate = z.infer<typeof userCreate>;

export const userUpdate = z.object({
  name: optionalText,
  email: email.optional(),
  phone: optionalText,
  role: userRole.optional(),
  status: userStatus.optional(),
  sub_role: subRole.optional(),
  designation: optionalText,
  buyer_company_name: optionalText,
  parent_user_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  company_ids: companyIdList,
  // Profile fields.
  date_of_birth: optionalText,
  occupation: optionalText,
  address: optionalText,
  broker_company: optionalText,
  // Self password change: `current_password` must accompany `password`.
  password: strongPassword.optional(),
  current_password: z.string().optional(),
});
export type UserUpdate = z.infer<typeof userUpdate>;

export const userListQuery = z.object({});
export type UserListQuery = z.infer<typeof userListQuery>;

export const companyMembership = z.object({
  company_ids: z.array(z.string().uuid()).min(1, "At least one company id is required."),
});
export type CompanyMembership = z.infer<typeof companyMembership>;

export const brokerTeamInvite = z.object({
  invited_broker_id: z.string().uuid(),
});
export type BrokerTeamInvite = z.infer<typeof brokerTeamInvite>;

/** A company summary attached to a user. */
export const assignedCompany = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  contact_email: z.string().nullable(),
});
export type AssignedCompany = z.infer<typeof assignedCompany>;

export const userResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: userRole,
  effective_role: effectiveRole,
  sub_role: subRole.nullable(),
  designation: z.string().nullable(),
  status: userStatus,
  company_id: z.string().uuid().nullable(),
  company_ids: z.array(z.string().uuid()),
  assigned_companies: z.array(assignedCompany),
  is_team_invite: z.boolean().optional(),
  /**
   * When this person joined the deal. Absent from the response until now, so the
   * team card read `u.created_at` off an object that never carried it and
   * rendered the string "Joined Invalid Date" for every member.
   *
   * Nullable because a row genuinely may not have one; the UI shows "—" then,
   * rather than inventing a date or printing a formatter error.
   */
  created_at: z.string().nullable().optional(),
});
export type UserResponse = z.infer<typeof userResponse>;
