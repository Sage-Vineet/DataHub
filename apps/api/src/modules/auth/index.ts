import type { Router } from "express";
import { loadAuthConfig, type AuthConfig } from "./config.js";
import { ConsoleEmailer } from "./emailer.js";
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

/** Compose the auth module: config (fail-closed) + service + router. */
export function createAuthModule(opts: CreateAuthModuleOptions): AuthModule {
  const config = loadAuthConfig(opts.env ?? process.env);
  const service = new AuthService({
    repo: opts.repo,
    emailer: opts.emailer ?? new ConsoleEmailer(),
    config,
  });
  return { router: createAuthRouter(service, config), service, config };
}

export { AuthService, canAccessCompany } from "./service.js";
export { InMemoryAuthRepository } from "./repository.memory.js";
export { DrizzleAuthRepository } from "./repository.drizzle.js";
export { ConsoleEmailer } from "./emailer.js";
export { loadAuthConfig, type AuthConfig } from "./config.js";
export { AuthError, InvalidCredentialsError } from "./errors.js";
export type { AuthRepository, AuthUserRecord, Emailer, OtpRecord } from "./ports.js";
