import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { ItemOrigin, ItemPriority, ItemStatus, ResponseKind } from "@datahub/contracts";
import type {
  AppendResponseInput,
  AssigneeRecord,
  AssigneesRepository,
  AssignmentEventRecord,
  CategoriesRepository,
  CategoryRecord,
  CreateItemInput,
  DataRoomAttachmentPort,
  DealMemberPort,
  ItemFilter,
  ItemRecord,
  ItemsRepository,
  NomineeRecord,
  PresentationRecord,
  PresentationsRepository,
  ResponseRecord,
  ResponsesRepository,
} from "./ports.js";

const {
  documents,
  qaAssignees,
  qaAssignmentEvents,
  qaAttachments,
  qaCategories,
  qaItemVisibility,
  qaItems,
  qaNominations,
  qaPresentations,
  qaResponses,
  userCompanies,
  users,
} = schema;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

/** The default vocabulary — the same list migration 0003 backfills. */
const DEFAULT_CATEGORIES: ReadonlyArray<[string, string]> = [
  ["finance", "Finance"],
  ["legal", "Legal"],
  ["compliance", "Compliance"],
  ["hr", "HR"],
  ["tax", "Tax"],
  ["ma", "M&A"],
  ["other", "Other"],
];

export class DrizzleCategoriesRepository implements CategoriesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Give a company its categories if it has none.
   *
   * Migration 0003 backfills the companies that existed when it ran; anything
   * created afterwards arrives here instead. `onConflictDoNothing` on the
   * (company, key) unique index makes two concurrent first reads harmless.
   */
  async ensureDefaults(companyId: string): Promise<void> {
    await this.db
      .insert(qaCategories)
      .values(
        DEFAULT_CATEGORIES.map(([key, label], index) => ({
          companyId,
          key,
          label,
          sortOrder: index + 1,
        })),
      )
      .onConflictDoNothing({ target: [qaCategories.companyId, qaCategories.key] });
  }

  async listFor(companyId: string): Promise<CategoryRecord[]> {
    const rows = await this.db
      .select()
      .from(qaCategories)
      .where(eq(qaCategories.companyId, companyId))
      .orderBy(asc(qaCategories.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      key: r.key,
      label: r.label,
      sortOrder: r.sortOrder,
    }));
  }

  async nomineesFor(companyId: string): Promise<Map<string, NomineeRecord[]>> {
    const rows = await this.db
      .select({
        categoryId: qaNominations.categoryId,
        userId: qaNominations.userId,
        nominatedBy: qaNominations.nominatedBy,
        name: users.name,
      })
      .from(qaNominations)
      .leftJoin(users, eq(users.id, qaNominations.userId))
      .where(and(eq(qaNominations.companyId, companyId), isNull(qaNominations.revokedAt)));
    const out = new Map<string, NomineeRecord[]>();
    for (const row of rows) {
      const list = out.get(row.categoryId) ?? [];
      list.push({ userId: row.userId, name: row.name, nominatedBy: row.nominatedBy });
      out.set(row.categoryId, list);
    }
    return out;
  }

  /** A set, replaced wholesale — two people editing a roster must not interleave. */
  async replaceNominees(categoryId: string, userIds: string[], actorId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(qaNominations).where(eq(qaNominations.categoryId, categoryId));
      if (userIds.length === 0) return;
      const [category] = await tx
        .select({ companyId: qaCategories.companyId })
        .from(qaCategories)
        .where(eq(qaCategories.id, categoryId))
        .limit(1);
      if (!category) return;
      await tx.insert(qaNominations).values(
        userIds.map((userId) => ({
          companyId: category.companyId,
          categoryId,
          userId,
          nominatedBy: actorId,
        })),
      );
    });
  }

  async getById(categoryId: string): Promise<CategoryRecord | null> {
    const rows = await this.db
      .select()
      .from(qaCategories)
      .where(eq(qaCategories.id, categoryId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          id: row.id,
          companyId: row.companyId,
          key: row.key,
          label: row.label,
          sortOrder: row.sortOrder,
        }
      : null;
  }
}

function toItem(row: {
  item: typeof qaItems.$inferSelect;
  categoryLabel: string | null;
  requestorName: string | null;
}): ItemRecord {
  const i = row.item;
  return {
    id: i.id,
    companyId: i.companyId,
    categoryId: i.categoryId,
    categoryLabel: row.categoryLabel,
    reference: i.reference,
    title: i.title,
    body: i.body,
    status: i.status as ItemStatus,
    priority: i.priority as ItemPriority,
    origin: i.origin as ItemOrigin,
    moduleTag: i.moduleTag,
    sectionTag: i.sectionTag,
    accountRef: i.accountRef,
    externalRef: i.externalRef,
    requestorId: i.requestorId,
    requestorName: row.requestorName,
    askedAt: iso(i.askedAt) ?? "",
    answeredAt: iso(i.answeredAt),
    dueDate: i.dueDate,
    closedAt: iso(i.closedAt),
  };
}

export class DrizzleItemsRepository implements ItemsRepository {
  constructor(private readonly db: Db) {}

  /**
   * The visibility predicate, as SQL.
   *
   * An explicit `allow` for this user beats any `hide`, so a role-wide hide can
   * carve out one person. It is a NOT EXISTS on the hide side rather than a
   * filter applied afterwards, because a hidden item must never enter the result
   * set in the first place.
   */
  private visiblePredicate(userId: string, roleKey: string) {
    return sql`(
      EXISTS (
        SELECT 1 FROM ${qaItemVisibility} v
        WHERE v.item_id = ${qaItems.id} AND v.effect = 'allow' AND v.user_id = ${userId}
      )
      OR NOT EXISTS (
        SELECT 1 FROM ${qaItemVisibility} v
        WHERE v.item_id = ${qaItems.id} AND v.effect = 'hide'
          AND (v.user_id = ${userId} OR v.role_key = ${roleKey})
      )
    )`;
  }

  async list(companyId: string, filter: ItemFilter): Promise<ItemRecord[]> {
    const conditions = [
      eq(qaItems.companyId, companyId),
      this.visiblePredicate(filter.viewer.userId, filter.viewer.roleKey),
    ];
    if (filter.categoryId) conditions.push(eq(qaItems.categoryId, filter.categoryId));
    if (filter.status) conditions.push(eq(qaItems.status, filter.status));
    if (filter.mine?.as === "requestor") {
      conditions.push(eq(qaItems.requestorId, filter.mine.userId));
    }
    if (filter.mine?.as === "requestee") {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${qaAssignees} a
          WHERE a.item_id = ${qaItems.id} AND a.user_id = ${filter.mine.userId}
            AND a.removed_at IS NULL
        )`,
      );
    }
    const rows = await this.db
      .select({
        item: qaItems,
        categoryLabel: qaCategories.label,
        requestorName: users.name,
      })
      .from(qaItems)
      .leftJoin(qaCategories, eq(qaCategories.id, qaItems.categoryId))
      .leftJoin(users, eq(users.id, qaItems.requestorId))
      .where(and(...conditions))
      .orderBy(asc(qaItems.askedAt));
    return rows.map(toItem);
  }

  async getById(itemId: string): Promise<ItemRecord | null> {
    const rows = await this.db
      .select({ item: qaItems, categoryLabel: qaCategories.label, requestorName: users.name })
      .from(qaItems)
      .leftJoin(qaCategories, eq(qaCategories.id, qaItems.categoryId))
      .leftJoin(users, eq(users.id, qaItems.requestorId))
      .where(eq(qaItems.id, itemId))
      .limit(1);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async create(input: CreateItemInput): Promise<ItemRecord> {
    const [row] = await this.db
      .insert(qaItems)
      .values({
        companyId: input.companyId,
        categoryId: input.categoryId,
        reference: input.reference,
        title: input.title,
        body: input.body,
        priority: input.priority,
        origin: input.origin,
        moduleTag: input.moduleTag,
        sectionTag: input.sectionTag,
        accountRef: input.accountRef,
        externalRef: input.externalRef,
        dueDate: input.dueDate,
        requestorId: input.requestorId,
        createdBy: input.createdBy,
      })
      .returning({ id: qaItems.id });
    const created = await this.getById(row!.id);
    return created!;
  }

  async update(
    itemId: string,
    patch: Partial<{
      title: string;
      body: string;
      categoryId: string | null;
      priority: ItemPriority;
      status: ItemStatus;
      dueDate: string | null;
    }>,
  ): Promise<ItemRecord | null> {
    await this.db
      .update(qaItems)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.status !== undefined
          ? { status: patch.status, closedAt: patch.status === "closed" ? new Date() : null }
          : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      })
      .where(eq(qaItems.id, itemId));
    return this.getById(itemId);
  }

  async markAnswered(itemId: string, at: Date): Promise<void> {
    // Only the first answer sets it — a later one must not move the date.
    await this.db
      .update(qaItems)
      .set({ answeredAt: at, status: "answered" })
      .where(and(eq(qaItems.id, itemId), isNull(qaItems.answeredAt)));
  }

  async nextReference(companyId: string): Promise<string> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(qaItems)
      .where(eq(qaItems.companyId, companyId));
    return `QA-${String(Number(row?.n ?? 0) + 1).padStart(3, "0")}`;
  }

  async isHiddenFrom(itemId: string, userId: string, roleKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ effect: qaItemVisibility.effect, userId: qaItemVisibility.userId })
      .from(qaItemVisibility)
      .where(
        and(
          eq(qaItemVisibility.itemId, itemId),
          or(eq(qaItemVisibility.userId, userId), eq(qaItemVisibility.roleKey, roleKey)),
        ),
      );
    if (rows.some((r) => r.effect === "allow" && r.userId === userId)) return false;
    return rows.some((r) => r.effect === "hide");
  }

  async setVisibilityRule(input: {
    itemId: string;
    userId: string | null;
    roleKey: string | null;
    effect: "hide" | "allow";
    createdBy: string;
  }): Promise<void> {
    await this.db.insert(qaItemVisibility).values({
      itemId: input.itemId,
      userId: input.userId,
      roleKey: input.roleKey,
      effect: input.effect,
      createdBy: input.createdBy,
    });
  }
}

export class DrizzleAssigneesRepository implements AssigneesRepository {
  constructor(private readonly db: Db) {}

  async listFor(itemId: string): Promise<AssigneeRecord[]> {
    const rows = await this.db
      .select({
        userId: qaAssignees.userId,
        kind: qaAssignees.kind,
        assignedAt: qaAssignees.assignedAt,
        name: users.name,
      })
      .from(qaAssignees)
      .leftJoin(users, eq(users.id, qaAssignees.userId))
      .where(and(eq(qaAssignees.itemId, itemId), isNull(qaAssignees.removedAt)))
      .orderBy(asc(qaAssignees.assignedAt));
    return rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      kind: r.kind as AssigneeRecord["kind"],
      assignedAt: iso(r.assignedAt) ?? "",
    }));
  }

  /**
   * Replace the live set and record one event describing the change.
   *
   * Rows are marked removed rather than deleted, so "who was on this yesterday"
   * survives — which is the question an audit of a stalled item actually asks.
   */
  async replace(input: {
    itemId: string;
    userIds: string[];
    kind: "requestee" | "delegate";
    actorId: string;
    note: string | null;
  }): Promise<AssigneeRecord[]> {
    await this.db.transaction(async (tx) => {
      const prior = await tx
        .select({ userId: qaAssignees.userId })
        .from(qaAssignees)
        .where(and(eq(qaAssignees.itemId, input.itemId), isNull(qaAssignees.removedAt)));
      const priorIds = prior.map((p) => p.userId);

      await tx
        .update(qaAssignees)
        .set({ removedAt: new Date() })
        .where(and(eq(qaAssignees.itemId, input.itemId), isNull(qaAssignees.removedAt)));

      if (input.userIds.length > 0) {
        await tx
          .insert(qaAssignees)
          .values(
            input.userIds.map((userId) => ({
              itemId: input.itemId,
              userId,
              kind: input.kind,
              assignedBy: input.actorId,
            })),
          )
          .onConflictDoUpdate({
            target: [qaAssignees.itemId, qaAssignees.userId, qaAssignees.kind],
            set: { removedAt: null, assignedAt: new Date(), assignedBy: input.actorId },
          });
      }

      await tx.insert(qaAssignmentEvents).values({
        itemId: input.itemId,
        action:
          priorIds.length === 0
            ? "assigned"
            : input.kind === "delegate"
              ? "delegated"
              : "reassigned",
        priorUserIds: priorIds,
        newUserIds: input.userIds,
        actorId: input.actorId,
        note: input.note,
      });
    });
    return this.listFor(input.itemId);
  }

  async history(itemId: string): Promise<AssignmentEventRecord[]> {
    const rows = await this.db
      .select({ event: qaAssignmentEvents, actorName: users.name })
      .from(qaAssignmentEvents)
      .leftJoin(users, eq(users.id, qaAssignmentEvents.actorId))
      .where(eq(qaAssignmentEvents.itemId, itemId))
      .orderBy(asc(qaAssignmentEvents.at));
    return rows.map((r) => ({
      id: r.event.id,
      action: r.event.action as AssignmentEventRecord["action"],
      priorUserIds: r.event.priorUserIds,
      newUserIds: r.event.newUserIds,
      actorId: r.event.actorId,
      actorName: r.actorName,
      note: r.event.note,
      at: iso(r.event.at) ?? "",
    }));
  }
}

/**
 * Insert-only, and there is no update method to find.
 *
 * A correction inserts a row with `supersedesId`, joins the lineage the earlier
 * answer rooted, and flips that row's `isCurrent` — the only mutation anywhere in
 * this repository, and the partial unique index in the schema is the backstop
 * behind it.
 */
export class DrizzleResponsesRepository implements ResponsesRepository {
  constructor(private readonly db: Db) {}

  private async attachmentsFor(itemId: string) {
    const rows = await this.db
      .select({
        responseId: qaAttachments.responseId,
        documentId: qaAttachments.documentId,
        folderId: qaAttachments.folderId,
        name: documents.name,
      })
      .from(qaAttachments)
      .leftJoin(documents, eq(documents.id, qaAttachments.documentId))
      .where(eq(qaAttachments.itemId, itemId));
    const byResponse = new Map<
      string,
      Array<{ documentId: string; folderId: string | null; name: string | null }>
    >();
    for (const row of rows) {
      if (!row.responseId) continue;
      const list = byResponse.get(row.responseId) ?? [];
      list.push({ documentId: row.documentId, folderId: row.folderId, name: row.name });
      byResponse.set(row.responseId, list);
    }
    return byResponse;
  }

  async listFor(itemId: string): Promise<ResponseRecord[]> {
    const [rows, attachments] = await Promise.all([
      this.db
        .select({ response: qaResponses, authorName: users.name })
        .from(qaResponses)
        .leftJoin(users, eq(users.id, qaResponses.authorId))
        .where(eq(qaResponses.itemId, itemId))
        .orderBy(asc(qaResponses.postedAt)),
      this.attachmentsFor(itemId),
    ]);
    return rows.map((r) => toResponse(r.response, r.authorName, attachments.get(r.response.id) ?? []));
  }

  async getById(responseId: string): Promise<ResponseRecord | null> {
    const rows = await this.db
      .select({ response: qaResponses, authorName: users.name })
      .from(qaResponses)
      .leftJoin(users, eq(users.id, qaResponses.authorId))
      .where(eq(qaResponses.id, responseId))
      .limit(1);
    return rows[0] ? toResponse(rows[0].response, rows[0].authorName, []) : null;
  }

  async append(input: AppendResponseInput): Promise<ResponseRecord> {
    return this.db.transaction(async (tx) => {
      let answerRootId: string | null = null;
      let answerVersion = 1;

      if (input.supersedesId) {
        const [prior] = await tx
          .select()
          .from(qaResponses)
          .where(eq(qaResponses.id, input.supersedesId))
          .limit(1);
        if (prior) {
          answerRootId = prior.answerRootId ?? prior.id;
          answerVersion = prior.answerVersion + 1;
          // The only mutation in this repository, and it is a flag rather than
          // content — the superseded text itself is never touched.
          await tx
            .update(qaResponses)
            .set({ isCurrent: false })
            .where(eq(qaResponses.id, prior.id));
        }
      }

      const [row] = await tx
        .insert(qaResponses)
        .values({
          itemId: input.itemId,
          citationRef: input.citationRef,
          kind: input.kind,
          body: input.body,
          authorId: input.authorId,
          supersedesId: input.supersedesId,
          answerRootId,
          answerVersion,
        })
        .returning();

      // A first answer roots its own lineage, so every later version shares one
      // id and "all versions of this answer" is a single equality.
      if (input.kind === "answer" && !answerRootId) {
        await tx
          .update(qaResponses)
          .set({ answerRootId: row!.id })
          .where(eq(qaResponses.id, row!.id));
        row!.answerRootId = row!.id;
      }

      const names = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, input.authorId))
        .limit(1);
      return toResponse(row!, names[0]?.name ?? null, []);
    });
  }

  async nextCitationRef(itemId: string, itemReference: string): Promise<string> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(qaResponses)
      .where(eq(qaResponses.itemId, itemId));
    return `${itemReference}.R${Number(row?.n ?? 0) + 1}`;
  }

  async attach(input: {
    itemId: string;
    responseId: string | null;
    documentId: string;
    folderId: string;
    createdBy: string;
  }): Promise<void> {
    await this.db
      .insert(qaAttachments)
      .values({
        itemId: input.itemId,
        responseId: input.responseId,
        documentId: input.documentId,
        folderId: input.folderId,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing();
  }
}

function toResponse(
  row: typeof qaResponses.$inferSelect,
  authorName: string | null,
  attachments: Array<{ documentId: string; folderId: string | null; name: string | null }>,
): ResponseRecord {
  return {
    id: row.id,
    itemId: row.itemId,
    citationRef: row.citationRef,
    kind: row.kind as ResponseKind,
    body: row.body,
    authorId: row.authorId,
    authorName,
    postedAt: iso(row.postedAt) ?? "",
    supersedesId: row.supersedesId,
    answerRootId: row.answerRootId,
    answerVersion: row.answerVersion,
    isCurrent: row.isCurrent,
    attachments,
  };
}

export class DrizzlePresentationsRepository implements PresentationsRepository {
  constructor(private readonly db: Db) {}

  async listFor(itemId: string): Promise<PresentationRecord[]> {
    const rows = await this.db
      .select({ presentation: qaPresentations, authorName: users.name })
      .from(qaPresentations)
      .leftJoin(users, eq(users.id, qaPresentations.authorId))
      .where(eq(qaPresentations.itemId, itemId))
      .orderBy(asc(qaPresentations.version));
    return rows.map((r) => toPresentation(r.presentation, r.authorName));
  }

  async getById(id: string): Promise<PresentationRecord | null> {
    const rows = await this.db
      .select({ presentation: qaPresentations, authorName: users.name })
      .from(qaPresentations)
      .leftJoin(users, eq(users.id, qaPresentations.authorId))
      .where(eq(qaPresentations.id, id))
      .limit(1);
    return rows[0] ? toPresentation(rows[0].presentation, rows[0].authorName) : null;
  }

  async append(input: {
    itemId: string;
    sourceResponseId: string;
    body: string;
    authorId: string;
  }): Promise<PresentationRecord> {
    return this.db.transaction(async (tx) => {
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(qaPresentations)
        .where(eq(qaPresentations.itemId, input.itemId));
      await tx
        .update(qaPresentations)
        .set({ isCurrent: false })
        .where(eq(qaPresentations.itemId, input.itemId));
      const [row] = await tx
        .insert(qaPresentations)
        .values({
          itemId: input.itemId,
          sourceResponseId: input.sourceResponseId,
          body: input.body,
          version: Number(count?.n ?? 0) + 1,
          authorId: input.authorId,
        })
        .returning();
      const names = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, input.authorId))
        .limit(1);
      return toPresentation(row!, names[0]?.name ?? null);
    });
  }

  async publish(id: string): Promise<PresentationRecord | null> {
    await this.db
      .update(qaPresentations)
      .set({ status: "published" })
      .where(eq(qaPresentations.id, id));
    return this.getById(id);
  }
}

function toPresentation(
  row: typeof qaPresentations.$inferSelect,
  authorName: string | null,
): PresentationRecord {
  return {
    id: row.id,
    itemId: row.itemId,
    sourceResponseId: row.sourceResponseId,
    body: row.body,
    version: row.version,
    isCurrent: row.isCurrent,
    status: row.status as PresentationRecord["status"],
    authorId: row.authorId,
    authorName,
    createdAt: iso(row.createdAt) ?? "",
  };
}

/**
 * Who is on the deal — `users.company_id` union `user_companies`.
 *
 * The same association `canAccessCompany` reads, which is what keeps "may see
 * this deal" and "may be assigned on this deal" from drifting apart.
 */
export class DrizzleDealMemberPort implements DealMemberPort {
  constructor(private readonly db: Db) {}

  async isMember(companyId: string, userId: string): Promise<boolean> {
    const direct = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.companyId, companyId)))
      .limit(1);
    if (direct.length > 0) return true;
    const joined = await this.db
      .select({ userId: userCompanies.userId })
      .from(userCompanies)
      .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, companyId)))
      .limit(1);
    return joined.length > 0;
  }

  async listMembers(companyId: string) {
    const direct = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.companyId, companyId));
    const joinedIds = await this.db
      .select({ userId: userCompanies.userId })
      .from(userCompanies)
      .where(eq(userCompanies.companyId, companyId));
    const ids = joinedIds.map((j) => j.userId).filter((id) => !direct.some((d) => d.id === id));
    const joined =
      ids.length > 0
        ? await this.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, ids))
        : [];
    return [...direct, ...joined];
  }
}

export class DrizzleDataRoomAttachmentPort implements DataRoomAttachmentPort {
  readonly available = true;
  constructor(private readonly db: Db) {}

  async describe(documentId: string) {
    const rows = await this.db
      .select({
        id: documents.id,
        companyId: documents.companyId,
        folderId: documents.folderId,
        name: documents.name,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    return rows[0] ?? null;
  }
}
