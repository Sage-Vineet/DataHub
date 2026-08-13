import { describe, expect, it } from "vitest";
import { brokerTeamInvites, companies, companyMessages, directMessages, documentActivity, documents, folderAccess, folders, groupMessageReads, groupMessages, messageGroupMembers, messageGroups, requestDocuments, requestNarratives, requestReminders, requests, uploads, users, emailVerifications, userCompanies } from "./schema.js";

import { keyReportVersions } from "./schema.js";
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
