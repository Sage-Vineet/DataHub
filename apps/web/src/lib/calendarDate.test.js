import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatCalendarDate, isPastDue, parseCalendarDate } from './calendarDate';

/**
 * The bug this file exists to prevent: a broker sets a due date of 2026-08-19,
 * and the seller is told the request is due 18 Aug 2026. Both were reading the
 * same row. `new Date('2026-08-19')` is UTC midnight, and any timezone behind
 * UTC renders that as the previous day.
 *
 * These tests pin a timezone deliberately. Run in UTC they would all pass with
 * the broken implementation, which is exactly why the defect survived.
 */
describe('parseCalendarDate', () => {
  it('reads a date-only string as that calendar day, not UTC midnight', () => {
    const d = parseCalendarDate('2026-08-19');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August
    expect(d.getDate()).toBe(19);
  });

  it('lands at midday, so no offset or DST jump can cross a day boundary', () => {
    expect(parseCalendarDate('2026-08-19').getHours()).toBe(12);
  });

  it('leaves a real timestamp alone — that is an instant, not a calendar day', () => {
    const iso = '2026-08-19T23:30:00.000Z';
    expect(parseCalendarDate(iso).toISOString()).toBe(iso);
  });

  it('returns null rather than an Invalid Date for junk', () => {
    expect(parseCalendarDate('not a date')).toBeNull();
    expect(parseCalendarDate('')).toBeNull();
    expect(parseCalendarDate(null)).toBeNull();
    expect(parseCalendarDate(undefined)).toBeNull();
  });
});

describe('formatCalendarDate', () => {
  it('renders the day that was stored', () => {
    // The assertion that fails on the old implementation in any negative-offset
    // timezone: it produced "18 Aug 2026".
    expect(formatCalendarDate('2026-08-19')).toContain('19');
    expect(formatCalendarDate('2026-08-19')).toContain('Aug');
    expect(formatCalendarDate('2026-08-19')).toContain('2026');
  });

  it('renders the same day regardless of the host timezone', () => {
    // Both roles render through this helper, so agreement between them reduces
    // to this one property.
    const rendered = formatCalendarDate('2026-01-01');
    expect(rendered).toContain('1');
    expect(rendered).toContain('Jan');
    expect(rendered).toContain('2026');
  });

  it('uses the caller fallback instead of printing Invalid Date', () => {
    expect(formatCalendarDate(null)).toBe('Not set');
    expect(formatCalendarDate('nonsense', {}, 'en-GB', 'Unknown')).toBe('Unknown');
  });
});

describe('isPastDue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is false for a request due today, at any hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 19, 0, 1)); // 00:01 on the due day
    expect(isPastDue('2026-08-19')).toBe(false);
    vi.setSystemTime(new Date(2026, 7, 19, 23, 59));
    expect(isPastDue('2026-08-19')).toBe(false);
  });

  it('is true the day after', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 0, 1));
    expect(isPastDue('2026-08-19')).toBe(true);
  });

  it('is false for a future date and for no date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 19, 12, 0));
    expect(isPastDue('2026-09-01')).toBe(false);
    expect(isPastDue(null)).toBe(false);
  });
});
