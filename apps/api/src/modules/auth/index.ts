import type { Router } from "express";
import type { Db } from "@datahub/db";
import { loadAuthConfig, type AuthConfig } from "./config.js";
import { createBetterAuth, loadBetterAuthConfig, type BetterAuth } from "./better-auth.js";
import { createBetterAuthRouter } from "./router.better.js";
import { ConsoleEmailer } from "./emailer.js";
import { DrizzleAuthRepository } from "./repository.drizzle.js";
import type { AuthRepository, Emailer } from "./ports.js";
import { createAuthRouter } from "./router.js";
import { AuthService } from "./service.js";

export interface AuthModule {
  router: Router;
  service: AuthService;
  config: AuthConfig;
}

export interface CreateAuthModuleOptions {
  repo: AuthRepository;
  emailer?: Emailer;
  env?: NodeJS.ProcessEnv;
}

/** Compose the bespoke auth module: config (fail-closed) + service + router. */
export function createAuthModule(opts: CreateAuthModuleOptions): AuthModule {
  const config = loadAuthConfig(opts.env ?? process.env);
  const service = new AuthService({
    repo: opts.repo,
    emailer: opts.emailer ?? new ConsoleEmailer(),
    config,
  });
  return { router: createAuthRouter(service, config), service, config };
}

export interface BetterAuthModule {
  router: Router;
  auth: BetterAuth;
  config: AuthConfig;
}

export interface CreateBetterAuthModuleOptions {
  /** Runtime Drizzle client, or a pre-built repo/auth (tests inject these). */
  db?: Db;
  repo?: AuthRepository;
  auth?: BetterAuth;
  emailer?: Emailer;
  env?: NodeJS.ProcessEnv;
}

/**
 * Compose the Better Auth module (ADR-0007): Better Auth engine + Drizzle repo
 * (for company memberships / provisioning) + the legacy-compatible router. The
 * rate-limit window/max and default-folder list are reused from `loadAuthConfig`;
 * the signing secret is validated fail-closed in both configs.
 */
export function createBetterAuthModule(opts: CreateBetterAuthModuleOptions): BetterAuthModule {
  const env = opts.env ?? process.env;
  const config = loadAuthConfig(env);
  const emailer = opts.emailer ?? new ConsoleEmailer();
  const repo =
    opts.repo ?? (opts.db ? new DrizzleAuthRepository(opts.db) : undefined);
  if (!repo) throw new Error("createBetterAuthModule requires a `db` or `repo`.");
  const auth =
    opts.auth ??
    (opts.db
      ? createBetterAuth({ db: opts.db, emailer, config: loadBetterAuthConfig(env) })
      : undefined);
  if (!auth) throw new Error("createBetterAuthModule requires a `db` or `auth`.");
  return { router: createBetterAuthRouter({ auth, repo, config }), auth, config };
}

export { AuthService, canAccessCompany } from "./service.js";
export { InMemoryAuthRepository } from "./repository.memory.js";
export { DrizzleAuthRepository } from "./repository.drizzle.js";
export { ConsoleEmailer } from "./emailer.js";
export { GraphEmailer } from "./emailer.graph.js";
export { createBetterAuth, loadBetterAuthConfig } from "./better-auth.js";
export type { BetterAuth, BetterAuthConfig } from "./better-auth.js";
export { backfillBetterAuthIdentities, type BackfillResult } from "./backfill.js";
export { requireBetterAuth, toSessionUser } from "./better-session.js";
export { loadAuthConfig, type AuthConfig } from "./config.js";
export { AuthError, InvalidCredentialsError } from "./errors.js";
export type { AuthRepository, AuthUserRecord, Emailer, OtpRecord } from "./ports.js";
