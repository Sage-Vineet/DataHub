import { randomUUID } from "node:crypto";
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

/** The default vocabulary, matching the migration and the requests module. */
const DEFAULT_CATEGORIES: ReadonlyArray<[string, string]> = [
  ["finance", "Finance"],
  ["legal", "Legal"],
  ["compliance", "Compliance"],
  ["hr", "HR"],
  ["tax", "Tax"],
  ["ma", "M&A"],
  ["other", "Other"],
];

interface VisibilityRow {
  itemId: string;
  userId: string | null;
  roleKey: string | null;
  effect: "hide" | "allow";
}

export class QaStore {
  readonly categories: CategoryRecord[] = [];
  readonly nominations: Array<{ categoryId: string; userId: string; nominatedBy: string }> = [];
  readonly items: ItemRecord[] = [];
  readonly assignees: Array<AssigneeRecord & { itemId: string; removed: boolean }> = [];
  readonly events: Array<AssignmentEventRecord & { itemId: string }> = [];
  readonly responses: ResponseRecord[] = [];
  readonly presentations: PresentationRecord[] = [];
  readonly visibility: VisibilityRow[] = [];
  readonly attachments: Array<{
    itemId: string;
    responseId: string | null;
    documentId: string;
    folderId: string;
  }> = [];
  readonly members = new Map<string, Array<{ id: string; name: string | null }>>();
  readonly documents = new Map<
    string,
    { id: string; companyId: string; folderId: string; name: string }
  >();
  private clock = 0;

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  addMember(companyId: string, id: string, name: string): void {
    const list = this.members.get(companyId) ?? [];
    list.push({ id, name });
    this.members.set(companyId, list);
  }

  addDocument(doc: { id: string; companyId: string; folderId: string; name: string }): void {
    this.documents.set(doc.id, doc);
  }

  nameOf(userId: string): string | null {
    for (const list of this.members.values()) {
      const found = list.find((m) => m.id === userId);
      if (found) return found.name;
    }
    return null;
  }
}

export class MemoryCategoriesRepository implements CategoriesRepository {
  constructor(private readonly store: QaStore) {}

  async ensureDefaults(companyId: string): Promise<void> {
    if (this.store.categories.some((c) => c.companyId === companyId)) return;
    DEFAULT_CATEGORIES.forEach(([key, label], index) => {
      this.store.categories.push({
        id: randomUUID(),
        companyId,
        key,
        label,
        sortOrder: index + 1,
      });
    });
  }

  async listFor(companyId: string): Promise<CategoryRecord[]> {
    return this.store.categories
      .filter((c) => c.companyId === companyId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async nomineesFor(companyId: string): Promise<Map<string, NomineeRecord[]>> {
    const out = new Map<string, NomineeRecord[]>();
    for (const category of this.store.categories.filter((c) => c.companyId === companyId)) {
      out.set(
        category.id,
        this.store.nominations
          .filter((n) => n.categoryId === category.id)
          .map((n) => ({
            userId: n.userId,
            name: this.store.nameOf(n.userId),
            nominatedBy: n.nominatedBy,
          })),
      );
    }
    return out;
  }

  async replaceNominees(categoryId: string, userIds: string[], actorId: string): Promise<void> {
    for (let i = this.store.nominations.length - 1; i >= 0; i--) {
      if (this.store.nominations[i]!.categoryId === categoryId) {
        this.store.nominations.splice(i, 1);
      }
    }
    for (const userId of userIds) {
      this.store.nominations.push({ categoryId, userId, nominatedBy: actorId });
    }
  }

  async getById(categoryId: string): Promise<CategoryRecord | null> {
    return this.store.categories.find((c) => c.id === categoryId) ?? null;
  }
}

export class MemoryItemsRepository implements ItemsRepository {
  constructor(private readonly store: QaStore) {}

  async list(companyId: string, filter: ItemFilter): Promise<ItemRecord[]> {
    const liveAssignees = (itemId: string) =>
      this.store.assignees.filter((a) => a.itemId === itemId && !a.removed).map((a) => a.userId);
    const results: ItemRecord[] = [];
    for (const item of this.store.items) {
      if (item.companyId !== companyId) continue;
      if (filter.categoryId && item.categoryId !== filter.categoryId) continue;
      if (filter.status && item.status !== filter.status) continue;
      if (filter.mine?.as === "requestor" && item.requestorId !== filter.mine.userId) continue;
      if (
        filter.mine?.as === "requestee" &&
        !liveAssignees(item.id).includes(filter.mine.userId)
      ) {
        continue;
      }
      // The override is applied in the listing, not after it — a hidden item
      // never enters the result set.
      if (await this.isHiddenFrom(item.id, filter.viewer.userId, filter.viewer.roleKey)) continue;
      results.push(item);
    }
    return results;
  }

  async getById(itemId: string): Promise<ItemRecord | null> {
    return this.store.items.find((i) => i.id === itemId) ?? null;
  }

  async create(input: CreateItemInput): Promise<ItemRecord> {
    const category = this.store.categories.find((c) => c.id === input.categoryId);
    const record: ItemRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      categoryId: input.categoryId,
      categoryLabel: category?.label ?? null,
      reference: input.reference,
      title: input.title,
      body: input.body,
      status: "open",
      priority: input.priority,
      origin: input.origin,
      moduleTag: input.moduleTag,
      sectionTag: input.sectionTag,
      accountRef: input.accountRef,
      externalRef: input.externalRef,
      requestorId: input.requestorId,
      requestorName: this.store.nameOf(input.requestorId),
      askedAt: this.store.now(),
      answeredAt: null,
      dueDate: input.dueDate,
      closedAt: null,
    };
    this.store.items.push(record);
    return record;
  }

  async update(
    itemId: string,
    patch: Partial<{
      title: string;
      body: string;
      categoryId: string | null;
      priority: ItemRecord["priority"];
      status: ItemRecord["status"];
      dueDate: string | null;
    }>,
  ): Promise<ItemRecord | null> {
    const item = this.store.items.find((i) => i.id === itemId);
    if (!item) return null;
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.body !== undefined) item.body = patch.body;
    if (patch.categoryId !== undefined) {
      item.categoryId = patch.categoryId;
      item.categoryLabel =
        this.store.categories.find((c) => c.id === patch.categoryId)?.label ?? null;
    }
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.status !== undefined) {
      item.status = patch.status;
      item.closedAt = patch.status === "closed" ? this.store.now() : null;
    }
    if (patch.dueDate !== undefined) item.dueDate = patch.dueDate;
    return item;
  }

  async markAnswered(itemId: string): Promise<void> {
    const item = this.store.items.find((i) => i.id === itemId);
    if (!item || item.answeredAt) return;
    item.answeredAt = this.store.now();
    if (item.status === "open") item.status = "answered";
  }

  async nextReference(companyId: string): Promise<string> {
    const n = this.store.items.filter((i) => i.companyId === companyId).length + 1;
    return `QA-${String(n).padStart(3, "0")}`;
  }

  async isHiddenFrom(itemId: string, userId: string, roleKey: string): Promise<boolean> {
    const rules = this.store.visibility.filter((v) => v.itemId === itemId);
    // An explicit allow beats a hide, so a role-wide hide can carve out a person.
    if (rules.some((r) => r.effect === "allow" && r.userId === userId)) return false;
    return rules.some(
      (r) => r.effect === "hide" && (r.userId === userId || r.roleKey === roleKey),
    );
  }

  async setVisibilityRule(input: {
    itemId: string;
    userId: string | null;
    roleKey: string | null;
    effect: "hide" | "allow";
    createdBy: string;
  }): Promise<void> {
    this.store.visibility.push({
      itemId: input.itemId,
      userId: input.userId,
      roleKey: input.roleKey,
      effect: input.effect,
    });
  }
}

export class MemoryAssigneesRepository implements AssigneesRepository {
  constructor(private readonly store: QaStore) {}

  async listFor(itemId: string): Promise<AssigneeRecord[]> {
    return this.store.assignees
      .filter((a) => a.itemId === itemId && !a.removed)
      .map(({ userId, name, kind, assignedAt }) => ({ userId, name, kind, assignedAt }));
  }

  async replace(input: {
    itemId: string;
    userIds: string[];
    kind: "requestee" | "delegate";
    actorId: string;
    note: string | null;
  }): Promise<AssigneeRecord[]> {
    const prior = (await this.listFor(input.itemId)).map((a) => a.userId);
    for (const row of this.store.assignees) {
      if (row.itemId === input.itemId) row.removed = true;
    }
    for (const userId of input.userIds) {
      this.store.assignees.push({
        itemId: input.itemId,
        userId,
        name: this.store.nameOf(userId),
        kind: input.kind,
        assignedAt: this.store.now(),
        removed: false,
      });
    }
    this.store.events.push({
      id: randomUUID(),
      itemId: input.itemId,
      action:
        prior.length === 0 ? "assigned" : input.kind === "delegate" ? "delegated" : "reassigned",
      priorUserIds: prior,
      newUserIds: input.userIds,
      actorId: input.actorId,
      actorName: this.store.nameOf(input.actorId),
      note: input.note,
      at: this.store.now(),
    });
    return this.listFor(input.itemId);
  }

  async history(itemId: string): Promise<AssignmentEventRecord[]> {
    return this.store.events
      .filter((e) => e.itemId === itemId)
      .map(({ itemId: _drop, ...rest }) => rest);
  }
}

export class MemoryResponsesRepository implements ResponsesRepository {
  constructor(private readonly store: QaStore) {}

  async listFor(itemId: string): Promise<ResponseRecord[]> {
    return this.store.responses
      .filter((r) => r.itemId === itemId)
      .map((r) => ({
        ...r,
        attachments: this.store.attachments
          .filter((a) => a.responseId === r.id)
          .map((a) => ({
            documentId: a.documentId,
            folderId: a.folderId,
            name: this.store.documents.get(a.documentId)?.name ?? null,
          })),
      }));
  }

  async getById(responseId: string): Promise<ResponseRecord | null> {
    return this.store.responses.find((r) => r.id === responseId) ?? null;
  }

  async append(input: AppendResponseInput): Promise<ResponseRecord> {
    const prior = input.supersedesId
      ? this.store.responses.find((r) => r.id === input.supersedesId)
      : undefined;
    // The lineage root is the first answer in the chain; superseding rows join it
    // rather than starting a new one.
    const answerRootId =
      input.kind === "answer" ? (prior?.answerRootId ?? prior?.id ?? null) : null;
    if (prior) prior.isCurrent = false;

    const record: ResponseRecord = {
      id: randomUUID(),
      itemId: input.itemId,
      citationRef: input.citationRef,
      kind: input.kind,
      body: input.body,
      authorId: input.authorId,
      authorName: this.store.nameOf(input.authorId),
      postedAt: this.store.now(),
      supersedesId: input.supersedesId,
      answerRootId: null,
      answerVersion: prior ? prior.answerVersion + 1 : 1,
      isCurrent: true,
      attachments: [],
    };
    // A first answer roots its own lineage, so every version shares one id.
    record.answerRootId = input.kind === "answer" ? (answerRootId ?? record.id) : null;
    this.store.responses.push(record);
    return record;
  }

  async nextCitationRef(itemId: string, itemReference: string): Promise<string> {
    const n = this.store.responses.filter((r) => r.itemId === itemId).length + 1;
    return `${itemReference}.R${n}`;
  }

  async attach(input: {
    itemId: string;
    responseId: string | null;
    documentId: string;
    folderId: string;
  }): Promise<void> {
    this.store.attachments.push({
      itemId: input.itemId,
      responseId: input.responseId,
      documentId: input.documentId,
      folderId: input.folderId,
    });
  }
}

export class MemoryPresentationsRepository implements PresentationsRepository {
  constructor(private readonly store: QaStore) {}

  async listFor(itemId: string): Promise<PresentationRecord[]> {
    return this.store.presentations.filter((p) => p.itemId === itemId);
  }

  async getById(id: string): Promise<PresentationRecord | null> {
    return this.store.presentations.find((p) => p.id === id) ?? null;
  }

  async append(input: {
    itemId: string;
    sourceResponseId: string;
    body: string;
    authorId: string;
  }): Promise<PresentationRecord> {
    const existing = this.store.presentations.filter((p) => p.itemId === input.itemId);
    for (const p of existing) p.isCurrent = false;
    const record: PresentationRecord = {
      id: randomUUID(),
      itemId: input.itemId,
      sourceResponseId: input.sourceResponseId,
      body: input.body,
      version: existing.length + 1,
      isCurrent: true,
      status: "draft",
      authorId: input.authorId,
      authorName: this.store.nameOf(input.authorId),
      createdAt: this.store.now(),
    };
    this.store.presentations.push(record);
    return record;
  }

  async publish(id: string): Promise<PresentationRecord | null> {
    const found = this.store.presentations.find((p) => p.id === id);
    if (!found) return null;
    found.status = "published";
    return found;
  }
}

export class MemoryDealMemberPort implements DealMemberPort {
  constructor(private readonly store: QaStore) {}

  async isMember(companyId: string, userId: string): Promise<boolean> {
    return (this.store.members.get(companyId) ?? []).some((m) => m.id === userId);
  }

  async listMembers(companyId: string) {
    return this.store.members.get(companyId) ?? [];
  }
}

export class MemoryDataRoomAttachmentPort implements DataRoomAttachmentPort {
  readonly available = true;
  constructor(private readonly store: QaStore) {}

  async describe(documentId: string) {
    return this.store.documents.get(documentId) ?? null;
  }
}

/** The null adapter used when the data room capability is switched off. */
export const unavailableDataRoom: DataRoomAttachmentPort = {
  available: false,
  describe: async () => null,
};

export function memoryQa(store = new QaStore()) {
  return {
    store,
    categories: new MemoryCategoriesRepository(store),
    items: new MemoryItemsRepository(store),
    assignees: new MemoryAssigneesRepository(store),
    responses: new MemoryResponsesRepository(store),
    presentations: new MemoryPresentationsRepository(store),
    members: new MemoryDealMemberPort(store),
    dataRoom: new MemoryDataRoomAttachmentPort(store),
  };
}
