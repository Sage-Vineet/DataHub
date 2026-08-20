import { randomUUID } from "node:crypto";
import type { ContentClass } from "@datahub/contracts";
import type {
  BlockRecord,
  CimDataRoomPort,
  DeckRecord,
  DecksRepository,
  ProvenanceRepository,
  PublicationsRepository,
  QaPort,
  QuestionLibraryRepository,
  SectionRecord,
  SlideRecord,
  StructureRepository,
  VersionRecord,
  VersionsRepository,
} from "./ports.js";

export interface AnswerFixture {
  itemId: string;
  responseId: string;
  externalRef: string;
  questionText: string;
  answerText: string;
  respondentId: string | null;
  respondentName: string | null;
  submittedAt: string;
}

export class CimStore {
  readonly decks: DeckRecord[] = [];
  readonly versions: VersionRecord[] = [];
  readonly sections: SectionRecord[] = [];
  readonly slides: SlideRecord[] = [];
  readonly blocks: BlockRecord[] = [];
  readonly provenance: Array<{
    blockId: string;
    qaResponseId: string | null;
    outcome: "accepted" | "discarded";
    rawAnswer: string | null;
    versionId: string;
  }> = [];
  readonly publications = new Map<
    string,
    { sha256: string; documentId: string | null; byteSize: number }
  >();
  readonly library: Array<{
    id: string;
    scope: "system" | "firm" | "user";
    sectionKey: string;
    blockKeyPattern: string | null;
    questionText: string;
    helpText: string | null;
    sortOrder: number;
  }> = [];
  /** Answers the Q&A module would return, seeded by a test. */
  readonly answers: AnswerFixture[] = [];
  /** Items the CIM asked the Q&A module to create. */
  readonly createdItems: Array<{ externalRef: string; text: string; itemId: string }> = [];
  readonly publishedDocuments: Array<{ name: string; bytes: Buffer; companyId: string }> = [];
  private clock = 0;

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  versionIdForBlock(blockId: string): string {
    return this.blocks.find((b) => b.id === blockId)?.versionId ?? "";
  }
}

export class MemoryDecksRepository implements DecksRepository {
  constructor(private readonly store: CimStore) {}

  async listFor(companyId: string) {
    return this.store.decks
      .filter((d) => d.companyId === companyId)
      .map((d) => {
        const versions = this.store.versions
          .filter((v) => v.deckId === d.id)
          .sort((a, b) => b.versionNo - a.versionNo);
        const current = versions[0] ?? null;
        const pub = current ? this.store.publications.get(current.id) : undefined;
        return {
          ...d,
          currentVersion: current,
          sha256: pub?.sha256 ?? null,
          documentId: pub?.documentId ?? null,
        };
      });
  }

  async getById(deckId: string): Promise<DeckRecord | null> {
    return this.store.decks.find((d) => d.id === deckId) ?? null;
  }

  async create(input: {
    companyId: string;
    name: string;
    templateKey: string;
    createdBy: string;
  }): Promise<DeckRecord> {
    const record: DeckRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      templateKey: input.templateKey,
      createdAt: this.store.now(),
    };
    this.store.decks.push(record);
    return record;
  }

  async versionsFor(deckId: string) {
    return this.store.versions
      .filter((v) => v.deckId === deckId)
      .sort((a, b) => b.versionNo - a.versionNo)
      .map((v) => {
        const pub = this.store.publications.get(v.id);
        return { ...v, sha256: pub?.sha256 ?? null, documentId: pub?.documentId ?? null };
      });
  }
}

export class MemoryVersionsRepository implements VersionsRepository {
  constructor(private readonly store: CimStore) {}

  async getById(versionId: string): Promise<VersionRecord | null> {
    return this.store.versions.find((v) => v.id === versionId) ?? null;
  }

  async openVersionFor(deckId: string): Promise<VersionRecord | null> {
    return (
      this.store.versions.find(
        (v) => v.deckId === deckId && (v.status === "draft" || v.status === "in_review"),
      ) ?? null
    );
  }

  async create(input: {
    deckId: string;
    versionNo: number;
    cover: Record<string, unknown>;
    theme: Record<string, unknown>;
  }): Promise<VersionRecord> {
    // Mirrors the partial unique index: one open version per deck, so "the draft"
    // is never ambiguous.
    if (await this.openVersionFor(input.deckId)) {
      throw new Error("cim_versions_one_open");
    }
    const record: VersionRecord = {
      id: randomUUID(),
      deckId: input.deckId,
      versionNo: input.versionNo,
      status: "draft",
      cover: input.cover,
      theme: input.theme,
      approvedBy: null,
      approvedAt: null,
      publishedBy: null,
      publishedAt: null,
      createdAt: this.store.now(),
    };
    this.store.versions.push(record);
    return record;
  }

  async setCover(versionId: string, cover: Record<string, unknown>): Promise<void> {
    const version = this.store.versions.find((v) => v.id === versionId);
    if (version) version.cover = cover;
  }

  async markPublished(versionId: string, publishedBy: string): Promise<void> {
    const version = this.store.versions.find((v) => v.id === versionId);
    if (!version) return;
    version.status = "published";
    version.publishedBy = publishedBy;
    version.publishedAt = this.store.now();
  }

  async recordApproval(versionId: string, approvedBy: string): Promise<void> {
    const version = this.store.versions.find((v) => v.id === versionId);
    if (!version) return;
    version.approvedBy = approvedBy;
    version.approvedAt = this.store.now();
  }

  async nextVersionNo(deckId: string): Promise<number> {
    return this.store.versions.filter((v) => v.deckId === deckId).length + 1;
  }
}

export class MemoryStructureRepository implements StructureRepository {
  constructor(private readonly store: CimStore) {}

  async sectionsFor(versionId: string): Promise<SectionRecord[]> {
    return this.store.sections
      .filter((s) => s.versionId === versionId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async slidesFor(versionId: string): Promise<SlideRecord[]> {
    return this.store.slides
      .filter((s) => s.versionId === versionId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async blocksFor(versionId: string): Promise<BlockRecord[]> {
    return this.store.blocks.filter((b) => b.versionId === versionId);
  }

  async getBlock(blockId: string): Promise<BlockRecord | null> {
    return this.store.blocks.find((b) => b.id === blockId) ?? null;
  }

  async createOutline(
    versionId: string,
    outline: Parameters<StructureRepository["createOutline"]>[1],
  ): Promise<void> {
    let sortOrder = 0;
    outline.forEach((section, sectionIndex) => {
      const sectionId = randomUUID();
      this.store.sections.push({
        id: sectionId,
        versionId,
        sectionKey: section.sectionKey,
        title: section.title,
        sortOrder: sectionIndex + 1,
      });
      for (const slide of section.slides) {
        const slideId = randomUUID();
        sortOrder += 1;
        this.store.slides.push({
          id: slideId,
          versionId,
          sectionId,
          slideClass: "qualitative",
          layoutKey: slide.layoutKey,
          slideNo: slide.slideNo,
          sortOrder,
        });
        for (const block of slide.blocks) {
          this.store.blocks.push({
            id: randomUUID(),
            versionId,
            slideId,
            blockKey: block.blockKey,
            kind: block.kind,
            label: block.label,
            content: null,
            contentClass: "deal",
            contentClassLocked: false,
            populatedBy: null,
            updatedAt: this.store.now(),
          });
        }
      }
    });
  }

  async upsertBlocks(
    versionId: string,
    blocks: ReadonlyArray<{ blockKey: string; content: unknown; contentClass?: ContentClass }>,
    updatedBy: string,
  ): Promise<void> {
    void updatedBy;
    for (const incoming of blocks) {
      const found = this.store.blocks.find(
        (b) => b.versionId === versionId && b.blockKey === incoming.blockKey,
      );
      if (!found) continue;
      found.content = incoming.content;
      found.populatedBy = "author";
      found.updatedAt = this.store.now();
      // A locked block keeps its class whatever the request says — that lock is
      // what stops answer-derived text becoming firm boilerplate.
      if (incoming.contentClass && !found.contentClassLocked) {
        found.contentClass = incoming.contentClass;
      }
    }
  }

  async writeAcceptedAnswer(input: {
    blockId: string;
    content: unknown;
    acceptedBy: string;
  }): Promise<void> {
    const block = this.store.blocks.find((b) => b.id === input.blockId);
    if (!block) return;
    block.content = input.content;
    block.populatedBy = "answer";
    block.contentClass = "deal";
    block.contentClassLocked = true;
    block.updatedAt = this.store.now();
  }

  async cloneInto(sourceVersionId: string, targetVersionId: string): Promise<void> {
    const sectionMap = new Map<string, string>();
    const slideMap = new Map<string, string>();
    for (const section of this.store.sections.filter((s) => s.versionId === sourceVersionId)) {
      const id = randomUUID();
      sectionMap.set(section.id, id);
      this.store.sections.push({ ...section, id, versionId: targetVersionId });
    }
    for (const slide of this.store.slides.filter((s) => s.versionId === sourceVersionId)) {
      const id = randomUUID();
      slideMap.set(slide.id, id);
      this.store.slides.push({
        ...slide,
        id,
        versionId: targetVersionId,
        sectionId: sectionMap.get(slide.sectionId)!,
      });
    }
    for (const block of this.store.blocks.filter((b) => b.versionId === sourceVersionId)) {
      this.store.blocks.push({
        ...block,
        id: randomUUID(),
        versionId: targetVersionId,
        slideId: slideMap.get(block.slideId)!,
      });
    }
  }
}

export class MemoryProvenanceRepository implements ProvenanceRepository {
  constructor(private readonly store: CimStore) {}

  async record(input: Parameters<ProvenanceRepository["record"]>[0]): Promise<void> {
    this.store.provenance.push({
      blockId: input.blockId,
      qaResponseId: input.qaResponseId,
      outcome: input.outcome,
      rawAnswer: input.rawAnswer,
      versionId: this.store.versionIdForBlock(input.blockId),
    });
  }

  async decidedResponseIds(versionId: string): Promise<Set<string>> {
    return new Set(
      this.store.provenance
        .filter((p) => p.versionId === versionId && p.qaResponseId)
        .map((p) => p.qaResponseId!),
    );
  }
}

export class MemoryQuestionLibraryRepository implements QuestionLibraryRepository {
  constructor(private readonly store: CimStore) {}

  async listFor(input: { sectionKeys: string[] }) {
    return this.store.library.filter((q) => input.sectionKeys.includes(q.sectionKey));
  }
}

export class MemoryPublicationsRepository implements PublicationsRepository {
  constructor(private readonly store: CimStore) {}

  async forVersion(versionId: string) {
    const found = this.store.publications.get(versionId);
    return found ? { sha256: found.sha256, documentId: found.documentId } : null;
  }

  async record(input: Parameters<PublicationsRepository["record"]>[0]): Promise<void> {
    this.store.publications.set(input.versionId, {
      sha256: input.sha256,
      documentId: input.documentId,
      byteSize: input.byteSize,
    });
  }
}

export class MemoryCimDataRoom implements CimDataRoomPort {
  readonly available = true;
  constructor(private readonly store: CimStore) {}

  async publishDocument(input: {
    companyId: string;
    name: string;
    bytes: Buffer;
    contentType: string;
    uploadedBy: string;
  }) {
    this.store.publishedDocuments.push({
      name: input.name,
      bytes: input.bytes,
      companyId: input.companyId,
    });
    return { uploadId: randomUUID(), documentId: randomUUID() };
  }
}

export const unavailableCimDataRoom: CimDataRoomPort = {
  available: false,
  publishDocument: async () => {
    throw new Error("data room unavailable");
  },
};

export class MemoryQaPort implements QaPort {
  readonly available = true;
  constructor(private readonly store: CimStore) {}

  async createItems(input: Parameters<QaPort["createItems"]>[0]) {
    return input.items.map((item) => {
      const itemId = randomUUID();
      this.store.createdItems.push({
        externalRef: item.externalRef,
        text: item.text,
        itemId,
      });
      return { itemId, externalRef: item.externalRef };
    });
  }

  async listAnswers(input: { actingUserId: string; externalRefs: string[] }) {
    return this.store.answers.filter((a) => input.externalRefs.includes(a.externalRef));
  }

  async outstandingCount(input: { actingUserId: string; externalRefs: string[] }) {
    const answered = new Set(this.store.answers.map((a) => a.externalRef));
    return this.store.createdItems.filter(
      (i) => input.externalRefs.includes(i.externalRef) && !answered.has(i.externalRef),
    ).length;
  }
}

export const unavailableQa: QaPort = {
  available: false,
  createItems: async () => [],
  listAnswers: async () => [],
  outstandingCount: async () => 0,
};

export function memoryCim(store = new CimStore()) {
  return {
    store,
    decks: new MemoryDecksRepository(store),
    versions: new MemoryVersionsRepository(store),
    structure: new MemoryStructureRepository(store),
    provenance: new MemoryProvenanceRepository(store),
    library: new MemoryQuestionLibraryRepository(store),
    publications: new MemoryPublicationsRepository(store),
    dataRoom: new MemoryCimDataRoom(store),
    qa: new MemoryQaPort(store),
  };
}
