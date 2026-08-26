import { z } from "zod";

const uuid = z.string().uuid();

export const dataSource = z.enum(["company_financials", "tax_return"]);
export type DataSource = z.infer<typeof dataSource>;

export const earningsMetric = z.enum(["adjusted_ebitda", "sde"]);
export type EarningsMetric = z.infer<typeof earningsMetric>;

export const aggregation = z.enum(["annual", "monthly"]);
export type Aggregation = z.infer<typeof aggregation>;

/** The four sourcing mechanisms the add-back wizard gates on (`QE - 0004`). */
export const addbackKind = z.enum([
  "pnl_account_vendor",
  "balance_sheet_change",
  "manual_adjustment",
  "recast",
]);
export type AddbackKind = z.infer<typeof addbackKind>;

export const entryGranularity = z.enum(["detail", "smoothed"]);
export type EntryGranularity = z.infer<typeof entryGranularity>;

export const ebitdaRole = z.enum([
  "interest_income",
  "interest_expense",
  "income_tax",
  "depreciation",
  "amortization",
  "owner_compensation",
]);
export type EbitdaRole = z.infer<typeof ebitdaRole>;

/** Comma-separated fiscal years — periods are chosen discretely, never as a range. */
const yearList = z
  .string()
  .transform((raw) => raw.split(",").map((v) => Number(v.trim())).filter(Number.isFinite))
  .pipe(z.array(z.number().int().min(1900).max(2200)).min(1, "Select at least one period."));

export const bridgeQuery = z.object({
  version_id: z.string().min(1),
  years: yearList.optional(),
  aggregation: aggregation.default("annual"),
  data_source: dataSource.default("company_financials"),
});
export type BridgeQuery = z.infer<typeof bridgeQuery>;

const amounts = z.record(z.string(), z.number());

export const bridgeLineItem = z.object({
  key: z.string(),
  label: z.string(),
  amounts,
  commentary: z.string().nullable().optional(),
});

export const bridgeResponse = z.object({
  periods: z.array(
    z.object({ fiscalYear: z.number().int(), month: z.number().int().nullable(), label: z.string() }),
  ),
  netIncome: bridgeLineItem,
  ebitLines: z.array(bridgeLineItem),
  reportedEbitda: amounts,
  addbackGroups: z.array(
    z.object({
      id: z.string().nullable(),
      label: z.string().nullable(),
      items: z.array(bridgeLineItem),
      subtotals: amounts,
    }),
  ),
  ownerCompensation: bridgeLineItem.nullable(),
  adjusted: amounts,
  metric: earningsMetric,
  metricLabel: z.string(),
  revenue: amounts,
  margin: amounts,
  unflaggedAccounts: z.array(z.string()),
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      statementType: z.enum(["profit_loss", "balance_sheet"]),
      ebitdaRole: ebitdaRole.nullable(),
    }),
  ),
});
export type BridgeResponse = z.infer<typeof bridgeResponse>;

/**
 * Add-back create/update.
 *
 * The per-kind rules `QE - 0004` requires are enforced here so the API refuses
 * the same things the wizard refuses:
 *   - a manual adjustment with no written explanation
 *   - a P&L account/vendor add-back with no linked GL account
 *   - a recast with no normalized value
 * A P&L account/vendor amount is pulled from the GL, so `values` is rejected
 * outright rather than silently ignored.
 */
const addbackBase = z.object({
  version_id: z.string().min(1),
  company_id: uuid,
  kind: addbackKind,
  data_source: dataSource.default("company_financials"),
  type_key: z.string().min(1),
  name: z.string().trim().min(1, "A name is required."),
  linked_account_id: z.string().nullable().optional(),
  vendor_scope: z.array(z.string()).default([]),
  granularity: entryGranularity.default("detail"),
  values: z.record(z.string(), z.number()).optional(),
  recast_normalized_value: z.number().nullable().optional(),
  group_id: z.string().nullable().optional(),
  group_label: z.string().nullable().optional(),
  explanation: z.string().nullable().optional(),
  commentary: z.string().nullable().optional(),
});

export const addbackCreate = addbackBase.superRefine((value, ctx) => {
  if (value.kind === "manual_adjustment" && !value.explanation?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["explanation"],
      message: "A manual adjustment requires a written explanation before it can be saved.",
    });
  }
  if (value.kind === "pnl_account_vendor") {
    if (!value.linked_account_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["linked_account_id"],
        message: "A P&L account/vendor add-back requires a linked GL account.",
      });
    }
    if (value.values !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: "A P&L account/vendor amount comes from the GL and cannot be entered manually.",
      });
    }
  }
  if (value.kind === "recast") {
    if (!value.linked_account_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["linked_account_id"],
        message: "A recast add-back requires a linked P&L account.",
      });
    }
    if (value.recast_normalized_value === null || value.recast_normalized_value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recast_normalized_value"],
        message: "A recast add-back requires a normalized post-close value.",
      });
    }
  }
});
export type AddbackCreate = z.infer<typeof addbackCreate>;

export const addbackResponse = addbackBase.extend({
  id: uuid,
  created_by: uuid.nullable(),
});
export type AddbackResponse = z.infer<typeof addbackResponse>;

/** Query for the balance sheet or trial balance. */
export const statementQuery = z.object({
  version_id: z.string().min(1),
  years: yearList.optional(),
  aggregation: aggregation.default("annual"),
});
export type StatementQuery = z.infer<typeof statementQuery>;

/**
 * Result of classifying a chart of accounts.
 *
 * `applied` was written; `suggested` matched but wants a human before it moves
 * the number; `unclassified` was deliberately left out, and `reason` says why —
 * an operating tax reads as a decision rather than an oversight.
 */
export const classification = z.object({
  accountId: z.string(),
  accountName: z.string(),
  accountType: z.string().nullable(),
  role: ebitdaRole.nullable(),
  confidence: z.enum(["high", "low"]),
  rule: z.string(),
  reason: z.string(),
});
export type Classification = z.infer<typeof classification>;

export const classificationReport = z.object({
  applied: z.array(classification),
  suggested: z.array(classification),
  unclassified: z.array(classification),
  applied_count: z.number().int(),
  dry_run: z.boolean(),
});
export type ClassificationReport = z.infer<typeof classificationReport>;

export const accountType = z.enum(["asset", "liability", "equity", "income", "cogs", "expense"]);
export type AccountType = z.infer<typeof accountType>;

/** Reclassify an account. `statement_type` is derived server-side, never sent. */
export const accountClassificationUpdate = z.object({ account_type: accountType });
export type AccountClassificationUpdate = z.infer<typeof accountClassificationUpdate>;

/** Account-level EBITDA role assignment — the flag that replaces label matching. */
export const accountRoleUpdate = z.object({
  ebitda_role: ebitdaRole.nullable(),
});
export type AccountRoleUpdate = z.infer<typeof accountRoleUpdate>;
