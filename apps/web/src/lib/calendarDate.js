/**
 * Calendar dates, as distinct from instants.
 *
 * A due date is a day on a calendar. It has no time and no timezone — "the
 * audited statements are due on 19 August" means the same thing in Chicago and
 * in Frankfurt. The API sends these as `YYYY-MM-DD`.
 *
 * `new Date('2026-08-19')` does NOT produce that. Per ECMA-262, a date-only
 * string is parsed as UTC midnight, so in any timezone behind UTC the resulting
 * instant lands on the *previous* calendar day the moment it is formatted for
 * display. That is how the broker came to see a due date of 2026-08-19 while the
 * seller, looking at the same request, was told it was due 18 Aug 2026 — a
 * deadline a day earlier than the one that had been set.
 *
 * These helpers parse `YYYY-MM-DD` into local noon instead. Noon rather than
 * midnight so that neither a DST jump nor an off-by-a-few-hours offset can push
 * the value across a day boundary in either direction.
 *
 * Values that carry a time (a real timestamp, e.g. `created_at`) are instants
 * and are left alone — use `formatDateTime` for those.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a value into a Date suitable for display.
 *
 * A bare `YYYY-MM-DD` becomes local noon on that calendar day. Anything else —
 * a full ISO timestamp, an epoch, a Date — is passed through to `new Date`,
 * because it genuinely is an instant.
 *
 * Returns null when the value cannot be parsed, so callers can render their own
 * "not set" rather than the string "Invalid Date".
 */
export function parseCalendarDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'string') {
    const match = DATE_ONLY.exec(value.trim());
    if (match) {
      const [, y, m, d] = match;
      return new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0);
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Format a calendar date for display. Returns `fallback` when unparseable. */
export function formatCalendarDate(value, options = {}, locale = 'en-GB', fallback = 'Not set') {
  const date = parseCalendarDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
  });
}

/**
 * Is this calendar date strictly before today?
 *
 * Compared day-to-day, not instant-to-instant: a request due today is not
 * overdue at 00:01, which is what an instant comparison against `new Date()`
 * would claim.
 */
export function isPastDue(value) {
  const date = parseCalendarDate(value);
  if (!date) return false;
  const today = new Date();
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const nowDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return dueDay.getTime() < nowDay.getTime();
}
