import type {
  NarrativeUpdate,
  ReminderResponse,
  RequestCreate,
  RequestResponse,
  RequestUpdate,
  SessionUser,
} from "@datahub/contracts";
import { resolveReminderFrequencyDays } from "@datahub/contracts";
import { buildReminders, type ReminderView } from "./reminders.js";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type {
  CreateRequestInput,
  RequestRecord,
  RequestsRepository,
  UpdateRequestPatch,
} from "./ports.js";

export interface RequestsServiceDeps {
  repo: RequestsRepository;
}

function isFutureDate(yyyyMmDd: string): boolean {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  return yyyyMmDd > todayStr;
}

/** The `/narrative/file` wire shape — snake_case, and every field always present. */
export interface NarrativeFileResponse {
  content: string;
  author_name: string | null;
  author_role: string | null;
  updated_at: string | null;
}

export class RequestsService {
  private readonly repo: RequestsRepository;
  constructor(deps: RequestsServiceDeps) {
    this.repo = deps.repo;
  }

  async list(user: SessionUser, companyId: string): Promise<RequestResponse[]> {
    this.requireCompany(user, companyId);
    return (await this.repo.listByCompany(companyId)).map(toResponse);
  }

  /**
   * The reminders board for a company.
   *
   * Derived from requests and their send history — see `reminders.ts` for why
   * this does not read the `reminders` table.
   */
  async listReminders(user: SessionUser, companyId: string): Promise<ReminderView[]> {
    this.requireCompany(user, companyId);
    const sources = await this.repo.listReminderSources(companyId);
    const visible = sources.filter((s) => s.request.companyId === companyId);
    const history = await this.repo.listReminderHistory(visible.map((s) => s.request.id));
    return buildReminders(user, visible, history);
  }

  async get(user: SessionUser, id: string): Promise<RequestResponse> {
    return toResponse(await this.requireAccessible(user, id));
  }

  async create(user: SessionUser, companyId: string, input: RequestCreate, allowPast = false): Promise<RequestResponse> {
    this.requireCompany(user, companyId);
    return toResponse(await this.repo.create(this.toCreateInput(user, companyId, input, allowPast)));
  }

  async createBulk(user: SessionUser, companyId: string, items: RequestCreate[], allowPast: boolean): Promise<RequestResponse[]> {
    this.requireCompany(user, companyId);
    const inputs = items.map((i) => this.toCreateInput(user, companyId, i, allowPast));
    return (await this.repo.createMany(inputs)).map(toResponse);
  }

  async update(user: SessionUser, id: string, input: RequestUpdate): Promise<RequestResponse> {
    const existing = await this.requireAccessible(user, id);
    const patch: UpdateRequestPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.sub_label !== undefined) patch.subLabel = input.sub_label ?? null;
    if (input.description !== undefined) patch.description = input.description;
    if (input.category !== undefined) patch.category = input.category;
    if (input.response_type !== undefined) patch.responseType = input.response_type;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.status !== undefined) patch.status = input.status;
    if (input.due_date !== undefined) patch.dueDate = input.due_date;
    if (input.assigned_to !== undefined) patch.assignedTo = input.assigned_to ?? null;
    if (input.visible !== undefined) patch.visible = input.visible;
    if (input.priority !== undefined || input.reminder_frequency_days !== undefined) {
      patch.reminderFrequencyDays = resolveReminderFrequencyDays(
        input.priority ?? existing.priority,
        input.reminder_frequency_days,
      );
    }
    return toResponse((await this.repo.update(id, patch)) ?? existing);
  }

  async approve(user: SessionUser, id: string, assignedTo: string | null): Promise<RequestResponse> {
    await this.requireAccessible(user, id);
    return toResponse((await this.repo.approve(id, user.id, assignedTo))!);
  }

  async delete(user: SessionUser, id: string): Promise<void> {
    await this.requireAccessible(user, id);
    await this.repo.delete(id);
  }

  async addReminder(user: SessionUser, id: string): Promise<ReminderResponse> {
    await this.requireAccessible(user, id);
    const r = await this.repo.appendReminder(id, user.id);
    return { id: r.id, request_id: r.requestId, sent_by: r.sentBy, sent_at: r.sentAt };
  }

  async getNarrative(user: SessionUser, id: string): Promise<{ content: string } | null> {
    await this.requireAccessible(user, id);
    const n = await this.repo.getNarrative(id);
    return n ? { content: n.content } : null;
  }

  /**
   * The narrative as the SPA's request-detail pane reads it.
   *
   * Legacy served this at `/narrative/file` and always answered 200 — an absent
   * narrative is empty content, not a missing resource, because the pane renders
   * an empty editor either way. The sibling `/narrative` keeps its 404, since a
   * caller asking for the resource itself is asking a different question.
   */
  async getNarrativeFile(user: SessionUser, id: string): Promise<NarrativeFileResponse> {
    await this.requireAccessible(user, id);
    const n = await this.repo.getNarrative(id);
    return {
      content: n?.content ?? "",
      author_name: n?.authorName ?? null,
      author_role: n?.authorRole ?? null,
      updated_at: n?.updatedAt ?? null,
    };
  }

  async updateNarrative(user: SessionUser, id: string, input: NarrativeUpdate): Promise<{ content: string }> {
    await this.requireAccessible(user, id);
    const n = await this.repo.upsertNarrative(id, input.content, user.id);
    return { content: n.content };
  }

  async listDocuments(user: SessionUser, id: string): Promise<Array<{ document_id: string; visible: boolean }>> {
    await this.requireAccessible(user, id);
    return (await this.repo.listDocuments(id)).map((d) => ({ document_id: d.documentId, visible: d.visible }));
  }

  async linkDocument(user: SessionUser, id: string, documentId: string, visible: boolean): Promise<{ document_id: string; visible: boolean }> {
    await this.requireAccessible(user, id);
    const link = await this.repo.linkDocument(id, documentId, visible);
    return { document_id: link.documentId, visible: link.visible };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private toCreateInput(user: SessionUser, companyId: string, input: RequestCreate, allowPast: boolean): CreateRequestInput {
    if (!allowPast && !isFutureDate(input.due_date)) {
      throw new BadRequestError("due_date must be a future date");
    }
    const now = new Date();
    return {
      companyId,
      title: input.title,
      subLabel: input.sub_label ?? null,
      description: input.description,
      category: input.category,
      responseType: input.response_type,
      priority: input.priority,
      status: input.status ?? "pending",
      dueDate: input.due_date,
      assignedTo: input.assigned_to ?? null,
      visible: input.visible ?? true,
      reminderFrequencyDays: resolveReminderFrequencyDays(input.priority, input.reminder_frequency_days),
      submissionSource: input.submission_source ?? "broker",
      approvalStatus: "approved",
      approvedBy: user.id,
      approvedAt: now,
      createdBy: user.id,
    };
  }

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have permission to access this company's requests.");
    }
  }

  private async requireAccessible(user: SessionUser, id: string): Promise<RequestRecord> {
    const record = await this.repo.getById(id);
    if (!record) throw new NotFoundError("Request not found.");
    if (!canAccessCompany(user, record.companyId)) {
      throw new ForbiddenError("You do not have permission to access this request.");
    }
    return record;
  }
}

export function toResponse(r: RequestRecord): RequestResponse {
  return {
    id: r.id,
    company_id: r.companyId,
    title: r.title,
    sub_label: r.subLabel,
    description: r.description,
    category: r.category,
    response_type: r.responseType,
    priority: r.priority,
    status: r.status,
    due_date: r.dueDate,
    assigned_to: r.assignedTo,
    visible: r.visible,
    reminder_frequency_days: r.reminderFrequencyDays,
    submission_source: r.submissionSource,
    approval_status: r.approvalStatus,
    approved_by: r.approvedBy,
    created_by: r.createdBy,
  };
}
