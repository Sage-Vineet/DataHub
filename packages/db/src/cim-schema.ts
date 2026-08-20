import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies, documents, uploads, users } from "./schema.js";

/**
 * The CIM builder (`CM - 0001`), at narrative depth.
 *
 * Relational spine, `jsonb` leaves: real tables for anything needing a version
 * axis or an identity, and `cimBlocks.content` holding exactly the value shape
 * the existing SPA renderer already understands. Mirrors
 * `migrations/0004_cim.sql`, which is the authority.
 */

export const cimDecks = pgTable(
  "cim_decks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    templateKey: text("template_key").notNull().default("source-38"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    byCompany: index("idx_cim_decks_company").on(t.companyId, t.deletedAt),
  }),
);

/**
 * One version of a deck.
 *
 * `status` is the write lock — anything past `in_review` refuses mutation — and
 * the partial unique index allows at most one unpublished version per deck, so
 * "the draft" is never ambiguous.
 */
export const cimVersions = pgTable(
  "cim_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deckId: uuid("deck_id")
      .notNull()
      .references(() => cimDecks.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    status: text("status").notNull().default("draft"),
    cover: jsonb("cover").notNull().default(sql`'{}'::jsonb`),
    theme: jsonb("theme").notNull().default(sql`'{}'::jsonb`),
    /** Recorded and shown, but NOT gating publication — see the change's Non-goals. */
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perDeck: uniqueIndex("cim_versions_deck_id_version_no_key").on(t.deckId, t.versionNo),
    statusValues: check(
      "cim_versions_status_check",
      sql`${t.status} IN ('draft', 'in_review', 'seller_approved', 'published', 'archived')`,
    ),
  }),
);

export const cimSections = pgTable(
  "cim_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => cimVersions.id, { onDelete: "cascade" }),
    sectionKey: text("section_key").notNull(),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => ({
    perVersion: uniqueIndex("cim_sections_version_id_section_key_key").on(
      t.versionId,
      t.sectionKey,
    ),
  }),
);

export const cimSlides = pgTable(
  "cim_slides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => cimVersions.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => cimSections.id, { onDelete: "cascade" }),
    /** Declared though no exhibit ships: adding the axis later means a migration. */
    slideClass: text("slide_class").notNull().default("qualitative"),
    layoutKey: text("layout_key").notNull(),
    slideNo: integer("slide_no").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => ({
    perVersion: uniqueIndex("cim_slides_version_id_sort_order_key").on(t.versionId, t.sortOrder),
    bySection: index("idx_cim_slides_section").on(t.sectionId, t.sortOrder),
    classValues: check(
      "cim_slides_slide_class_check",
      sql`${t.slideClass} IN ('qualitative', 'financial_exhibit')`,
    ),
  }),
);

/**
 * One addressable piece of slide content.
 *
 * `blockKey` is the SPA's existing field id verbatim — the fact that makes the
 * god-file a re-point rather than a rewrite.
 *
 * `contentClass` is required by `CM - 0002`, which states `CM - 0001` must carry
 * it; `contentClassLocked` is set permanently when an answer or an import
 * populates a block, so deal content can never be reclassified as firm
 * boilerplate and travel into another company's template.
 */
export const cimBlocks = pgTable(
  "cim_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => cimVersions.id, { onDelete: "cascade" }),
    slideId: uuid("slide_id")
      .notNull()
      .references(() => cimSlides.id, { onDelete: "cascade" }),
    blockKey: text("block_key").notNull(),
    kind: text("kind").notNull().default("text"),
    label: text("label"),
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    contentClass: text("content_class").notNull().default("deal"),
    contentClassLocked: boolean("content_class_locked").notNull().default(false),
    populatedBy: text("populated_by"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perVersion: uniqueIndex("cim_blocks_version_id_block_key_key").on(t.versionId, t.blockKey),
    byGap: index("idx_cim_blocks_gaps").on(t.versionId, t.populatedBy),
    classValues: check(
      "cim_blocks_content_class_check",
      sql`${t.contentClass} IN ('deal', 'firm_boilerplate')`,
    ),
  }),
);

/** The question library (`CM - 0004`), scoped as `CM - 0002` scopes templates. */
export const cimQuestionLibrary = pgTable(
  "cim_question_library",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull().default("system"),
    ownerId: uuid("owner_id"),
    sectionKey: text("section_key").notNull(),
    layoutKey: text("layout_key"),
    blockKeyPattern: text("block_key_pattern"),
    questionText: text("question_text").notNull(),
    helpText: text("help_text"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    lookup: index("idx_cim_question_library_lookup").on(t.scope, t.sectionKey, t.archivedAt),
    scopeValues: check(
      "cim_question_library_scope_check",
      sql`${t.scope} IN ('system', 'firm', 'user')`,
    ),
  }),
);

/**
 * Where a block's content came from.
 *
 * `rawAnswer` holds what the respondent actually submitted, kept even where the
 * broker edited it before accepting — so "who said this" survives the edit that
 * made it presentable. A discarded answer is recorded here too and never
 * deleted.
 */
export const cimBlockProvenance = pgTable(
  "cim_block_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockId: uuid("block_id")
      .notNull()
      .references(() => cimBlocks.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    /** Opaque ids from the Q&A module — this module never joins across to it. */
    qaItemId: text("qa_item_id"),
    qaResponseId: text("qa_response_id"),
    respondentId: uuid("respondent_id").references(() => users.id, { onDelete: "set null" }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").notNull().default("accepted"),
    rawAnswer: text("raw_answer"),
  },
  (t) => ({
    byBlock: index("idx_cim_block_provenance_block").on(t.blockId),
    sourceValues: check(
      "cim_block_provenance_source_check",
      sql`${t.source} IN ('qa_answer', 'loader', 'autofill', 'broker')`,
    ),
    outcomeValues: check(
      "cim_block_provenance_outcome_check",
      sql`${t.outcome} IN ('accepted', 'discarded')`,
    ),
  }),
);

/**
 * The published artifact.
 *
 * Content-addressed, so "did this version change" is a hash comparison rather
 * than an assertion — which is what makes the freeze checkable.
 */
export const cimPublications = pgTable("cim_publications", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id")
    .notNull()
    .unique()
    .references(() => cimVersions.id, { onDelete: "cascade" }),
  uploadId: uuid("upload_id").references(() => uploads.id, { onDelete: "set null" }),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  sha256: text("sha256").notNull(),
  pageCount: integer("page_count"),
  byteSize: bigint("byte_size", { mode: "number" }),
  publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});
