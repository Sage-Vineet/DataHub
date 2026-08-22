import type { Request, RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";

import { createGeminiClassifier } from "./classifier.gemini.js";
import { createLegacyHierarchyWriter } from "./hierarchy.legacy.js";
import type { HierarchyWriter, ReasonablenessClassifier } from "./ports.js";
import { DrizzleCoaReviewRepository } from "./repository.drizzle.js";
import { createCoaReviewRouter } from "./router.js";
import { createCoaReviewService } from "./service.js";

export interface CoaReviewModule {
  router: Router;
}

export interface CreateCoaReviewModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  /** Where legacy is reachable — it owns `chart_of_accounts` for now. */
  legacyOrigin: string;
  /**
   * Overridable so a test, or a later provider change, needs no edit here.
   * Defaults to Gemini when `GEMINI_API_KEY` is set.
   */
  classifier?: ReasonablenessClassifier;
  /** Overridable for tests. Defaults to the legacy PATCH route. */
  hierarchyFor?: (req: Request) => HierarchyWriter;
  apiKey?: string;
}

/**
 * Wire the reasonableness review.
 *
 * ## With no API key, this still mounts
 *
 * Listing, applying, accepting and rejecting are database operations with
 * nothing to do with a model; only *generating* recommendations needs one. A
 * classifier that rejects every call is the honest representation of that, and
 * the service is already fail-soft around it — so the effect is "generation
 * unavailable", not a dead route group. Refusing to mount would take the review
 * queue away from a reviewer over a dependency they are not using.
 */
export function createCoaReviewModule(opts: CreateCoaReviewModuleOptions): CoaReviewModule {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const classifier =
    opts.classifier ??
    (apiKey
      ? createGeminiClassifier({ apiKey })
      : {
          review(): Promise<{ text: string; model: string }> {
            return Promise.reject(
              new Error("GEMINI_API_KEY is not set — reasonableness generation is unavailable"),
            );
          },
        });

  const repo = new DrizzleCoaReviewRepository(opts.db);

  /**
   * The caller's credentials, forwarded to whoever owns the chart of accounts.
   *
   * Both are taken from the incoming request: the bridge has already minted the
   * `Authorization` header legacy verifies, so this is the same identity legacy
   * would have seen had the request proxied straight through. Nothing here
   * invents an actor.
   */
  const hierarchyFor =
    opts.hierarchyFor ??
    ((req: Request): HierarchyWriter =>
      createLegacyHierarchyWriter({
        origin: opts.legacyOrigin,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
      }));

  const serviceFor = (req: Request) =>
    createCoaReviewService({
      repo,
      classifier,
      hierarchy: hierarchyFor(req),
      logger: { warn: (msg: string) => console.warn(msg) },
    });

  return { router: createCoaReviewRouter({ serviceFor, requireAuth: opts.requireAuth }) };
}
