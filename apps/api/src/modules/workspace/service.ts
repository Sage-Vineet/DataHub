import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { WorkspaceRepository } from "./ports.js";

/** The page key the CIM questionnaire shares across everyone on a company. */
export const CIM_QUESTIONNAIRE_PAGE_KEY = "cim-questionnaire";

/** Every page-state endpoint answers in this shape. */
export interface PageStateResponse {
  success: true;
  state: unknown;
  updatedAt: string | null;
  userId: string;
}

/**
 * Per-user state, achieved by scoping the key rather than the table.
 *
 * `workspace_page_state` is unique on (company, page key) and has no user
 * column, so two people editing the same page would otherwise overwrite each
 * other. Appending the user id is what makes a draft private — and *not*
 * appending it is what makes the CIM questionnaire shared. The distinction is
 * the whole design, so it lives in one named function rather than as an inline
 * template string at five call sites.
 */
export function scopedPageKey(pageKey: string, userId: string): string {
  return `${pageKey}:${userId}`;
}

/** A CIM questionnaire payload, with the envelope the client expects. */
export interface QuestionnaireState {
  version: number;
  items: Record<string, unknown>;
  currentBatchId: string;
  history: unknown[];
  createdAt: string;
  sentAt: string | null;
  sentBy: unknown;
  clientSubmittedAt: string | null;
  clientSubmittedBy: unknown;
  updatedAt: string;
  updatedBy: { id: string | null; name: string; email: string; role: string };
}

export interface WorkspaceServiceDeps {
  repo: WorkspaceRepository;
  /** Injected so a test can pin `updatedAt` without freezing global time. */
  now?: () => Date;
}

export class WorkspaceService {
  private readonly repo: WorkspaceRepository;
  private readonly now: () => Date;

  constructor(deps: WorkspaceServiceDeps) {
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
  }

  private assertAccess(user: SessionUser, companyId: string | undefined): string {
    // The company arrives from a header, a query parameter or the Referer, so it
    // is caller-supplied in every case — which is exactly why the access check
    // below is not optional.
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) {
      throw new ForbiddenError("You do not have permission to access this workspace.");
    }
    return companyId;
  }

  private respond(user: SessionUser, state: { payload: unknown; updatedAt: string } | null): PageStateResponse {
    return {
      success: true,
      state: state?.payload ?? null,
      updatedAt: state?.updatedAt ?? null,
      userId: user.id,
    };
  }

  async getPageState(
    user: SessionUser,
    companyId: string | undefined,
    pageKey: string,
  ): Promise<PageStateResponse> {
    const company = this.assertAccess(user, companyId);
    return this.respond(user, await this.repo.get(company, scopedPageKey(pageKey, user.id)));
  }

  async savePageState(
    user: SessionUser,
    companyId: string | undefined,
    pageKey: string,
    payload: unknown,
  ): Promise<PageStateResponse> {
    const company = this.assertAccess(user, companyId);
    // `payload` is stored opaquely: it is whatever the page needs to resume, and
    // the server has no business knowing its shape.
    return this.respond(
      user,
      await this.repo.replace(company, scopedPageKey(pageKey, user.id), payload ?? {}),
    );
  }

  async clearPageState(
    user: SessionUser,
    companyId: string | undefined,
    pageKey: string,
  ): Promise<{ success: true; deleted: boolean }> {
    const company = this.assertAccess(user, companyId);
    const deleted = await this.repo.remove(company, scopedPageKey(pageKey, user.id));
    return { success: true, deleted };
  }

  /**
   * The CIM questionnaire, which is shared rather than per-user: the broker
   * prepares it and the client answers it, on one document.
   */
  async getQuestionnaire(user: SessionUser, companyId: string | undefined): Promise<PageStateResponse> {
    const company = this.assertAccess(user, companyId);
    return this.respond(user, await this.repo.get(company, CIM_QUESTIONNAIRE_PAGE_KEY));
  }

  async saveQuestionnaire(
    user: SessionUser,
    companyId: string | undefined,
    input: unknown,
  ): Promise<PageStateResponse> {
    const company = this.assertAccess(user, companyId);
    const payload = this.normalizeQuestionnaire(input, user);
    return this.respond(user, await this.repo.replace(company, CIM_QUESTIONNAIRE_PAGE_KEY, payload));
  }

  /**
   * Fill in the questionnaire envelope.
   *
   * Unlike ordinary page state this payload is not fully opaque: the server
   * stamps who last touched it and when, because "sent to client" and "client
   * submitted" are workflow facts a client must not be able to backdate by
   * posting its own timestamps.
   */
  private normalizeQuestionnaire(input: unknown, user: SessionUser): QuestionnaireState {
    const raw = (input ?? {}) as Partial<QuestionnaireState>;
    const now = this.now().toISOString();
    const items =
      raw.items && typeof raw.items === "object" ? (raw.items as Record<string, unknown>) : {};

    return {
      version: 1,
      items,
      currentBatchId: typeof raw.currentBatchId === "string" ? raw.currentBatchId : "",
      history: Array.isArray(raw.history) ? raw.history : [],
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
      sentAt: raw.sentAt ?? null,
      sentBy: raw.sentBy ?? null,
      clientSubmittedAt: raw.clientSubmittedAt ?? null,
      clientSubmittedBy: raw.clientSubmittedBy ?? null,
      updatedAt: now,
      updatedBy: {
        id: user.id,
        name: user.name || user.email || "User",
        email: user.email || "",
        role: user.role || "",
      },
    };
  }
}
