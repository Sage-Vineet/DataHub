import type { SessionUser } from "@datahub/contracts";
import {
  accumulate,
  buildLadder,
  monthOf,
  monthsInRange,
  readMonthlyLineItems,
  type BankAccountActivity,
  type BankAccountRef,
  type BankMovement,
} from "@datahub/financial-engine";
import { canAccessCompany } from "../../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { StatementsRepository } from "../../statements/ports.js";
import type { QuickBooksRepository } from "../ports.js";
import { escapeQueryLiteral, type QbEntityType, type ReportFetcher } from "./client.js";
import { QUICKBOOKS_SOURCE_KEY } from "./service.js";

/**
 * The reconciliation page's Balance Review, from QuickBooks directly.
 *
 * For each of a company's bank accounts: what came in and what went out each
 * month, the balance that implies, and the balance the balance sheet states.
 * The arithmetic is `@datahub/financial-engine`'s; this fetches.
 *
 * TRANSACTIONS ARE PAGED, NOT CAPPED
 * ----------------------------------
 * The version this replaces asked for `MAXRESULTS 1000` once per entity and
 * used whatever came back. A company with more than a thousand deposits in the
 * range got the first thousand and no indication that the rest existed — a
 * ladder that is simply, quietly short, with every subsequent balance wrong by
 * the missing amount and nothing on the page to say so.
 *
 * Every entity is paged here until a short page arrives. Where a hard ceiling
 * is genuinely reached the answer says so, because a truncated reconciliation
 * that admits it is a different thing from one that does not.
 *
 * DATES DO NOT GO INTO THE QUERY UNCHECKED
 * ----------------------------------------
 * Legacy interpolated `start_date` and `end_date` from the query string
 * straight into the QuickBooks query language. Same class of hole as the
 * document-number injection in `entities.ts`: a caller-controlled string in a
 * quoted literal, against a client's live accounting data. Both are validated
 * as dates here before they go anywhere near a query.
 */

/** How many records one page asks for. Intuit's own ceiling. */
const PAGE_SIZE = 1_000;

/**
 * How many pages one entity may take before the answer is called truncated.
 *
 * Twenty thousand transactions of one kind in one range is not a reporting
 * period, it is an import, and fetching it a page at a time would take longer
 * than any page will wait. The ceiling is named in the response rather than
 * enforced silently.
 */
const MAX_PAGES = 20;

export interface BankActivityRange {
  startDate: string;
  endDate: string;
  accountingMethod: string;
}

export interface BankActivityResult {
  success: true;
  accounts: BankAccountActivity[];
  months: string[];
  plFinancials: {
    totalIncome: Record<string, number>;
    totalExpenses: Record<string, number>;
  };
  /** Entities whose results hit the page ceiling, so the ladder is short. */
  truncated: string[];
}

export interface QuickBooksBankActivityDeps {
  connections: QuickBooksRepository;
  fetcher: ReportFetcher;
  statements: StatementsRepository;
}

/** A date as QuickBooks writes one, or a 400. */
export function requireIsoDate(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BadRequestError(`${field} must be a date, as YYYY-MM-DD.`);
  }
  // Checked as a real date, not merely as a shape: "2026-02-31" matches the
  // pattern, and QuickBooks answers a nonsense range with an empty report
  // rather than an error, which reads as a company with no transactions.
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestError(`${field} is not a real date: ${text}.`);
  }
  return text;
}

/** An accounting method QuickBooks understands. */
export function toAccountingMethod(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "cash" ? "Cash" : "Accrual";
}

/** The records inside a query answer, whatever the entity. */
function recordsOf(payload: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const response = payload.QueryResponse;
  if (response === null || typeof response !== "object") return [];
  const rows = (response as Record<string, unknown>)[name];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** A money value as QuickBooks writes one. */
export function amountOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  // `parseFloat("1,234.56")` is 1 — it stops at the comma and reports success.
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class QuickBooksBankActivityService {
  constructor(private readonly deps: QuickBooksBankActivityDeps) {}

  private requireCompany(user: SessionUser, companyId: string): void {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");
  }

  /** Every record of one entity in the range, a page at a time. */
  private async queryAll(
    realmId: string,
    accessToken: string,
    entityType: QbEntityType,
    entityName: string,
    where: string,
    truncated: string[],
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const fetched = await this.deps.fetcher.queryEntity({
        realmId,
        accessToken,
        entityType,
        where,
        startPosition: page * PAGE_SIZE + 1,
        maxResults: PAGE_SIZE,
      });
      const rows = recordsOf(fetched.payload, entityName);
      all.push(...rows);
      // A short page is the last page. Intuit returns no total, so this is the
      // only way to know, and asking once more for a company with an exact
      // multiple costs one empty request rather than a wrong answer.
      if (rows.length < PAGE_SIZE) return all;
    }

    truncated.push(entityName);
    return all;
  }

  /**
   * The ladder for every bank account.
   *
   * A pull rather than a cache read: the page has a Refresh button and this is
   * what it calls. The result is SAVED as the company's bank reconciliation,
   * so `/qb-bank-activity/saved` can restore it later without a connection.
   */
  async ladders(
    user: SessionUser,
    companyId: string,
    range: BankActivityRange,
  ): Promise<BankActivityResult> {
    this.requireCompany(user, companyId);

    const connection = await this.deps.connections.get(companyId);
    if (!connection?.isConnected) {
      throw new NotFoundError("QuickBooks is not connected for this company.");
    }
    const tokens = await this.deps.connections.tokens(companyId);
    if (!tokens?.accessToken) {
      throw new NotFoundError("QuickBooks is not connected for this company.");
    }

    const { realmId } = connection;
    const { accessToken } = tokens;
    const truncated: string[] = [];
    const dateWhere =
      `TxnDate >= '${escapeQueryLiteral(range.startDate)}' ` +
      `AND TxnDate <= '${escapeQueryLiteral(range.endDate)}'`;

    const query = (entityType: QbEntityType, entityName: string, where: string) =>
      this.queryAll(realmId, accessToken, entityType, entityName, where, truncated);

    const [accountRows, deposits, purchases, transfers, journals] = await Promise.all([
      query("accounts", "Account", "AccountType = 'Bank'"),
      query("deposits", "Deposit", dateWhere),
      query("purchases", "Purchase", dateWhere),
      query("transfers", "Transfer", dateWhere),
      query("journal_entries", "JournalEntry", dateWhere),
    ]);

    const accounts: BankAccountRef[] = accountRows.map((row) => ({
      id: String(row.Id ?? ""),
      name: String(row.Name ?? ""),
      accountNumber: String(row.AcctNum ?? ""),
      currentBalance: amountOf(row.CurrentBalance),
    }));
    const bankIds = new Set(accounts.map((account) => account.id));

    const months = monthsInRange(range.startDate, range.endDate);
    const movements = toMovements({ deposits, purchases, transfers, journals }, bankIds);
    const activity = accumulate(movements);

    const balances = await this.monthlyBalanceSheets(realmId, accessToken, months, range, accounts);
    const ladders = accounts.map((account) =>
      buildLadder(account, months, activity.get(account.id), balances.get(account.id)),
    );

    const result: BankActivityResult = {
      success: true,
      accounts: ladders,
      months,
      plFinancials: await this.plFinancials(realmId, accessToken, range),
      truncated,
    };

    await this.save(user, companyId, range, result);
    return result;
  }

  /**
   * What each bank account held at each month end, per the balance sheet.
   *
   * One report per month, because a balance sheet states a position rather
   * than a movement and `summarize_column_by=Month` on it answers a different
   * question. A month that will not fetch is left absent rather than zero: a
   * zero is a bank account holding nothing, and the ladder would report a
   * variance the size of the balance.
   */
  private async monthlyBalanceSheets(
    realmId: string,
    accessToken: string,
    months: readonly string[],
    range: BankActivityRange,
    accounts: readonly BankAccountRef[],
  ): Promise<Map<string, Map<string, number>>> {
    const byAccount = new Map<string, Map<string, number>>();
    if (accounts.length === 0) return byAccount;

    const fetched = await Promise.all(
      months.map(async (month) => {
        const [year, monthNumber] = month.split("-").map(Number);
        const lastDay = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
        try {
          const report = await this.deps.fetcher.fetchReport({
            realmId,
            accessToken,
            reportType: "balance_sheet",
            params: {
              start_date: `${month}-01`,
              end_date: `${month}-${String(lastDay).padStart(2, "0")}`,
              accounting_method: range.accountingMethod,
            },
          });
          return { month, report: report.payload as unknown };
        } catch {
          return { month, report: null };
        }
      }),
    );

    for (const { month, report } of fetched) {
      if (!report) continue;
      for (const [accountId, amount] of readBankRows(report, accounts)) {
        let byMonth = byAccount.get(accountId);
        if (!byMonth) {
          byMonth = new Map();
          byAccount.set(accountId, byMonth);
        }
        byMonth.set(month, amount);
      }
    }

    return byAccount;
  }

  /**
   * Sales and expenses per month, for the "per financials" columns.
   *
   * Read by the engine's monthly-line-item reader rather than by walking the
   * report here. Legacy matched its sections with `/^(expenses?|total
   * expenses?)$/i`, which misses "Operating Expenses" and "Cost of Sales" —
   * for a chart using either, it reported total expenses as an empty object
   * and the page showed nothing, with no error to explain it.
   *
   * Non-fatal: the ladder is the answer, and the P&L columns are alongside it.
   */
  private async plFinancials(
    realmId: string,
    accessToken: string,
    range: BankActivityRange,
  ): Promise<BankActivityResult["plFinancials"]> {
    try {
      const report = await this.deps.fetcher.fetchReport({
        realmId,
        accessToken,
        reportType: "profit_and_loss",
        params: {
          start_date: range.startDate,
          end_date: range.endDate,
          summarize_column_by: "Month",
          accounting_method: range.accountingMethod,
        },
      });
      const monthly = readMonthlyLineItems(report.payload as unknown);
      return {
        totalIncome: monthly.plTotalIncome,
        // Expenses read positive: the page adds them to a costs column, and a
        // negative there subtracts a cost from the total.
        totalExpenses: Object.fromEntries(
          Object.entries(monthly.plTotalExpenses).map(([month, value]) => [month, Math.abs(value)]),
        ),
      };
    } catch {
      return { totalIncome: {}, totalExpenses: {} };
    }
  }

  /** Keep the answer, so the page can restore it without a connection. */
  private async save(
    user: SessionUser,
    companyId: string,
    range: BankActivityRange,
    result: BankActivityResult,
  ): Promise<void> {
    await this.deps.statements.save({
      companyId,
      provenance: {
        from: "pull",
        reportParams: { accountingMethod: range.accountingMethod },
        // The basis is part of the pull's identity. Without it the same range
        // on a cash basis replaces the accrual one, and the page shows
        // whichever was fetched last with nothing to say which.
        variant: range.accountingMethod,
      },
      statementType: "bank_reconciliation",
      sourceKey: QUICKBOOKS_SOURCE_KEY,
      periodStart: range.startDate,
      periodEnd: range.endDate,
      asOfDate: range.endDate,
      fiscalYear: Number(range.endDate.slice(0, 4)),
      payload: {
        accounts: result.accounts,
        months: result.months,
        plFinancials: result.plFinancials,
        truncated: result.truncated,
      },
      extractedBy: user.id,
    });
  }

  /**
   * One account's ladder.
   *
   * The same arithmetic over one account rather than all of them, for the page
   * that drills into a single bank. Its balances come from the same monthly
   * balance sheets, so the two views agree — legacy's single-account route
   * used the account's CURRENT balance as the opening and never fetched a
   * balance sheet at all, so the drill-down and the grid disagreed by however
   * much the account had moved since the period ended.
   */
  async oneLadder(
    user: SessionUser,
    companyId: string,
    accountId: string,
    range: BankActivityRange,
  ): Promise<{ success: true; account: BankAccountSummary; monthlyData: BankAccountActivity["monthlyData"]; truncated: string[] }> {
    this.requireCompany(user, companyId);
    if (!accountId) throw new BadRequestError("accountId is required.");

    const all = await this.ladders(user, companyId, range);
    const ladder = all.accounts.find((account) => account.accountId === accountId);
    if (!ladder) throw new NotFoundError("That bank account is not on this company's chart.");

    return {
      success: true,
      account: {
        accountId: ladder.accountId,
        bankName: ladder.accountName,
        accountNumber: ladder.accountNumber,
      },
      monthlyData: ladder.monthlyData,
      truncated: all.truncated,
    };
  }
}

export interface BankAccountSummary {
  accountId: string;
  bankName: string;
  accountNumber: string;
}

/**
 * Turn QuickBooks' four transaction shapes into one kind of movement.
 *
 * Each shape names its bank account differently and carries its amount
 * differently, and the ladder cares about neither — only about which account
 * moved, when, and by how much.
 */
export function toMovements(
  input: {
    deposits: readonly Record<string, unknown>[];
    purchases: readonly Record<string, unknown>[];
    transfers: readonly Record<string, unknown>[];
    journals: readonly Record<string, unknown>[];
  },
  bankIds: ReadonlySet<string>,
): BankMovement[] {
  const movements: BankMovement[] = [];
  const ref = (value: unknown): string =>
    value !== null && typeof value === "object"
      ? String((value as { value?: unknown }).value ?? "")
      : "";

  for (const deposit of input.deposits) {
    const month = monthOf(String(deposit.TxnDate ?? ""));
    const accountId = ref(deposit.DepositToAccountRef);
    if (!month || !accountId) continue;
    movements.push({
      accountId,
      month,
      deposits: amountOf(deposit.TotalAmt),
      withdrawals: 0,
      intercompany: false,
    });
  }

  for (const purchase of input.purchases) {
    const month = monthOf(String(purchase.TxnDate ?? ""));
    const accountId = ref(purchase.AccountRef);
    if (!month || !accountId) continue;
    movements.push({
      accountId,
      month,
      deposits: 0,
      // A refunded purchase is negative. Its absolute value as a withdrawal
      // would take money out of the account twice.
      withdrawals: Math.abs(amountOf(purchase.TotalAmt)),
      intercompany: false,
    });
  }

  for (const transfer of input.transfers) {
    const month = monthOf(String(transfer.TxnDate ?? ""));
    if (!month) continue;
    const fromId = ref(transfer.FromAccountRef);
    const toId = ref(transfer.ToAccountRef);
    const amount = amountOf(transfer.Amount);
    // Intercompany when BOTH ends are the company's own bank accounts: money
    // moved between pockets rather than earned or spent.
    const intercompany = bankIds.has(fromId) && bankIds.has(toId);

    if (fromId) {
      movements.push({ accountId: fromId, month, deposits: 0, withdrawals: amount, intercompany });
    }
    if (toId) {
      movements.push({ accountId: toId, month, deposits: amount, withdrawals: 0, intercompany });
    }
  }

  for (const journal of input.journals) {
    const month = monthOf(String(journal.TxnDate ?? ""));
    if (!month) continue;
    const lines = Array.isArray(journal.Line) ? (journal.Line as Record<string, unknown>[]) : [];
    for (const line of lines) {
      const detail = line.JournalEntryLineDetail;
      if (detail === null || typeof detail !== "object") continue;
      const accountId = ref((detail as Record<string, unknown>).AccountRef);
      if (!accountId || !bankIds.has(accountId)) continue;

      const posting = String((detail as Record<string, unknown>).PostingType ?? "");
      const amount = amountOf(line.Amount);
      // A line with no posting type is skipped rather than assumed to be a
      // credit. Legacy's `if (Debit) deposits else withdrawals` took money OUT
      // of the account for every line that failed to say.
      if (posting === "Debit") {
        movements.push({ accountId, month, deposits: amount, withdrawals: 0, intercompany: false });
      } else if (posting === "Credit") {
        movements.push({ accountId, month, deposits: 0, withdrawals: amount, intercompany: false });
      }
    }
  }

  return movements;
}

/**
 * The bank rows of a balance sheet, matched to the chart's accounts.
 *
 * Matched by NAME, because a balance sheet report names its rows rather than
 * carrying account ids in every shape. A row whose name matches no bank
 * account is skipped — the section holds sub-totals and other assets, and a
 * "Total Bank Accounts" row taken for an account would double the cash.
 */
export function readBankRows(
  report: unknown,
  accounts: readonly BankAccountRef[],
): Array<[string, number]> {
  const byName = new Map(accounts.map((account) => [normaliseName(account.name), account.id]));
  const found: Array<[string, number]> = [];

  const walk = (rows: unknown): void => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;

      const columns = record.ColData;
      if (Array.isArray(columns) && columns.length > 1) {
        const label = normaliseName(String((columns[0] as { value?: unknown })?.value ?? ""));
        const accountId = byName.get(label);
        if (accountId !== undefined) {
          found.push([accountId, amountOf((columns[1] as { value?: unknown })?.value)]);
        }
      }

      const nested = record.Rows;
      if (nested !== null && typeof nested === "object") {
        walk((nested as { Row?: unknown }).Row);
      }
    }
  };

  const rows = (report as { Rows?: { Row?: unknown } } | null)?.Rows?.Row;
  walk(rows);
  return found;
}

/** A row label and an account name, comparably. */
function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
