import { describe, expect, it } from "vitest";
import { brokerTeamInvites, companies, users, emailVerifications, userCompanies } from "./schema.js";

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
