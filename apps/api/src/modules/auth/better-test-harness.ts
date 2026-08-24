import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import bcrypt from "bcryptjs";
import express from "express";
import type { Express } from "express";
import { schema, type Db } from "@datahub/db";
import { createBetterAuth } from "./better-auth.js";
import { backfillBetterAuthIdentities } from "./backfill.js";
import { DrizzleAuthRepository } from "./repository.drizzle.js";
import { createBetterAuthRouter } from "./router.better.js";
import { loadAuthConfig } from "./config.js";
import { AuthService } from "./service.js";
import type { Emailer } from "./ports.js";

/**
 * Shared harness for the Better Auth integration tests: a throwaway real
 * Postgres (PGlite) with the business + Better Auth schema, a capturing emailer,
 * and the module mounted on an Express app exactly as the gateway mounts it.
 * NOT part of the runtime module — excluded from coverage (see vitest.config.ts).
 */

const BUSINESS_DDL = `
CREATE TYPE user_role AS ENUM ('admin','broker','buyer');
CREATE TYPE user_status AS ENUM ('active','inactive');
CREATE TYPE company_status AS ENUM ('active','inactive');

CREATE TABLE companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  project_name text,
  industry text,
  status company_status NOT NULL DEFAULT 'active',
  since date,
  logo text,
  contact_name text,
  contact_email text,
  contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda',
  data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false,
  last_source_switch_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text,
  password_hash text NOT NULL,
  role user_role NOT NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  status user_status NOT NULL DEFAULT 'active',
  sub_role text, designation text, buyer_company_name text, parent_user_id uuid,
  date_of_birth date, occupation text, address text, broker_company text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_companies (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE TABLE email_verifications (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  otp_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  resend_count integer NOT NULL DEFAULT 0,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz
);
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL,
  color text,
  created_by uuid NOT NULL,
  -- Present in the Drizzle model, so an insert names it. Without it here the
  -- default-folder provisioning fails against this harness and nowhere else.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export const SECRET = "better-auth-integration-secret-value-xyz";

/** A capturing emailer so tests can read the OTP that would have been sent. */
/** An emailer that refuses, for the failure paths mail dispatch has. */
export class FailingEmailer implements Emailer {
  constructor(private readonly reason = "The mail server refused the message.") {}
  sendOtp(): Promise<{ sent: boolean }> {
    return Promise.reject(new Error(this.reason));
  }
}

export class CaptureEmailer implements Emailer {
  last: { email: string; otp: string } | null = null;
  async sendOtp(email: string, otp: string) {
    this.last = { email, otp };
    return { sent: true };
  }
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: "admin" | "broker" | "buyer";
  companyId?: string | null;
}

export interface Harness {
  app: Express;
  router: import("express").Router;
  db: Db;
  /** Whatever the seed supplied, defaulting to a `CaptureEmailer`. */
  emailer: Emailer;
  close: () => Promise<void>;
}

export interface HarnessSeed {
  companies?: { id: string; name?: string; contactEmail?: string | null }[];
  users: SeededUser[];
  /** user_companies links (multi-tenant membership). */
  memberships?: { userId: string; companyId: string }[];
  /**
   * Make every dispatch fail, for the paths that exist because mail can.
   * A mailbox that refuses is the ordinary case here, not an exotic one.
   */
  emailer?: Emailer;
}

/**
 * Build a fully-wired Better Auth module over a fresh PGlite, seed legacy users
 * (with real bcrypt hashes), run the real backfill, and return an Express app.
 */
export async function makeHarness(seed: HarnessSeed): Promise<Harness> {
  const client = new PGlite();
  await client.exec(BUSINESS_DDL);
  await client.exec(schema.DDL);
  const db = drizzle(client, { schema }) as unknown as Db;

  for (const c of seed.companies ?? []) {
    await db.insert(schema.companies).values({
      id: c.id,
      name: c.name ?? "Acme",
      industry: "tech",
      contactEmail: c.contactEmail ?? null,
    });
  }
  for (const u of seed.users) {
    await db.insert(schema.users).values({
      id: u.id,
      name: u.email.split("@")[0] ?? u.email,
      email: u.email,
      passwordHash: await bcrypt.hash(u.password, 10), // real legacy-style hash
      role: u.role,
      companyId: u.companyId ?? null,
      status: "active",
    });
  }
  for (const m of seed.memberships ?? []) {
    await db.insert(schema.userCompanies).values({ userId: m.userId, companyId: m.companyId });
  }

  // The migration: legacy users -> Better Auth identities (bcrypt hash carried over).
  await backfillBetterAuthIdentities(db);

  const env = { JWT_SECRET: SECRET, AUTH_LOGIN_RATE_MAX: "5" } as NodeJS.ProcessEnv;
  const config = loadAuthConfig(env);
  const emailer = seed.emailer ?? new CaptureEmailer();
  const auth = createBetterAuth({
    db,
    emailer,
    config: { secret: SECRET, baseURL: "http://localhost:8080", trustedOrigins: [] },
  });
  const repo = new DrizzleAuthRepository(db);
  const signupOtp = new AuthService({ repo, emailer, config });
  const router = createBetterAuthRouter({ auth, repo, config, signupOtp });

  const app = express();
  app.use("/auth", router);

  return { app, router, db, emailer, close: () => client.close() };
}

/** Extract the session cookie (name=value) from a Set-Cookie header list. */
export function sessionCookie(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((c) => /session_token=/.test(c));
  return found ? (found.split(";")[0] ?? "") : "";
}
