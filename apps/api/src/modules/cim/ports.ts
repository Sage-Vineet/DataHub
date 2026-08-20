import type { ContentClass, PopulatedBy, SlideClass } from "@datahub/contracts";

/**
 * The CIM builder (`CM - 0001`), at narrative depth.
 *
 * The seam worth understanding before the rest: `QaPort`. `CM - 0004`'s guided
 * questions could have been built privately here — the SPA already has a
 * questionnaire stored as a JSON blob — and that is precisely what must not
 * happen again. It would be the fourth unrelated "ask someone for information"
 * system in this codebase. So the CIM owns the two ends (which blocks are empty,
 * and what to do with an answer) and delegates the middle.
 */

export interface DeckRecord {
  id: string;
  companyId: string;
  name: string;
  templateKey: string;
  createdAt: string;
}

export interface VersionRecord {
  id: string;
  deckId: string;
  versionNo: number;
  status: "draft" | "in_review" | "seller_approved" | "published" | "archived";
  cover: Record<string, unknown>;
  theme: Record<string, unknown>;
  approvedBy: string | null;
  approvedAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface SectionRecord {
  id: string;
  versionId: string;
  sectionKey: string;
  title: string;
  sortOrder: number;
}

export interface SlideRecord {
  id: string;
  versionId: string;
  sectionId: string;
  slideClass: SlideClass;
  layoutKey: string;
  slideNo: number;
  sortOrder: number;
}

export interface BlockRecord {
  id: string;
  versionId: string;
  slideId: string;
  blockKey: string;
  kind: "text" | "image" | "table" | "chart" | "repeatable";
  label: string | null;
  content: unknown;
  contentClass: ContentClass;
  contentClassLocked: boolean;
  populatedBy: PopulatedBy | null;
  updatedAt: string;
}

export interface DecksRepository {
  listFor(companyId: string): Promise<
    Array<DeckRecord & { currentVersion: VersionRecord | null; sha256: string | null; documentId: string | null }>
  >;
  getById(deckId: string): Promise<DeckRecord | null>;
  create(input: {
    companyId: string;
    name: string;
    templateKey: string;
    createdBy: string;
  }): Promise<DeckRecord>;
  versionsFor(deckId: string): Promise<
    Array<VersionRecord & { sha256: string | null; documentId: string | null }>
  >;
}

export interface VersionsRepository {
  getById(versionId: string): Promise<VersionRecord | null>;
  /** The one draft or in-review version, if the deck has one. */
  openVersionFor(deckId: string): Promise<VersionRecord | null>;
  create(input: {
    deckId: string;
    versionNo: number;
    cover: Record<string, unknown>;
    theme: Record<string, unknown>;
  }): Promise<VersionRecord>;
  setCover(versionId: string, cover: Record<string, unknown>): Promise<void>;
  markPublished(versionId: string, publishedBy: string): Promise<void>;
  recordApproval(versionId: string, approvedBy: string): Promise<void>;
  nextVersionNo(deckId: string): Promise<number>;
}

export interface StructureRepository {
  sectionsFor(versionId: string): Promise<SectionRecord[]>;
  slidesFor(versionId: string): Promise<SlideRecord[]>;
  blocksFor(versionId: string): Promise<BlockRecord[]>;
  getBlock(blockId: string): Promise<BlockRecord | null>;
  /** Seed a version's outline. Used at creation, and when cloning for a new draft. */
  createOutline(
    versionId: string,
    outline: ReadonlyArray<{
      sectionKey: string;
      title: string;
      slides: ReadonlyArray<{
        layoutKey: string;
        slideNo: number;
        blocks: ReadonlyArray<{ blockKey: string; label: string | null; kind: BlockRecord["kind"] }>;
      }>;
    }>,
  ): Promise<void>;
  upsertBlocks(
    versionId: string,
    blocks: ReadonlyArray<{
      blockKey: string;
      content: unknown;
      contentClass?: ContentClass;
    }>,
    updatedBy: string,
  ): Promise<void>;
  /**
   * Write one block from an accepted answer.
   *
   * Sets `populatedBy = 'answer'` and locks the content class permanently, so
   * answer-derived text can never be reclassified as firm boilerplate and travel
   * into another company's template.
   */
  writeAcceptedAnswer(input: {
    blockId: string;
    content: unknown;
    acceptedBy: string;
  }): Promise<void>;
  /** Copy a published version's structure and content into a fresh draft. */
  cloneInto(sourceVersionId: string, targetVersionId: string): Promise<void>;
}

export interface ProvenanceRepository {
  record(input: {
    blockId: string;
    source: "qa_answer" | "loader" | "autofill" | "broker";
    qaItemId: string | null;
    qaResponseId: string | null;
    respondentId: string | null;
    answeredAt: string | null;
    acceptedBy: string;
    outcome: "accepted" | "discarded";
    rawAnswer: string | null;
  }): Promise<void>;
  /** Which (item, response) pairs have already been decided on this version. */
  decidedResponseIds(versionId: string): Promise<Set<string>>;
}

export interface QuestionLibraryRepository {
  listFor(input: {
    sectionKeys: string[];
    firmId: string | null;
    userId: string;
  }): Promise<
    Array<{
      id: string;
      scope: "system" | "firm" | "user";
      sectionKey: string;
      blockKeyPattern: string | null;
      questionText: string;
      helpText: string | null;
      sortOrder: number;
    }>
  >;
}

export interface PublicationsRepository {
  forVersion(versionId: string): Promise<{ sha256: string; documentId: string | null } | null>;
  record(input: {
    versionId: string;
    uploadId: string;
    documentId: string;
    sha256: string;
    byteSize: number;
    pageCount: number | null;
    publishedBy: string;
  }): Promise<void>;
}

/**
 * Publishing the rendered deck into the deal's data room.
 *
 * Stores the bytes through the shared blob port and creates a tracked document,
 * so the published CIM inherits data room access control and versioning rather
 * than living in a second place with its own rules.
 */
export interface CimDataRoomPort {
  available: boolean;
  publishDocument(input: {
    companyId: string;
    name: string;
    bytes: Buffer;
    contentType: string;
    uploadedBy: string;
  }): Promise<{ uploadId: string; documentId: string }>;
}

/**
 * The guided-Q&A seam (`CM - 0004`).
 *
 * `externalRef` carries a `cim_blocks.id` and is opaque to whatever implements
 * this — the Q&A module never learns what a CIM is. That single field is the
 * entire contract between the two capabilities.
 */
export interface QaPort {
  available: boolean;
  createItems(input: {
    companyId: string;
    createdBy: string;
    items: ReadonlyArray<{
      externalRef: string;
      sectionKey: string;
      text: string;
      title: string;
      assigneeUserId?: string;
    }>;
  }): Promise<Array<{ itemId: string; externalRef: string }>>;
  /** Answers submitted against items carrying one of these external references. */
  listAnswers(input: {
    companyId: string;
    externalRefs: string[];
  }): Promise<
    Array<{
      itemId: string;
      responseId: string;
      externalRef: string;
      questionText: string;
      answerText: string;
      respondentId: string | null;
      respondentName: string | null;
      submittedAt: string;
    }>
  >;
  /** How many generated questions are still unanswered — for the health panel. */
  outstandingCount(input: { companyId: string; externalRefs: string[] }): Promise<number>;
}

export interface CimActivityPort {
  emit(event: {
    type: string;
    companyId: string;
    subjectId: string;
    actorId: string | null;
  }): void;
}
