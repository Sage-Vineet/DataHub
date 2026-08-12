import {
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Auth-slice schema, hand-authored from backend/sql/schema.sql (no reachable
 * DATABASE_URL at authoring time — see phase-1-auth design D4). To be replaced /
 * reconciled by `drizzle-kit pull` against the live database. Only the tables
 * the auth module touches are modeled here; the rest follow as their domains
 * migrate. The legacy 76-file migration set is frozen.
 */

export const userRole = pgEnum("user_role", ["admin", "broker", "buyer"]);
export const userStatus = pgEnum("user_status", ["active", "inactive"]);
export const companyStatus = pgEnum("company_status", ["active", "inactive"]);

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  projectName: text("project_name"),
  industry: text("industry"),
  status: companyStatus("status").notNull().default("active"),
  since: date("since"),
  logo: text("logo"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  // Canonical profit metric ("adjusted_ebitda" | "sde"); text at the DB layer
  // (legacy is untyped), normalized to the contract enum on the way in.
  profitMetric: text("profit_metric").notNull().default("adjusted_ebitda"),
  // Integration-managed columns — NEVER written by a companies update (safe-field rule).
  dataSourceType: text("data_source_type"),
  quickbooksConnected: boolean("quickbooks_connected").notNull().default(false),
  manualUploadActive: boolean("manual_upload_active").notNull().default(false),
  lastSourceSwitchAt: timestamp("last_source_switch_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  status: userStatus("status").notNull().default("active"),
  // Multi-role fields (migration 041). `sub_role` is text at the DB layer (parity).
  subRole: text("sub_role"),
  designation: text("designation"),
  buyerCompanyName: text("buyer_company_name"),
  parentUserId: uuid("parent_user_id"),
  // Profile fields.
  dateOfBirth: date("date_of_birth"),
  occupation: text("occupation"),
  address: text("address"),
  brokerCompany: text("broker_company"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Broker-team invitations: a broker (owner) inviting another broker to their team. */
export const brokerTeamInvites = pgTable(
  "broker_team_invites",
  {
    teamOwnerId: uuid("team_owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitedBrokerId: uuid("invited_broker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.teamOwnerId, t.invitedBrokerId] }) }),
);

export const userCompanies = pgTable(
  "user_companies",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.companyId] }) }),
);

export const emailVerifications = pgTable("email_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  otpHash: text("otp_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  resendCount: integer("resend_count").notNull().default(0),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});

export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  color: text("color"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
