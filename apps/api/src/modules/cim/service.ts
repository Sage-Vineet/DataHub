import { createHash } from "node:crypto";
import type {
  AcceptAnswer,
  BlockBulkUpsert,
  DeckCreate,
  DeckHealth,
  DeckSummary,
  DiscardAnswer,
  GapResponse,
  GenerateRequest,
  GenerateResult,
  PublishResult,
  ReviewItem,
  SessionUser,
  VersionDetail,
  VersionSummary,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { DEFAULT_OUTLINE } from "./outline.js";
import type {
  BlockRecord,
  CimActivityPort,
  CimDataRoomPort,
  DecksRepository,
  ProvenanceRepository,
  PublicationsRepository,
  QaPort,
  QuestionLibraryRepository,
  SlideRecord,
  StructureRepository,
  VersionRecord,
  VersionsRepository,
} from "./ports.js";

export interface CimServiceDeps {
  decks: DecksRepository;
  versions: VersionsRepository;
  structure: StructureRepository;
  provenance: ProvenanceRepository;
  library: QuestionLibraryRepository;
  publications: PublicationsRepository;
  dataRoom: CimDataRoomPort;
  qa: QaPort;
  activity?: CimActivityPort;
}

const isBrokerSide = (user: SessionUser): boolean =>
  user.role === "broker" || user.role === "admin";

/** A version past review is frozen: `CM - 0001` makes a published deck immutable. */
const isOpen = (v: VersionRecord): boolean => v.status === "draft" || v.status === "in_review";

/** Empty means unanswered. A blank string is not content, it is an unfilled field. */
function hasContent(block: BlockRecord): boolean {
  if (block.populatedBy === null) return false;
  const c = block.content;
  if (c === null || c === undefined) return false;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c)) return c.length > 0;
  if (typeof c === "object") return Object.keys(c as object).length > 0;
  return true;
}

function toVersionSummary(
  v: VersionRecord,
  pub: { sha256: string; documentId: string | null } | null,
): VersionSummary {
  return {
    id: v.id,
    deck_id: v.deckId,
    version_no: v.versionNo,
    status: v.status,
    published_at: v.publishedAt,
    published_by: v.publishedBy,
    approved_at: v.approvedAt,
    approved_by: v.approvedBy,
    sha256: pub?.sha256 ?? null,
    document_id: pub?.documentId ?? null,
    created_at: v.createdAt,
  };
}

export class CimService {
  private readonly deps: CimServiceDeps;

  constructor(deps: CimServiceDeps) {
    this.deps = deps;
  }

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have access to this deal.");
    }
  }

  /**
   * A CIM is broker-side work.
   *
   * `CM - 0001` §5 excludes buyers outright and limits the seller to answering
   * questions and approving — neither of which goes through the builder. So the
   * builder itself is gated, and the seller's contribution arrives through the
   * Q&A module.
   */
  private requireBuilderAccess(user: SessionUser, companyId: string): void {
    this.requireCompany(user, companyId);
    if (!isBrokerSide(user)) {
      throw new ForbiddenError("Only the deal team can work on the CIM.");
    }
  }

  private async requireVersion(
    user: SessionUser,
    versionId: string,
  ): Promise<{ version: VersionRecord; deck: { id: string; companyId: string } }> {
    const version = await this.deps.versions.getById(versionId);
    if (!version) throw new NotFoundError("CIM version not found.");
    const deck = await this.deps.decks.getById(version.deckId);
    if (!deck) throw new NotFoundError("CIM not found.");
    this.requireBuilderAccess(user, deck.companyId);
    return { version, deck };
  }

  /** Every mutation goes through here, so "published is immutable" has one home. */
  private async requireOpenVersion(user: SessionUser, versionId: string) {
    const resolved = await this.requireVersion(user, versionId);
    if (!isOpen(resolved.version)) {
      throw new BadRequestError(
        `This version is ${resolved.version.status} and cannot be edited. Create a new draft instead.`,
      );
    }
    return resolved;
  }

  // ── decks and versions ────────────────────────────────────────────────────

  async listDecks(user: SessionUser, companyId: string): Promise<DeckSummary[]> {
    this.requireBuilderAccess(user, companyId);
    const decks = await this.deps.decks.listFor(companyId);
    return decks.map((d) => ({
      id: d.id,
      company_id: d.companyId,
      name: d.name,
      template_key: d.templateKey,
      current_version_id: d.currentVersion?.id ?? null,
      current_version_no: d.currentVersion?.versionNo ?? null,
      current_status: d.currentVersion?.status ?? null,
      created_at: d.createdAt,
    }));
  }

  async createDeck(
    user: SessionUser,
    companyId: string,
    input: DeckCreate,
  ): Promise<DeckSummary> {
    this.requireBuilderAccess(user, companyId);
    const deck = await this.deps.decks.create({
      companyId,
      name: input.name,
      templateKey: input.template_key ?? "source-38",
      createdBy: user.id,
    });
    const version = await this.deps.versions.create({
      deckId: deck.id,
      versionNo: 1,
      cover: {},
      theme: {},
    });
    await this.deps.structure.createOutline(version.id, DEFAULT_OUTLINE);

    this.deps.activity?.emit({
      type: "cim.deck.created",
      companyId,
      subjectId: deck.id,
      actorId: user.id,
    });

    return {
      id: deck.id,
      company_id: deck.companyId,
      name: deck.name,
      template_key: deck.templateKey,
      current_version_id: version.id,
      current_version_no: version.versionNo,
      current_status: version.status,
      created_at: deck.createdAt,
    };
  }

  async listVersions(user: SessionUser, deckId: string): Promise<VersionSummary[]> {
    const deck = await this.deps.decks.getById(deckId);
    if (!deck) throw new NotFoundError("CIM not found.");
    this.requireBuilderAccess(user, deck.companyId);
    const versions = await this.deps.decks.versionsFor(deckId);
    return versions.map((v) =>
      toVersionSummary(v, v.sha256 ? { sha256: v.sha256, documentId: v.documentId } : null),
    );
  }

  /** The whole deck, in one round trip — the editor needs all of it at once. */
  async getVersion(user: SessionUser, versionId: string): Promise<VersionDetail> {
    const { version } = await this.requireVersion(user, versionId);
    const [sections, slides, blocks, pub] = await Promise.all([
      this.deps.structure.sectionsFor(versionId),
      this.deps.structure.slidesFor(versionId),
      this.deps.structure.blocksFor(versionId),
      this.deps.publications.forVersion(versionId),
    ]);

    const blocksBySlide = new Map<string, BlockRecord[]>();
    for (const block of blocks) {
      const list = blocksBySlide.get(block.slideId) ?? [];
      list.push(block);
      blocksBySlide.set(block.slideId, list);
    }
    const slidesBySection = new Map<string, SlideRecord[]>();
    for (const slide of slides) {
      const list = slidesBySection.get(slide.sectionId) ?? [];
      list.push(slide);
      slidesBySection.set(slide.sectionId, list);
    }

    return {
      version: toVersionSummary(version, pub),
      cover: version.cover,
      theme: version.theme,
      sections: sections.map((section) => ({
        id: section.id,
        section_key: section.sectionKey,
        title: section.title,
        sort_order: section.sortOrder,
        slides: (slidesBySection.get(section.id) ?? []).map((slide) => ({
          id: slide.id,
          section_id: slide.sectionId,
          slide_class: slide.slideClass,
          layout_key: slide.layoutKey,
          slide_no: slide.slideNo,
          sort_order: slide.sortOrder,
          blocks: (blocksBySlide.get(slide.id) ?? []).map((block) => ({
            id: block.id,
            slide_id: block.slideId,
            block_key: block.blockKey,
            kind: block.kind,
            label: block.label,
            content: block.content,
            content_class: block.contentClass,
            content_class_locked: block.contentClassLocked,
            populated_by: block.populatedBy,
            updated_at: block.updatedAt,
          })),
        })),
      })),
    };
  }

  async saveBlocks(
    user: SessionUser,
    versionId: string,
    input: BlockBulkUpsert,
  ): Promise<VersionDetail> {
    await this.requireOpenVersion(user, versionId);
    if (input.cover) await this.deps.versions.setCover(versionId, input.cover);
    if (input.blocks.length > 0) {
      // snake_case on the wire, camelCase inside — the same projection every
      // other module does at its service boundary.
      await this.deps.structure.upsertBlocks(
        versionId,
        input.blocks.map((b) => ({
          blockKey: b.block_key,
          content: b.content,
          ...(b.content_class ? { contentClass: b.content_class } : {}),
        })),
        user.id,
      );
    }
    return this.getVersion(user, versionId);
  }

  /**
   * Fork a published version into a new draft.
   *
   * `CM - 0001` requires editing a published CIM to produce a new version while
   * every prior published version stays retrievable — so this clones rather than
   * unfreezes, and the published row and its publication record are untouched.
   */
  async createDraftFrom(user: SessionUser, deckId: string): Promise<VersionSummary> {
    const deck = await this.deps.decks.getById(deckId);
    if (!deck) throw new NotFoundError("CIM not found.");
    this.requireBuilderAccess(user, deck.companyId);

    const open = await this.deps.versions.openVersionFor(deckId);
    if (open) {
      throw new BadRequestError("This CIM already has an open draft.");
    }
    const all = await this.deps.decks.versionsFor(deckId);
    const latest = all[0];
    if (!latest) throw new NotFoundError("This CIM has no versions to fork.");

    const next = await this.deps.versions.create({
      deckId,
      versionNo: await this.deps.versions.nextVersionNo(deckId),
      cover: latest.cover,
      theme: latest.theme,
    });
    await this.deps.structure.cloneInto(latest.id, next.id);
    return toVersionSummary(next, null);
  }

  async recordApproval(user: SessionUser, versionId: string): Promise<VersionSummary> {
    const { version } = await this.requireVersion(user, versionId);
    await this.deps.versions.recordApproval(versionId, user.id);
    const refreshed = await this.deps.versions.getById(versionId);
    return toVersionSummary(refreshed ?? version, null);
  }

  // ── guided Q&A (CM - 0004) ────────────────────────────────────────────────

  /**
   * Which blocks are still empty, and what would fill them.
   *
   * A block with no mapped library question comes back flagged rather than
   * omitted: `CM - 0004` requires the gap to be surfaced, and a silently skipped
   * one is how a deck reports itself complete with a slide still blank.
   */
  async gaps(user: SessionUser, versionId: string): Promise<GapResponse[]> {
    await this.requireVersion(user, versionId);
    const [sections, slides, blocks] = await Promise.all([
      this.deps.structure.sectionsFor(versionId),
      this.deps.structure.slidesFor(versionId),
      this.deps.structure.blocksFor(versionId),
    ]);
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    const slideById = new Map(slides.map((s) => [s.id, s]));

    const library = await this.deps.library.listFor({
      sectionKeys: sections.map((s) => s.sectionKey),
      firmId: null,
      userId: user.id,
    });
    const questionFor = (sectionKey: string, blockKey: string): string | null => {
      const exact = library.find(
        (q) => q.sectionKey === sectionKey && q.blockKeyPattern === blockKey,
      );
      return exact?.questionText ?? null;
    };

    const out: GapResponse[] = [];
    for (const block of blocks) {
      if (hasContent(block)) continue;
      const slide = slideById.get(block.slideId);
      const section = slide ? sectionById.get(slide.sectionId) : undefined;
      const sectionKey = section?.sectionKey ?? "unclassified";
      // The authored label is itself usually a question — the library is seeded
      // from those labels — so it is the fallback before declaring a gap unmapped.
      const question = questionFor(sectionKey, block.blockKey) ?? block.label;
      out.push({
        block_id: block.id,
        block_key: block.blockKey,
        section_key: sectionKey,
        slide_no: slide?.slideNo ?? 0,
        label: block.label,
        question_text: question,
        unmapped: question === null,
      });
    }
    return out;
  }

  /**
   * Send the questions, as items in the Q&A module.
   *
   * Nothing about a CIM crosses the seam: each item carries the block id as an
   * opaque external reference, and that is the whole contract.
   */
  async generate(
    user: SessionUser,
    versionId: string,
    input: GenerateRequest,
  ): Promise<GenerateResult> {
    const { version, deck } = await this.requireOpenVersion(user, versionId);
    if (!this.deps.qa.available) {
      throw new BadRequestError("The Q&A module is not available, so questions cannot be sent.");
    }

    const blocks = await this.deps.structure.blocksFor(versionId);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const sections = await this.deps.structure.sectionsFor(versionId);
    const slides = await this.deps.structure.slidesFor(versionId);
    const sectionKeyForBlock = (blockId: string): string => {
      const block = byId.get(blockId);
      const slide = block ? slides.find((s) => s.id === block.slideId) : undefined;
      return sections.find((s) => s.id === slide?.sectionId)?.sectionKey ?? "unclassified";
    };

    for (const q of input.questions) {
      if (!byId.has(q.block_id)) {
        throw new BadRequestError("One of those questions targets a block on a different CIM.");
      }
    }

    const created = await this.deps.qa.createItems({
      companyId: deck.companyId,
      createdBy: user.id,
      items: input.questions.map((q) => ({
        externalRef: q.block_id,
        sectionKey: sectionKeyForBlock(q.block_id),
        text: q.text,
        title: byId.get(q.block_id)?.label ?? "CIM question",
        ...(q.assignee_user_id ? { assigneeUserId: q.assignee_user_id } : {}),
      })),
    });

    this.deps.activity?.emit({
      type: "cim.request.generated",
      companyId: deck.companyId,
      subjectId: version.id,
      actorId: user.id,
    });

    return {
      created: created.length,
      items: created.map((c) => ({ block_id: c.externalRef, qa_item_id: c.itemId })),
    };
  }

  /** Answers waiting on a decision. Anything already accepted or discarded is gone. */
  async reviewQueue(user: SessionUser, versionId: string): Promise<ReviewItem[]> {
    const { deck } = await this.requireVersion(user, versionId);
    if (!this.deps.qa.available) return [];

    const blocks = await this.deps.structure.blocksFor(versionId);
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const [answers, decided, sections, slides] = await Promise.all([
      this.deps.qa.listAnswers({
        companyId: deck.companyId,
        externalRefs: blocks.map((b) => b.id),
      }),
      this.deps.provenance.decidedResponseIds(versionId),
      this.deps.structure.sectionsFor(versionId),
      this.deps.structure.slidesFor(versionId),
    ]);

    return answers
      .filter((a) => byId.has(a.externalRef) && !decided.has(a.responseId))
      .map((a) => {
        const block = byId.get(a.externalRef)!;
        const slide = slides.find((s) => s.id === block.slideId);
        const sectionKey =
          sections.find((s) => s.id === slide?.sectionId)?.sectionKey ?? "unclassified";
        return {
          block_id: block.id,
          block_key: block.blockKey,
          section_key: sectionKey,
          question_text: a.questionText,
          answer_text: a.answerText,
          qa_item_id: a.itemId,
          qa_response_id: a.responseId,
          respondent_id: a.respondentId,
          respondent_name: a.respondentName,
          submitted_at: a.submittedAt,
          block_has_content: hasContent(block),
        };
      });
  }

  /**
   * Put an answer on a slide.
   *
   * Three things hold here, and each is a `CM - 0004` requirement rather than a
   * preference: existing content is never overwritten without an explicit mode
   * (default skip); the respondent's original text is preserved as provenance
   * even when the broker edited it before accepting; and the block's content
   * class is locked to deal content permanently, so answer-derived text can never
   * travel into a firm template.
   */
  async acceptAnswer(
    user: SessionUser,
    blockId: string,
    input: AcceptAnswer,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const block = await this.deps.structure.getBlock(blockId);
    if (!block) throw new NotFoundError("Block not found.");
    const { deck } = await this.requireOpenVersion(user, block.versionId);

    const answers = await this.deps.qa.listAnswers({
      companyId: deck.companyId,
      externalRefs: [blockId],
    });
    const answer = answers.find((a) => a.responseId === input.qa_response_id);
    if (!answer) throw new NotFoundError("That answer is not on this block.");

    const text = input.text ?? answer.answerText;
    const existing = typeof block.content === "string" ? block.content : "";

    let next: string;
    if (!hasContent(block)) {
      next = text;
    } else if (input.mode === "replace") {
      next = text;
    } else if (input.mode === "append") {
      next = `${existing}\n\n${text}`;
    } else {
      // Skip: record the decision so it leaves the queue, and leave the slide be.
      await this.deps.provenance.record({
        blockId,
        source: "qa_answer",
        qaItemId: input.qa_item_id,
        qaResponseId: input.qa_response_id,
        respondentId: answer.respondentId,
        answeredAt: answer.submittedAt,
        acceptedBy: user.id,
        outcome: "discarded",
        rawAnswer: answer.answerText,
      });
      return { accepted: false, reason: "The block already has content, and the mode was skip." };
    }

    await this.deps.structure.writeAcceptedAnswer({
      blockId,
      content: next,
      acceptedBy: user.id,
    });
    await this.deps.provenance.record({
      blockId,
      source: "qa_answer",
      qaItemId: input.qa_item_id,
      qaResponseId: input.qa_response_id,
      respondentId: answer.respondentId,
      answeredAt: answer.submittedAt,
      acceptedBy: user.id,
      outcome: "accepted",
      // What the respondent actually wrote, kept even where the broker edited it.
      rawAnswer: answer.answerText,
    });

    this.deps.activity?.emit({
      type: "cim.answer.accepted",
      companyId: deck.companyId,
      subjectId: blockId,
      actorId: user.id,
    });

    return { accepted: true };
  }

  /** Discard: the block is untouched and the answer is retained, never deleted. */
  async discardAnswer(
    user: SessionUser,
    blockId: string,
    input: DiscardAnswer,
  ): Promise<void> {
    const block = await this.deps.structure.getBlock(blockId);
    if (!block) throw new NotFoundError("Block not found.");
    const { deck } = await this.requireOpenVersion(user, block.versionId);
    const answers = await this.deps.qa.listAnswers({
      companyId: deck.companyId,
      externalRefs: [blockId],
    });
    const answer = answers.find((a) => a.responseId === input.qa_response_id);
    await this.deps.provenance.record({
      blockId,
      source: "qa_answer",
      qaItemId: input.qa_item_id,
      qaResponseId: input.qa_response_id,
      respondentId: answer?.respondentId ?? null,
      answeredAt: answer?.submittedAt ?? null,
      acceptedBy: user.id,
      outcome: "discarded",
      rawAnswer: answer?.answerText ?? null,
    });
  }

  // ── health and publication ────────────────────────────────────────────────

  async health(user: SessionUser, versionId: string): Promise<DeckHealth> {
    const { version, deck } = await this.requireVersion(user, versionId);
    const gaps = await this.gaps(user, versionId);
    const blocks = await this.deps.structure.blocksFor(versionId);
    const outstanding = this.deps.qa.available
      ? await this.deps.qa.outstandingCount({
          companyId: deck.companyId,
          externalRefs: blocks.map((b) => b.id),
        })
      : 0;
    return {
      unpopulated_blocks: gaps.length,
      unmapped_gaps: gaps.filter((g) => g.unmapped).length,
      outstanding_questions: outstanding,
      seller_approved: version.approvedAt !== null,
      // Publication is deliberately not gated on approval or on gaps — CM-0004 is
      // explicit that an unanswered request must never block a release, and the
      // approval gate is a recorded deferral rather than an oversight.
      publishable: isOpen(version),
    };
  }

  /**
   * Freeze a version around a rendered document.
   *
   * The bytes are rendered by the client; what happens here is the part that
   * makes the freeze mean something — hash the artifact, store it, land it in the
   * data room as a tracked document, and lock the version. Immutability comes
   * from the write lock plus the content hash, not from where the pixels were
   * rasterised.
   */
  async publish(
    user: SessionUser,
    versionId: string,
    bytes: Buffer,
    meta: { contentType: string; pageCount: number | null },
  ): Promise<PublishResult> {
    const { version, deck } = await this.requireOpenVersion(user, versionId);
    if (bytes.length === 0) throw new BadRequestError("The rendered document is empty.");
    if (!this.deps.dataRoom.available) {
      throw new BadRequestError(
        "The data room is not available, so a published CIM has nowhere to land.",
      );
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const deckRecord = await this.deps.decks.getById(version.deckId);
    const name = `${deckRecord?.name ?? "CIM"} v${version.versionNo}.pdf`;

    const stored = await this.deps.dataRoom.publishDocument({
      companyId: deck.companyId,
      name,
      bytes,
      contentType: meta.contentType,
      uploadedBy: user.id,
    });

    await this.deps.publications.record({
      versionId,
      uploadId: stored.uploadId,
      documentId: stored.documentId,
      sha256,
      byteSize: bytes.length,
      pageCount: meta.pageCount,
      publishedBy: user.id,
    });
    await this.deps.versions.markPublished(versionId, user.id);

    this.deps.activity?.emit({
      type: "cim.version.published",
      companyId: deck.companyId,
      subjectId: versionId,
      actorId: user.id,
    });

    const published = await this.deps.versions.getById(versionId);
    return {
      version_id: versionId,
      version_no: version.versionNo,
      status: published?.status ?? "published",
      sha256,
      document_id: stored.documentId,
      upload_id: stored.uploadId,
      published_at: published?.publishedAt ?? new Date().toISOString(),
    };
  }
}
