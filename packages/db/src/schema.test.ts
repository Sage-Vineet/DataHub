import { describe, expect, it } from "vitest";
import { brokerTeamInvites, companies, companyMessages, directMessages, documentActivity, documents, folderAccess, folders, groupMessageReads, groupMessages, messageGroupMembers, messageGroups, requestDocuments, requestNarratives, requestReminders, requests, uploads, users, emailVerifications, userCompanies } from "./schema.js";

import { keyReportVersions } from "./schema.js";
import {
  documentComments,
  documentVersions,
  qaAssignees,
  qaAssignmentEvents,
  qaAttachments,
  qaCategories,
  qaItemVisibility,
  qaItems,
  qaNominations,
  qaPresentations,
  qaResponses,
  uploadChunks,
  uploadSessions,
} from "./dataroom-qa-schema.js";
describe("@datahub/db schema (reports slice)", () => {
  it("models key_report_versions", () => {
    expect(keyReportVersions.versionNumber.name).toBe("version_number");
    expect(keyReportVersions.isActive.name).toBe("is_active");
    expect(keyReportVersions.resolvedBatchId.name).toBe("resolved_batch_id");
    expect(keyReportVersions.metadata.name).toBe("metadata");
  });
});

describe("@datahub/db schema (messages slice)", () => {
  it("models the six message tables", () => {
    expect(companyMessages.senderId.name).toBe("sender_id");
    expect(directMessages.recipientId.name).toBe("recipient_id");
    expect(messageGroups.groupType.name).toBe("group_type");
    expect(messageGroupMembers.userId.name).toBe("user_id");
    expect(groupMessages.groupId.name).toBe("group_id");
    expect(groupMessageReads.lastReadAt.name).toBe("last_read_at");
  });
});

describe("@datahub/db schema (requests slice)", () => {
  it("models requests + reminders/narratives/documents", () => {
    expect(requests.reminderFrequencyDays.name).toBe("reminder_frequency_days");
    expect(requests.approvalStatus.name).toBe("approval_status");
    expect(requests.dueDate.name).toBe("due_date");
    expect(requestReminders.sentBy.name).toBe("sent_by");
    expect(requestNarratives.requestId.name).toBe("request_id");
    expect(requestDocuments.documentId.name).toBe("document_id");
  });
});

describe("@datahub/db schema (uploads slice)", () => {
  it("models uploads (bytea blob), documents, and document_activity", () => {
    expect(uploads.data.name).toBe("data");
    expect(uploads.sizeBytes.name).toBe("size_bytes");
    expect(documents.folderId.name).toBe("folder_id");
    expect(documents.uploadId.name).toBe("upload_id");
    expect(documents.archivedAt.name).toBe("archived_at");
    expect(documentActivity.documentId.name).toBe("document_id");
    expect(documentActivity.action.name).toBe("action");
  });
});

describe("@datahub/db schema (folders slice)", () => {
  it("adds archived_at to folders", () => {
    expect(folders.archivedAt.name).toBe("archived_at");
  });
  it("models the folder_access grant table", () => {
    expect(folderAccess.folderId.name).toBe("folder_id");
    expect(folderAccess.userId.name).toBe("user_id");
    expect(folderAccess.groupId.name).toBe("group_id");
    expect(folderAccess.canRead.name).toBe("can_read");
    expect(folderAccess.canDownload.name).toBe("can_download");
  });
});

describe("@datahub/db schema (users slice)", () => {
  it("models the multi-role + profile columns", () => {
    expect(users.subRole.name).toBe("sub_role");
    expect(users.designation.name).toBe("designation");
    expect(users.buyerCompanyName.name).toBe("buyer_company_name");
    expect(users.parentUserId.name).toBe("parent_user_id");
    expect(users.dateOfBirth.name).toBe("date_of_birth");
    expect(users.brokerCompany.name).toBe("broker_company");
  });

  it("models the broker-team invites join", () => {
    expect(brokerTeamInvites.teamOwnerId.name).toBe("team_owner_id");
    expect(brokerTeamInvites.invitedBrokerId.name).toBe("invited_broker_id");
  });
});

describe("@datahub/db schema (companies slice)", () => {
  it("models the full companies columns", () => {
    expect(companies.projectName.name).toBe("project_name");
    expect(companies.logo.name).toBe("logo");
    expect(companies.contactName.name).toBe("contact_name");
    expect(companies.contactPhone.name).toBe("contact_phone");
    expect(companies.profitMetric.name).toBe("profit_metric");
    expect(companies.dataSourceType.name).toBe("data_source_type");
    expect(companies.quickbooksConnected.name).toBe("quickbooks_connected");
    expect(companies.manualUploadActive.name).toBe("manual_upload_active");
    expect(companies.lastSourceSwitchAt.name).toBe("last_source_switch_at");
  });
});

describe("@datahub/db schema (auth slice)", () => {
  it("models the users table with the auth columns", () => {
    expect(users.email.name).toBe("email");
    expect(users.passwordHash.name).toBe("password_hash");
    expect(users.role.name).toBe("role");
  });

  it("models the OTP store", () => {
    expect(emailVerifications.otpHash.name).toBe("otp_hash");
    expect(emailVerifications.attempts.name).toBe("attempts");
  });

  it("models the user↔company join", () => {
    expect(userCompanies.userId.name).toBe("user_id");
    expect(userCompanies.companyId.name).toBe("company_id");
  });
});

describe("@datahub/db schema (data room versioning slice)", () => {
  it("models document_versions, keyed by document and version number", () => {
    expect(documentVersions.documentId.name).toBe("document_id");
    expect(documentVersions.versionNo.name).toBe("version_no");
    expect(documentVersions.uploadId.name).toBe("upload_id");
    expect(documentVersions.sizeBytes.name).toBe("size_bytes");
  });

  it("gives documents a pointer at its current version, not a version column", () => {
    // The document keeps its identity; the version lives in its own table. If
    // this ever became a `version` integer on documents, every existing FK would
    // start resolving to the wrong content.
    expect(documents.currentVersionId.name).toBe("current_version_id");
    expect(documents.versionCount.name).toBe("version_count");
  });

  it("models document comments with the internal/shared split", () => {
    expect(documentComments.visibility.name).toBe("visibility");
    expect(documentComments.visibility.default).toBe("internal");
    expect(documentComments.documentId.name).toBe("document_id");
    expect(documentComments.authorId.name).toBe("author_id");
  });

  it("models chunked upload sessions and their staged chunks", () => {
    expect(uploadSessions.totalChunks.name).toBe("total_chunks");
    expect(uploadSessions.receivedCount.name).toBe("received_count");
    expect(uploadSessions.expiresAt.name).toBe("expires_at");
    // documentId set on a session is what makes the upload a new VERSION.
    expect(uploadSessions.documentId.name).toBe("document_id");
    expect(uploadChunks.chunkIndex.name).toBe("chunk_index");
    expect(uploadChunks.data.name).toBe("data");
  });
});

describe("@datahub/db schema (deal Q&A slice)", () => {
  it("models categories as per-company rows, so a nomination can hang off one", () => {
    expect(qaCategories.companyId.name).toBe("company_id");
    expect(qaCategories.key.name).toBe("key");
    expect(qaNominations.categoryId.name).toBe("category_id");
    expect(qaNominations.userId.name).toBe("user_id");
  });

  it("models items with their origin and structured tags", () => {
    expect(qaItems.origin.name).toBe("origin");
    expect(qaItems.origin.default).toBe("manual");
    // Unclassified rather than null: QA-0002 requires no item leave the pipeline.
    expect(qaItems.moduleTag.default).toBe("Unclassified");
    expect(qaItems.requestorId.name).toBe("requestor_id");
  });

  it("carries the opaque external reference the CIM builder writes into", () => {
    // One column is the entire contract between deal-qa and the CIM module.
    expect(qaItems.externalRef.name).toBe("external_ref");
  });

  it("models many assignees per item, and the history of every change", () => {
    expect(qaAssignees.itemId.name).toBe("item_id");
    expect(qaAssignees.kind.default).toBe("requestee");
    expect(qaAssignmentEvents.priorUserIds.name).toBe("prior_user_ids");
    expect(qaAssignmentEvents.newUserIds.name).toBe("new_user_ids");
    expect(qaAssignmentEvents.actorId.name).toBe("actor_id");
  });

  it("models responses as a supersede chain, never an update", () => {
    expect(qaResponses.supersedesId.name).toBe("supersedes_id");
    expect(qaResponses.answerRootId.name).toBe("answer_root_id");
    expect(qaResponses.answerVersion.name).toBe("answer_version");
    expect(qaResponses.isCurrent.name).toBe("is_current");
    // Every response is individually citable, per QA-0002.
    expect(qaResponses.citationRef.name).toBe("citation_ref");
  });

  it("keeps the broker's rewording in a separate table from the seller's answer", () => {
    // Separate table is the whole point: it cannot overwrite what was written.
    expect(qaPresentations.sourceResponseId.name).toBe("source_response_id");
    expect(qaPresentations.status.default).toBe("draft");
    expect(qaPresentations.version.name).toBe("version");
  });

  it("links an answer's evidence to both the item and the data room", () => {
    expect(qaAttachments.documentId.name).toBe("document_id");
    expect(qaAttachments.folderId.name).toBe("folder_id");
    expect(qaAttachments.responseId.name).toBe("response_id");
  });

  it("models the per-item visibility override", () => {
    expect(qaItemVisibility.userId.name).toBe("user_id");
    expect(qaItemVisibility.roleKey.name).toBe("role_key");
    expect(qaItemVisibility.effect.default).toBe("hide");
  });
});
