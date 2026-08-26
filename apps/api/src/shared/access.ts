import type { SessionUser } from "@datahub/contracts";

/**
 * The multi-tenant access rule — the single most-reused guard in the app
 * (promoted here from `modules/auth` in `companies-domain` so every domain shares
 * one implementation). Pure function over the session user.
 *
 * Only **admins** are unscoped. Everyone else — brokers included — may access a
 * company only through an explicit association: `users.company_id`, or membership
 * in `user_companies`.
 *
 * The broker rule is deliberate and load-bearing. An earlier version of this guard
 * short-circuited `role === "broker"` to `true`, which does not match legacy
 * (`backend/src/services/permissionService.js`, where only `isAdmin` is unscoped).
 * Because every domain module routes its tenant check through here, that grant
 * would have handed every broker read access to every other tenant's company,
 * folders, documents, requests and messages the moment a domain was cut over — on
 * a platform where the tenants are competing sellers in the same M&A process.
 * Listing endpoints were correctly scoped, so it only surfaced on direct
 * fetch-by-id: exactly the shape that survives a demo.
 *
 * Engine-agnostic — it reads a `SessionUser`, not any auth internals.
 */
export function canAccessCompany(user: SessionUser, companyId: string): boolean {
  if (user.role === "admin") return true;
  if (user.company_id === companyId) return true;
  return (user.company_ids ?? []).includes(companyId);
}
