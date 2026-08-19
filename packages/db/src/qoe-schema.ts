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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_coa_version").on(t.versionId, t.companyId)],
);

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
