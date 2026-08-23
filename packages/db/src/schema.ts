import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres `bytea` — file blobs are stored in-DB behind the uploads StoragePort. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Auth-slice schema, hand-authored from backend/sql/schema.sql (no reachable
 * DATABASE_URL at authoring time — see phase-1-auth design D4). To be replaced /
 * reconciled by `drizzle-kit pull` against the live database. Only the tables
 * the auth module touches are modeled here; the rest follow as their domains
 * migrate. The legacy 76-file migration set is frozen.
 */

export const userRole = pgEnum("user_role", ["admin", "broker", "buyer"]);
export const userStatus = pgEnum("user_status", ["active", "inactive"]);
export const companyStatus = pgEnum("company_status", ["active", "inactive"]);

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  projectName: text("project_name"),
  industry: text("industry"),
  status: companyStatus("status").notNull().default("active"),
  since: date("since"),
  logo: text("logo"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  // Canonical profit metric ("adjusted_ebitda" | "sde"); text at the DB layer
  // (legacy is untyped), normalized to the contract enum on the way in.
  profitMetric: text("profit_metric").notNull().default("adjusted_ebitda"),
  // Integration-managed columns — NEVER written by a companies update (safe-field rule).
  dataSourceType: text("data_source_type"),
  quickbooksConnected: boolean("quickbooks_connected").notNull().default(false),
  manualUploadActive: boolean("manual_upload_active").notNull().default(false),
  lastSourceSwitchAt: timestamp("last_source_switch_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  status: userStatus("status").notNull().default("active"),
  // Multi-role fields (migration 041). `sub_role` is text at the DB layer (parity).
  subRole: text("sub_role"),
  designation: text("designation"),
  buyerCompanyName: text("buyer_company_name"),
  parentUserId: uuid("parent_user_id"),
  // Profile fields.
  dateOfBirth: date("date_of_birth"),
  occupation: text("occupation"),
  address: text("address"),
  brokerCompany: text("broker_company"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Broker-team invitations: a broker (owner) inviting another broker to their team. */
export const brokerTeamInvites = pgTable(
  "broker_team_invites",
  {
    teamOwnerId: uuid("team_owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedBrokerId: uuid("invited_broker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.teamOwnerId, t.invitedBrokerId] }) }),
);

export const userCompanies = pgTable(
  "user_companies",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.companyId] }) }),
);

export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  otpHash: text("otp_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  resendCount: integer("resend_count").notNull().default(0),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    color: text("color"),
    createdBy: uuid("created_by").notNull(),
    // Soft-delete marker (folders-domain D5): archived when set, live when null.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotent default-folder provisioning relies on this uniqueness instead of
    // the legacy in-process mutex (D2). `parent_id` NULLs are distinct in Postgres,
    // so the coalesce keeps top-level names unique per company too.
    companyParentName: uniqueIndex("folders_company_parent_name_uq").on(
      t.companyId,
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ),
  }),
);

/**
 * Per-folder access grants (folders-domain D4). Exactly one subject — a user OR a
 * group — enforced by the CHECK below (and by the contract/service). Access rows
 * cascade when their folder is deleted.
 */
export const folderAccess = pgTable(
  "folder_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    groupId: uuid("group_id"),
    canRead: boolean("can_read").notNull().default(true),
    canWrite: boolean("can_write").notNull().default(false),
    canDownload: boolean("can_download").notNull().default(false),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneSubject: check(
      "folder_access_one_subject",
      sql`(${t.userId} IS NOT NULL) <> (${t.groupId} IS NOT NULL)`,
    ),
  }),
);

export const documentStatus = pgEnum("document_status", ["active", "processing", "error"]);

/** File blobs, stored in-DB as `bytea` behind the uploads StoragePort (uploads-domain D2). */
export const uploads = pgTable("uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  prefix: text("prefix"),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Folder-scoped document metadata pointing at a stored upload (uploads-domain D3). */
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id")
    .notNull()
    .references(() => folders.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fileUrl: text("file_url"),
  uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
  size: text("size").notNull(),
  ext: text("ext").notNull(),
  status: documentStatus("status").notNull().default("active"),
  uploadedBy: uuid("uploaded_by").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /**
   * Versioning (DR - 0001, migration 0003). The document keeps its identity and
   * points at whichever version is live, so every reference held elsewhere —
   * document_activity, request_documents, file_references, the SPA's tree nodes
   * — keeps resolving, and restore is a pointer swap rather than a blob copy.
   *
   * No `.references()`: a foreign key here would make documents and
   * document_versions mutually dependent at create time, for a guarantee the
   * service already holds.
   */
  currentVersionId: uuid("current_version_id"),
  versionCount: integer("version_count").notNull().default(1),
});

/** Append-only document activity log (uploads-domain D5). */
export const documentActivity = pgTable("document_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The deal activity feed.
 *
 * The table has existed and been written to all along; it was only ever READ
 * through the legacy handler, which queries Supabase. With no Supabase the read
 * fails, `safeQuery` swallows it, and the endpoint answers `200 []` — so three
 * activity panels showed "No activity yet" over rows that were sitting right
 * here. An unreachable data source and an empty one are not the same thing, and
 * the legacy path could not tell them apart.
 */
export const activityType = pgEnum("activity_type", [
  "upload",
  "request",
  "approved",
  "reminder",
]);

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: activityType("type").notNull(),
    message: text("message").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byCompany: index("idx_activity_company").on(table.companyId),
  }),
);

export const requestCategoryEnum = pgEnum("request_category", [
  "Finance",
  "Legal",
  "Compliance",
  "HR",
  "Tax",
  "M&A",
  "Other",
]);
export const responseTypeEnum = pgEnum("response_type", ["Upload", "Narrative", "Both"]);
export const requestPriorityEnum = pgEnum("request_priority", ["critical", "high", "medium", "low"]);
export const requestStatusEnum = pgEnum("request_status", ["pending", "in-review", "completed", "blocked"]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved"]);

/** Broker↔client requests (requests-domain). */
export const requests = pgTable("requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  subLabel: text("sub_label"),
  description: text("description").notNull(),
  category: requestCategoryEnum("category").notNull(),
  responseType: responseTypeEnum("response_type").notNull(),
  priority: requestPriorityEnum("priority").notNull(),
  status: requestStatusEnum("status").notNull().default("pending"),
  dueDate: date("due_date").notNull(),
  assignedTo: uuid("assigned_to"),
  visible: boolean("visible").notNull().default(true),
  reminderFrequencyDays: integer("reminder_frequency_days").notNull().default(7),
  submissionSource: text("submission_source").notNull().default("broker"),
  approvalStatus: approvalStatusEnum("approval_status").notNull().default("approved"),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const requestReminders = pgTable("request_reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => requests.id, { onDelete: "cascade" }),
  sentBy: uuid("sent_by").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const requestNarratives = pgTable("request_narratives", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .unique()
    .references(() => requests.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const requestDocuments = pgTable("request_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => requests.id, { onDelete: "cascade" }),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  visible: boolean("visible").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-company conversation messages (messages-domain). */
export const companyMessages = pgTable("company_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 1:1 direct messages within a company. */
export const directMessages = pgTable("direct_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").notNull(),
  recipientId: uuid("recipient_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Topic message-groups. */
export const messageGroups = pgTable("message_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  groupType: text("group_type").notNull(),
  buyerUserId: uuid("buyer_user_id"),
  autoCreated: boolean("auto_created").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messageGroupMembers = pgTable(
  "message_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => messageGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.userId] }) }),
);

export const groupMessages = pgTable("group_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => messageGroups.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupMessageReads = pgTable(
  "group_message_reads",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => messageGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.userId] }) }),
);

/**
 * Buyer groups (groups-domain) — a company's named groups of buyer users.
 *
 * Distinct from `message_groups` above despite the similar name: those are
 * conversation topics, these are membership sets used to scope who sees what.
 * The SPA lists them per company on the portal dashboard and file explorer.
 *
 * There is deliberately no `updated_at`. The legacy PATCH handler wrote one, and
 * the column has never existed on this table — so that update has always failed
 * against this database. The column is not added back: nothing reads it.
 */
export const buyerGroups = pgTable("buyer_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buyerGroupMembers = pgTable(
  "buyer_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => buyerGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.userId] }) }),
);

/**
 * Server-persisted workspace UI state (workspace-domain).
 *
 * One row per (company, page key), with the payload as opaque JSON — the server
 * never reads inside it. There is deliberately no user column: per-user state is
 * achieved by the caller appending the user id to the page key, which is what
 * makes the same table serve both a private draft and a shared one like the CIM
 * questionnaire.
 */
export const workspacePageState = pgTable(
  "workspace_page_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pageKey: text("page_key").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ companyPage: uniqueIndex("uq_workspace_page_state_company_page").on(t.companyId, t.pageKey) }),
);

/** Key Report versions (reports-domain). Exactly one active version per company (partial unique). */
export const keyReportVersions = pgTable(
  "key_report_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    versionName: text("version_name"),
    status: text("status").notNull().default("draft"),
    isActive: boolean("is_active").notNull().default(false),
    resolvedBatchId: uuid("resolved_batch_id"),
    resolvedDatasetVersion: integer("resolved_dataset_version"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyNumber: uniqueIndex("key_report_versions_company_number_uq").on(t.companyId, t.versionNumber),
    oneActive: uniqueIndex("key_report_versions_one_active_uq")
      .on(t.companyId)
      .where(sql`${t.isActive}`),
  }),
);

/**
 * A Data Room document linked to a category of a key-report version.
 *
 * The unique index is `(version_id, report_category, document_id)`, which is
 * what makes linking the same file twice a no-op rather than a duplicate row —
 * the SPA re-sends the whole selection when a checkbox changes.
 */
export const keyReportFileMappings = pgTable(
  "key_report_file_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => keyReportVersions.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** profit_loss | balance_sheet | general_ledger | bank_statement | tax_return */
    reportCategory: text("report_category").notNull(),
    // Both are ON DELETE SET NULL in the deployed schema: deleting the file
    // leaves the mapping behind as a record that something was once linked
    // here, rather than silently removing the row.
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
    fileName: text("file_name"),
    /** Inferred from the file name at link time; null when none could be read. */
    year: integer("year"),
    status: text("status").notNull().default("linked"),
    linkedBy: uuid("linked_by"),
    metadata: jsonb("metadata").notNull().default({}),
    extractedRows: integer("extracted_rows").default(0),
    extractionStatus: text("extraction_status").default("pending"),
    extractionError: text("extraction_error"),
    lastExtractedAt: timestamp("last_extracted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex("uq_key_report_file_mappings_unique").on(
      t.versionId,
      t.reportCategory,
      t.documentId,
    ),
  }),
);

/**
 * The column mapping somebody confirmed for an uploaded ledger.
 *
 * Detection is a default; a person can correct it, and that correction has to
 * survive. A ledger imported twice under two different mappings is two
 * different sets of figures from one file. See migration 0012.
 */
export const glImportMappings = pgTable(
  "gl_import_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "cascade" }),
    /** field → column name, "" for unmapped. */
    mapping: jsonb("mapping").notNull().default({}),
    /** What detection thought, kept beside what the person chose. */
    detected: jsonb("detected").notNull().default({}),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_gl_import_mappings_upload").on(t.companyId, t.uploadId)],
);

/**
 * A numbered, activatable snapshot of a company's imported financial data.
 *
 * NOT a `keyReportVersions` — that is a reporting configuration and already
 * points at one of these through `resolvedDatasetVersion`. This is the DATA as
 * imported at a moment. See migration 0010.
 *
 * Replaces `dataset_versions` (which legacy created twice, with materially
 * different definitions) and `finalized_datasets` (the same rows again once
 * terminal). One table with a status cannot disagree with itself.
 */
export const datasetVersions = pgTable(
  "dataset_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Per company and source, monotonic. What a person means by "v3". */
    versionNumber: integer("version_number").notNull(),
    label: text("label"),
    sourceKey: text("source_key").notNull().default("manual_gl_upload"),
    /** staging | validating | finalized | failed | rolled_back */
    status: text("status").notNull().default("staging"),
    isActive: boolean("is_active").notNull().default(false),
    syncRunId: uuid("sync_run_id").references(() => syncRuns.id, { onDelete: "set null" }),
    rowCount: integer("row_count").notNull().default(0),
    fiscalYears: integer("fiscal_years").array().notNull().default([]),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_dataset_versions_company_number").on(
      t.companyId,
      t.sourceKey,
      t.versionNumber,
    ),
    uniqueIndex("uq_dataset_versions_one_active").on(t.companyId).where(sql`${t.isActive}`),
    index("idx_dataset_versions_company_recent").on(t.companyId, t.versionNumber),
    check(
      "dataset_versions_status_check",
      sql`${t.status} IN ('staging', 'validating', 'finalized', 'failed', 'rolled_back')`,
    ),
    // Activating something still staging would point every report at
    // half-written data.
    check(
      "dataset_versions_active_is_finalized",
      sql`NOT ${t.isActive} OR ${t.status} = 'finalized'`,
    ),
  ],
);

/**
 * One attempt at pulling a source's data in, and how far it got.
 *
 * Replaces `sync_jobs`, `sync_logs`, `sync_metadata` and `connection_status` —
 * all absent — and the two in-memory Maps that actually served the progress
 * bar. See migration 0009 for why a table rather than a Map.
 *
 * `heartbeatAt` is what a reader compares to now: a process that died holding
 * a `running` row cannot write its own epitaph, so staleness is the reader's
 * judgement rather than a state stored here.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Same vocabulary as `report_source_records.source_key`. */
    sourceKey: text("source_key").notNull(),
    /** documents | quickbooks — what kind of work this is. */
    kind: text("kind").notNull().default("documents"),
    /** queued | running | completed | failed | cancelled */
    status: text("status").notNull().default("queued"),
    totalFiles: integer("total_files").notNull().default(0),
    processedFiles: integer("processed_files").notNull().default(0),
    currentFile: text("current_file"),
    currentStep: text("current_step"),
    /** What it produced. Kept even on a failure — nine imports and one error. */
    result: jsonb("result").notNull().default({}),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sync_runs_company_recent").on(t.companyId, t.startedAt),
    uniqueIndex("uq_sync_runs_one_active")
      .on(t.companyId, t.sourceKey)
      .where(sql`${t.status} IN ('queued', 'running')`),
    check(
      "sync_runs_status_check",
      sql`${t.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "sync_runs_finished_check",
      sql`(${t.status} IN ('completed', 'failed', 'cancelled') AND ${t.finishedAt} IS NOT NULL)
          OR (${t.status} IN ('queued', 'running') AND ${t.finishedAt} IS NULL)`,
    ),
  ],
);

/**
 * A company's link to its QuickBooks Online account.
 *
 * The token columns are named `*Sealed` because they hold ciphertext, not
 * tokens — AES-256-GCM under a key derived from the application secret. See
 * `apps/api/src/shared/secret-box.ts` and migration 0008. Naming them
 * `accessToken` would invite writing a plaintext one in and having it look
 * right.
 */
export const quickbooksConnections = pgTable(
  "quickbooks_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Intuit's identifier for the connected QuickBooks company. */
    realmId: text("realm_id").notNull(),
    realmCompanyName: text("realm_company_name"),
    accessTokenSealed: text("access_token_sealed"),
    refreshTokenSealed: text("refresh_token_sealed"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    /** sandbox | production, per connection rather than per deployment. */
    environment: text("environment").notNull().default("production"),
    oauthClientId: text("oauth_client_id"),
    redirectUri: text("redirect_uri"),
    /** False after a disconnect; the row stays as history. */
    isConnected: boolean("is_connected").notNull().default(true),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    connectedBy: uuid("connected_by").references(() => users.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_quickbooks_connections_company").on(t.companyId),
    uniqueIndex("uq_quickbooks_connections_realm_live")
      .on(t.realmId)
      .where(sql`${t.isConnected}`),
    check(
      "quickbooks_connections_environment_check",
      sql`${t.environment} IN ('sandbox', 'production')`,
    ),
  ],
);

/**
 * What we read out of an uploaded financial statement.
 *
 * One row per document per statement type — a single PDF can carry both a
 * balance sheet and a P&L, and those are two extracts. Re-extracting the same
 * statement from the same file replaces rather than accumulates.
 *
 * Replaces `qb_synced_reports`, whose identity was a jsonb blob the code then
 * filtered on with `report_params->>'documentId'`. See migration 0007.
 */
export const statementExtracts = pgTable(
  "statement_extracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /**
     * The file it was read out of — null when it came from an API pull instead.
     * A row must have this or `syncRunId`; provenance is never nothing.
     */
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    /** The run that pulled it, for a statement that came from an API. */
    syncRunId: uuid("sync_run_id").references(() => syncRuns.id, { onDelete: "set null" }),
    /** Which import it belongs to, so switching dataset version switches these. */
    datasetVersionId: uuid("dataset_version_id").references(() => datasetVersions.id, {
      onDelete: "cascade",
    }),
    /** What the API was asked. Kept so a surprising figure can be traced. */
    reportParams: jsonb("report_params").notNull().default({}),
    /**
     * The identity of a PULLED statement, as one string: source, type, dataset
     * version and period. Null for one read out of a file. Built by the writer
     * so the identity is legible in one place — see migration 0011 for why not
     * an expression index.
     */
    pullKey: text("pull_key"),
    /** balance_sheet | profit_and_loss | cash_flow | bank_reconciliation | tax_return */
    statementType: text("statement_type").notNull(),
    uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
    /** Same vocabulary as `report_source_records.source_key`. */
    sourceKey: text("source_key").notNull().default("manual_upload_excel_pdf"),
    /**
     * Nullable throughout: extraction genuinely fails to find a period, and a
     * guessed one is worse than an absent one. A balance sheet is a moment and
     * carries `asOfDate`; a P&L is a span and carries both ends.
     */
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    asOfDate: date("as_of_date"),
    fiscalYear: integer("fiscal_year"),
    /** The extracted statement. Shape varies by type and extractor. */
    payload: jsonb("payload").notNull().default({}),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    extractedBy: uuid("extracted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two partial indexes, because the identity genuinely differs by
    // provenance: one extract per statement per FILE, and for a pull one per
    // period per dataset version. See migration 0011.
    uniqueIndex("uq_statement_extracts_from_document")
      .on(t.companyId, t.documentId, t.statementType)
      .where(sql`${t.documentId} IS NOT NULL`),
    index("idx_statement_extracts_latest").on(
      t.companyId,
      t.sourceKey,
      t.statementType,
      t.extractedAt,
    ),
    uniqueIndex("uq_statement_extracts_from_pull")
      .on(t.companyId, t.pullKey)
      .where(sql`${t.pullKey} IS NOT NULL`),
    check(
      "statement_extracts_provenance_check",
      sql`${t.documentId} IS NOT NULL OR ${t.syncRunId} IS NOT NULL`,
    ),
    // A pulled statement has a key; a file-sourced one does not. A pull that
    // lost its key would silently start appending a row per sync.
    check(
      "statement_extracts_pull_key_check",
      sql`(${t.documentId} IS NULL) = (${t.pullKey} IS NOT NULL)`,
    ),
    check(
      "statement_extracts_type_check",
      sql`${t.statementType} IN ('balance_sheet', 'profit_and_loss', 'cash_flow', 'bank_reconciliation', 'tax_return')`,
    ),
  ],
);

/**
 * Which set of books a company's reports are read from.
 *
 * One row per source per company, unique on `(company_id, source_key)`, with
 * exactly one carrying `is_selected`. `companies.data_source_type` holds the
 * same answer as a denormalized cache; this table is the authority.
 */
export const reportSourceRecords = pgTable(
  "report_source_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    sourceLabel: text("source_label").notNull().default(""),
    isSelected: boolean("is_selected").notNull().default(false),
    /** Does anything back this source for this company? Derived, not stored truth. */
    isAvailable: boolean("is_available").notNull().default(false),
    isConnected: boolean("is_connected").notNull().default(false),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companySource: uniqueIndex("uq_report_source_records_company_source").on(
      t.companyId,
      t.sourceKey,
    ),
  }),
);

/**
 * A hand-entered correction to one cell of the bank-reconciliation grid.
 *
 * `(company_id, month, row_key)` is unique, which is what makes editing a cell
 * an upsert: the grid saves on blur, so the same cell is written repeatedly and
 * must not accumulate rows.
 */
export const bankReconciliationAdjustments = pgTable(
  "bank_reconciliation_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The column, as the grid labels it — "2024-03". */
    month: text("month").notNull(),
    /** The row, as the grid keys it. */
    rowKey: text("row_key").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cell: uniqueIndex("uq_bank_recon_adjustment").on(t.companyId, t.month, t.rowKey),
  }),
);

/** A named add-back line on the reconciliation, with an amount per month. */
export const bankReconciliationAddbackItems = pgTable(
  "bank_reconciliation_addback_items",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  /** deposits | withdrawals — the two halves of the reconciliation. */
  section: text("section").notNull(),
  name: text("name").notNull(),
  /** manual | derived — where the line came from. */
  source: text("source").notNull().default("manual"),
  /** month → amount, as the grid renders it. */
  monthAmounts: jsonb("month_amounts").notNull().default({}),
  reportSource: text("report_source").notNull().default("quickbooks_online"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "bank_reconciliation_addback_items_section_check",
      sql`${t.section} IN ('deposits', 'withdrawals')`,
    ),
  ],
);

/**
 * One attempt at syncing a version's linked documents into the report tables.
 *
 * Append-only, and read newest-first: the page shows the last few attempts so
 * a failed sync leaves a trail rather than just an unchanged report.
 */
export const keyReportSyncLogs = pgTable("key_report_sync_logs", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  versionId: uuid("version_id")
    .notNull()
    .references(() => keyReportVersions.id, { onDelete: "cascade" }),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  /** started | completed | failed */
  syncStatus: text("sync_status").notNull().default("started"),
  syncStartedAt: timestamp("sync_started_at", { withTimezone: true }).notNull().defaultNow(),
  syncCompletedAt: timestamp("sync_completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata").notNull().default({}),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A per-user setting, keyed by name.
 *
 * The unique index on `(user_id, pref_key)` is what makes writing one an upsert
 * rather than a read-then-write race.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    prefKey: text("pref_key").notNull(),
    prefValue: jsonb("pref_value").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ userKey: uniqueIndex("uq_user_preferences_user_key").on(t.userId, t.prefKey) }),
);

/**
 * What is holding a document in place.
 *
 * A row here is the reason a Data Room file cannot be deleted: some module has
 * linked it to one of its entities. `folders/adapters.ts` already reads this
 * table to report a document's reference count; this is the write side.
 */
export const fileReferences = pgTable("file_references", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull(),
  /** Which module is holding it — "key_reports", and others in time. */
  linkedModule: text("linked_module").notNull(),
  linkedEntityId: uuid("linked_entity_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ── Activity log (SE-0004, capture half) ──────────────────────────────────────
 *
 * One append-only table holds all three record kinds (envelope / event / gap) so
 * they share a single hash chain — a chain per kind would let a whole category be
 * removed without breaking anything.
 *
 * Partitioned monthly by `occurred_at` (design D7): tier-1 writes on every request,
 * so this becomes the largest table in the system, and introducing partitioning
 * later is expensive. A DEFAULT partition always exists, so an insert whose month
 * has no partition still lands rather than erroring — capture must never fail a
 * write because an operator forgot to roll a partition forward.
 *
 * The primary key must include the partition key, hence `(seq, occurred_at)`.
 * `seq` is assigned by the chain head (below), not by a sequence, because the
 * chain and the ordering have to agree.
 *
 * Drizzle has no declarative partitioning, so the physical DDL lives in
 * `activity-ddl.ts`; this declaration is the read/write model over it.
 */
export const activityEvents = pgTable(
  "activity_events",
  {
    seq: bigint("seq", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    correlationId: uuid("correlation_id"),
    actorId: text("actor_id"),
    actorKind: text("actor_kind").notNull(),
    engine: text("engine"),
    method: text("method"),
    rawPath: text("raw_path"),
    path: text("path"),
    status: integer("status"),
    durationMs: integer("duration_ms"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    eventType: text("event_type"),
    subjectId: text("subject_id"),
    companyId: uuid("company_id"),
    payload: jsonb("payload"),
    droppedCount: integer("dropped_count"),
    gapFrom: timestamp("gap_from", { withTimezone: true }),
    gapTo: timestamp("gap_to", { withTimezone: true }),
    reason: text("reason"),
    contentHash: text("content_hash").notNull(),
    prevHash: text("prev_hash"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.seq, t.occurredAt] }),
  }),
);

/**
 * The single-row chain head. Appends lock this row `FOR UPDATE`, so concurrent
 * writers serialize and produce ONE well-formed chain instead of forking it.
 *
 * A row-level lock rather than an advisory lock: it works identically in Postgres
 * and in the PGlite instances the tests run against, and it keeps the chain's
 * state and its mutex in the same place.
 */
export const activityChainHead = pgTable("activity_chain_head", {
  id: integer("id").primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
  lastHash: text("last_hash"),
});

/**
 * Hand corrections to a tax reconciliation.
 *
 * A row per CELL — company, year, line — rather than legacy's one blob per
 * company. These are manual adjustments to figures that end up in a valuation,
 * so "who changed the 2023 meals figure, from what, and when" is the first
 * question anybody asks about a number that moved, and one blob with one
 * `updated_at` cannot answer it for any individual cell.
 *
 * Distinct from `statement_extracts` on purpose: every row there is something
 * a machine READ out of a document, and every row here is something a PERSON
 * TYPED, disagreeing with what the machine read. An extract can be recomputed
 * from its source; a correction cannot be recovered from anything.
 */
export const taxReconciliationOverrides = pgTable(
  "tax_reconciliation_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    fiscalYear: integer("fiscal_year").notNull(),
    /**
     * The reconciling line as it reads on the return. Text rather than a
     * foreign key: these come off whatever the accountant wrote on a Schedule
     * K, and a fixed list would refuse the edit somebody is trying to make.
     */
    lineLabel: text("line_label").notNull(),
    /**
     * The two sides being reconciled, nullable independently: an override
     * often corrects one side and leaves the other as extracted, and a zero
     * would read as "this line really is nil".
     */
    taxReturnAmount: numeric("tax_return_amount", { precision: 18, scale: 2 }),
    bookAmount: numeric("book_amount", { precision: 18, scale: 2 }),
    /**
     * Whether a person added this line rather than correcting one extraction
     * found. A user-added line has no extracted counterpart, so its absence
     * from the return is not a discrepancy.
     */
    userAdded: boolean("user_added").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One correction per line per year; two rows for the same cell would leave
    // the reconciliation picking whichever came back first.
    uniqueIndex("uq_tax_reconciliation_overrides_cell").on(
      t.companyId,
      t.fiscalYear,
      t.lineLabel,
    ),
    index("idx_tax_reconciliation_overrides_company").on(t.companyId, t.fiscalYear),
  ],
);
