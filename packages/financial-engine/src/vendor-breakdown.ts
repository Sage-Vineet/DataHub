import { addTo, emptyAmounts, periodKeyFor, roundAmounts } from "./periods.js";
import { UnclassifiedAccountError } from "./income-statement.js";
import type { Account, AccountType, Aggregation, GlEntry, Period } from "./types.js";

/**
 * Who the money went to, and on what.
 *
 * A second cut of the same ledger the income statement reads: vendor first,
 * then account. It lives here rather than in a presenter for one reason — the
 * sign convention. Revenue and cost both arrive positive from the ledger, so a
 * breakdown that applies the sign itself is a second place that can get it
 * wrong, and getting it wrong here is invisible: the totals still look like
 * money, and only tie out against the P&L if somebody checks.
 *
 * Sharing `UnclassifiedAccountError` with the income statement is deliberate
 * too. An unclassified P&L account is a hard error there; making it a silent
 * omission here would let a vendor's spend quietly under-report.
 */

export interface VendorAccountTotals {
  accountId: string;
  accountName: string;
  accountType: AccountType;
  /** Signed per period: revenue positive, cost negative. */
  amounts: Record<string, number>;
  total: number;
}

export interface VendorTotals {
  /** `null` where the ledger row named no vendor. */
  vendorName: string | null;
  accounts: VendorAccountTotals[];
  amounts: Record<string, number>;
  total: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function buildVendorBreakdown(
  accounts: Account[],
  entries: GlEntry[],
  periods: Period[],
  aggregation: Aggregation,
): VendorTotals[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const template = emptyAmounts(periods);
  const unclassified = new Set<string>();

  interface Bucket {
    vendorName: string | null;
    accounts: Map<string, VendorAccountTotals>;
    amounts: Record<string, number>;
  }
  const vendors = new Map<string, Bucket>();

  for (const entry of entries) {
    const account = byId.get(entry.accountId);
    if (!account || account.statementType !== "profit_loss") continue;

    const key = periodKeyFor(entry, aggregation);
    if (template[key] === undefined) continue;

    if (account.accountType === null || account.accountType === undefined) {
      unclassified.add(entry.accountId);
      continue;
    }

    // The same one place the sign is applied on the income statement.
    const signed = account.accountType === "income" ? entry.amount : -entry.amount;

    // An empty vendor string and a null vendor are the same absence.
    const trimmed = (entry.vendor ?? "").trim();
    const name = trimmed === "" ? null : trimmed;
    // A leading space cannot collide with a real trimmed vendor name.
    const vendorKey = name ?? " none";

    let bucket = vendors.get(vendorKey);
    if (!bucket) {
      vendors.set(
        vendorKey,
        (bucket = { vendorName: name, accounts: new Map(), amounts: { ...template } }),
      );
    }
    addTo(bucket.amounts, key, signed);

    let line = bucket.accounts.get(entry.accountId);
    if (!line) {
      bucket.accounts.set(
        entry.accountId,
        (line = {
          accountId: entry.accountId,
          accountName: account.name,
          accountType: account.accountType,
          amounts: { ...template },
          total: 0,
        }),
      );
    }
    addTo(line.amounts, key, signed);
  }

  if (unclassified.size > 0) throw new UnclassifiedAccountError([...unclassified].sort());

  const sum = (amounts: Record<string, number>): number =>
    round2(Object.values(amounts).reduce((total, v) => total + v, 0));

  return [...vendors.values()]
    .map((bucket) => ({
      vendorName: bucket.vendorName,
      amounts: roundAmounts(bucket.amounts),
      total: sum(bucket.amounts),
      accounts: [...bucket.accounts.values()]
        .map((line) => ({
          ...line,
          amounts: roundAmounts(line.amounts),
          total: sum(line.amounts),
        }))
        .sort((a, b) => a.accountName.localeCompare(b.accountName)),
    }))
    // Largest first by magnitude: a big refund matters as much as a big spend.
    .sort(
      (a, b) =>
        Math.abs(b.total) - Math.abs(a.total) ||
        (a.vendorName ?? "").localeCompare(b.vendorName ?? ""),
    );
}
