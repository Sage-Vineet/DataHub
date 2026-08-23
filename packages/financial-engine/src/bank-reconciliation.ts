/**
 * Matching what the bank says against what the books say.
 *
 * The point of a reconciliation is to find the DIFFERENCES, so every design
 * decision here is about not hiding one. Two ways of hiding a difference show
 * up in the version this replaces, and both under-report — which is the
 * dangerous direction, because a reconciliation that reports nothing reads as
 * a reconciliation that passed.
 *
 * THE TWO THINGS THAT WERE WRONG
 * ------------------------------
 * 1. MATCHES WERE NOT CONSUMED. The old code did `books.find(...)` per bank
 *    row and never marked the book row used, so two £500 bank lines on the
 *    same date both matched the SAME book line. A genuinely duplicated payment
 *    — the classic thing a reconciliation exists to catch — came back
 *    "Matched, Matched" instead of "Matched, Unmatched".
 *
 * 2. THE BOOKS WERE NEVER REPORTED. The output was the bank rows mapped over,
 *    so a transaction recorded in the books with no bank counterpart did not
 *    appear at all. That is money the company thinks it moved and the bank has
 *    never seen, and it was invisible.
 *
 * Both are fixed by matching one-to-one and returning both sides.
 */

/** A line off a bank statement. */
export interface BankLine {
  id?: string | number;
  date: string;
  narration: string | null;
  amount: number;
}

/** A line off the books — a general-ledger transaction against the bank account. */
export interface BookLine {
  id?: string | number;
  date: string;
  name: string | null;
  amount: number;
}

/**
 * What happened to a pair.
 *
 * `matched` — same date, same amount, same sign.
 * `sign_mismatch` — same date and same magnitude, opposite sign. Almost always
 *   a payment entered as a receipt, and worth its own name because the fix
 *   differs from a missing entry.
 * `bank_only` — the bank has it and the books do not.
 * `books_only` — the books have it and the bank does not.
 */
export type ReconciliationOutcome =
  | "matched"
  | "sign_mismatch"
  | "bank_only"
  | "books_only";

export interface ReconciliationRow {
  outcome: ReconciliationOutcome;
  bankDate: string | null;
  bankNarration: string | null;
  bankAmount: number | null;
  bookDate: string | null;
  bookName: string | null;
  bookAmount: number | null;
  /** The difference, where both sides are present. */
  difference: number | null;
}

export interface ReconciliationSummary {
  rows: ReconciliationRow[];
  counts: Record<ReconciliationOutcome, number>;
  /** What the bank says moved, in total. */
  bankTotal: number;
  /** What the books say moved, in total. */
  booksTotal: number;
  /**
   * Books minus bank.
   *
   * The single number somebody looks at first. Zero does NOT mean reconciled —
   * two opposite errors cancel — which is why the counts are beside it rather
   * than behind a "reconciled" boolean that a cancelling pair would set true.
   */
  variance: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const amountOf = (line: { amount: unknown }): number => (isNumber(line.amount) ? line.amount : 0);

/**
 * A date as the matcher compares it.
 *
 * Trimmed to the day: bank exports carry timestamps and ledgers do not, and
 * comparing "2024-01-15T00:00:00Z" against "2024-01-15" matches nothing at all
 * while looking like a company whose books agree with nothing.
 */
export function reconciliationDateKey(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  return text.slice(0, 10);
}

/**
 * The key two lines must share to be candidates.
 *
 * Date and MAGNITUDE, not signed amount. A payment entered on the wrong side is
 * a real and common error, and keying on the signed amount would report it as
 * two separate problems — one missing from each side — rather than as the one
 * problem it is.
 */
const candidateKey = (date: string, amount: number): string =>
  `${reconciliationDateKey(date)}|${Math.abs(round2(amount)).toFixed(2)}`;

export interface ReconcileInput {
  bank: readonly BankLine[];
  books: readonly BookLine[];
}

/**
 * Reconcile the bank against the books.
 *
 * Matching is one-to-one and greedy over date-and-magnitude. Where several
 * book lines could match one bank line, the first unconsumed one in the given
 * order wins — arbitrary, but arbitrary between things that are identical in
 * every respect the matcher can see, and consuming SOMETHING is what keeps a
 * duplicate from matching twice.
 *
 * Same-sign matches are preferred over opposite-sign ones within a candidate
 * group, so a genuine match is not consumed by a sign error that a later row
 * would have explained.
 */
export function reconcileBankToBooks(input: ReconcileInput): ReconciliationSummary {
  // Book lines grouped by what could match them, so matching is a lookup
  // rather than a scan per bank row — a year of transactions on both sides is
  // tens of thousands of comparisons otherwise.
  const byKey = new Map<string, BookLine[]>();
  for (const line of input.books) {
    const key = candidateKey(line.date, amountOf(line));
    const bucket = byKey.get(key);
    if (bucket) bucket.push(line);
    else byKey.set(key, [line]);
  }

  const consumed = new Set<BookLine>();
  const rows: ReconciliationRow[] = [];

  for (const bankLine of input.bank) {
    const bankAmount = round2(amountOf(bankLine));
    const candidates = byKey.get(candidateKey(bankLine.date, bankAmount)) ?? [];
    const available = candidates.filter((c) => !consumed.has(c));

    // Prefer an exact match to a sign error. Without this a bank line with two
    // candidates — one correct, one entered on the wrong side — could consume
    // the correct one and report the pair as a mismatch, then leave the wrong
    // one to be reported as missing.
    const match =
      available.find((c) => round2(amountOf(c)) === bankAmount) ?? available[0];

    if (!match) {
      rows.push({
        outcome: "bank_only",
        bankDate: reconciliationDateKey(bankLine.date),
        bankNarration: bankLine.narration ?? null,
        bankAmount,
        bookDate: null,
        bookName: null,
        bookAmount: null,
        difference: null,
      });
      continue;
    }

    consumed.add(match);
    const bookAmount = round2(amountOf(match));
    rows.push({
      outcome: bookAmount === bankAmount ? "matched" : "sign_mismatch",
      bankDate: reconciliationDateKey(bankLine.date),
      bankNarration: bankLine.narration ?? null,
      bankAmount,
      bookDate: reconciliationDateKey(match.date),
      bookName: match.name ?? null,
      bookAmount,
      difference: round2(bookAmount - bankAmount),
    });
  }

  // What the books have and the bank has not. Legacy never reported these:
  // money the company thinks it moved that the bank has never seen.
  for (const bookLine of input.books) {
    if (consumed.has(bookLine)) continue;
    rows.push({
      outcome: "books_only",
      bankDate: null,
      bankNarration: null,
      bankAmount: null,
      bookDate: reconciliationDateKey(bookLine.date),
      bookName: bookLine.name ?? null,
      bookAmount: round2(amountOf(bookLine)),
      difference: null,
    });
  }

  const counts: Record<ReconciliationOutcome, number> = {
    matched: 0,
    sign_mismatch: 0,
    bank_only: 0,
    books_only: 0,
  };
  for (const row of rows) counts[row.outcome] += 1;

  const bankTotal = round2(input.bank.reduce((total, line) => total + amountOf(line), 0));
  const booksTotal = round2(input.books.reduce((total, line) => total + amountOf(line), 0));

  return { rows, counts, bankTotal, booksTotal, variance: round2(booksTotal - bankTotal) };
}
