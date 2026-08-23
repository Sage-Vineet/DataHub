import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { AskInput, DocumentReader } from "../../shared/gemini.js";
import {
  MAX_STATEMENT_TEXT,
  StatementTransactionsService,
  toIsoDate,
  toStatementTransaction,
} from "./statement-transactions.js";

/**
 * Reading transactions out of a statement's text.
 *
 * The version this replaces took the SYSTEM PROMPT from the request body and
 * passed it to the model. That made the endpoint an open proxy to a paid API:
 * any authenticated user could send any instructions and any content on the
 * company's key. The first thing these tests are about is that the caller no
 * longer writes the prompt.
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

function reader(answer: unknown = []): DocumentReader & { asks: AskInput[] } {
  const asks: AskInput[] = [];
  return {
    asks,
    ask: () => Promise.reject(new Error("not used")),
    askForJson: <T,>(input: AskInput): Promise<T> => {
      asks.push(input);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
  };
}

const build = (answer?: unknown) => {
  const r = reader(answer);
  return { reader: r, service: new StatementTransactionsService({ reader: r }) };
};

describe("who writes the prompt", () => {
  it("sends the server's instructions, whatever the caller asked for", async () => {
    // The caller supplies TEXT. The instructions live on the server, so no
    // request can replace them.
    const { service, reader: r } = build();
    await service.parse(USER, COMPANY, "15/01/2026  Coffee  -4.50");
    expect(r.asks[0]!.prompt).toContain("bank statement parser");
    expect(r.asks[0]!.prompt).toContain("15/01/2026  Coffee  -4.50");
  });

  it("caps how much text one request may spend on", async () => {
    // The text goes to a model that charges by the token, and the caller
    // supplies it. Uncapped, one request can spend an unbounded amount.
    const { service } = build();
    await expect(
      service.parse(USER, COMPANY, "x".repeat(MAX_STATEMENT_TEXT + 1)),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("refuses an empty request rather than paying for nothing", async () => {
    const { service, reader: r } = build();
    await expect(service.parse(USER, COMPANY, "   ")).rejects.toThrow(/no statement text/i);
    expect(r.asks).toEqual([]);
  });

  it("checks the company, because this spends on the company's key", async () => {
    const { service, reader: r } = build();
    await expect(
      service.parse(USER, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "text"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(r.asks).toEqual([]);
  });

  it("refuses a request naming no company", async () => {
    const { service } = build();
    await expect(service.parse(USER, "", "text")).rejects.toThrow(/clientId/);
  });
});

describe("reading one transaction", () => {
  const row = {
    date: "2026-01-15",
    name: "Coffee Shop",
    amount: -4.5,
    type: "debit",
    reference: "REF123",
    balance: 995.5,
  };

  it("reads the fields", () => {
    expect(toStatementTransaction(row)).toEqual({
      date: "2026-01-15",
      name: "Coffee Shop",
      amount: -4.5,
      type: "debit",
      reference: "REF123",
      balance: 995.5,
    });
  });

  it("accepts the spellings different statements use", () => {
    // A model reading an Indian statement writes `narration`, an American one
    // `description`.
    const indian = toStatementTransaction({
      txn_date: "2026-01-15",
      narration: "NEFT TRANSFER",
      amount: 1000,
      chq_ref_no: "N123",
      running_balance: 5000,
    });
    expect(indian).toMatchObject({ name: "NEFT TRANSFER", reference: "N123", balance: 5000 });
  });

  it("lets the SIGN decide the type, not the label", () => {
    // A model that writes `"type": "debit"` on a positive amount has
    // contradicted itself, and the amount is what everything downstream adds.
    expect(toStatementTransaction({ ...row, amount: 100, type: "debit" })!.type).toBe("credit");
    expect(toStatementTransaction({ ...row, amount: -100, type: "credit" })!.type).toBe("debit");
  });

  it("falls back to the label for a transaction of exactly zero", () => {
    expect(toStatementTransaction({ ...row, amount: 0, type: "debit" })!.type).toBe("debit");
  });

  it("reads an amount written the way a statement writes it", () => {
    expect(toStatementTransaction({ ...row, amount: "1,23,456.78" })!.amount).toBe(123456.78);
    expect(toStatementTransaction({ ...row, amount: "(500.00)" })!.amount).toBe(-500);
  });

  it("keeps a null balance apart from a zero one", () => {
    expect(toStatementTransaction({ ...row, balance: null })!.balance).toBeNull();
    expect(toStatementTransaction({ ...row, balance: 0 })!.balance).toBe(0);
  });

  it("drops a row that is not a transaction", () => {
    // A header or a blank the statement carries for layout. Stored, it puts a
    // phantom line in every reconciliation.
    expect(toStatementTransaction({ ...row, date: "" })).toBeNull();
    expect(toStatementTransaction({ ...row, name: "" })).toBeNull();
    expect(toStatementTransaction({ ...row, amount: "n/a" })).toBeNull();
    expect(toStatementTransaction(null)).toBeNull();
    expect(toStatementTransaction("Opening Balance")).toBeNull();
  });

  it("reports a date it cannot read as absent rather than guessing", () => {
    // A transaction on the wrong date reconciles against the wrong month, and
    // the totals still add up.
    expect(toIsoDate("15/01/2026")).toBe("");
    expect(toIsoDate("2026-01-15")).toBe("2026-01-15");
    expect(toIsoDate("")).toBe("");
    expect(toIsoDate(null)).toBe("");
  });
});

describe("parsing a chunk", () => {
  it("returns the transactions it could read", async () => {
    const { service } = build([
      { date: "2026-01-15", name: "Coffee", amount: -4.5 },
      { date: "2026-01-16", name: "Salary", amount: 2000 },
    ]);
    const result = await service.parse(USER, COMPANY, "some statement text");
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[1]!.type).toBe("credit");
  });

  it("counts the rows it could not read", async () => {
    // A chunk where half the rows were unreadable is worth looking at, and a
    // list shorter than the statement looks exactly like a statement with
    // fewer transactions.
    const { service } = build([
      { date: "2026-01-15", name: "Coffee", amount: -4.5 },
      { name: "Opening Balance" },
      "not a row",
    ]);
    const result = await service.parse(USER, COMPANY, "text");
    expect(result.transactions).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it("answers nothing for a chunk with no transactions", async () => {
    const { service } = build([]);
    expect(await service.parse(USER, COMPANY, "text")).toEqual({
      transactions: [],
      skipped: 0,
    });
  });

  it("treats a reply that is not an array as no transactions", async () => {
    const { service } = build({ error: "could not read" });
    expect((await service.parse(USER, COMPANY, "text")).transactions).toEqual([]);
  });
});
