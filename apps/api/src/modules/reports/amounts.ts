/**
 * Reading a number out of a record keyed by period, year or month.
 *
 * Every view here holds its figures in `Record<string, number>` maps keyed by
 * a period, and every read of one has to say what an absent key means. With
 * `noUncheckedIndexedAccess` that is a `?? 0` at each site — and there were
 * around sixty of them, none reachable by a test, because the keys are built
 * from the same list the reads iterate.
 *
 * They mean the same thing every time: a period a figure was never written
 * for is a period in which nothing happened, which is zero. Saying it once
 * makes it one decision that is tested rather than sixty that are not, and
 * leaves the views reading as arithmetic instead of as null-handling.
 */

/** Two decimal places, and never `-0`. */
export function round2(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** One period's figure. Absent means nothing happened, which is zero. */
export function amountAt(
  record: Readonly<Record<string, number>> | undefined,
  key: string | number | null | undefined,
): number {
  if (record === undefined || key === null || key === undefined) return 0;
  return record[String(key)] ?? 0;
}

/** The same, rounded — which is how a view reports it. */
export function roundedAt(
  record: Readonly<Record<string, number>> | undefined,
  key: string | number | null | undefined,
): number {
  return round2(amountAt(record, key));
}

/** Several periods added up. A year with no periods contributes nothing. */
export function sumAt(
  record: Readonly<Record<string, number>> | undefined,
  keys: Iterable<string | number> | undefined,
): number {
  let total = 0;
  for (const key of keys ?? []) total += amountAt(record, key);
  return round2(total);
}

/** Add one period's figure to a running record, in place. */
export function addAt(
  record: Record<string, number>,
  key: string | number,
  amount: number,
): void {
  record[String(key)] = round2(amountAt(record, key) + amount);
}

/** The last of a list, or null where there is none. */
export function lastOf<T>(items: readonly T[]): T | null {
  return items.length === 0 ? null : items[items.length - 1]!;
}
