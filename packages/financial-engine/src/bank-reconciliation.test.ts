import { describe, expect, it } from "vitest";
import {
  reconcileBankToBooks,
  reconciliationDateKey,
  type BankLine,
  type BookLine,
} from "./bank-reconciliation.js";

/**
 * Matching the bank against the books.
 *
 * The point of a reconciliation is to find the DIFFERENCES, so every test here
 * is about not hiding one. The two that mattered most both under-reported,
 * which is the dangerous direction: a reconciliation that reports nothing
 * reads as a reconciliation that passed.
 */

const bank = (date: string, amount: number, narration = "PAYMENT"): BankLine => ({
  date,
  amount,
  narration,
});
const book = (date: string, amount: number, name = "Supplier"): BookLine => ({
  date,
  amount,
  name,
});

describe("what it matches", () => {
  it("pairs a bank line with its book line", () => {
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500)],
      books: [book("2024-01-15", -500)],
    });
    expect(result.counts.matched).toBe(1);
    expect(result.rows[0]).toMatchObject({
      outcome: "matched",
      bankAmount: -500,
      bookAmount: -500,
      difference: 0,
    });
  });

  it("consumes a book line, so a duplicate payment is CAUGHT", () => {
    // The defect this exists to prevent. The old code did `books.find(...)` per
    // bank row and never marked the book row used, so two £500 lines on one
    // date both matched the same book line and came back "Matched, Matched".
    // A duplicated payment is the classic thing a reconciliation catches, and
    // it was reported as fine.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500), bank("2024-01-15", -500)],
      books: [book("2024-01-15", -500)],
    });
    expect(result.counts.matched).toBe(1);
    expect(result.counts.bank_only).toBe(1);
  });

  it("matches two genuine pairs of the same amount and date", () => {
    // The other side of the same coin: two real payments with two real book
    // entries must both match, not collapse into one match and one exception.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500), bank("2024-01-15", -500)],
      books: [book("2024-01-15", -500), book("2024-01-15", -500)],
    });
    expect(result.counts.matched).toBe(2);
    expect(result.counts.bank_only).toBe(0);
  });

  it("reports a book line the bank has never seen", () => {
    // Legacy mapped over the bank rows only, so this did not appear at all —
    // money the company thinks it moved that the bank has no record of.
    const result = reconcileBankToBooks({
      bank: [],
      books: [book("2024-01-15", -500, "Rent")],
    });
    expect(result.counts.books_only).toBe(1);
    expect(result.rows[0]).toMatchObject({
      outcome: "books_only",
      bookName: "Rent",
      bankAmount: null,
    });
  });

  it("reports a bank line the books have never seen", () => {
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500, "DIRECT DEBIT")],
      books: [],
    });
    expect(result.rows[0]).toMatchObject({
      outcome: "bank_only",
      bankNarration: "DIRECT DEBIT",
      bookAmount: null,
    });
  });
});

describe("a payment entered on the wrong side", () => {
  it("is one problem, not two", () => {
    // Keying on the signed amount would report a sign error as a missing bank
    // line AND a missing book line, sending somebody looking for two
    // transactions when there is one, entered backwards.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500)],
      books: [book("2024-01-15", 500)],
    });
    expect(result.counts.sign_mismatch).toBe(1);
    expect(result.counts.bank_only).toBe(0);
    expect(result.counts.books_only).toBe(0);
    expect(result.rows[0]!.difference).toBe(1000);
  });

  it("does not consume a correct match when a sign error is also available", () => {
    // Otherwise the bank line pairs with the backwards entry, reports a
    // mismatch, and leaves the CORRECT entry to be reported as missing — two
    // exceptions where the truth is one.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500)],
      books: [book("2024-01-15", 500, "Wrong side"), book("2024-01-15", -500, "Correct")],
    });
    expect(result.rows[0]).toMatchObject({ outcome: "matched", bookName: "Correct" });
    expect(result.counts.books_only).toBe(1);
  });
});

describe("dates as exports actually write them", () => {
  it("compares to the day, ignoring a timestamp", () => {
    // Bank exports carry timestamps and ledgers do not. Comparing them raw
    // matches nothing, which looks like a company whose books agree with the
    // bank on no transaction at all.
    const result = reconcileBankToBooks({
      bank: [{ date: "2024-01-15T09:31:00Z", amount: -500, narration: null }],
      books: [book("2024-01-15", -500)],
    });
    expect(result.counts.matched).toBe(1);
  });

  it("normalises a date to its day", () => {
    expect(reconciliationDateKey("2024-01-15T09:31:00Z")).toBe("2024-01-15");
    expect(reconciliationDateKey("2024-01-15")).toBe("2024-01-15");
    expect(reconciliationDateKey("")).toBe("");
    expect(reconciliationDateKey(null)).toBe("");
    expect(reconciliationDateKey(undefined)).toBe("");
  });

  it("does not match across days", () => {
    // A payment that cleared the next day is a real timing difference and the
    // reconciliation must show it rather than quietly pair it.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-16", -500)],
      books: [book("2024-01-15", -500)],
    });
    expect(result.counts.matched).toBe(0);
    expect(result.counts.bank_only).toBe(1);
    expect(result.counts.books_only).toBe(1);
  });
});

describe("the totals", () => {
  it("reports each side and the difference between them", () => {
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500), bank("2024-01-16", 200)],
      books: [book("2024-01-15", -500)],
    });
    expect(result.bankTotal).toBe(-300);
    expect(result.booksTotal).toBe(-500);
    expect(result.variance).toBe(-200);
  });

  it("does not call a cancelling pair of errors reconciled", () => {
    // A zero variance with exceptions on both sides is two mistakes that
    // happen to cancel. The counts sit beside the variance for exactly this
    // reason — a "reconciled" boolean would be true here and it should not be.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500)],
      books: [book("2024-01-16", -500)],
    });
    expect(result.variance).toBe(0);
    expect(result.counts.matched).toBe(0);
    expect(result.counts.bank_only).toBe(1);
    expect(result.counts.books_only).toBe(1);
  });

  it("rounds to the cent rather than carrying float noise", () => {
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", 0.1), bank("2024-01-16", 0.2)],
      books: [],
    });
    expect(result.bankTotal).toBe(0.3);
  });
});

describe("data it was handed badly", () => {
  it("treats an unreadable amount as zero rather than as NaN", () => {
    // A NaN amount propagates into every total and turns the whole
    // reconciliation into "NaN", which says nothing about anything.
    const result = reconcileBankToBooks({
      bank: [{ date: "2024-01-15", amount: Number.NaN, narration: null }],
      books: [],
    });
    expect(result.bankTotal).toBe(0);
    expect(result.rows[0]!.bankAmount).toBe(0);
  });

  it("keeps a null narration null rather than inventing text", () => {
    const result = reconcileBankToBooks({
      bank: [{ date: "2024-01-15", amount: -1, narration: null }],
      books: [],
    });
    expect(result.rows[0]!.bankNarration).toBeNull();
  });

  it("keeps a nameless book line nameless, matched or not", () => {
    // `name` is nullable on a ledger line, and both the matched row and the
    // books-only row read it. An empty string renders as a blank cell that
    // looks like a rendering fault; null renders as "—", which reads as a line
    // the export did not name.
    const matched = reconcileBankToBooks({
      bank: [{ date: "2024-01-15", amount: -500, narration: "Rent" }],
      books: [{ date: "2024-01-15", amount: -500, name: null }],
    });
    expect(matched.rows[0]).toMatchObject({ outcome: "matched", bookName: null });

    const booksOnly = reconcileBankToBooks({
      bank: [],
      books: [{ date: "2024-01-15", amount: -500, name: null }],
    });
    expect(booksOnly.rows[0]).toMatchObject({ outcome: "books_only", bookName: null });
  });

  it("reconciles nothing against nothing without complaint", () => {
    const result = reconcileBankToBooks({ bank: [], books: [] });
    expect(result.rows).toEqual([]);
    expect(result.variance).toBe(0);
    expect(result.counts).toEqual({
      matched: 0,
      sign_mismatch: 0,
      bank_only: 0,
      books_only: 0,
    });
  });

  it("counts every row it emits, exactly once", () => {
    // The counts are what a reader trusts. A row emitted and not counted is a
    // difference that exists on the page and not in the summary.
    const result = reconcileBankToBooks({
      bank: [bank("2024-01-15", -500), bank("2024-02-01", -10)],
      books: [book("2024-01-15", 500), book("2024-03-01", -99)],
    });
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.rows.length);
  });
});

describe("a year's worth on both sides", () => {
  it("matches without comparing every row against every other", () => {
    // A scan per bank row is quadratic; a thousand a side is a million
    // comparisons, and a real ledger is larger than that.
    const bankLines: BankLine[] = [];
    const bookLines: BookLine[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const date = `2024-01-${String((i % 28) + 1).padStart(2, "0")}`;
      bankLines.push(bank(date, -(i + 1)));
      bookLines.push(book(date, -(i + 1)));
    }
    const result = reconcileBankToBooks({ bank: bankLines, books: bookLines });
    expect(result.counts.matched).toBe(2_000);
    expect(result.counts.bank_only).toBe(0);
    expect(result.counts.books_only).toBe(0);
  });
});
