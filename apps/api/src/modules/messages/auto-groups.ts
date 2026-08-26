import {
  BROKER_SUB_ROLES,
  BUYER_SIDE_SUB_ROLES,
  CLIENT_SIDE_SUB_ROLES,
  type GroupType,
} from "@datahub/contracts";

/**
 * Which message groups a company should have, derived from who is on the deal.
 *
 * Kept as a pure function because it is all rules and no I/O: three-way role
 * classification, a naming convention, and a membership set per group. Legacy
 * interleaved those rules with Supabase calls inside one 100-line function, so
 * the only way to ask "what groups should this company have?" was to run it
 * against a database and look at what appeared.
 *
 * The caller reconciles the plan against what exists (`service.autoCreateGroups`).
 * Planning and persisting are separate so that neither has to be tested through
 * the other.
 */

/** A company member, with the fields that decide which side of the deal they are on. */
export interface GroupingMember {
  id: string;
  role: string;
  subRole: string | null;
  parentUserId: string | null;
  name: string | null;
  brokerCompany: string | null;
  buyerCompanyName: string | null;
}

/** One group the company should have, with the members it should contain. */
export interface PlannedGroup {
  name: string;
  groupType: GroupType;
  /** Set only for a per-buyer channel; null marks a company-wide group. */
  buyerUserId: string | null;
  memberIds: string[];
}

export type DealSide = "broker" | "client" | "buyer" | "unknown";

/**
 * Which side of the deal someone is on.
 *
 * `sub_role` wins when present; `role` is the fallback for accounts predating
 * sub-roles. A member matching nothing is `unknown` and joins no group — that is
 * deliberate, because guessing would put someone in a room with the other side.
 */
export function sideOf(member: GroupingMember): DealSide {
  const sub = member.subRole;
  if (sub) {
    if ((BROKER_SUB_ROLES as readonly string[]).includes(sub)) return "broker";
    if ((CLIENT_SIDE_SUB_ROLES as readonly string[]).includes(sub)) return "client";
    if ((BUYER_SIDE_SUB_ROLES as readonly string[]).includes(sub)) return "buyer";
    return "unknown";
  }
  if (member.role === "broker" || member.role === "admin") return "broker";
  // "client" is not in the database's role enum, but legacy wrote it and rows
  // carrying it still exist.
  if (member.role === "buyer" || member.role === "client") return "client";
  return "unknown";
}

/**
 * The broker firm's display name, taken from the first broker who has one.
 *
 * Falls back to "Broker" rather than to a person's name: these strings become
 * group titles that the other side of the deal reads.
 */
export function brokerCompanyNameOf(members: readonly GroupingMember[]): string {
  for (const m of members) {
    if (sideOf(m) === "broker" && m.brokerCompany) return m.brokerCompany;
  }
  return "Broker";
}

/** A buyer's firm name, falling back to their own name, then to "Buyer". */
function buyerCompanyNameOf(parent: GroupingMember | undefined): string {
  return parent?.buyerCompanyName || parent?.name || "Buyer";
}

/**
 * Group buyer-side members under the account that represents their firm.
 *
 * A buyer team member points at its principal via `parent_user_id`; a principal
 * points at nobody and is its own parent. That is what makes one buyer firm one
 * channel rather than one channel per person.
 */
export function buyersByFirm(members: readonly GroupingMember[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of members) {
    if (sideOf(m) !== "buyer") continue;
    const parentId = m.parentUserId ?? m.id;
    const list = out.get(parentId) ?? [];
    list.push(m.id);
    out.set(parentId, list);
  }
  return out;
}

/**
 * The groups a company should have.
 *
 * `broker_internal` is deliberately absent. Legacy skipped it during
 * auto-creation so the broker's private room is only ever created when a broker
 * actually adds a team member — an empty one pre-populated for every company
 * would be noise.
 */
export function planCompanyGroups(
  companyName: string,
  members: readonly GroupingMember[],
): PlannedGroup[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const brokerIds = members.filter((m) => sideOf(m) === "broker").map((m) => m.id);
  const clientIds = members.filter((m) => sideOf(m) === "client").map((m) => m.id);
  const buyerFirms = buyersByFirm(members);
  const brokerCompany = brokerCompanyNameOf(members);

  const plan: PlannedGroup[] = [];

  // Broker ↔ client: the working channel for the sell side.
  if (brokerIds.length > 0 && clientIds.length > 0) {
    plan.push({
      name: `${brokerCompany} - ${companyName}`,
      groupType: "broker_client",
      buyerUserId: null,
      memberIds: [...brokerIds, ...clientIds],
    });
  }

  // Deal team: everyone on the deal, in one room.
  const everyone = [...new Set([...brokerIds, ...clientIds, ...[...buyerFirms.values()].flat()])];
  if (everyone.length > 0) {
    plan.push({
      name: `DealTeam - ${companyName}`,
      groupType: "deal_team",
      buyerUserId: null,
      memberIds: everyone,
    });
  }

  // One private channel per buyer firm. Without a broker there is nobody on the
  // other side of it, so it is not created.
  if (brokerIds.length > 0) {
    for (const [parentId, firmMemberIds] of buyerFirms) {
      plan.push({
        name: `${brokerCompany} - ${buyerCompanyNameOf(byId.get(parentId))}`,
        groupType: "broker_buyer",
        buyerUserId: parentId,
        memberIds: [...brokerIds, ...firmMemberIds],
      });
    }
  }

  return plan;
}
