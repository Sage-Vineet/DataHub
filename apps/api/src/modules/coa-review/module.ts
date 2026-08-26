import type { Request, RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { HttpError } from "../../shared/errors.js";

import { createGeminiClassifier } from "./classifier.gemini.js";
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
   * Applying a recommendation means writing to the chart of accounts, and this
   * module does not own that table.
   *
   * It used to forward the write to the legacy backend over HTTP, carrying the
   * caller's own credentials so legacy saw the identity it would have seen had
   * the request proxied straight through. There is no legacy backend now, so
   * the only writer is the chart-of-accounts module in this process.
   *
   * Without it, applying REFUSES rather than failing at a socket. The review
   * queue itself still works — reading recommendations, rejecting them, and
   * generating new ones need no writer — so switching the chart of accounts off
   * subtracts one action rather than the module.
   */
  const hierarchyFor =
    opts.hierarchyFor ??
    ((): HierarchyWriter => ({
      updateAccountHierarchy: () =>
        Promise.reject(
          new HttpError(
            503,
            "The chart of accounts is not available in this deployment, so a " +
              "recommendation cannot be applied. Recommendations can still be " +
              "reviewed and rejected.",
          ),
        ),
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
