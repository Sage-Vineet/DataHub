import type { SessionUser } from "@datahub/contracts";
import {
  reconcileBankToBooks,
  type BankLine,
  type BookLine,
  type ReconciliationSummary,
} from "@datahub/financial-engine";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { ReconciliationTransactionsRepository } from "./ports.js";

/**
 * Comparing what the bank says against what the books say.
 *
 * The matching itself lives in `@datahub/financial-engine` — it is arithmetic
 * over two lists and has no business knowing about a database. This is the
 * part that does: fetch both sides, hand them over, and answer.
 *
 * Legacy did the matching inline in the route handler, and got two things
 * wrong that a pure function with tests would not have survived. It never
 * consumed a matched book line, so a duplicated payment matched twice and came
 * back clean; and it mapped over the bank rows only, so a transaction in the
 * books that the bank had never seen did not appear at all.
 */

export interface ReconcileServiceDeps {
  repo: ReconciliationTransactionsRepository;
}

export class ReconcileService {
  constructor(private readonly deps: ReconcileServiceDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  async reconcile(user: SessionUser, companyId: string): Promise<ReconciliationSummary> {
    this.requireCompany(user, companyId);

    const [bank, books] = await Promise.all([
      this.deps.repo.listBankTransactions(companyId),
      this.deps.repo.listBookTransactions(companyId),
    ]);

    return reconcileBankToBooks({
      bank: bank.map(
        (line): BankLine => ({
          id: line.id,
          date: line.date,
          narration: line.narration,
          amount: line.amount,
        }),
      ),
      books: books.map(
        (line): BookLine => ({ id: line.id, date: line.date, name: line.name, amount: line.amount }),
      ),
    });
  }
}
