import type { RequestHandler, Router } from "express";
import type { Db } from "@datahub/db";
import { fixtureEngagement } from "./fixture.js";
import type { CommentaryDraftPort, QoeRepository } from "./ports.js";
import { DrizzleQoeRepository } from "./repository.drizzle.js";
import { InMemoryQoeRepository } from "./repository.memory.js";
import { createQoeRouter } from "./router.js";
import { QoeService } from "./service.js";

export interface QoeModule {
  router: Router;
  service: QoeService;
}

export interface CreateQoeModuleOptions {
  db: Db;
  requireAuth: RequestHandler;
  commentary?: CommentaryDraftPort;
  /**
   * Serve the anonymized walkthrough engagement from memory instead of the
   * database. Set by `QOE_DEMO_VERSION_ID` so the bridge can be demonstrated
   * against known-correct figures before the ingest path is cut over.
   */
  demoVersionId?: string;
  demoCompanyId?: string;
}

export function createQoeModule(opts: CreateQoeModuleOptions): QoeModule {
  let repo: QoeRepository;
  if (opts.demoVersionId && opts.demoCompanyId) {
    const memory = new InMemoryQoeRepository();
    memory.seedEngagement(opts.demoVersionId, fixtureEngagement(opts.demoCompanyId));
    repo = memory;
    console.warn(
      `[gateway] QoE module serving the DEMO engagement at version ${opts.demoVersionId}`,
    );
  } else {
    repo = new DrizzleQoeRepository(opts.db);
  }

  const service = new QoeService({ repo, commentary: opts.commentary });
  return { router: createQoeRouter({ service, requireAuth: opts.requireAuth }), service };
}

export { QoeService } from "./service.js";
export { DrizzleQoeRepository } from "./repository.drizzle.js";
export { InMemoryQoeRepository } from "./repository.memory.js";
export { createQoeRouter } from "./router.js";
export { fixtureEngagement } from "./fixture.js";
export type { QoeRepository, EngagementData, AddbackRecord, CommentaryDraftPort } from "./ports.js";
