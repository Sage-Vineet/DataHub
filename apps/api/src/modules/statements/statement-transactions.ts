import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../shared/access.js";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { DocumentReader } from "../../shared/gemini.js";
import { modelNumber } from "../../shared/model-json.js";

/**
 * Reading the individual transactions out of a bank statement's text.
 *
 * Distinct from `bank-statements.ts`, which reads a statement's SUMMARY —
 * opening, deposits, withdrawals, closing. This reads the lines.
 *
 * THE SERVER OWNS THE PROMPT NOW
 * ------------------------------
 * The version this replaces took `systemPrompt` AND `userMessage` from the
 * request body and passed both to the model:
 *
 *   const { systemPrompt, userMessage } = req.body;
 *   await client.messages.create({ system: systemPrompt, messages: [...] });
 *
 * That makes the endpoint an open proxy to a paid model API. It is behind
 * `requireAuth`, so it is not open to the world — but any authenticated user
 * could send any instructions and any content on the company's key and read
 * the answer back. Nothing in the request is a bank statement by construction,
 * and no guardrail in the prompt survives, because the caller writes the
 * prompt.
 *
 * The caller now sends the statement TEXT. The instructions live here. A
 * caller that still sends `systemPrompt` is not refused — the SPA does, and
 * refusing would break it for no gain — it is simply ignored, which is the
 * whole point.
 */

/** One line off a statement. */
export interface StatementTransaction {
  date: string;
  name: string;
  amount: number;
  type: "debit" | "credit";
  reference: string;
  balance: number | null;
}

export const TRANSACTION_PROMPT = `You are a bank statement parser. Extract EVERY
transaction from the statement text and return them as a JSON array.

Return ONLY a raw JSON array. No markdown, no backticks, no explanation. Start
with [ and end with ].

Each object has exactly these six fields:
{ "date": "YYYY-MM-DD", "name": "description", "amount": 1234.56,
  "type": "debit" or "credit", "reference": "ref or empty string",
  "balance": 12345.67 or null }

Rules:
- Extract every transaction. Do not stop early, summarise, or skip a row.
- Dates: DD/MM/YYYY, DD/MM/YY and "15 Jan 2026" all become YYYY-MM-DD.
- Credits and deposits are POSITIVE; debits and withdrawals are NEGATIVE.
- Where withdrawal and deposit are separate columns, the withdrawal is negative
  and the deposit positive.
- Strip currency symbols and separators: "1,23,456.78" becomes 123456.78.
- SKIP column headers, opening and closing balance rows, account information,
  blank lines and page markers — they are not transactions.
- Join a description that spans lines into one name.
- If there are no transactions, return exactly [].`;

/**
 * How long a statement's text may be.
 *
 * The text goes to a model that charges by the token, and the caller supplies
 * it. Without a cap, one request can spend an unbounded amount — which is the
 * other half of the problem the prompt move fixes. A megabyte is far more text
 * than any bank statement, and a caller with more should send it in chunks,
 * which is what the page already does.
 */
export const MAX_STATEMENT_TEXT = 1_000_000;

const DATE_FORMATS: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^(\d{4})-(\d{2})-(\d{2})/, (m) => `${m[1]}-${m[2]}-${m[3]}`],
];

/** A date as the grid stores it, or "" for anything unreadable. */
export function toIsoDate(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  for (const [pattern, format] of DATE_FORMATS) {
    const match = text.match(pattern);
    if (match) return format(match);
  }
  // Anything else is left to the model, which was asked for ISO. A date this
  // cannot read is reported as absent rather than guessed — a transaction on
  // the wrong date reconciles against the wrong month and the totals still
  // add up.
  return "";
}

/**
 * Read one transaction out of the model's object.
 *
 * The field names vary because statements do: a model reading an Indian
 * statement writes `narration`, an American one `description`. Every spelling
 * that has been seen is accepted rather than requiring one.
 */
export function toStatementTransaction(row: unknown): StatementTransaction | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const raw = row as Record<string, unknown>;

  const first = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return undefined;
  };

  const date = toIsoDate(
    first("date", "txn_date", "txnDate", "transaction_date", "transactionDate", "posting_date", "postingDate", "value_date", "valueDate"),
  );
  const name = String(
    first("name", "narration", "description", "memo", "particulars", "details") ?? "",
  ).trim();
  const amount = modelNumber(first("amount", "value", "txn_amount", "transactionAmount"));

  // A row with no date, no name or no amount is a header or a blank the
  // statement carries for layout. Stored as a transaction it puts a phantom
  // line in every reconciliation.
  if (date === "" || name === "" || amount === null) return null;

  const statedType = String(first("type", "txn_type", "transactionType") ?? "").toLowerCase();
  // The SIGN decides, not the label. A model that writes `"type": "debit"` on a
  // positive amount has contradicted itself, and the amount is the figure
  // everything downstream adds up.
  const type: "debit" | "credit" =
    amount < 0 ? "debit" : amount > 0 ? "credit" : statedType === "debit" ? "debit" : "credit";

  return {
    date,
    name,
    amount,
    type,
    reference: String(first("reference", "ref", "chq_ref_no", "chqRefNo", "cheque_no") ?? "").trim(),
    balance: modelNumber(first("balance", "running_balance", "runningBalance", "closing_balance")),
  };
}

export interface StatementTransactionsServiceDeps {
  reader: DocumentReader;
}

export class StatementTransactionsService {
  constructor(private readonly deps: StatementTransactionsServiceDeps) {}

  /**
   * Parse a chunk of statement text into transactions.
   *
   * The company is checked even though nothing is read from or written to it:
   * this spends money on the company's key, and an endpoint that spends should
   * be reachable only by somebody entitled to that company.
   */
  async parse(
    user: SessionUser,
    companyId: string,
    text: string,
  ): Promise<{ transactions: StatementTransaction[]; skipped: number }> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const statementText = String(text ?? "").trim();
    if (statementText === "") {
      throw new BadRequestError("No statement text was sent.");
    }
    if (statementText.length > MAX_STATEMENT_TEXT) {
      throw new BadRequestError(
        `That is more text than a bank statement: ${statementText.length} characters, ` +
          `and at most ${MAX_STATEMENT_TEXT} can be parsed at once. Send it in chunks.`,
      );
    }

    const parsed = await this.deps.reader.askForJson({
      prompt: `${TRANSACTION_PROMPT}\n\nStatement text:\n\n${statementText}`,
    });

    const rows = Array.isArray(parsed) ? parsed : [];
    const transactions: StatementTransaction[] = [];
    let skipped = 0;
    for (const row of rows) {
      const transaction = toStatementTransaction(row);
      if (transaction) transactions.push(transaction);
      else skipped += 1;
    }

    // Counted rather than dropped silently: a chunk where half the rows were
    // unreadable is a chunk worth looking at, and a shorter list than the
    // statement has looks exactly like a statement with fewer transactions.
    return { transactions, skipped };
  }
}
