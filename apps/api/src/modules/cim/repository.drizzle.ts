import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { ContentClass, PopulatedBy, SlideClass } from "@datahub/contracts";
import type {
  BlockRecord,
  DeckRecord,
  DecksRepository,
  ProvenanceRepository,
  PublicationsRepository,
  QuestionLibraryRepository,
  SectionRecord,
  SlideRecord,
  StructureRepository,
  VersionRecord,
  VersionsRepository,
} from "./ports.js";

const {
  cimBlockProvenance,
  cimBlocks,
  cimDecks,
  cimPublications,
  cimQuestionLibrary,
  cimSections,
  cimSlides,
  cimVersions,
} = schema;

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v;

const OPEN_STATUSES = ["draft", "in_review"] as const;

function toDeck(row: typeof cimDecks.$inferSelect): DeckRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    templateKey: row.templateKey,
    createdAt: iso(row.createdAt) ?? "",
  };
}

function toVersion(row: typeof cimVersions.$inferSelect): VersionRecord {
  return {
    id: row.id,
    deckId: row.deckId,
    versionNo: row.versionNo,
    status: row.status as VersionRecord["status"],
    cover: (row.cover ?? {}) as Record<string, unknown>,
    theme: (row.theme ?? {}) as Record<string, unknown>,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    publishedBy: row.publishedBy,
    publishedAt: iso(row.publishedAt),
    createdAt: iso(row.createdAt) ?? "",
  };
}

function toBlock(row: typeof cimBlocks.$inferSelect): BlockRecord {
  return {
    id: row.id,
    versionId: row.versionId,
    slideId: row.slideId,
    blockKey: row.blockKey,
    kind: row.kind as BlockRecord["kind"],
    label: row.label,
    content: row.content,
    contentClass: row.contentClass as ContentClass,
    contentClassLocked: row.contentClassLocked,
    populatedBy: (row.populatedBy ?? null) as PopulatedBy | null,
    updatedAt: iso(row.updatedAt) ?? "",
  };
}

export class DrizzleDecksRepository implements DecksRepository {
  constructor(private readonly db: Db) {}

  async listFor(companyId: string) {
    const decks = await this.db
      .select()
      .from(cimDecks)
      .where(and(eq(cimDecks.companyId, companyId), isNull(cimDecks.deletedAt)))
      .orderBy(desc(cimDecks.createdAt));
    if (decks.length === 0) return [];

    const versions = await this.db
      .select({ version: cimVersions, sha256: cimPublications.sha256, documentId: cimPublications.documentId })
      .from(cimVersions)
      .leftJoin(cimPublications, eq(cimPublications.versionId, cimVersions.id))
      .where(inArray(cimVersions.deckId, decks.map((d) => d.id)))
      .orderBy(desc(cimVersions.versionNo));

    return decks.map((deck) => {
      const latest = versions.find((v) => v.version.deckId === deck.id);
      return {
        ...toDeck(deck),
        currentVersion: latest ? toVersion(latest.version) : null,
        sha256: latest?.sha256 ?? null,
        documentId: latest?.documentId ?? null,
      };
    });
  }

  async getById(deckId: string): Promise<DeckRecord | null> {
    const rows = await this.db.select().from(cimDecks).where(eq(cimDecks.id, deckId)).limit(1);
    return rows[0] ? toDeck(rows[0]) : null;
  }

  async create(input: {
    companyId: string;
    name: string;
    templateKey: string;
    createdBy: string;
  }): Promise<DeckRecord> {
    const [row] = await this.db
      .insert(cimDecks)
      .values({
        companyId: input.companyId,
        name: input.name,
        templateKey: input.templateKey,
        createdBy: input.createdBy,
      })
      .returning();
    return toDeck(row!);
  }

  async versionsFor(deckId: string) {
    const rows = await this.db
      .select({ version: cimVersions, sha256: cimPublications.sha256, documentId: cimPublications.documentId })
      .from(cimVersions)
      .leftJoin(cimPublications, eq(cimPublications.versionId, cimVersions.id))
      .where(eq(cimVersions.deckId, deckId))
      .orderBy(desc(cimVersions.versionNo));
    return rows.map((r) => ({
      ...toVersion(r.version),
      sha256: r.sha256,
      documentId: r.documentId,
    }));
  }
}

export class DrizzleVersionsRepository implements VersionsRepository {
  constructor(private readonly db: Db) {}

  async getById(versionId: string): Promise<VersionRecord | null> {
    const rows = await this.db
      .select()
      .from(cimVersions)
      .where(eq(cimVersions.id, versionId))
      .limit(1);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async openVersionFor(deckId: string): Promise<VersionRecord | null> {
    const rows = await this.db
      .select()
      .from(cimVersions)
      .where(
        and(
          eq(cimVersions.deckId, deckId),
          or(...OPEN_STATUSES.map((s) => eq(cimVersions.status, s))),
        ),
      )
      .limit(1);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async create(input: {
    deckId: string;
    versionNo: number;
    cover: Record<string, unknown>;
    theme: Record<string, unknown>;
  }): Promise<VersionRecord> {
    // The partial unique index refuses a second open version, so a race here
    // fails loudly rather than leaving a deck with two drafts.
    const [row] = await this.db
      .insert(cimVersions)
      .values({
        deckId: input.deckId,
        versionNo: input.versionNo,
        cover: input.cover,
        theme: input.theme,
      })
      .returning();
    return toVersion(row!);
  }

  async setCover(versionId: string, cover: Record<string, unknown>): Promise<void> {
    await this.db.update(cimVersions).set({ cover }).where(eq(cimVersions.id, versionId));
  }

  async markPublished(versionId: string, publishedBy: string): Promise<void> {
    await this.db
      .update(cimVersions)
      .set({ status: "published", publishedBy, publishedAt: new Date() })
      .where(eq(cimVersions.id, versionId));
  }

  async recordApproval(versionId: string, approvedBy: string): Promise<void> {
    await this.db
      .update(cimVersions)
      .set({ approvedBy, approvedAt: new Date() })
      .where(eq(cimVersions.id, versionId));
  }

  async nextVersionNo(deckId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`coalesce(max(${cimVersions.versionNo}), 0) + 1` })
      .from(cimVersions)
      .where(eq(cimVersions.deckId, deckId));
    return Number(row?.n ?? 1);
  }
}

export class DrizzleStructureRepository implements StructureRepository {
  constructor(private readonly db: Db) {}

  async sectionsFor(versionId: string): Promise<SectionRecord[]> {
    const rows = await this.db
      .select()
      .from(cimSections)
      .where(eq(cimSections.versionId, versionId))
      .orderBy(asc(cimSections.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      versionId: r.versionId,
      sectionKey: r.sectionKey,
      title: r.title,
      sortOrder: r.sortOrder,
    }));
  }

  async slidesFor(versionId: string): Promise<SlideRecord[]> {
    const rows = await this.db
      .select()
      .from(cimSlides)
      .where(eq(cimSlides.versionId, versionId))
      .orderBy(asc(cimSlides.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      versionId: r.versionId,
      sectionId: r.sectionId,
      slideClass: r.slideClass as SlideClass,
      layoutKey: r.layoutKey,
      slideNo: r.slideNo,
      sortOrder: r.sortOrder,
    }));
  }

  async blocksFor(versionId: string): Promise<BlockRecord[]> {
    const rows = await this.db
      .select()
      .from(cimBlocks)
      .where(eq(cimBlocks.versionId, versionId))
      .orderBy(asc(cimBlocks.blockKey));
    return rows.map(toBlock);
  }

  async getBlock(blockId: string): Promise<BlockRecord | null> {
    const rows = await this.db.select().from(cimBlocks).where(eq(cimBlocks.id, blockId)).limit(1);
    return rows[0] ? toBlock(rows[0]) : null;
  }

  async createOutline(
    versionId: string,
    outline: Parameters<StructureRepository["createOutline"]>[1],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      let sortOrder = 0;
      for (const [sectionIndex, section] of outline.entries()) {
        const [sectionRow] = await tx
          .insert(cimSections)
          .values({
            versionId,
            sectionKey: section.sectionKey,
            title: section.title,
            sortOrder: sectionIndex + 1,
          })
          .returning({ id: cimSections.id });
        for (const slide of section.slides) {
          sortOrder += 1;
          const [slideRow] = await tx
            .insert(cimSlides)
            .values({
              versionId,
              sectionId: sectionRow!.id,
              layoutKey: slide.layoutKey,
              slideNo: slide.slideNo,
              sortOrder,
            })
            .returning({ id: cimSlides.id });
          if (slide.blocks.length === 0) continue;
          await tx.insert(cimBlocks).values(
            slide.blocks.map((block) => ({
              versionId,
              slideId: slideRow!.id,
              blockKey: block.blockKey,
              label: block.label,
              kind: block.kind,
            })),
          );
        }
      }
    });
  }

  async upsertBlocks(
    versionId: string,
    blocks: ReadonlyArray<{ blockKey: string; content: unknown; contentClass?: ContentClass }>,
    updatedBy: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const incoming of blocks) {
        // Content always lands. The class is a separate decision, applied below.
        await tx
          .update(cimBlocks)
          .set({
            content: incoming.content as never,
            populatedBy: "author",
            updatedBy,
            updatedAt: new Date(),
          })
          .where(and(eq(cimBlocks.versionId, versionId), eq(cimBlocks.blockKey, incoming.blockKey)));

        if (!incoming.contentClass) continue;
        // Reclassification is refused on a locked block, in the WHERE clause
        // rather than by a check the caller could skip. The lock is set when an
        // answer or an import populates a block, and it is what stops deal
        // content becoming firm boilerplate and travelling into another
        // company's template (CM-0002).
        await tx
          .update(cimBlocks)
          .set({ contentClass: incoming.contentClass })
          .where(
            and(
              eq(cimBlocks.versionId, versionId),
              eq(cimBlocks.blockKey, incoming.blockKey),
              eq(cimBlocks.contentClassLocked, false),
            ),
          );
      }
    });
  }

  async writeAcceptedAnswer(input: {
    blockId: string;
    content: unknown;
    acceptedBy: string;
  }): Promise<void> {
    await this.db
      .update(cimBlocks)
      .set({
        content: input.content as never,
        populatedBy: "answer",
        contentClass: "deal",
        contentClassLocked: true,
        updatedBy: input.acceptedBy,
        updatedAt: new Date(),
      })
      .where(eq(cimBlocks.id, input.blockId));
  }

  async cloneInto(sourceVersionId: string, targetVersionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const sections = await tx
        .select()
        .from(cimSections)
        .where(eq(cimSections.versionId, sourceVersionId))
        .orderBy(asc(cimSections.sortOrder));
      const slides = await tx
        .select()
        .from(cimSlides)
        .where(eq(cimSlides.versionId, sourceVersionId))
        .orderBy(asc(cimSlides.sortOrder));
      const blocks = await tx
        .select()
        .from(cimBlocks)
        .where(eq(cimBlocks.versionId, sourceVersionId));

      const sectionMap = new Map<string, string>();
      for (const section of sections) {
        const [row] = await tx
          .insert(cimSections)
          .values({
            versionId: targetVersionId,
            sectionKey: section.sectionKey,
            title: section.title,
            sortOrder: section.sortOrder,
          })
          .returning({ id: cimSections.id });
        sectionMap.set(section.id, row!.id);
      }

      const slideMap = new Map<string, string>();
      for (const slide of slides) {
        const [row] = await tx
          .insert(cimSlides)
          .values({
            versionId: targetVersionId,
            sectionId: sectionMap.get(slide.sectionId)!,
            slideClass: slide.slideClass,
            layoutKey: slide.layoutKey,
            slideNo: slide.slideNo,
            sortOrder: slide.sortOrder,
          })
          .returning({ id: cimSlides.id });
        slideMap.set(slide.id, row!.id);
      }

      if (blocks.length > 0) {
        await tx.insert(cimBlocks).values(
          blocks.map((block) => ({
            versionId: targetVersionId,
            slideId: slideMap.get(block.slideId)!,
            blockKey: block.blockKey,
            kind: block.kind,
            label: block.label,
            content: block.content,
            contentClass: block.contentClass,
            contentClassLocked: block.contentClassLocked,
            populatedBy: block.populatedBy,
          })),
        );
      }
    });
  }
}

export class DrizzleProvenanceRepository implements ProvenanceRepository {
  constructor(private readonly db: Db) {}

  async record(input: Parameters<ProvenanceRepository["record"]>[0]): Promise<void> {
    await this.db.insert(cimBlockProvenance).values({
      blockId: input.blockId,
      source: input.source,
      qaItemId: input.qaItemId,
      qaResponseId: input.qaResponseId,
      respondentId: input.respondentId,
      answeredAt: input.answeredAt ? new Date(input.answeredAt) : null,
      acceptedBy: input.acceptedBy,
      outcome: input.outcome,
      rawAnswer: input.rawAnswer,
    });
  }

  async decidedResponseIds(versionId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ qaResponseId: cimBlockProvenance.qaResponseId })
      .from(cimBlockProvenance)
      .innerJoin(cimBlocks, eq(cimBlocks.id, cimBlockProvenance.blockId))
      .where(eq(cimBlocks.versionId, versionId));
    return new Set(rows.map((r) => r.qaResponseId).filter((id): id is string => id !== null));
  }
}

export class DrizzleQuestionLibraryRepository implements QuestionLibraryRepository {
  constructor(private readonly db: Db) {}

  async listFor(input: { sectionKeys: string[]; firmId: string | null; userId: string }) {
    if (input.sectionKeys.length === 0) return [];
    // Scope visibility mirrors CM-0002: system, own firm, own. Nobody sees
    // another firm's or another user's questions.
    const visible = [
      eq(cimQuestionLibrary.scope, "system"),
      and(eq(cimQuestionLibrary.scope, "user"), eq(cimQuestionLibrary.ownerId, input.userId)),
      ...(input.firmId
        ? [and(eq(cimQuestionLibrary.scope, "firm"), eq(cimQuestionLibrary.ownerId, input.firmId))]
        : []),
    ];
    const rows = await this.db
      .select()
      .from(cimQuestionLibrary)
      .where(
        and(
          inArray(cimQuestionLibrary.sectionKey, input.sectionKeys),
          isNull(cimQuestionLibrary.archivedAt),
          or(...visible),
        ),
      )
      .orderBy(asc(cimQuestionLibrary.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as "system" | "firm" | "user",
      sectionKey: r.sectionKey,
      blockKeyPattern: r.blockKeyPattern,
      questionText: r.questionText,
      helpText: r.helpText,
      sortOrder: r.sortOrder,
    }));
  }
}

export class DrizzlePublicationsRepository implements PublicationsRepository {
  constructor(private readonly db: Db) {}

  async forVersion(versionId: string) {
    const rows = await this.db
      .select({ sha256: cimPublications.sha256, documentId: cimPublications.documentId })
      .from(cimPublications)
      .where(eq(cimPublications.versionId, versionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async record(input: Parameters<PublicationsRepository["record"]>[0]): Promise<void> {
    await this.db.insert(cimPublications).values({
      versionId: input.versionId,
      uploadId: input.uploadId,
      documentId: input.documentId,
      sha256: input.sha256,
      byteSize: input.byteSize,
      pageCount: input.pageCount,
      publishedBy: input.publishedBy,
    });
  }
}
