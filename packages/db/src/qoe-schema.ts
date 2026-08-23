import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies, users } from "./schema.js";

/**
 * Financial tables the QoE bridge reads and writes.
 *
 * Hand-authored against the live shapes in `backend/sql/migrations/` (046–054
 * for key reports and the chart of accounts, 043/045 for add-backs) rather than
 * introspected, to keep the column set to what this module actually touches.
 * The legacy raw-SQL migration set stays frozen; changes here ship as Drizzle
 * migrations under `packages/db/drizzle/`.
 */

export const chartOfAccounts = pgTable(
  "chart_of_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    accountNumber: text("account_number"),
    accountName: text("account_name").notNull(),
    parentAccountId: uuid("parent_account_id"),
    /** asset | liability | equity | income | cogs | expense */
    accountType: text("account_type"),
    /** balance_sheet | profit_loss */
    statementType: text("statement_type"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order"),
    /**
     * The centralized EBITDA classification `QE - 0004` requires in place of
     * matching account labels. NULL means unflagged, which contributes nothing
     * to Reported EBITDA — deliberately the safe direction.
     */
    ebitdaRole: text("ebitda_role"),

    /**
     * The hierarchy columns.
     *
     * Modelled because the reasonableness review reads them
     * (`apps/api/src/modules/coa-review`); the QoE bridge does not. They were
     * absent from this model until then — not because they do not exist, but
     * because nothing modernized had needed them, which is worth knowing before
     * assuming a missing column means a missing migration.
     *
     * `metadata.is_group` distinguishes a document-driven section node from a
     * posting account, and `metadata.user_modified` marks a row somebody edited
     * by hand — which the review must leave alone.
     */
    metadata: jsonb("metadata").$type<{ is_group?: boolean; user_modified?: boolean }>(),
    baseAccount: text("base_account"),
    hierarchyPath: text("hierarchy_path"),
    /** `"<number> <name>"`, denormalized for search. */
    accountIdName: text("account_id_name"),
    /** How the current classification was arrived at: "ai", "manual", … */
    classificationMethod: text("classification_method"),
    /**
     * What the classifier first produced, kept untouched so an edit can be
     * undone. The `adjusted_*` pair is what a person changed it to; nothing may
     * write to `original_*` after generation.
     */
    originalName: text("original_name"),
    originalHierarchy: jsonb("original_hierarchy"),
    adjustedName: text("adjusted_name"),
    adjustedHierarchy: jsonb("adjusted_hierarchy"),
    /**
     * `level_1`..`level_15`, flattened. The generator pads every column past a
     * leaf's real depth by repeating its deepest value, so a consumer has to
     * collapse the trailing repeats — see `columnsToLevels` in
     * `@datahub/financial-engine`.
     *
     * NOTE: there is no `system_id` here. Legacy migration 052 added one on the
     * branch this review was ported from; `ba/rearch` never took that migration,
     * so the column does not exist in this schema and the adapter reports null
     * for it rather than selecting something that is not there.
     */
    level1: text("level_1"),
    level2: text("level_2"),
    level3: text("level_3"),
    level4: text("level_4"),
    level5: text("level_5"),
    level6: text("level_6"),
    level7: text("level_7"),
    level8: text("level_8"),
    level9: text("level_9"),
    level10: text("level_10"),
    level11: text("level_11"),
    level12: text("level_12"),
    level13: text("level_13"),
    level14: text("level_14"),
    level15: text("level_15"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_coa_version").on(t.versionId, t.companyId)],
);

/**
 * Every hand edit to an account, one row per field changed.
 *
 * Separate from `coa_classification_history` on purpose: this records WHAT
 * changed (old and new value of one field), while the history records the whole
 * hierarchy as it stood and HOW it was arrived at. A reviewer asking "who
 * renamed this?" and one asking "what did the classifier think?" are asking
 * different questions.
 */
export const coaAccountAdjustments = pgTable("coa_account_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  versionId: uuid("version_id").notNull(),
  companyId: uuid("company_id"),
  fieldChanged: text("field_changed").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  changedBy: uuid("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A snapshot of an account's classification each time it was set. */
export const coaClassificationHistory = pgTable("coa_classification_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  versionId: uuid("version_id").notNull(),
  companyId: uuid("company_id"),
  classificationMethod: text("classification_method"),
  hierarchySnapshot: jsonb("hierarchy_snapshot"),
  source: text("source"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The standard hierarchy vocabulary — the labels an account may be filed under
 * at each level. Reference data, not per-company.
 */
export const coaHierarchyLevels = pgTable("coa_hierarchy_levels", {
  id: uuid("id").primaryKey().defaultRandom(),
  levelNumber: integer("level_number").notNull(),
  statementType: text("statement_type"),
  parentLabel: text("parent_label"),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isStandard: boolean("is_standard").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const generalLedgerEntries = pgTable(
  "general_ledger_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    versionId: uuid("version_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    transactionDate: date("transaction_date"),
    fiscalYear: integer("fiscal_year"),
    accountName: text("account_name"),
    accountNumber: text("account_number"),
    sourceFileId: uuid("source_file_id"),
    coaId: uuid("coa_id"),
    /** ACCOUNT_HEADER | BEGINNING_BALANCE | TRANSACTION | TOTAL_ROW */
    rowType: text("row_type").notNull().default("TRANSACTION"),
    amount: numeric("amount", { precision: 18, scale: 2 }),
    // The repo's column is `vendor_name`. The deployed UAT database has drifted
    // to `vendor` + `customer` + `entity_type`; the migration set here is the
    // authority, so that drift is reconciled rather than mirrored.
    vendor: text("vendor_name"),
    memoDescription: text("memo_description"),
  },
  (t) => [index("idx_gl_version_year").on(t.versionId, t.fiscalYear)],
);

/**
 * Extracted balance-sheet statements.
 *
 * The QoE engine reads these as roll-forward *anchors*: a statement is a source
 * of accounts and their stated balances at a date, not merely of numbers. Rows
 * where `isTotal` or `isGenerated` is set are subtotals or previously-derived
 * output and must never be fed back in as an anchor.
 */
export const balanceSheetEntries = pgTable(
  "balance_sheet_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    versionId: uuid("version_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceFileId: uuid("source_file_id"),
    asOfDate: date("as_of_date").notNull(),
    fiscalYear: integer("fiscal_year"),
    accountName: text("account_name"),
    accountNumber: text("account_number"),
    accountType: text("account_type"),
    /** assets | liabilities | equity */
    section: text("section"),
    subSection: text("sub_section"),
    amount: numeric("amount", { precision: 18, scale: 2 }),
    hierarchyLevel: integer("hierarchy_level"),
    sortOrder: integer("sort_order"),
    isTotal: boolean("is_total"),
    isGenerated: boolean("is_generated"),
    coaId: uuid("coa_id"),
  },
  (t) => [index("idx_bs_entries_version_date").on(t.versionId, t.asOfDate)],
);

export const qoeAddbacks = pgTable(
  "qoe_addbacks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    versionId: text("version_id").notNull(),
    /** Sourcing mechanism — orthogonal to `typeKey` (design D4). */
    kind: text("kind").notNull(),
    /** company_financials | tax_return. Records are retained across the toggle. */
    dataSource: text("data_source").notNull().default("company_financials"),
    /** Category: personal_expense, officer_compensation, … */
    typeKey: text("type_key").notNull(),
    name: text("name").notNull(),
    linkedAccountId: text("linked_account_id"),
    /** Empty array means the entire account is in scope. */
    vendorScope: jsonb("vendor_scope").notNull().default([]),
    /** detail | smoothed */
    granularity: text("granularity").notNull().default("detail"),
    /** Manual/BS-change amounts keyed by period ("2024" or "2024-07"). */
    values: jsonb("values").notNull().default({}),
    recastNormalizedValue: numeric("recast_normalized_value", { precision: 18, scale: 2 }),
    groupId: text("group_id"),
    groupLabel: text("group_label"),
    explanation: text("explanation"),
    commentary: text("commentary"),
    qaCitationIds: jsonb("qa_citation_ids").notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("idx_qoe_addbacks_scope").on(t.companyId, t.versionId, t.deletedAt)],
);
