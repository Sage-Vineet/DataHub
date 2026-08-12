import type { SessionUser } from "@datahub/contracts";

/**
 * The multi-tenant access rule — the single most-reused guard in the app
 * (promoted here from `modules/auth` in `companies-domain` so every domain shares
 * one implementation). Pure function over the session user: admins and brokers
 * may access any company; everyone else only the companies they belong to.
 *
 * Engine-agnostic — it reads a `SessionUser`, not any auth internals.
 */
export function canAccessCompany(user: SessionUser, companyId: string): boolean {
  if (user.role === "admin" || user.role === "broker") return true;
  if (user.company_id === companyId) return true;
  return (user.company_ids ?? []).includes(companyId);
}
