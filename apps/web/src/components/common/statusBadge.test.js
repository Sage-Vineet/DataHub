import { describe, expect, it } from 'vitest';
import { resolveBadge } from './StatusBadge.jsx';

/**
 * The defect this pins: the badge fell back to `statusConfig.pending` for any
 * value it did not recognise, and the request statuses `in-review`,
 * `completed`, `blocked` and `overdue` were all missing from the config.
 *
 * So the broker's Deal Tracker rendered six requests as "Pending" while one was
 * overdue, one blocked, one in review and one completed — and the requests
 * table, which formatted its own badges, showed the truth. Two screens, same six
 * rows, different answers.
 */
describe('resolveBadge — request workflow statuses', () => {
  it.each([
    ['pending', 'Pending'],
    ['in-review', 'In Review'],
    ['in_review', 'In Review'],
    ['completed', 'Completed'],
    ['blocked', 'Blocked'],
    ['overdue', 'Overdue'],
  ])('resolves %s to %s', (value, label) => {
    const badge = resolveBadge(value);
    expect(badge.label).toBe(label);
    expect(badge.known).toBe(true);
  });

  it('never renders a non-pending status as Pending', () => {
    for (const value of ['in-review', 'completed', 'blocked', 'overdue']) {
      expect(resolveBadge(value).label).not.toBe('Pending');
    }
  });

  it('gives overdue and blocked a negative treatment, not a neutral one', () => {
    for (const value of ['overdue', 'blocked']) {
      expect(resolveBadge(value).text).toContain('negative');
    }
  });

  it('gives completed a positive treatment', () => {
    expect(resolveBadge('completed').text).toContain('green');
  });
});

describe('resolveBadge — unknown values', () => {
  it('shows the value itself rather than impersonating a known status', () => {
    const badge = resolveBadge('awaiting_counsel');
    expect(badge.label).toBe('Awaiting Counsel');
    expect(badge.known).toBe(false);
  });

  it('reports that it did not recognise the value, so callers can flag it', () => {
    expect(resolveBadge('zzz').known).toBe(false);
    expect(resolveBadge('pending').known).toBe(true);
  });

  it('renders a dash for a missing value instead of inventing a status', () => {
    for (const missing of [undefined, null, '']) {
      const badge = resolveBadge(missing);
      expect(badge.label).toBe('—');
      expect(badge.known).toBe(false);
    }
  });
});

describe('resolveBadge — priority', () => {
  it.each([
    ['critical', 'Critical'],
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ])('resolves %s priority to %s', (value, label) => {
    expect(resolveBadge(value, 'priority').label).toBe(label);
  });

  it('does not silently downgrade an unknown priority to Low', () => {
    const badge = resolveBadge('blocker', 'priority');
    expect(badge.label).not.toBe('Low');
    expect(badge.known).toBe(false);
  });

  it('keeps the two vocabularies separate', () => {
    // "high" is a priority, not a status — asking for it as a status must not
    // silently succeed against the priority table.
    expect(resolveBadge('high', 'status').known).toBe(false);
  });
});
