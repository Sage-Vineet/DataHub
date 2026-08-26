import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies, keyReportVersions } from "./schema.js";
import { chartOfAccounts } from "./qoe-schema.js";

/**
 * Chart-of-accounts reasonableness recommendations.
 *
 * Mirrors `migrations/0005_coa_recommendations.sql`, which is the authority.
 *
 * Advisory only: no report engine reads this table. A row reaches
 * `chart_of_accounts` only when a person accepts it, and then only through the
 * one hierarchy-writing path.
 */
export const coaRecommendations = pgTable(
  "key_report_coa_hierarchy_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => keyReportVersions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id, { onDelete: "cascade" }),

    /**
     * The account as the reviewer saw it, including its own name last.
     *
     * This is the input to the staleness gate: comparing it against the account
     * now is how an old proposal is stopped from undoing a newer edit.
     */
    currentHierarchy: jsonb("current_hierarchy").notNull().$type<string[]>(),
    currentAccountType: text("current_account_type"),
    currentStatementType: text("current_statement_type"),

    kind: text("kind").notNull().default("ROLLUP_INSERT"),

    /** Nullable: rows from the original engine carry only `recommendedRollup`. */
    recommendedHierarchy: jsonb("recommended_hierarchy").$type<string[]>(),
    /** Part of the uniqueness key the upsert conflicts on. */
    recommendedRollup: text("recommended_rollup").notNull(),
    recommendedParent: text("recommended_parent"),

    /** RECLASSIFY only. Null means "presentation only — do not touch the type". */
    recommendedAccountType: text("recommended_account_type"),
    recommendedStatementType: text("recommended_statement_type"),

    confidence: numeric("confidence"),
    confidenceBand: text("confidence_band"),
    source: text("source"),
    impact: text("impact"),
    reason: text("reason"),
    aiModel: text("ai_model"),

    status: text("status").notNull().default("pending"),
    rejectionReason: text("rejection_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** What was actually written, recorded independently of what was proposed. */
    appliedHierarchy: jsonb("applied_hierarchy").$type<string[]>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * The conflict target. Without it a second pass duplicates every row
     * instead of refreshing it.
     */
    perAccountRollup: uniqueIndex("key_report_coa_hierarchy_recommendations_version_id_account_id_r").on(
      t.versionId,
      t.accountId,
      t.recommendedRollup,
    ),
    byVersion: index("idx_coa_reco_version").on(t.versionId),
    byStatus: index("idx_coa_reco_status").on(t.versionId, t.status),
    byBand: index("idx_coa_reco_band").on(t.versionId, t.confidenceBand),
    byAccount: index("idx_coa_reco_account").on(t.accountId),

    // `accepted`/`ignored` are the original engine's vocabulary, retained so
    // decided rows imported from the legacy deployment stay valid.
    statusCheck: check(
      "coa_reco_status_check",
      sql`${t.status} IN ('pending', 'applied', 'rejected', 'accepted', 'ignored')`,
    ),
    kindCheck: check(
      "coa_reco_kind_check",
      sql`${t.kind} IN ('ROLLUP_INSERT', 'HIERARCHY_MOVE', 'RECLASSIFY')`,
    ),
    bandCheck: check(
      "coa_reco_confidence_band_check",
      sql`${t.confidenceBand} IS NULL OR ${t.confidenceBand} IN ('HIGH', 'MEDIUM', 'LOW')`,
    ),
    sourceCheck: check(
      "coa_reco_source_check",
      sql`${t.source} IS NULL OR ${t.source} IN ('DOCUMENT_MATCH', 'AI_REASONABLENESS')`,
    ),
    impactCheck: check(
      "coa_reco_impact_check",
      sql`${t.impact} IS NULL OR ${t.impact} IN ('CLASSIFICATION', 'PRESENTATION', 'BALANCE_SHEET_SECTION', 'OPERATING_RESULT')`,
    ),
    /**
     * A RECLASSIFY is the only kind allowed to carry a target type, and must
     * carry one — the same rule the service enforces, here where a future
     * writer cannot bypass it.
     *
     * The `IS NOT NULL` is load-bearing: `NULL IN (...)` evaluates to NULL, and
     * a CHECK rejects only on FALSE, so without it a RECLASSIFY carrying no
     * type satisfies the constraint by being unknown.
     */
    reclassifyCheck: check(
      "coa_reco_reclassify_type_check",
      sql`(${t.kind} = 'RECLASSIFY' AND ${t.recommendedAccountType} IS NOT NULL AND ${t.recommendedAccountType} IN ('income', 'cogs', 'expense', 'asset', 'liability', 'equity')) OR (${t.kind} <> 'RECLASSIFY' AND ${t.recommendedAccountType} IS NULL)`,
    ),
  }),
);
