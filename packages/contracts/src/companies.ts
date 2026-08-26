import { z } from "zod";

/** Company lifecycle status (parity with the `company_status` enum). */
export const companyStatus = z.enum(["active", "inactive"]);
export type CompanyStatus = z.infer<typeof companyStatus>;

/** Canonical profit-metric values (parity with legacy `PROFIT_METRIC_VALUES`). */
export const profitMetric = z.enum(["adjusted_ebitda", "sde"]);
export type ProfitMetric = z.infer<typeof profitMetric>;

/**
 * Normalize a profit-metric alias to a canonical value (parity with legacy
 * `normalizeProfitMetric`): case/space/hyphen-insensitive, with a safe fallback.
 */
export function normalizeProfitMetric(
  value: unknown,
  fallback: ProfitMetric = "adjusted_ebitda",
): ProfitMetric {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return fallback;
  if (
    normalized === "sde" ||
    normalized === "seller_discretionary_earnings" ||
    normalized === "sellers_discretionary_earnings" ||
    normalized === "seller's_discretionary_earnings"
  ) {
    return "sde";
  }
  if (
    normalized === "adjusted_ebitda" ||
    normalized === "adj_ebitda" ||
    normalized === "ebitda"
  ) {
    return "adjusted_ebitda";
  }
  return fallback;
}

/** Optional profit-metric field that normalizes any alias to a canonical value. */
const profitMetricField = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? undefined : normalizeProfitMetric(v)),
  profitMetric.optional(),
);

const optionalText = z.string().trim().optional();
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email("A valid contact email is required.")
  .optional()
  .or(z.literal("").transform(() => undefined));

/** Fields a caller may set on create. */
export const companyCreate = z.object({
  name: z.string().trim().min(1, "Company name is required."),
  project_name: optionalText,
  industry: optionalText,
  status: companyStatus.optional(),
  since: z.string().trim().optional(),
  logo: z.string().trim().optional(),
  contact_name: optionalText,
  contact_email: optionalEmail,
  contact_phone: optionalText,
  profit_metric: profitMetricField,
});
export type CompanyCreate = z.infer<typeof companyCreate>;

/**
 * Fields a caller may change on update — SAFE fields only. Integration-managed
 * columns (`quickbooks_connected`, `data_source_type`, …) are intentionally
 * absent so an update can never clobber them (spec: safe-field update).
 */
export const companyUpdate = companyCreate.partial();
export type CompanyUpdate = z.infer<typeof companyUpdate>;

/** Optional list filters. */
export const companyListQuery = z.object({
  status: companyStatus.optional(),
});
export type CompanyListQuery = z.infer<typeof companyListQuery>;

/** The company as returned to clients, including request-count stats. */
export const companyResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  project_name: z.string().nullable(),
  industry: z.string().nullable(),
  status: companyStatus,
  since: z.string().nullable(),
  logo: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  profit_metric: profitMetric,
  data_source_type: z.string().nullable(),
  quickbooks_connected: z.boolean(),
  manual_upload_active: z.boolean(),
  request_count: z.number().int(),
  pending_request_count: z.number().int(),
  completed_request_count: z.number().int(),
});
export type CompanyResponse = z.infer<typeof companyResponse>;

/**
 * One event on a deal's activity feed.
 *
 * The rows have always been written; only the READ went through legacy, which
 * queries Supabase and — with none configured — answered `200 []`. Three
 * activity panels reported "No activity yet" over data that was in Postgres the
 * whole time, and nothing distinguished an empty feed from an unreachable one.
 */
export const activityEvent = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  type: z.enum(["upload", "request", "approved", "reminder"]),
  message: z.string(),
  actor_id: z.string().uuid().nullable(),
  /** Resolved so the feed can name a person rather than print an id. */
  actor_name: z.string().nullable(),
  created_at: z.string(),
});
export type ActivityEvent = z.infer<typeof activityEvent>;
