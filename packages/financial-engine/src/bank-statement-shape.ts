/**
 * Turning extracted bank statements into the reconciliation's grid.
 *
 * One row per bank account, one column per month, and a totals row. The
 * statements arrive one per PDF; this groups them, fills the grid, and adds
 * the two kinds of total the page shows.
 *
 * THE TWO TOTALS ARE NOT THE SAME KIND OF SUM
 * -------------------------------------------
 * Across BANKS in one month, every figure adds: three accounts holding £10k,
 * £5k and £2k at month end hold £17k between them. That total is a real number.
 *
 * Across MONTHS for one account, only the flows add. Deposits and withdrawals
 * are movements and sum over a year; a BALANCE is a position at a moment and
 * does not. An account's starting balance for the year is JANUARY'S starting
 * balance, and its ending balance is DECEMBER'S — not the sum of twelve
 * months' balances, which is what the version this replaces computed. On a
 * year of statements that row read roughly twelve times the real figure, on a
 * page whose whole purpose is agreeing balances with the bank.
 */

/** One statement, as extraction produces it. */
export interface ExtractedBankStatement {
  bank_name?: string | null;
  bank_name_clean?: string | null;
  account_name?: string | null;
  account_number?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  beginning_balance?: unknown;
  ending_balance?: unknown;
  deposits?: unknown;
  withdrawals?: unknown;
  fees?: unknown;
  status?: string | null;
}

export interface BankMonth {
  monthKey: string;
  displayMonth: string;
  startingBalance: number;
  deposits: number;
  withdrawals: number;
  endingBalance: number;
  status: string;
  statement_start_date: string;
  statement_end_date: string;
}

export interface BankAccountTotals {
  /** The first month's opening position, not a sum. */
  startingBalance: number;
  deposits: number;
  withdrawals: number;
  /** The last month's closing position, not a sum. */
  endingBalance: number;
}

export interface BankRow {
  bank_name: string;
  bank_name_clean: string;
  account_name: string;
  account_number: string;
  accounts: Array<{
    account_name: string;
    months: BankMonth[];
    totals: BankAccountTotals;
    status: string;
  }>;
}

export interface MonthTotals {
  month: string;
  monthKey: string;
  startingBalance: number;
  deposits: number;
  withdrawals: number;
  endingBalance: number;
}

export interface BankResponseShape {
  banks: BankRow[];
  months: string[];
  totals: MonthTotals[];
  /** Statements dropped because nothing could date them. */
  skipped: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (text === "") return 0;
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()]/g, "").replace(/[^0-9.\-]/g, "");
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
};

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** `2024-06-30` → `2024-06`. Null for anything undatable. */
export function toMonthKey(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})/);
  if (iso) {
    const month = Number.parseInt(iso[2]!, 10);
    return month >= 1 && month <= 12 ? `${iso[1]}-${iso[2]}` : null;
  }
  // `06/30/2024` and `30/06/2024` are both written, and telling them apart
  // needs a day above twelve. Where both readings are possible the month is
  // ambiguous, and guessing files a statement in the wrong month — so only the
  // unambiguous form is accepted.
  const slashed = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashed) {
    const first = Number.parseInt(slashed[1]!, 10);
    const second = Number.parseInt(slashed[2]!, 10);
    const month = second > 12 ? first : first > 12 ? second : first;
    if (month >= 1 && month <= 12) return `${slashed[3]}-${String(month).padStart(2, "0")}`;
  }
  return null;
}

/** `2024-06` → `Jun-2024`, which is what the column heading reads. */
export function toDisplayMonth(monthKey: string): string {
  const parts = String(monthKey ?? "").split("-");
  const month = Number.parseInt(parts[1] ?? "", 10);
  if (!parts[0] || !Number.isInteger(month) || month < 1 || month > 12) return String(monthKey);
  return `${MONTH_LABELS[month - 1]}-${parts[0]}`;
}

/**
 * What makes two statements the same statement.
 *
 * The same account and the same period. A bank statement re-uploaded — which
 * happens whenever somebody re-syncs a folder — would otherwise have its
 * deposits added to themselves, doubling a month's movement on a page whose
 * purpose is agreeing that movement with the bank.
 */
export function statementKey(statement: ExtractedBankStatement): string {
  return [
    String(statement.bank_name ?? "").trim().toLowerCase(),
    String(statement.account_number ?? "").trim().slice(-4),
    String(statement.period_start ?? "").trim(),
    String(statement.period_end ?? "").trim(),
  ].join("|");
}

/** Drop repeats, keeping the first of each. */
export function deduplicateStatements(
  statements: readonly ExtractedBankStatement[],
): ExtractedBankStatement[] {
  const seen = new Set<string>();
  const out: ExtractedBankStatement[] = [];
  for (const statement of statements) {
    const key = statementKey(statement);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(statement);
  }
  return out;
}

interface MonthAccumulator extends BankMonth {
  /** The latest period end seen for this month, so the closing balance is the latest. */
  latestEnd: string;
}

/** Build the grid. */
export function buildBankResponseShape(
  statements: readonly ExtractedBankStatement[],
): BankResponseShape {
  if (statements.length === 0) return { banks: [], months: [], totals: [], skipped: 0 };

  interface Group {
    bankNameClean: string;
    accountName: string;
    accountNumber: string;
    months: Map<string, MonthAccumulator>;
  }

  const groups = new Map<string, Group>();
  let skipped = 0;

  for (const statement of deduplicateStatements(statements)) {
    const bankName = String(statement.bank_name ?? "Unknown Bank").trim() || "Unknown Bank";
    const monthKey = toMonthKey(statement.period_end) ?? toMonthKey(statement.period_start);
    if (!monthKey) {
      // Counted, not silently dropped: a statement nobody can date is a month
      // missing from the grid, and the page needs to be able to say so.
      skipped += 1;
      continue;
    }

    let group = groups.get(bankName);
    if (!group) {
      group = {
        bankNameClean:
          String(statement.bank_name_clean ?? "").trim() ||
          bankName.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
        accountName: String(statement.account_name ?? "").trim(),
        accountNumber: String(statement.account_number ?? "").trim().slice(-4),
        months: new Map(),
      };
      groups.set(bankName, group);
    }
    // Fill in what a later statement knows and an earlier one did not.
    if (!group.accountName && statement.account_name) {
      group.accountName = String(statement.account_name).trim();
    }
    if (!group.accountNumber && statement.account_number) {
      group.accountNumber = String(statement.account_number).trim().slice(-4);
    }

    const periodEnd = String(statement.period_end ?? "").trim();
    const existing = group.months.get(monthKey);

    if (!existing) {
      group.months.set(monthKey, {
        monthKey,
        displayMonth: toDisplayMonth(monthKey),
        startingBalance: num(statement.beginning_balance),
        deposits: num(statement.deposits),
        withdrawals: num(statement.withdrawals) + num(statement.fees),
        endingBalance: num(statement.ending_balance),
        status: String(statement.status ?? "").trim() || "Verified",
        statement_start_date: String(statement.period_start ?? "").trim(),
        statement_end_date: periodEnd || monthKey,
        latestEnd: periodEnd,
      });
      continue;
    }

    // Two statements in one month — a mid-month account change, or a bank that
    // issues twice. The MOVEMENTS add.
    existing.deposits = round2(existing.deposits + num(statement.deposits));
    existing.withdrawals = round2(
      existing.withdrawals + num(statement.withdrawals) + num(statement.fees),
    );
    // The closing balance is the LATEST statement's, by date rather than by
    // whichever happened to be processed last. Array order depends on which
    // folder was read first, which is not a fact about the account.
    if (periodEnd >= existing.latestEnd) {
      existing.endingBalance = num(statement.ending_balance);
      existing.latestEnd = periodEnd;
      existing.statement_end_date = periodEnd || existing.statement_end_date;
    }
    if (String(statement.status ?? "") === "Needs Review") existing.status = "Needs Review";
  }

  const allMonthKeys = new Set<string>();

  const banks: BankRow[] = [...groups.entries()].map(([bankName, group]) => {
    const months = [...group.months.values()]
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map(({ latestEnd: _latestEnd, ...month }) => {
        allMonthKeys.add(month.monthKey);
        return month;
      });

    // Flows sum; balances do not. The account's opening position for the whole
    // period is the FIRST month's opening, and its closing position is the
    // LAST month's closing.
    const totals: BankAccountTotals = {
      startingBalance: months[0]?.startingBalance ?? 0,
      deposits: round2(months.reduce((sum, m) => sum + m.deposits, 0)),
      withdrawals: round2(months.reduce((sum, m) => sum + m.withdrawals, 0)),
      endingBalance: months[months.length - 1]?.endingBalance ?? 0,
    };

    return {
      bank_name: bankName,
      bank_name_clean: group.bankNameClean,
      account_name: group.accountName,
      account_number: group.accountNumber,
      accounts: [
        {
          account_name: group.accountName || "Business Checking",
          months,
          totals,
          status: months.some((m) => m.status === "Needs Review") ? "Needs Review" : "Verified",
        },
      ],
    };
  });

  const sortedMonthKeys = [...allMonthKeys].sort();

  // Across BANKS in one month, every figure adds — three accounts' balances at
  // month end do make up the company's cash.
  const totals: MonthTotals[] = sortedMonthKeys.map((monthKey) => {
    let startingBalance = 0;
    let deposits = 0;
    let withdrawals = 0;
    let endingBalance = 0;
    for (const bank of banks) {
      const month = bank.accounts[0]!.months.find((m) => m.monthKey === monthKey);
      if (!month) continue;
      startingBalance += month.startingBalance;
      deposits += month.deposits;
      withdrawals += month.withdrawals;
      endingBalance += month.endingBalance;
    }
    return {
      month: toDisplayMonth(monthKey),
      monthKey,
      startingBalance: round2(startingBalance),
      deposits: round2(deposits),
      withdrawals: round2(withdrawals),
      endingBalance: round2(endingBalance),
    };
  });

  return { banks, months: sortedMonthKeys.map(toDisplayMonth), totals, skipped };
}

/**
 * Narrow a built grid to one calendar year.
 *
 * Every total is recomputed from the surviving months rather than filtered,
 * so the response stays self-consistent: a totals row carried over from the
 * unfiltered grid would describe months the page is no longer showing.
 */
export function scopeToYear(shape: BankResponseShape, year: number | null): BankResponseShape {
  if (!year) return shape;
  const prefix = String(year);

  const banks = shape.banks
    .map((bank) => {
      const months = bank.accounts[0]!.months.filter((m) => m.monthKey.startsWith(prefix));
      return {
        ...bank,
        accounts: [
          {
            ...bank.accounts[0]!,
            months,
            totals: {
              startingBalance: months[0]?.startingBalance ?? 0,
              deposits: round2(months.reduce((sum, m) => sum + m.deposits, 0)),
              withdrawals: round2(months.reduce((sum, m) => sum + m.withdrawals, 0)),
              endingBalance: months[months.length - 1]?.endingBalance ?? 0,
            },
          },
        ],
      };
    })
    // A bank with no months in the year is not a row with no data; it is not a
    // row. Keeping it puts an empty line in a grid that reads as an account
    // holding nothing.
    .filter((bank) => bank.accounts[0]!.months.length > 0);

  const monthKeys = shape.totals
    .map((t) => t.monthKey)
    .filter((monthKey) => monthKey.startsWith(prefix));

  return {
    banks,
    months: monthKeys.map(toDisplayMonth),
    totals: shape.totals.filter((t) => t.monthKey.startsWith(prefix)),
    skipped: shape.skipped,
  };
}
