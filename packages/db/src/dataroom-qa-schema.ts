import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies, documents, folders, uploads, users } from "./schema.js";

/**
 * Data room versioning, comments and chunked upload (DR - 0001), and the deal
 * Q&A module (QA - 0001 / 0002 / 0003).
 *
 * The declarations mirror `migrations/0003_dataroom_qa.sql`, which is the
 * authority — that file is applied, this one is read. They live outside
 * `schema.ts` for the same reason `qoe-schema.ts` does: schema.ts holds the
 * tables the earlier cut-over domains touch, and appending two capabilities to
 * it makes a file nobody can scan.
 *
 * `text` + CHECK rather than pgEnum throughout, deviating from schema.ts's
 * style. PGlite integration tests hand-write DDL per file, enum ALTER is awkward
 * across that boundary, and the zod contracts are the real validation edge here.
 */

/** Postgres `bytea` — upload chunks are staged in-DB, like uploads themselves. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ── data room ───────────────────────────────────────────────────────────────

/**
 * One version of a document's content.
 *
 * `documents` keeps the stable identity — everything from `document_activity` to
 * `file_references` to the SPA's tree nodes points at `documents.id` — and
 * carries `current_version_id` as a mutable pointer at whichever version is live.
 * Restoring an old version therefore copies a pointer, not bytes.
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    contentType: text("content_type"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perDocument: uniqueIndex("document_versions_document_id_version_no_key").on(
      t.documentId,
      t.versionNo,
    ),
    byDocument: index("idx_document_versions_doc").on(t.documentId, t.versionNo),
  }),
);

/**
 * Comment threads on a document.
 *
 * `visibility` carries the entire access rule: `internal` is readable only by
 * broker and admin roles, `shared` by anyone who can read the document. The
 * predicate belongs in the query, never in the component.
 */
export const documentComments = pgTable(
  "document_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    versionId: uuid("version_id").references(() => documentVersions.id, { onDelete: "set null" }),
    parentId: uuid("parent_id"),
    body: text("body").notNull(),
    visibility: text("visibility").notNull().default("internal"),
    pageNumber: integer("page_number"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    byDocument: index("idx_document_comments_doc").on(t.documentId, t.createdAt),
    visibilityValues: check(
      "document_comments_visibility_check",
      sql`${t.visibility} IN ('internal', 'shared')`,
    ),
  }),
);

/**
 * A chunked upload in flight.
 *
 * `documentId` set means this upload is a new VERSION of that document rather
 * than a new document — which is how a same-name re-upload becomes a version
 * without the client deciding.
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    chunkSize: integer("chunk_size").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    receivedCount: integer("received_count").notNull().default(0),
    status: text("status").notNull().default("open"),
    uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byExpiry: index("idx_upload_sessions_expiry").on(t.status, t.expiresAt),
    statusValues: check(
      "upload_sessions_status_check",
      sql`${t.status} IN ('open', 'completed', 'aborted')`,
    ),
  }),
);

/**
 * Staged chunk bytes.
 *
 * Keyed by (session, index) so a re-sent chunk is an upsert — that idempotency
 * IS the resume mechanism, and assembly is a single `string_agg` ordered by
 * index, so no file is ever materialized in Node.
 */
export const uploadChunks = pgTable(
  "upload_chunks",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.chunkIndex] }),
  }),
);

// ── deal Q&A ────────────────────────────────────────────────────────────────

/**
 * Q&A categories, per company.
 *
 * Rows rather than a pgEnum because the seller nominates answerers per category
 * per deal, and an enum cannot carry a nomination.
 */
export const qaCategories = pgTable(
  "qa_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perCompany: uniqueIndex("qa_categories_company_id_key_key").on(t.companyId, t.key),
  }),
);

/**
 * The seller's nomination of who answers a category.
 *
 * Supplies the DEFAULT requestee at item creation. QA-0001's "any deal member may
 * reassign, and it is logged" still applies, so this extends broker assignment
 * rather than replacing it.
 */
export const qaNominations = pgTable(
  "qa_nominations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => qaCategories.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nominatedBy: uuid("nominated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    perCategory: uniqueIndex("qa_nominations_category_id_user_id_key").on(t.categoryId, t.userId),
  }),
);

/** A tracked question on a deal. */
export const qaItems = pgTable(
  "qa_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => qaCategories.id, { onDelete: "set null" }),
    reference: text("reference"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("open"),
    priority: text("priority").notNull().default("medium"),
    /** QA-0003 source of origin: manual, qe_generator, or cim_guided. */
    origin: text("origin").notNull().default("manual"),
    /** QA-0002 structured metadata. Defaults to Unclassified, never null, so no
     *  item is silently dropped from the tagging pipeline. */
    moduleTag: text("module_tag").notNull().default("Unclassified"),
    sectionTag: text("section_tag"),
    accountRef: text("account_ref"),
    /**
     * Opaque to this module. The CIM builder writes a block id here and this
     * module never learns what a CIM is — one column is the whole contract.
     */
    externalRef: text("external_ref"),
    requestorId: uuid("requestor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    dueDate: date("due_date"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("idx_qa_items_company_status").on(t.companyId, t.status),
    byCategory: index("idx_qa_items_company_category").on(t.companyId, t.categoryId),
    statusValues: check(
      "qa_items_status_check",
      sql`${t.status} IN ('open', 'answered', 'follow_up', 'closed')`,
    ),
    originValues: check(
      "qa_items_origin_check",
      sql`${t.origin} IN ('manual', 'qe_generator', 'cim_guided')`,
    ),
  }),
);

/** Who is accountable for answering. Many per item. */
export const qaAssignees = pgTable(
  "qa_assignees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => qaItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("requestee"),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    perItem: uniqueIndex("qa_assignees_item_id_user_id_kind_key").on(t.itemId, t.userId, t.kind),
    kindValues: check("qa_assignees_kind_check", sql`${t.kind} IN ('requestee', 'delegate')`),
  }),
);

/** Every assignment change, with who moved it and from what to what (QA-0001). */
export const qaAssignmentEvents = pgTable(
  "qa_assignment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => qaItems.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    priorUserIds: uuid("prior_user_ids").array().notNull().default(sql`'{}'`),
    newUserIds: uuid("new_user_ids").array().notNull().default(sql`'{}'`),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byItem: index("idx_qa_assignment_events_item").on(t.itemId, t.at),
  }),
);

/**
 * Responses. INSERT-ONLY — there is no update path anywhere in the module, so
 * QA-0002's immutability is enforced by the absence of a route rather than by a
 * guard inside one.
 *
 * A correction is a new row with `supersedesId` and an incremented
 * `answerVersion`; the only mutation is flipping the prior row's `isCurrent`.
 * Every version keeps its own `citationRef`, so a narrative citing v1 still
 * resolves — QA-0002's "a follow-up does not invalidate a narrative", by
 * construction rather than by policy.
 */
export const qaResponses = pgTable(
  "qa_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => qaItems.id, { onDelete: "cascade" }),
    citationRef: text("citation_ref").notNull(),
    kind: text("kind").notNull().default("answer"),
    body: text("body").notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesId: uuid("supersedes_id"),
    answerRootId: uuid("answer_root_id"),
    answerVersion: integer("answer_version").notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(true),
  },
  (t) => ({
    citation: uniqueIndex("qa_responses_citation_uq").on(t.citationRef),
    byItem: index("idx_qa_responses_item").on(t.itemId, t.postedAt),
    kindValues: check(
      "qa_responses_kind_check",
      sql`${t.kind} IN ('answer', 'comment', 'clarification')`,
    ),
  }),
);

/**
 * The broker's reworded, presentation-ready version of an answer.
 *
 * A separate table, so it is physically incapable of overwriting what the seller
 * wrote. Versioned on its own counter; only a published one is offered onward.
 */
export const qaPresentations = pgTable(
  "qa_presentations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => qaItems.id, { onDelete: "cascade" }),
    sourceResponseId: uuid("source_response_id")
      .notNull()
      .references(() => qaResponses.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    version: integer("version").notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(true),
    status: text("status").notNull().default("draft"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byItem: index("idx_qa_presentations_item").on(t.itemId, t.version),
    statusValues: check(
      "qa_presentations_status_check",
      sql`${t.status} IN ('draft', 'published')`,
    ),
  }),
);

/** An answer's evidence, filed into the data room and reachable from either side. */
export const qaAttachments = pgTable(
  "qa_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => qaItems.id, { onDelete: "cascade" }),
    responseId: uuid("response_id").references(() => qaResponses.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perResponse: uniqueIndex("qa_attachments_response_id_document_id_key").on(
      t.responseId,
      t.documentId,
    ),
  }),
);

/**
 * Per-item visibility override (QA-0003). Names a user xor a role, never both —
 * the same exclusive-subject idiom `folder_access` uses.
 */
export const qaItemVisibility = pgTable(
  "qa_item_visibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => qaItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key"),
    effect: text("effect").notNull().default("hide"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byItem: index("idx_qa_item_visibility_item").on(t.itemId),
    subject: check(
      "qa_item_visibility_subject",
      sql`(${t.userId} IS NOT NULL) <> (${t.roleKey} IS NOT NULL)`,
    ),
  }),
);
