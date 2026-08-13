import { randomUUID } from "node:crypto";
import type {
  CreateRequestInput,
  NarrativeRecord,
  ReminderRecord,
  RequestDocumentLinkRecord,
  RequestRecord,
  RequestsRepository,
  UpdateRequestPatch,
} from "./ports.js";

/** In-memory `RequestsRepository` for tests. */
export class InMemoryRequestsRepository implements RequestsRepository {
  private readonly reqs = new Map<string, RequestRecord>();
  private readonly reminders = new Map<string, ReminderRecord>();
  private readonly narratives = new Map<string, NarrativeRecord>();
  private readonly docs = new Map<string, RequestDocumentLinkRecord>();

  private fromInput(input: CreateRequestInput): RequestRecord {
    return {
      id: randomUUID(),
      companyId: input.companyId,
      title: input.title,
      subLabel: input.subLabel,
      description: input.description,
      category: input.category,
      responseType: input.responseType,
      priority: input.priority,
      status: input.status,
      dueDate: input.dueDate,
      assignedTo: input.assignedTo,
      visible: input.visible,
      reminderFrequencyDays: input.reminderFrequencyDays,
      submissionSource: input.submissionSource,
      approvalStatus: input.approvalStatus,
      approvedBy: input.approvedBy,
      createdBy: input.createdBy,
    };
  }

  async listByCompany(companyId: string): Promise<RequestRecord[]> {
    return [...this.reqs.values()].filter((r) => r.companyId === companyId);
  }
  async getById(id: string): Promise<RequestRecord | null> {
    return this.reqs.get(id) ?? null;
  }
  async create(input: CreateRequestInput): Promise<RequestRecord> {
    const r = this.fromInput(input);
    this.reqs.set(r.id, r);
    return r;
  }
  async createMany(inputs: CreateRequestInput[]): Promise<RequestRecord[]> {
    return Promise.all(inputs.map((i) => this.create(i)));
  }
  async update(id: string, patch: UpdateRequestPatch): Promise<RequestRecord | null> {
    const r = this.reqs.get(id);
    if (!r) return null;
    const u = { ...r, ...patch };
    this.reqs.set(id, u);
    return u;
  }
  async approve(id: string, approvedBy: string, assignedTo: string | null): Promise<RequestRecord | null> {
    const r = this.reqs.get(id);
    if (!r) return null;
    const u = { ...r, approvalStatus: "approved" as const, approvedBy, assignedTo: assignedTo ?? r.assignedTo };
    this.reqs.set(id, u);
    return u;
  }
  async delete(id: string): Promise<void> {
    this.reqs.delete(id);
    for (const [k, v] of this.reminders) if (v.requestId === id) this.reminders.delete(k);
    this.narratives.delete(id);
    for (const [k, v] of this.docs) if (v.requestId === id) this.docs.delete(k);
  }
  async appendReminder(requestId: string, sentBy: string): Promise<ReminderRecord> {
    const rec: ReminderRecord = { id: randomUUID(), requestId, sentBy, sentAt: new Date(0).toISOString() };
    this.reminders.set(rec.id, rec);
    return rec;
  }
  async listReminders(requestId: string): Promise<ReminderRecord[]> {
    return [...this.reminders.values()].filter((r) => r.requestId === requestId);
  }
  async getNarrative(requestId: string): Promise<NarrativeRecord | null> {
    return this.narratives.get(requestId) ?? null;
  }
  async upsertNarrative(requestId: string, content: string, updatedBy: string): Promise<NarrativeRecord> {
    const rec: NarrativeRecord = { requestId, content, updatedBy, updatedAt: new Date(0).toISOString() };
    this.narratives.set(requestId, rec);
    return rec;
  }
  async linkDocument(requestId: string, documentId: string, visible: boolean): Promise<RequestDocumentLinkRecord> {
    const rec: RequestDocumentLinkRecord = { id: randomUUID(), requestId, documentId, visible };
    this.docs.set(rec.id, rec);
    return rec;
  }
  async listDocuments(requestId: string): Promise<RequestDocumentLinkRecord[]> {
    return [...this.docs.values()].filter((d) => d.requestId === requestId);
  }
}
