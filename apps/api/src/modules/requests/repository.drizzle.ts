import { asc, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { RequestPriority } from "@datahub/contracts";
import type {
  ApprovalStatusValue,
  CreateRequestInput,
  NarrativeRecord,
  ReminderHistoryRow,
  ReminderRecord,
  ReminderSourceRow,
  RequestCategory,
  RequestDocumentLinkRecord,
  RequestRecord,
  RequestStatusValue,
  RequestsRepository,
  ResponseType,
  SubmissionSource,
  UpdateRequestPatch,
} from "./ports.js";

const { requests, requestReminders, requestNarratives, requestDocuments, companies, users, documents } = schema;
type Row = typeof requests.$inferSelect;

function toRecord(r: Row): RequestRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    title: r.title,
    subLabel: r.subLabel,
    description: r.description,
    category: r.category as RequestCategory,
    responseType: r.responseType as ResponseType,
    priority: r.priority as RequestPriority,
    status: r.status as RequestStatusValue,
    dueDate: r.dueDate,
    assignedTo: r.assignedTo,
    visible: r.visible,
    reminderFrequencyDays: r.reminderFrequencyDays,
    submissionSource: r.submissionSource as SubmissionSource,
    approvalStatus: r.approvalStatus as ApprovalStatusValue,
    approvedBy: r.approvedBy,
    createdBy: r.createdBy,
  };
}

function values(input: CreateRequestInput) {
  return {
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
    approvedAt: input.approvedAt,
    createdBy: input.createdBy,
  };
}

export class DrizzleRequestsRepository implements RequestsRepository {
  constructor(private readonly db: Db) {}

  async listByCompany(companyId: string): Promise<RequestRecord[]> {
    const rows = await this.db.select().from(requests).where(eq(requests.companyId, companyId)).orderBy(asc(requests.createdAt));
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<RequestRecord | null> {
    const rows = await this.db.select().from(requests).where(eq(requests.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(input: CreateRequestInput): Promise<RequestRecord> {
    const rows = await this.db.insert(requests).values(values(input)).returning();
    return toRecord(rows[0]!);
  }

  async createMany(inputs: CreateRequestInput[]): Promise<RequestRecord[]> {
    if (inputs.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const rows = await tx.insert(requests).values(inputs.map(values)).returning();
      return rows.map(toRecord);
    });
  }

  async update(id: string, patch: UpdateRequestPatch): Promise<RequestRecord | null> {
    const rows = await this.db.update(requests).set({ ...patch, updatedAt: new Date() }).where(eq(requests.id, id)).returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async approve(id: string, approvedBy: string, assignedTo: string | null): Promise<RequestRecord | null> {
    const set: Record<string, unknown> = { approvalStatus: "approved", approvedBy, approvedAt: new Date(), updatedAt: new Date() };
    if (assignedTo) set.assignedTo = assignedTo;
    const rows = await this.db.update(requests).set(set).where(eq(requests.id, id)).returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(requests).where(eq(requests.id, id));
  }

  async appendReminder(requestId: string, sentBy: string): Promise<ReminderRecord> {
    const rows = await this.db.insert(requestReminders).values({ requestId, sentBy }).returning();
    const r = rows[0]!;
    return { id: r.id, requestId: r.requestId, sentBy: r.sentBy, sentAt: r.sentAt.toISOString() };
  }

  async listReminders(requestId: string): Promise<ReminderRecord[]> {
    const rows = await this.db.select().from(requestReminders).where(eq(requestReminders.requestId, requestId)).orderBy(asc(requestReminders.sentAt));
    return rows.map((r) => ({ id: r.id, requestId: r.requestId, sentBy: r.sentBy, sentAt: r.sentAt.toISOString() }));
  }

  async listReminderSources(companyId: string): Promise<ReminderSourceRow[]> {
    const rows = await this.db
      .select({ request: requests, company: companies })
      .from(requests)
      .leftJoin(companies, eq(companies.id, requests.companyId))
      .where(eq(requests.companyId, companyId))
      .orderBy(desc(requests.createdAt));

    return rows.map((r) => ({
      request: toRecord(r.request),
      createdAt: r.request.createdAt.toISOString(),
      approvedAt: r.request.approvedAt?.toISOString() ?? null,
      companyName: r.company?.name ?? null,
      companyContactName: r.company?.contactName ?? null,
      companyContactEmail: r.company?.contactEmail ?? null,
      companyContactPhone: r.company?.contactPhone ?? null,
    }));
  }

  async listReminderHistory(requestIds: string[]): Promise<ReminderHistoryRow[]> {
    if (requestIds.length === 0) return [];
    const rows = await this.db
      .select({ reminder: requestReminders, sender: users })
      .from(requestReminders)
      .leftJoin(users, eq(users.id, requestReminders.sentBy))
      .where(inArray(requestReminders.requestId, requestIds))
      .orderBy(desc(requestReminders.sentAt));

    return rows.map((r) => ({
      requestId: r.reminder.requestId,
      sentAt: r.reminder.sentAt.toISOString(),
      sentBy: r.reminder.sentBy,
      sentByName: r.sender?.name ?? null,
      sentByEmail: r.sender?.email ?? null,
    }));
  }

  async getNarrative(requestId: string): Promise<NarrativeRecord | null> {
    // LEFT JOIN, not INNER: a narrative whose author row has gone still reads.
    const rows = await this.db
      .select({ narrative: requestNarratives, author: users })
      .from(requestNarratives)
      .leftJoin(users, eq(users.id, requestNarratives.updatedBy))
      .where(eq(requestNarratives.requestId, requestId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      requestId: r.narrative.requestId,
      content: r.narrative.content,
      updatedBy: r.narrative.updatedBy,
      updatedAt: r.narrative.updatedAt.toISOString(),
      authorName: r.author?.name ?? null,
      authorRole: r.author?.role ?? null,
    };
  }

  async upsertNarrative(requestId: string, content: string, updatedBy: string): Promise<NarrativeRecord> {
    const rows = await this.db
      .insert(requestNarratives)
      .values({ requestId, content, updatedBy })
      .onConflictDoUpdate({ target: requestNarratives.requestId, set: { content, updatedBy, updatedAt: new Date() } })
      .returning();
    const r = rows[0]!;
    // Re-read so the author is resolved the one way, in `getNarrative`, rather
    // than joined by hand here and left to drift from it.
    return (
      (await this.getNarrative(r.requestId)) ?? {
        requestId: r.requestId,
        content: r.content,
        updatedBy: r.updatedBy,
        updatedAt: r.updatedAt.toISOString(),
        authorName: null,
        authorRole: null,
      }
    );
  }

  async linkDocument(requestId: string, documentId: string, visible: boolean): Promise<RequestDocumentLinkRecord> {
    const rows = await this.db.insert(requestDocuments).values({ requestId, documentId, visible }).returning();
    const r = rows[0]!;
    return { id: r.id, requestId: r.requestId, documentId: r.documentId, visible: r.visible };
  }

  /**
   * Left joins, not inner: a link whose document has been deleted must still
   * list — otherwise an attachment silently disappears from a request rather
   * than showing as unavailable, and the count on the board stops matching the
   * detail pane.
   */
  async listDocuments(requestId: string): Promise<RequestDocumentLinkRecord[]> {
    const rows = await this.db
      .select({ link: requestDocuments, doc: documents, uploaderName: users.name })
      .from(requestDocuments)
      .leftJoin(documents, eq(documents.id, requestDocuments.documentId))
      .leftJoin(users, eq(users.id, documents.uploadedBy))
      .where(eq(requestDocuments.requestId, requestId));
    return rows.map((r) => ({
      id: r.link.id,
      requestId: r.link.requestId,
      documentId: r.link.documentId,
      visible: r.link.visible,
      name: r.doc?.name ?? null,
      size: r.doc?.size ?? null,
      ext: r.doc?.ext ?? null,
      uploadId: r.doc?.uploadId ?? null,
      uploadedByName: r.uploaderName ?? null,
      uploadedAt: r.doc?.uploadedAt ? new Date(r.doc.uploadedAt).toISOString() : null,
    }));
  }
}
