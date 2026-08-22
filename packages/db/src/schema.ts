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
