import { z } from "zod";

/**
 * Deal Q&A (`QA - 0001`, `QA - 0002`, `QA - 0003`).
 *
 * Three shapes here encode decisions rather than data, and are worth reading as
 * such:
 *
 *  - There is no `responseUpdate`. `QA - 0002` makes a posted response
 *    permanently immutable, and the cleanest way to enforce that is to give the
 *    system no vocabulary for the operation — no schema, and therefore no route.
 *  - A correction is a `responseCreate` carrying `supersedes_id`, not an edit.
 *  - The broker's rewording is `presentationCreate`, a different object pointing
 *    at a response, never a field on one.
 */

const uuid = z.string().uuid();

// ── categories and nomination ───────────────────────────────────────────────

export const categoryResponse = z.object({
  id: uuid,
  company_id: uuid,
  key: z.string(),
  label: z.string(),
  sort_order: z.number().int(),
  /** Who the seller has put forward to answer this category, in order. */
  nominees: z.array(
    z.object({ user_id: uuid, name: z.string().nullable(), nominated_by: uuid.nullable() }),
  ),
});
export type CategoryResponse = z.infer<typeof categoryResponse>;

/**
 * Replace a category's nominees wholesale.
 *
 * A whole-list PUT rather than add/remove calls: the seller is answering "who
 * handles Finance on this deal", and expressing that as a set avoids the
 * interleaving bugs that two people editing the same roster otherwise produce.
 */
export const nomineesReplace = z.object({
  user_ids: z.array(uuid).max(20),
});
export type NomineesReplace = z.infer<typeof nomineesReplace>;

// ── items ───────────────────────────────────────────────────────────────────

export const itemStatus = z.enum(["open", "answered", "follow_up", "closed"]);
export type ItemStatus = z.infer<typeof itemStatus>;

export const itemPriority = z.enum(["critical", "high", "medium", "low"]);
export type ItemPriority = z.infer<typeof itemPriority>;

/** Where an item came from (`QA - 0003`), for downstream reporting. */
export const itemOrigin = z.enum(["manual", "qe_generator", "cim_guided"]);
export type ItemOrigin = z.infer<typeof itemOrigin>;

export const itemCreate = z.object({
  title: z.string().trim().min(1, "A question needs a title.").max(300),
  body: z.string().trim().min(1, "A question needs a body.").max(20_000),
  category_id: uuid.optional(),
  priority: itemPriority.default("medium"),
  due_date: z.string().date().optional(),
  /**
   * Explicit requestees. Omit to let the category's nominees apply — which is the
   * normal path, and the one that makes nomination worth having.
   */
  requestee_ids: z.array(uuid).max(20).optional(),
  /** Server-supplied context. A client never sets these. */
  origin: itemOrigin.optional(),
  module_tag: z.string().trim().max(80).optional(),
  section_tag: z.string().trim().max(160).optional(),
  account_ref: z.string().trim().max(80).optional(),
  external_ref: z.string().trim().max(200).optional(),
});
export type ItemCreate = z.infer<typeof itemCreate>;

export const itemUpdate = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
    category_id: uuid.nullable(),
    priority: itemPriority,
    status: itemStatus,
    due_date: z.string().date().nullable(),
  })
  .partial();
export type ItemUpdate = z.infer<typeof itemUpdate>;

/** `mine` filters by the viewer's relationship to the item (`QA - 0001`). */
export const itemListQuery = z.object({
  category_id: uuid.optional(),
  status: itemStatus.optional(),
  mine: z.enum(["requestor", "requestee"]).optional(),
});
export type ItemListQuery = z.infer<typeof itemListQuery>;

export const assigneeResponse = z.object({
  user_id: uuid,
  name: z.string().nullable(),
  kind: z.enum(["requestee", "delegate"]),
  assigned_at: z.string(),
});
export type AssigneeResponse = z.infer<typeof assigneeResponse>;

export const itemResponse = z.object({
  id: uuid,
  company_id: uuid,
  category_id: uuid.nullable(),
  category_label: z.string().nullable(),
  reference: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  status: itemStatus,
  priority: itemPriority,
  origin: itemOrigin,
  module_tag: z.string(),
  section_tag: z.string().nullable(),
  account_ref: z.string().nullable(),
  external_ref: z.string().nullable(),
  requestor_id: uuid,
  requestor_name: z.string().nullable(),
  assignees: z.array(assigneeResponse),
  asked_at: z.string(),
  answered_at: z.string().nullable(),
  due_date: z.string().nullable(),
  closed_at: z.string().nullable(),
});
export type ItemResponse = z.infer<typeof itemResponse>;

// ── assignment ──────────────────────────────────────────────────────────────

/**
 * Reassign or delegate. `kind: "delegate"` is the seller redirecting a question
 * within their own side; `requestee` is a straight reassignment. Both land in the
 * same history, because from an audit standpoint they are the same event.
 */
export const assigneesReplace = z.object({
  user_ids: z.array(uuid).min(1, "An item needs at least one requestee.").max(20),
  kind: z.enum(["requestee", "delegate"]).default("requestee"),
  note: z.string().trim().max(500).optional(),
});
export type AssigneesReplace = z.infer<typeof assigneesReplace>;

export const assignmentEventResponse = z.object({
  id: uuid,
  action: z.enum(["assigned", "reassigned", "delegated", "removed", "status_changed"]),
  prior_user_ids: z.array(uuid),
  new_user_ids: z.array(uuid),
  actor_id: uuid,
  actor_name: z.string().nullable(),
  note: z.string().nullable(),
  at: z.string(),
});
export type AssignmentEventResponse = z.infer<typeof assignmentEventResponse>;

// ── responses ───────────────────────────────────────────────────────────────

export const responseKind = z.enum(["answer", "comment", "clarification"]);
export type ResponseKind = z.infer<typeof responseKind>;

/**
 * Post a response. There is deliberately no update or delete counterpart: a
 * posted response is immutable (`QA - 0002`), and `supersedes_id` is how a
 * correction is expressed — as a new response that points at the one it replaces.
 */
export const responseCreate = z.object({
  body: z.string().trim().min(1, "A response needs a body.").max(50_000),
  kind: responseKind.default("answer"),
  supersedes_id: uuid.optional(),
});
export type ResponseCreate = z.infer<typeof responseCreate>;

export const responseResponse = z.object({
  id: uuid,
  item_id: uuid,
  /** Permanent and unique, so a narrative citing this exact text keeps resolving. */
  citation_ref: z.string(),
  kind: responseKind,
  body: z.string(),
  author_id: uuid,
  author_name: z.string().nullable(),
  posted_at: z.string(),
  supersedes_id: uuid.nullable(),
  answer_root_id: uuid.nullable(),
  answer_version: z.number().int().positive(),
  is_current: z.boolean(),
  attachments: z.array(
    z.object({ document_id: uuid, folder_id: uuid.nullable(), name: z.string().nullable() }),
  ),
});
export type ResponseResponse = z.infer<typeof responseResponse>;

// ── presentable versions ────────────────────────────────────────────────────

/**
 * The broker's reworded version of a seller's answer.
 *
 * A separate object pointing at a response, never a field on it — which is what
 * makes it structurally incapable of overwriting what the seller wrote.
 */
export const presentationCreate = z.object({
  source_response_id: uuid,
  body: z.string().trim().min(1, "A presentable version needs a body.").max(50_000),
});
export type PresentationCreate = z.infer<typeof presentationCreate>;

export const presentationResponse = z.object({
  id: uuid,
  item_id: uuid,
  source_response_id: uuid,
  body: z.string(),
  version: z.number().int().positive(),
  is_current: z.boolean(),
  status: z.enum(["draft", "published"]),
  author_id: uuid,
  author_name: z.string().nullable(),
  created_at: z.string(),
});
export type PresentationResponse = z.infer<typeof presentationResponse>;

// ── attachments and visibility ──────────────────────────────────────────────

/**
 * File an answer's evidence into the data room.
 *
 * `folder_id` is required, not optional: `QA - 0003` requires the uploader to
 * choose a destination before the upload completes, so that evidence is filed
 * rather than scattered.
 */
export const attachmentCreate = z.object({
  document_id: uuid,
  folder_id: uuid,
  response_id: uuid.optional(),
});
export type AttachmentCreate = z.infer<typeof attachmentCreate>;

export const visibilityRule = z
  .object({
    user_id: uuid.optional(),
    role_key: z.string().trim().min(1).max(60).optional(),
    effect: z.enum(["hide", "allow"]).default("hide"),
  })
  .refine((r) => (r.user_id === undefined) !== (r.role_key === undefined), {
    message: "A visibility rule names a user or a role, never both and never neither.",
  });
export type VisibilityRule = z.infer<typeof visibilityRule>;

// ── audit ───────────────────────────────────────────────────────────────────

/**
 * One thing that happened to a question.
 *
 * A flattened, chronological view rather than a join of the underlying tables:
 * the question an audit answers is "what happened here, in order", and answering
 * it should not require the reader to interleave three lists by timestamp.
 */
export const auditEntry = z.object({
  at: z.string(),
  kind: z.enum([
    "asked",
    "assigned",
    "reassigned",
    "delegated",
    "answered",
    "corrected",
    "commented",
    "reworded",
    "published",
  ]),
  actor_id: uuid.nullable(),
  actor_name: z.string().nullable(),
  detail: z.string(),
  /** The response or presentation this entry is about, where there is one. */
  citation_ref: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntry>;

export const auditTrail = z.object({
  item_id: uuid,
  reference: z.string().nullable(),
  entries: z.array(auditEntry),
});
export type AuditTrail = z.infer<typeof auditTrail>;

// ── the item detail payload ─────────────────────────────────────────────────

/** Everything an item drawer needs, in one round trip. */
export const itemDetail = z.object({
  item: itemResponse,
  responses: z.array(responseResponse),
  presentations: z.array(presentationResponse),
  history: z.array(assignmentEventResponse),
});
export type ItemDetail = z.infer<typeof itemDetail>;
