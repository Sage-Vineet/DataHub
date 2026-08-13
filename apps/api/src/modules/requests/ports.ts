import type {
  RequestPriority,
} from "@datahub/contracts";

export type RequestCategory = "Finance" | "Legal" | "Compliance" | "HR" | "Tax" | "M&A" | "Other";
export type ResponseType = "Upload" | "Narrative" | "Both";
export type RequestStatusValue = "pending" | "in-review" | "completed" | "blocked";
export type ApprovalStatusValue = "pending" | "approved";
export type SubmissionSource = "broker" | "user" | "client";

export interface RequestRecord {
  id: string;
  companyId: string;
  title: string;
  subLabel: string | null;
  description: string;
  category: RequestCategory;
  responseType: ResponseType;
  priority: RequestPriority;
  status: RequestStatusValue;
  dueDate: string;
  assignedTo: string | null;
  visible: boolean;
  reminderFrequencyDays: number;
  submissionSource: SubmissionSource;
  approvalStatus: ApprovalStatusValue;
  approvedBy: string | null;
  createdBy: string;
}

export interface CreateRequestInput {
  companyId: string;
  title: string;
  subLabel: string | null;
  description: string;
  category: RequestCategory;
  responseType: ResponseType;
  priority: RequestPriority;
  status: RequestStatusValue;
  dueDate: string;
  assignedTo: string | null;
  visible: boolean;
  reminderFrequencyDays: number;
  submissionSource: SubmissionSource;
  approvalStatus: ApprovalStatusValue;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdBy: string;
}

export type UpdateRequestPatch = Partial<
  Pick<
    RequestRecord,
    | "title"
    | "subLabel"
    | "description"
    | "category"
    | "responseType"
    | "priority"
    | "status"
    | "dueDate"
    | "assignedTo"
    | "visible"
    | "reminderFrequencyDays"
  >
>;

export interface ReminderRecord {
  id: string;
  requestId: string;
  sentBy: string;
  sentAt: string;
}

export interface NarrativeRecord {
  requestId: string;
  content: string;
  updatedBy: string;
  updatedAt: string;
}

export interface RequestDocumentLinkRecord {
  id: string;
  requestId: string;
  documentId: string;
  visible: boolean;
}

export interface RequestsRepository {
  listByCompany(companyId: string): Promise<RequestRecord[]>;
  getById(id: string): Promise<RequestRecord | null>;
  create(input: CreateRequestInput): Promise<RequestRecord>;
  createMany(inputs: CreateRequestInput[]): Promise<RequestRecord[]>;
  update(id: string, patch: UpdateRequestPatch): Promise<RequestRecord | null>;
  approve(id: string, approvedBy: string, assignedTo: string | null): Promise<RequestRecord | null>;
  delete(id: string): Promise<void>;

  appendReminder(requestId: string, sentBy: string): Promise<ReminderRecord>;
  listReminders(requestId: string): Promise<ReminderRecord[]>;

  getNarrative(requestId: string): Promise<NarrativeRecord | null>;
  upsertNarrative(requestId: string, content: string, updatedBy: string): Promise<NarrativeRecord>;

  linkDocument(requestId: string, documentId: string, visible: boolean): Promise<RequestDocumentLinkRecord>;
  listDocuments(requestId: string): Promise<RequestDocumentLinkRecord[]>;
}
