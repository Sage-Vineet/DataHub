import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { ReconcileService } from "./reconcile.js";
import { InMemoryReconciliationTransactionsRepository } from "./repository.memory.js";

/**
 * Fetching both sides and handing them to the matcher.
 *
 * The matching itself is tested exhaustively in `@datahub/financial-engine`.
 * What is left here is the part that touches a store: that both sides are
 * fetched, that the fields survive the trip, and that a caller cannot reconcile
 * a company they cannot see.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const USER: SessionUser = {
  id: "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu",
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

function build() {
  const repo = new InMemoryReconciliationTransactionsRepository();
  return { repo, service: new ReconcileService({ repo }) };
}

describe("reconciling", () => {
  it("fetches both sides and pairs them", async () => {
    const { repo, service } = build();
    repo.addBankTransactions(COMPANY, [
      { date: "2024-01-15", narration: "DD SUPPLIER", amount: -500 },
    ]);
    await repo.replaceBookTransactions(COMPANY, [
      { date: "2024-01-15", name: "Supplier Ltd", transactionType: "Expense", amount: -500 },
    ]);

    const summary = await service.reconcile(USER, COMPANY);
    expect(summary.counts.matched).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      bankNarration: "DD SUPPLIER",
      bookName: "Supplier Ltd",
    });
  });

  it("carries the amounts across as numbers", async () => {
    // They come out of a `numeric` column as strings. A string reaching the
    // matcher compares by text, so "-500" and "-500.00" stop being equal and
    // every pair becomes an exception.
    const { repo, service } = build();
    repo.addBankTransactions(COMPANY, [{ date: "2024-01-15", narration: null, amount: -1234.56 }]);
    const summary = await service.reconcile(USER, COMPANY);
    expect(summary.bankTotal).toBe(-1234.56);
  });

  it("replaces the books rather than accumulating them", async () => {
    // A partial ledger reconciles against nothing useful, and merging two
    // fetches of overlapping periods doubles every transaction in the overlap
    // — which then reads as a duplicated payment, the exact thing this is
    // meant to detect.
    const { repo, service } = build();
    await repo.replaceBookTransactions(COMPANY, [
      { date: "2024-01-15", name: "First", transactionType: null, amount: -1 },
    ]);
    await repo.replaceBookTransactions(COMPANY, [
      { date: "2024-01-16", name: "Second", transactionType: null, amount: -2 },
    ]);

    const summary = await service.reconcile(USER, COMPANY);
    expect(summary.counts.books_only).toBe(1);
    expect(summary.rows[0]!.bookName).toBe("Second");
  });

  it("reconciles a company with nothing on either side", async () => {
    const { service } = build();
    const summary = await service.reconcile(USER, COMPANY);
    expect(summary.rows).toEqual([]);
    expect(summary.variance).toBe(0);
  });

  it("keeps one company's transactions off another's reconciliation", async () => {
    const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { repo, service } = build();
    repo.addBankTransactions(other, [{ date: "2024-01-15", narration: "THEIRS", amount: -9 }]);
    const summary = await service.reconcile(
      { ...USER, company_ids: [COMPANY, other] },
      COMPANY,
    );
    expect(summary.rows).toEqual([]);
  });

  it("reports how many book rows a replace wrote", async () => {
    const { repo } = build();
    expect(
      await repo.replaceBookTransactions(COMPANY, [
        { date: "2024-01-15", name: "A", transactionType: null, amount: -1 },
        { date: "2024-01-16", name: "B", transactionType: null, amount: -2 },
      ]),
    ).toBe(2);
    expect(await repo.replaceBookTransactions(COMPANY, [])).toBe(0);
  });
});

describe("who may reconcile", () => {
  it("refuses a company the caller cannot reach", async () => {
    const { service } = build();
    await expect(
      service.reconcile(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.reconcile(USER, "")).rejects.toBeInstanceOf(BadRequestError);
  });
});
