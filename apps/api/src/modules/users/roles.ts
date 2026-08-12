import {
  BROKER_TEAM_SUB_ROLES,
  CLIENT_SIDE_SUB_ROLES,
  CLIENT_TEAM_SUB_ROLES,
  type AssignedCompany,
  type EffectiveRole,
  type SubRole,
  type UserRole,
} from "@datahub/contracts";

/** The minimal user shape the pure role rules need. */
export interface RoleUser {
  role: UserRole | "client";
  subRole: SubRole | null;
  email: string;
}

/**
 * Compute a user's `effective_role` at parity with legacy `attachAssignedCompanies`:
 *  - admin/broker → same;
 *  - a defensive legacy `client` role → client;
 *  - buyer → `client` if it has a client-side sub-role OR its email matches a
 *    company contact ("seller"); otherwise `user`.
 * Pure and exhaustively testable (design D2).
 */
export function computeEffectiveRole(
  user: RoleUser,
  assignedCompanies: ReadonlyArray<Pick<AssignedCompany, "contact_email">>,
): EffectiveRole {
  if (user.role === "admin") return "admin";
  if (user.role === "broker") return "broker";
  if (user.role === "client") return "client";
  // role === "buyer"
  const email = user.email.trim().toLowerCase();
  const isSeller = assignedCompanies.some(
    (c) => (c.contact_email ?? "").trim().toLowerCase() === email && email !== "",
  );
  if (isSeller) return "client";
  if (user.subRole && (CLIENT_SIDE_SUB_ROLES as readonly string[]).includes(user.subRole)) {
    return "client";
  }
  return "user";
}

/** Client-team members are request-restricted (parity with the spec). */
export function isRequestRestricted(subRole: SubRole | null): boolean {
  return subRole != null && (CLIENT_TEAM_SUB_ROLES as readonly string[]).includes(subRole);
}

/** A broker-*team* sub-role a broker is allowed to create (DB role stays broker). */
export function isBrokerTeamSubRole(subRole: SubRole | null | undefined): boolean {
  return subRole != null && (BROKER_TEAM_SUB_ROLES as readonly string[]).includes(subRole);
}

export function isAdminRole(role: string): boolean {
  return role === "admin";
}
export function isBrokerRole(role: string): boolean {
  return role === "broker";
}
