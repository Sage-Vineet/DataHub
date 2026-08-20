import type { ItemOrigin, ItemPriority, ItemStatus, ResponseKind } from "@datahub/contracts";

/**
 * Deal Q&A (`QA - 0001`, `QA - 0002`, `QA - 0003`).
 *
 * Two shapes here are load-bearing and worth reading before the rest:
 *
 *  - `ResponsesRepository` has no update and no delete. A posted response is
 *    permanently immutable, and the enforcement is the absence of the operation
 *    rather than a guard inside one. A correction is `append` with a
 *    `supersedesId`.
 *  - The broker's rewording is a `PresentationsRepository` row pointing at a
 *    response, never a column on it.
 */

// ── categories and nomination ───────────────────────────────────────────────

export interface CategoryRecord {
  id: string;
  companyId: string;
  key: string;
  label: string;
  sortOrder: number;
}

export interface NomineeRecord {
  userId: string;
  name: string | null;
  nominatedBy: string | null;
}

export interface CategoriesRepository {
  listFor(companyId: string): Promise<CategoryRecord[]>;
  nomineesFor(companyId: string): Promise<Map<string, NomineeRecord[]>>;
  /** Replace a category's nominees wholesale — a set, not a sequence of edits. */
  replaceNominees(categoryId: string, userIds: string[], actorId: string): Promise<void>;
  getById(categoryId: string): Promise<CategoryRecord | null>;
  /**
   * Create a company's default categories if it has none.
   *
   * Provisioned on first use rather than at company creation, because the
   * migration that introduced categories could only backfill companies that
   * already existed — anything created afterwards would otherwise have none.
   * Idempotent, so concurrent first reads cannot double up.
   */
  ensureDefaults(companyId: string): Promise<void>;
}

// ── items ───────────────────────────────────────────────────────────────────

export interface ItemRecord {
  id: string;
  companyId: string;
  categoryId: string | null;
  categoryLabel: string | null;
  reference: string | null;
  title: string;
  body: string;
  status: ItemStatus;
  priority: ItemPriority;
  origin: ItemOrigin;
  moduleTag: string;
  sectionTag: string | null;
  accountRef: string | null;
  externalRef: string | null;
  requestorId: string;
  requestorName: string | null;
  askedAt: string;
  answeredAt: string | null;
  dueDate: string | null;
  closedAt: string | null;
}

export interface AssigneeRecord {
  userId: string;
  name: string | null;
  kind: "requestee" | "delegate";
  assignedAt: string;
}

export interface CreateItemInput {
  companyId: string;
  categoryId: string | null;
  title: string;
  body: string;
  priority: ItemPriority;
  origin: ItemOrigin;
  moduleTag: string;
  sectionTag: string | null;
  accountRef: string | null;
  externalRef: string | null;
  dueDate: string | null;
  requestorId: string;
  createdBy: string;
  reference: string;
}

export interface ItemFilter {
  categoryId?: string;
  status?: ItemStatus;
  /** Restrict to items the viewer raised, or is accountable for. */
  mine?: { userId: string; as: "requestor" | "requestee" };
  /** Users whose per-item overrides must be honoured — applied in the query. */
  viewer: { userId: string; roleKey: string };
}

export interface ItemsRepository {
  list(companyId: string, filter: ItemFilter): Promise<ItemRecord[]>;
  getById(itemId: string): Promise<ItemRecord | null>;
  create(input: CreateItemInput): Promise<ItemRecord>;
  update(
    itemId: string,
    patch: Partial<{
      title: string;
      body: string;
      categoryId: string | null;
      priority: ItemPriority;
      status: ItemStatus;
      dueDate: string | null;
    }>,
  ): Promise<ItemRecord | null>;
  markAnswered(itemId: string, at: Date): Promise<void>;
  /** Next human reference for a company, e.g. `QA-014`. */
  nextReference(companyId: string): Promise<string>;
  /** Is this item hidden from the viewer by a per-item override? */
  isHiddenFrom(itemId: string, userId: string, roleKey: string): Promise<boolean>;
  setVisibilityRule(input: {
    itemId: string;
    userId: string | null;
    roleKey: string | null;
    effect: "hide" | "allow";
    createdBy: string;
  }): Promise<void>;
}

// ── assignment ──────────────────────────────────────────────────────────────

export interface AssignmentEventRecord {
  id: string;
  action: "assigned" | "reassigned" | "delegated" | "removed" | "status_changed";
  priorUserIds: string[];
  newUserIds: string[];
  actorId: string;
  actorName: string | null;
  note: string | null;
  at: string;
}

export interface AssigneesRepository {
  listFor(itemId: string): Promise<AssigneeRecord[]>;
  /** Replace the live set and record the change as one event. */
  replace(input: {
    itemId: string;
    userIds: string[];
    kind: "requestee" | "delegate";
    actorId: string;
    note: string | null;
  }): Promise<AssigneeRecord[]>;
  history(itemId: string): Promise<AssignmentEventRecord[]>;
}

// ── responses and presentations ─────────────────────────────────────────────

export interface ResponseRecord {
  id: string;
  itemId: string;
  citationRef: string;
  kind: ResponseKind;
  body: string;
  authorId: string;
  authorName: string | null;
  postedAt: string;
  supersedesId: string | null;
  answerRootId: string | null;
  answerVersion: number;
  isCurrent: boolean;
  attachments: Array<{ documentId: string; folderId: string | null; name: string | null }>;
}

export interface AppendResponseInput {
  itemId: string;
  body: string;
  kind: ResponseKind;
  authorId: string;
  supersedesId: string | null;
  citationRef: string;
}

/**
 * Insert-only. There is no `update` and no `delete`, and there must not be:
 * `QA - 0002` makes a posted response permanently immutable, and a repository
 * that cannot express the operation cannot be talked into it later.
 */
export interface ResponsesRepository {
  listFor(itemId: string): Promise<ResponseRecord[]>;
  getById(responseId: string): Promise<ResponseRecord | null>;
  append(input: AppendResponseInput): Promise<ResponseRecord>;
  /** Next citation suffix for an item, so references never collide. */
  nextCitationRef(itemId: string, itemReference: string): Promise<string>;
  attach(input: {
    itemId: string;
    responseId: string | null;
    documentId: string;
    folderId: string;
    createdBy: string;
  }): Promise<void>;
}

export interface PresentationRecord {
  id: string;
  itemId: string;
  sourceResponseId: string;
  body: string;
  version: number;
  isCurrent: boolean;
  status: "draft" | "published";
  authorId: string;
  authorName: string | null;
  createdAt: string;
}

export interface PresentationsRepository {
  listFor(itemId: string): Promise<PresentationRecord[]>;
  getById(id: string): Promise<PresentationRecord | null>;
  append(input: {
    itemId: string;
    sourceResponseId: string;
    body: string;
    authorId: string;
  }): Promise<PresentationRecord>;
  publish(id: string): Promise<PresentationRecord | null>;
}

// ── cross-module ports ──────────────────────────────────────────────────────

/**
 * Who is actually on this deal.
 *
 * This is what enforces `QA - 0001`'s "no cross-deal assignment": a requestee has
 * to be a live member of the same company, checked here rather than trusted from
 * the request body.
 */
export interface DealMemberPort {
  isMember(companyId: string, userId: string): Promise<boolean>;
  listMembers(companyId: string): Promise<Array<{ id: string; name: string | null }>>;
}

/**
 * Filing an answer's evidence into the data room.
 *
 * Injected as a null adapter when the data room capability is switched off, so
 * attachment routes report unavailable while every other Q&A route keeps working.
 * A kill switch that takes out a neighbouring feature entirely is not a kill
 * switch.
 */
export interface DataRoomAttachmentPort {
  describe(
    documentId: string,
  ): Promise<{ id: string; companyId: string; folderId: string; name: string } | null>;
  available: boolean;
}

export interface QaActivityPort {
  emit(event: {
    type:
      | "qa.item.created"
      | "qa.response.posted"
      | "qa.assignment.changed"
      | "qa.presentation.published";
    companyId: string;
    subjectId: string;
    actorId: string | null;
  }): void;
}
