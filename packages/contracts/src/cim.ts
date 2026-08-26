import { z } from "zod";

/**
 * The CIM builder (`CM - 0001`), at narrative depth.
 *
 * Two shapes here carry decisions:
 *
 *  - `blockContent` is `jsonb` holding exactly what the existing renderer already
 *    understands. Keeping the leaf opaque is what lets the 5,000-line editor be
 *    re-pointed at a real schema rather than rewritten.
 *  - `acceptAnswer.mode` defaults to `skip`. `CM - 0004` requires that existing
 *    content is never overwritten without an explicit choice, and a default of
 *    `replace` would quietly destroy authored work the first time a broker
 *    accepted onto a filled block.
 */

const uuid = z.string().uuid();

export const deckStatus = z.enum([
  "draft",
  "in_review",
  "seller_approved",
  "published",
  "archived",
]);
export type DeckStatus = z.infer<typeof deckStatus>;

export const slideClass = z.enum(["qualitative", "financial_exhibit"]);
export type SlideClass = z.infer<typeof slideClass>;

/** `CM - 0002` requires `CM - 0001` to carry this; only boilerplate reaches a template. */
export const contentClass = z.enum(["deal", "firm_boilerplate"]);
export type ContentClass = z.infer<typeof contentClass>;

export const populatedBy = z.enum(["author", "answer", "loader", "autofill"]);
export type PopulatedBy = z.infer<typeof populatedBy>;

// ── decks and versions ──────────────────────────────────────────────────────

export const deckCreate = z.object({
  name: z.string().trim().min(1, "A CIM needs a name.").max(200),
  template_key: z.string().trim().max(80).optional(),
});
export type DeckCreate = z.infer<typeof deckCreate>;

export const deckSummary = z.object({
  id: uuid,
  company_id: uuid,
  name: z.string(),
  template_key: z.string(),
  current_version_id: uuid.nullable(),
  current_version_no: z.number().int().nullable(),
  current_status: deckStatus.nullable(),
  created_at: z.string(),
});
export type DeckSummary = z.infer<typeof deckSummary>;

export const versionSummary = z.object({
  id: uuid,
  deck_id: uuid,
  version_no: z.number().int().positive(),
  status: deckStatus,
  published_at: z.string().nullable(),
  published_by: uuid.nullable(),
  approved_at: z.string().nullable(),
  approved_by: uuid.nullable(),
  sha256: z.string().nullable(),
  document_id: uuid.nullable(),
  created_at: z.string(),
});
export type VersionSummary = z.infer<typeof versionSummary>;

// ── slides and blocks ───────────────────────────────────────────────────────

/**
 * Block content, left opaque on purpose.
 *
 * The renderer already knows how to read a field value; re-describing that shape
 * here would mean two definitions of it drifting apart, and would make every new
 * layout a contract change.
 */
export const blockContent = z.unknown();

export const blockResponse = z.object({
  id: uuid,
  slide_id: uuid,
  block_key: z.string(),
  kind: z.enum(["text", "image", "table", "chart", "repeatable"]),
  label: z.string().nullable(),
  content: blockContent,
  content_class: contentClass,
  content_class_locked: z.boolean(),
  populated_by: populatedBy.nullable(),
  updated_at: z.string(),
});
export type BlockResponse = z.infer<typeof blockResponse>;

export const slideResponse = z.object({
  id: uuid,
  section_id: uuid,
  slide_class: slideClass,
  layout_key: z.string(),
  slide_no: z.number().int(),
  sort_order: z.number().int(),
  blocks: z.array(blockResponse),
});
export type SlideResponse = z.infer<typeof slideResponse>;

export const sectionResponse = z.object({
  id: uuid,
  section_key: z.string(),
  title: z.string(),
  sort_order: z.number().int(),
  slides: z.array(slideResponse),
});
export type SectionResponse = z.infer<typeof sectionResponse>;

/** Everything the editor needs to render a deck, in one round trip. */
export const versionDetail = z.object({
  version: versionSummary,
  cover: z.record(z.string(), z.unknown()),
  theme: z.record(z.string(), z.unknown()),
  sections: z.array(sectionResponse),
});
export type VersionDetail = z.infer<typeof versionDetail>;

/** The editor's save: whichever blocks changed, keyed the way the SPA keys them. */
export const blockBulkUpsert = z.object({
  cover: z.record(z.string(), z.unknown()).optional(),
  blocks: z
    .array(
      z.object({
        block_key: z.string().min(1),
        content: blockContent,
        content_class: contentClass.optional(),
      }),
    )
    .max(2000),
});
export type BlockBulkUpsert = z.infer<typeof blockBulkUpsert>;

// ── guided Q&A (CM - 0004) ──────────────────────────────────────────────────

/**
 * One unfilled block, with the question that would fill it.
 *
 * `unmapped` marks a gap the library has no question for. `CM - 0004` requires
 * those to be surfaced rather than skipped — a silently omitted gap is how a deck
 * reports itself complete while a slide is still blank.
 */
export const gapResponse = z.object({
  block_id: uuid,
  block_key: z.string(),
  section_key: z.string(),
  slide_no: z.number().int(),
  label: z.string().nullable(),
  question_text: z.string().nullable(),
  unmapped: z.boolean(),
});
export type GapResponse = z.infer<typeof gapResponse>;

export const generateRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  questions: z
    .array(
      z.object({
        block_id: uuid,
        /** Reworded by the broker; the library question is not modified. */
        text: z.string().trim().min(1).max(2000),
        assignee_user_id: uuid.optional(),
      }),
    )
    .min(1, "A request needs at least one question.")
    .max(200),
});
export type GenerateRequest = z.infer<typeof generateRequest>;

export const generateResult = z.object({
  created: z.number().int().nonnegative(),
  items: z.array(z.object({ block_id: uuid, qa_item_id: z.string() })),
});
export type GenerateResult = z.infer<typeof generateResult>;

export const reviewItem = z.object({
  block_id: uuid,
  block_key: z.string(),
  section_key: z.string(),
  question_text: z.string(),
  answer_text: z.string(),
  qa_item_id: z.string(),
  qa_response_id: z.string(),
  respondent_id: uuid.nullable(),
  respondent_name: z.string().nullable(),
  submitted_at: z.string(),
  block_has_content: z.boolean(),
});
export type ReviewItem = z.infer<typeof reviewItem>;

/**
 * Accept an answer onto a block.
 *
 * `mode` defaults to `skip`, which is the whole point: `CM - 0004` requires an
 * explicit choice before existing content is touched, and a default that
 * overwrote would destroy authored work the first time it was used carelessly.
 */
export const acceptAnswer = z.object({
  qa_item_id: z.string().min(1),
  qa_response_id: z.string().min(1),
  mode: z.enum(["replace", "append", "skip"]).default("skip"),
  /** Broker's edit. The respondent's original is preserved as provenance. */
  text: z.string().trim().max(50_000).optional(),
});
export type AcceptAnswer = z.infer<typeof acceptAnswer>;

export const discardAnswer = z.object({
  qa_item_id: z.string().min(1),
  qa_response_id: z.string().min(1),
});
export type DiscardAnswer = z.infer<typeof discardAnswer>;

export const questionLibraryEntry = z.object({
  id: uuid,
  scope: z.enum(["system", "firm", "user"]),
  section_key: z.string(),
  block_key_pattern: z.string().nullable(),
  question_text: z.string(),
  help_text: z.string().nullable(),
  sort_order: z.number().int(),
});
export type QuestionLibraryEntry = z.infer<typeof questionLibraryEntry>;

// ── publication ─────────────────────────────────────────────────────────────

export const publishResult = z.object({
  version_id: uuid,
  version_no: z.number().int().positive(),
  status: deckStatus,
  sha256: z.string(),
  document_id: uuid,
  upload_id: uuid,
  published_at: z.string(),
});
export type PublishResult = z.infer<typeof publishResult>;

/** What blocks a clean release — the pre-publish check `CM - 0001` §6 describes. */
export const deckHealth = z.object({
  unpopulated_blocks: z.number().int().nonnegative(),
  unmapped_gaps: z.number().int().nonnegative(),
  outstanding_questions: z.number().int().nonnegative(),
  seller_approved: z.boolean(),
  publishable: z.boolean(),
});
export type DeckHealth = z.infer<typeof deckHealth>;
