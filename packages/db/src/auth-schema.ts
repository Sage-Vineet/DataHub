import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { companies, userRole, userStatus } from "./schema.js";

/**
 * Better Auth ([ADR-0007](../../../docs/adr/0007-auth-library-vs-bespoke.md)) owns
 * these four tables — `authUser` / `session` / `account` / `verification`. They are
 * the identity store; the existing `users` table (schema.ts) stays as the business
 * profile and keeps every downstream FK.
 *
 * IMPORTANT (design D2): `authUser.id` is preserved equal to the legacy `users.id`
 * during backfill, so `user_companies` / `folders.created_by` still line up by id.
 * Ids are `text` (not `uuid`) because Better Auth mints string ids for rows it
 * creates itself (verification, sessions), and we store the legacy uuid as its
 * text form for migrated users.
 *
 * `role` / `companyId` / `status` are Better Auth "additionalFields" surfaced on the
 * user model so the session carries them without a second query.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(true),
  image: text("image"),
  // additionalFields — mirror the legacy user's business attributes.
  role: userRole("role").notNull().default("buyer"),
  companyId: text("company_id"),
  status: userStatus("status").notNull().default("active"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  // For provider "credential", this holds the password hash — the legacy bcrypt
  // hash is copied here verbatim during backfill (design D3).
  password: text("password"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Keep a reference to `companies` so the relation is discoverable if we later add an FK. */
export type AuthUserCompanyRef = typeof companies.$inferSelect;

export const DDL = `
CREATE TABLE IF NOT EXISTS "auth_user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT true,
  image text,
  role user_role NOT NULL DEFAULT 'buyer',
  company_id text,
  status user_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "session" (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "auth_user"(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "account" (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "auth_user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "verification" (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
