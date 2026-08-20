import type {
  AuditTrail,
  AssigneesReplace,
  AttachmentCreate,
  CategoryResponse,
  ItemCreate,
  ItemDetail,
  ItemListQuery,
  ItemResponse,
  ItemUpdate,
  NomineesReplace,
  PresentationCreate,
  PresentationResponse,
  ResponseCreate,
  ResponseResponse,
  SessionUser,
  VisibilityRule,
} from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type {
  AssigneesRepository,
  CategoriesRepository,
  DataRoomAttachmentPort,
  DealMemberPort,
  ItemRecord,
  ItemsRepository,
  PresentationRecord,
  PresentationsRepository,
  QaActivityPort,
  ResponseRecord,
  ResponsesRepository,
} from "./ports.js";

export interface QaServiceDeps {
  categories: CategoriesRepository;
  items: ItemsRepository;
  assignees: AssigneesRepository;
  responses: ResponsesRepository;
  presentations: PresentationsRepository;
  members: DealMemberPort;
  dataRoom: DataRoomAttachmentPort;
  activity?: QaActivityPort;
}

const isBrokerSide = (user: SessionUser): boolean =>
  user.role === "broker" || user.role === "admin";

function toItemResponse(item: ItemRecord, assignees: ItemDetail["item"]["assignees"]): ItemResponse {
  return {
    id: item.id,
    company_id: item.companyId,
    category_id: item.categoryId,
    category_label: item.categoryLabel,
    reference: item.reference,
    title: item.title,
    body: item.body,
    status: item.status,
    priority: item.priority,
    origin: item.origin,
    module_tag: item.moduleTag,
    section_tag: item.sectionTag,
    account_ref: item.accountRef,
    external_ref: item.externalRef,
    requestor_id: item.requestorId,
    requestor_name: item.requestorName,
    assignees,
    asked_at: item.askedAt,
    answered_at: item.answeredAt,
    due_date: item.dueDate,
    closed_at: item.closedAt,
  };
}

function toResponseResponse(r: ResponseRecord): ResponseResponse {
  return {
    id: r.id,
    item_id: r.itemId,
    citation_ref: r.citationRef,
    kind: r.kind,
    body: r.body,
    author_id: r.authorId,
    author_name: r.authorName,
    posted_at: r.postedAt,
    supersedes_id: r.supersedesId,
    answer_root_id: r.answerRootId,
    answer_version: r.answerVersion,
    is_current: r.isCurrent,
    attachments: r.attachments.map((a) => ({
      document_id: a.documentId,
      folder_id: a.folderId,
      name: a.name,
    })),
  };
}

function toPresentationResponse(p: PresentationRecord): PresentationResponse {
  return {
    id: p.id,
    item_id: p.itemId,
    source_response_id: p.sourceResponseId,
    body: p.body,
    version: p.version,
    is_current: p.isCurrent,
    status: p.status,
    author_id: p.authorId,
    author_name: p.authorName,
    created_at: p.createdAt,
  };
}

export class QaService {
  private readonly deps: QaServiceDeps;

  constructor(deps: QaServiceDeps) {
    this.deps = deps;
  }

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have access to this deal.");
    }
  }

  /**
   * Resolve an item and prove the caller may see it.
   *
   * The per-item override is checked here as well as in the list query, because
   * a hidden item must not be reachable by guessing its id — a filter that only
   * applies to listings is not a visibility rule.
   */
  private async requireItem(user: SessionUser, itemId: string): Promise<ItemRecord> {
    const item = await this.deps.items.getById(itemId);
    if (!item) throw new NotFoundError("Question not found.");
    this.requireCompany(user, item.companyId);
    if (await this.deps.items.isHiddenFrom(itemId, user.id, user.role)) {
      // Not found rather than forbidden: confirming existence is itself a leak.
      throw new NotFoundError("Question not found.");
    }
    return item;
  }

  // ── categories and nomination ─────────────────────────────────────────────

  async listCategories(user: SessionUser, companyId: string): Promise<CategoryResponse[]> {
    this.requireCompany(user, companyId);
    // Provision on first use: the migration could only backfill companies that
    // already existed, so a company created since would otherwise have none.
    await this.deps.categories.ensureDefaults(companyId);
    const [categories, nominees] = await Promise.all([
      this.deps.categories.listFor(companyId),
      this.deps.categories.nomineesFor(companyId),
    ]);
    return categories.map((c) => ({
      id: c.id,
      company_id: c.companyId,
      key: c.key,
      label: c.label,
      sort_order: c.sortOrder,
      nominees: (nominees.get(c.id) ?? []).map((n) => ({
        user_id: n.userId,
        name: n.name,
        nominated_by: n.nominatedBy,
      })),
    }));
  }

  async replaceNominees(
    user: SessionUser,
    companyId: string,
    categoryId: string,
    input: NomineesReplace,
  ): Promise<CategoryResponse[]> {
    this.requireCompany(user, companyId);
    const category = await this.deps.categories.getById(categoryId);
    if (!category || category.companyId !== companyId) {
      throw new NotFoundError("Category not found on this deal.");
    }
    for (const userId of input.user_ids) {
      if (!(await this.deps.members.isMember(companyId, userId))) {
        throw new BadRequestError("You can only nominate people who are on this deal.");
      }
    }
    await this.deps.categories.replaceNominees(categoryId, input.user_ids, user.id);
    return this.listCategories(user, companyId);
  }

  // ── items ─────────────────────────────────────────────────────────────────

  async listItems(
    user: SessionUser,
    companyId: string,
    query: ItemListQuery,
  ): Promise<ItemResponse[]> {
    this.requireCompany(user, companyId);
    const items = await this.deps.items.list(companyId, {
      ...(query.category_id ? { categoryId: query.category_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.mine ? { mine: { userId: user.id, as: query.mine } } : {}),
      viewer: { userId: user.id, roleKey: user.role },
    });
    const withAssignees = await Promise.all(
      items.map(async (item) => {
        const assignees = await this.deps.assignees.listFor(item.id);
        return toItemResponse(
          item,
          assignees.map((a) => ({
            user_id: a.userId,
            name: a.name,
            kind: a.kind,
            assigned_at: a.assignedAt,
          })),
        );
      }),
    );
    return withAssignees;
  }

  /**
   * Raise a question.
   *
   * When no requestees are named, the category's nominees apply — that is the
   * normal path and the reason nomination exists. An explicitly empty list is
   * not the same instruction and is rejected, because an item nobody owns is
   * exactly the failure `QA - 0001` was written to stop.
   */
  async createItem(
    user: SessionUser,
    companyId: string,
    input: ItemCreate,
  ): Promise<ItemResponse> {
    this.requireCompany(user, companyId);
    await this.deps.categories.ensureDefaults(companyId);

    let categoryId: string | null = null;
    if (input.category_id) {
      const category = await this.deps.categories.getById(input.category_id);
      if (!category || category.companyId !== companyId) {
        throw new BadRequestError("That category does not belong to this deal.");
      }
      categoryId = category.id;
    }

    let requesteeIds = input.requestee_ids;
    if (!requesteeIds && categoryId) {
      const nominees = await this.deps.categories.nomineesFor(companyId);
      requesteeIds = (nominees.get(categoryId) ?? []).map((n) => n.userId);
    }
    for (const userId of requesteeIds ?? []) {
      if (!(await this.deps.members.isMember(companyId, userId))) {
        throw new BadRequestError("You can only assign someone who is on this deal.");
      }
    }

    const reference = await this.deps.items.nextReference(companyId);
    const item = await this.deps.items.create({
      companyId,
      categoryId,
      title: input.title,
      body: input.body,
      priority: input.priority,
      // Origin, tags and the external reference are server context. A client that
      // sends them is claiming provenance for itself, so only trusted callers
      // (the CIM generator, the QoE generator) get them through — the router does
      // not expose them.
      origin: input.origin ?? "manual",
      moduleTag: input.module_tag ?? "Unclassified",
      sectionTag: input.section_tag ?? null,
      accountRef: input.account_ref ?? null,
      externalRef: input.external_ref ?? null,
      dueDate: input.due_date ?? null,
      requestorId: user.id,
      createdBy: user.id,
      reference,
    });

    if (requesteeIds && requesteeIds.length > 0) {
      await this.deps.assignees.replace({
        itemId: item.id,
        userIds: requesteeIds,
        kind: "requestee",
        actorId: user.id,
        note: null,
      });
    }

    this.deps.activity?.emit({
      type: "qa.item.created",
      companyId,
      subjectId: item.id,
      actorId: user.id,
    });

    return this.itemWithAssignees(item);
  }

  private async itemWithAssignees(item: ItemRecord): Promise<ItemResponse> {
    const assignees = await this.deps.assignees.listFor(item.id);
    return toItemResponse(
      item,
      assignees.map((a) => ({
        user_id: a.userId,
        name: a.name,
        kind: a.kind,
        assigned_at: a.assignedAt,
      })),
    );
  }

  async getItem(user: SessionUser, itemId: string): Promise<ItemDetail> {
    const item = await this.requireItem(user, itemId);
    const [assignees, responses, presentations, history] = await Promise.all([
      this.deps.assignees.listFor(itemId),
      this.deps.responses.listFor(itemId),
      this.deps.presentations.listFor(itemId),
      this.deps.assignees.history(itemId),
    ]);
    return {
      item: toItemResponse(
        item,
        assignees.map((a) => ({
          user_id: a.userId,
          name: a.name,
          kind: a.kind,
          assigned_at: a.assignedAt,
        })),
      ),
      responses: responses.map(toResponseResponse),
      // Only published rewordings leave this module — a draft is the broker
      // thinking aloud, and downstream consumers must not read it as settled.
      presentations: presentations
        .filter((p) => p.status === "published" || isBrokerSide(user))
        .map(toPresentationResponse),
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        prior_user_ids: h.priorUserIds,
        new_user_ids: h.newUserIds,
        actor_id: h.actorId,
        actor_name: h.actorName,
        note: h.note,
        at: h.at,
      })),
    };
  }

  async updateItem(
    user: SessionUser,
    itemId: string,
    patch: ItemUpdate,
  ): Promise<ItemResponse> {
    await this.requireItem(user, itemId);
    const updated = await this.deps.items.update(itemId, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.category_id !== undefined ? { categoryId: patch.category_id } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.due_date !== undefined ? { dueDate: patch.due_date } : {}),
    });
    if (!updated) throw new NotFoundError("Question not found.");
    return this.itemWithAssignees(updated);
  }

  // ── assignment ────────────────────────────────────────────────────────────

  /**
   * Reassign or delegate.
   *
   * `QA - 0001` deliberately lets ANY deal member do this, not only the asker:
   * items stall when the wrong person holds them and only the wrong person can
   * hand them on. Every change is recorded with who, when, and from what to what.
   */
  async replaceAssignees(
    user: SessionUser,
    itemId: string,
    input: AssigneesReplace,
  ): Promise<ItemResponse> {
    const item = await this.requireItem(user, itemId);
    for (const userId of input.user_ids) {
      if (!(await this.deps.members.isMember(item.companyId, userId))) {
        throw new BadRequestError("You can only assign someone who is on this deal.");
      }
    }
    await this.deps.assignees.replace({
      itemId,
      userIds: input.user_ids,
      kind: input.kind,
      actorId: user.id,
      note: input.note ?? null,
    });

    this.deps.activity?.emit({
      type: "qa.assignment.changed",
      companyId: item.companyId,
      subjectId: itemId,
      actorId: user.id,
    });

    const refreshed = await this.deps.items.getById(itemId);
    return this.itemWithAssignees(refreshed!);
  }

  // ── responses ─────────────────────────────────────────────────────────────

  /**
   * Post a response, or supersede an earlier one.
   *
   * Nothing here updates a row. A correction inserts a new response pointing at
   * the one it replaces, so every version keeps its own citation reference and
   * timestamp and a narrative citing the older text still resolves.
   */
  async postResponse(
    user: SessionUser,
    itemId: string,
    input: ResponseCreate,
  ): Promise<ResponseResponse> {
    const item = await this.requireItem(user, itemId);

    if (input.supersedes_id) {
      const prior = await this.deps.responses.getById(input.supersedes_id);
      if (!prior || prior.itemId !== itemId) {
        throw new BadRequestError("The response you are correcting is not on this question.");
      }
      if (prior.authorId !== user.id && !isBrokerSide(user)) {
        throw new ForbiddenError("You can only correct your own answer.");
      }
    }

    const citationRef = await this.deps.responses.nextCitationRef(
      itemId,
      item.reference ?? item.id.slice(0, 8),
    );
    const posted = await this.deps.responses.append({
      itemId,
      body: input.body,
      kind: input.kind,
      authorId: user.id,
      supersedesId: input.supersedes_id ?? null,
      citationRef,
    });

    if (input.kind === "answer" && !item.answeredAt) {
      await this.deps.items.markAnswered(itemId, new Date());
    }

    this.deps.activity?.emit({
      type: "qa.response.posted",
      companyId: item.companyId,
      subjectId: itemId,
      actorId: user.id,
    });

    return toResponseResponse(posted);
  }

  // ── presentable versions ──────────────────────────────────────────────────

  /**
   * The broker's reworded version of a seller's answer.
   *
   * Written to its own table. The seller's words are not read, edited or
   * referenced except by id — which is what makes "the broker rewords the answer"
   * compatible with "a posted answer is immutable" rather than in tension with it.
   */
  async writePresentation(
    user: SessionUser,
    itemId: string,
    input: PresentationCreate,
  ): Promise<PresentationResponse> {
    await this.requireItem(user, itemId);
    if (!isBrokerSide(user)) {
      throw new ForbiddenError("Only the deal team can write a presentable version.");
    }
    const source = await this.deps.responses.getById(input.source_response_id);
    if (!source || source.itemId !== itemId) {
      throw new BadRequestError("That answer is not on this question.");
    }
    const created = await this.deps.presentations.append({
      itemId,
      sourceResponseId: input.source_response_id,
      body: input.body,
      authorId: user.id,
    });
    return toPresentationResponse(created);
  }

  async publishPresentation(
    user: SessionUser,
    itemId: string,
    presentationId: string,
  ): Promise<PresentationResponse> {
    const item = await this.requireItem(user, itemId);
    if (!isBrokerSide(user)) {
      throw new ForbiddenError("Only the deal team can publish a presentable version.");
    }
    const published = await this.deps.presentations.publish(presentationId);
    if (!published || published.itemId !== itemId) {
      throw new NotFoundError("Presentable version not found on this question.");
    }

    this.deps.activity?.emit({
      type: "qa.presentation.published",
      companyId: item.companyId,
      subjectId: itemId,
      actorId: user.id,
    });

    return toPresentationResponse(published);
  }

  /**
   * Everything that happened to a question, in order.
   *
   * Assembled from the assignment log, the responses and the rewordings rather
   * than read from one table — the three are separate records for good reasons,
   * and interleaving them is the reader's problem to be solved here rather than
   * in whatever renders it.
   */
  async audit(user: SessionUser, itemId: string): Promise<AuditTrail> {
    const item = await this.requireItem(user, itemId);
    const [events, responses, presentations] = await Promise.all([
      this.deps.assignees.history(itemId),
      this.deps.responses.listFor(itemId),
      this.deps.presentations.listFor(itemId),
    ]);

    const entries: AuditTrail["entries"] = [
      {
        at: item.askedAt,
        kind: "asked" as const,
        actor_id: item.requestorId,
        actor_name: item.requestorName,
        detail: item.title,
        citation_ref: item.reference,
      },
      ...events.map((event) => ({
        at: event.at,
        kind:
          event.action === "delegated"
            ? ("delegated" as const)
            : event.action === "assigned"
              ? ("assigned" as const)
              : ("reassigned" as const),
        actor_id: event.actorId,
        actor_name: event.actorName,
        detail:
          event.priorUserIds.length === 0
            ? `Assigned to ${event.newUserIds.length} person(s)`
            : `Moved from ${event.priorUserIds.length} to ${event.newUserIds.length} person(s)`,
        citation_ref: null,
      })),
      ...responses.map((response) => ({
        at: response.postedAt,
        kind:
          response.kind !== "answer"
            ? ("commented" as const)
            : response.supersedesId
              ? ("corrected" as const)
              : ("answered" as const),
        actor_id: response.authorId,
        actor_name: response.authorName,
        detail: response.body.slice(0, 200),
        citation_ref: response.citationRef,
      })),
      // Only published rewordings appear: a draft is the broker thinking aloud,
      // and an audit that showed unpublished drafts would misrepresent what was
      // ever actually put forward.
      ...presentations
        .filter((p) => p.status === "published")
        .map((p) => ({
          at: p.createdAt,
          kind: "reworded" as const,
          actor_id: p.authorId,
          actor_name: p.authorName,
          detail: p.body.slice(0, 200),
          citation_ref: null,
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    return { item_id: itemId, reference: item.reference, entries };
  }

  // ── attachments and visibility ────────────────────────────────────────────

  async attach(
    user: SessionUser,
    itemId: string,
    input: AttachmentCreate,
  ): Promise<void> {
    const item = await this.requireItem(user, itemId);
    if (!this.deps.dataRoom.available) {
      throw new BadRequestError("The data room is not available, so a file cannot be filed.");
    }
    const doc = await this.deps.dataRoom.describe(input.document_id);
    if (!doc) throw new NotFoundError("Document not found.");
    if (doc.companyId !== item.companyId) {
      throw new ForbiddenError("That document belongs to a different deal.");
    }

    /**
     * Attach to a response, always — never to the item alone.
     *
     * The contract makes `response_id` optional, but the read path does not: an
     * attachment is returned nested under the response it belongs to, so a row
     * with no response is stored and then silently never surfaces. Resolving the
     * current answer here fixes that for every caller at once, rather than asking
     * each one to remember.
     *
     * Where there is no answer yet — evidence attached to a question before anyone
     * has replied — the row is still written. It is not lost, and it becomes
     * visible as soon as the first answer lands and is linked.
     */
    let responseId = input.response_id ?? null;
    if (!responseId) {
      const responses = await this.deps.responses.listFor(itemId);
      const current = responses.filter((r) => r.kind === "answer" && r.isCurrent).at(-1);
      responseId = current?.id ?? null;
    }

    await this.deps.responses.attach({
      itemId,
      responseId,
      documentId: input.document_id,
      folderId: input.folder_id,
      createdBy: user.id,
    });
  }

  async setVisibility(
    user: SessionUser,
    itemId: string,
    rule: VisibilityRule,
  ): Promise<void> {
    const item = await this.requireItem(user, itemId);
    if (!isBrokerSide(user) && item.requestorId !== user.id) {
      throw new ForbiddenError("Only the deal team or the asker can change who sees a question.");
    }
    await this.deps.items.setVisibilityRule({
      itemId,
      userId: rule.user_id ?? null,
      roleKey: rule.role_key ?? null,
      effect: rule.effect,
      createdBy: user.id,
    });
  }
}
