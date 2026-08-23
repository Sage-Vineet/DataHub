import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  ADDBACK_SECTIONS,
  type AddbackItemRecord,
  type AdjustmentRecord,
  type BankReconciliationRepository,
} from "./ports.js";

export interface BankReconciliationServiceDeps {
  repo: BankReconciliationRepository;
}

/**
 * The editable parts of the bank reconciliation.
 *
 * Every method takes the company explicitly and checks it once, here — the
 * repository is given an already-authorised company id and does not decide
 * anything about access.
 */
export class BankReconciliationService {
  constructor(private readonly deps: BankReconciliationServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  async listAdjustments(user: SessionUser, companyId: string): Promise<AdjustmentRecord[]> {
    this.requireCompany(user, companyId);
    return this.deps.repo.listAdjustments(companyId);
  }

  /**
   * Write one cell.
   *
   * An amount that is not a number becomes zero rather than an error, which is
   * legacy's behaviour and the right one: the grid sends "" for a cleared cell,
   * and clearing a cell means zero.
   */
  async setAdjustment(
    user: SessionUser,
    companyId: string,
    input: { month: string; rowKey: string; amount: unknown },
  ): Promise<void> {
    this.requireCompany(user, companyId);
    if (!input.month || !input.rowKey) {
      throw new BadRequestError("Missing month or rowKey");
    }
    const amount = Number(input.amount);
    await this.deps.repo.setAdjustment(companyId, {
      month: input.month,
      rowKey: input.rowKey,
      amount: Number.isFinite(amount) ? amount : 0,
    });
  }

  async listAddbackItems(
    user: SessionUser,
    companyId: string,
    filter: { reportSource: string; section?: string },
  ): Promise<AddbackItemRecord[]> {
    this.requireCompany(user, companyId);
    // Without it every source's rows would come back together, and the grid
    // would show QuickBooks lines on a manual reconciliation.
    if (!filter.reportSource) throw new BadRequestError("Missing reportSource");
    // A section that cannot exist would silently list nothing, which reads as
    // "this section is empty" rather than "you asked for a section there is no
    // such thing as".
    if (filter.section !== undefined && !(ADDBACK_SECTIONS as readonly string[]).includes(filter.section)) {
      throw new BadRequestError(
        `Invalid section: ${filter.section}. Expected one of ${ADDBACK_SECTIONS.join(", ")}.`,
      );
    }
    return this.deps.repo.listAddbackItems(companyId, filter);
  }

  async createAddbackItem(
    user: SessionUser,
    companyId: string,
    input: {
      section: string;
      name: string;
      source?: string;
      monthAmounts?: Record<string, number>;
      reportSource: string;
    },
  ): Promise<AddbackItemRecord> {
    this.requireCompany(user, companyId);
    if (!input.section || !input.name || !input.reportSource) {
      throw new BadRequestError("Missing section, name, or reportSource");
    }
    // The database has a CHECK for this. Refusing here turns what would be a
    // 500 out of the driver into a 400 that names the field and its options.
    if (!(ADDBACK_SECTIONS as readonly string[]).includes(input.section)) {
      throw new BadRequestError(
        `Invalid section: ${input.section}. Expected one of ${ADDBACK_SECTIONS.join(", ")}.`,
      );
    }
    return this.deps.repo.createAddbackItem({
      companyId,
      section: input.section,
      name: input.name,
      source: input.source || "manual",
      monthAmounts: input.monthAmounts ?? {},
      reportSource: input.reportSource,
    });
  }

  /**
   * Edit an item's monthly amounts.
   *
   * 404s when nothing matched. Legacy scoped the update by company and
   * answered `{ success: true }` regardless, so editing an item that had been
   * deleted — or that belongs to another company — reported saved and changed
   * nothing. On a grid that saves on blur, the edit vanishes on the next
   * refresh with no indication anything went wrong.
   */
  async updateAddbackItemAmounts(
    user: SessionUser,
    companyId: string,
    id: string,
    monthAmounts: Record<string, number> | undefined,
  ): Promise<void> {
    this.requireCompany(user, companyId);
    const updated = await this.deps.repo.updateAddbackItemAmounts(
      companyId,
      id,
      monthAmounts ?? {},
    );
    if (!updated) throw new NotFoundError("Add-back item not found.");
  }

  async deleteAddbackItem(user: SessionUser, companyId: string, id: string): Promise<void> {
    this.requireCompany(user, companyId);
    const deleted = await this.deps.repo.deleteAddbackItem(companyId, id);
    if (!deleted) throw new NotFoundError("Add-back item not found.");
  }
}
