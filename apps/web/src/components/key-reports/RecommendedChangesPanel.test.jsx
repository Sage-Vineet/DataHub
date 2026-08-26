// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RecommendedChangesPanel from './RecommendedChangesPanel';

/**
 * The review panel.
 *
 * Mostly presentation, with two pieces of behaviour that are worth pinning
 * because getting them wrong is invisible in a screenshot: the bulk actions run
 * SEQUENTIALLY — `decidingId` is a single scalar and each call refetches, so
 * firing them concurrently would thrash the indicator and cause N overlapping
 * loads — and rejecting is two-step, so a misclick cannot silently discard a
 * recommendation.
 */

afterEach(cleanup);

const reco = (over = {}) => ({
  id: 'r1',
  accountId: 'acc-1',
  accountName: 'Interest Income',
  accountNumber: '4100',
  status: 'PENDING',
  confidenceBand: 'HIGH',
  kind: 'HIERARCHY_MOVE',
  source: 'DOCUMENT_MATCH',
  impact: 'OPERATING_RESULT',
  reason: 'Interest income is non-operating.',
  currentHierarchy: ['Net Income', 'Income', 'Interest Income'],
  recommendedHierarchy: ['Net Income', 'Other Income', 'Interest Income'],
  ...over,
});

/** A `useHierarchyRecommendations` result, with the parts the panel reads. */
function stubRec(recommendations, over = {}) {
  const pending = recommendations.filter((r) => r.status === 'PENDING');
  return {
    recommendations,
    pending,
    loading: false,
    decidingId: null,
    accept: vi.fn().mockResolvedValue(true),
    ignore: vi.fn().mockResolvedValue(true),
    byConfidence: {
      HIGH: pending.filter((r) => r.confidenceBand === 'HIGH'),
      MEDIUM: pending.filter((r) => r.confidenceBand === 'MEDIUM'),
      LOW: pending.filter((r) => r.confidenceBand === 'LOW'),
    },
    ...over,
  };
}

const open = (rec, extra = {}) =>
  render(
    <RecommendedChangesPanel isOpen onClose={vi.fn()} rec={rec} confirm={() => true} {...extra} />,
  );

describe('rendering', () => {
  it('shows the account, both hierarchies, and why it matters', () => {
    open(stubRec([reco()]));

    expect(screen.getByText('Interest Income')).toBeTruthy();
    expect(screen.getByText(/Net Income › Income › Interest Income/)).toBeTruthy();
    expect(screen.getByText(/Net Income › Other Income › Interest Income/)).toBeTruthy();
    // The impact is spelled out — "OPERATING_RESULT" tells a reviewer nothing.
    expect(screen.getByText(/Affects Operating Income/)).toBeTruthy();
    expect(screen.getByText('Interest income is non-operating.')).toBeTruthy();
  });

  it('distinguishes a matched section from a derived one', () => {
    // The reviewer needs to know when the target came from the company's own
    // documents versus when it was invented for them.
    open(stubRec([reco({ source: 'DOCUMENT_MATCH' })]));
    expect(screen.getByText(/From document/)).toBeTruthy();

    cleanup();
    open(stubRec([reco({ source: 'AI_REASONABLENESS' })]));
    expect(screen.getByText('AI-derived')).toBeTruthy();
  });

  it('flags a reclassification and shows the type change', () => {
    open(
      stubRec([
        reco({
          kind: 'RECLASSIFY',
          currentAccountType: 'income',
          recommendedAccountType: 'equity',
        }),
      ]),
    );

    expect(screen.getByText(/Reclassification/)).toBeTruthy();
    expect(screen.getByText(/equity/)).toBeTruthy();
  });

  it('groups by confidence band, most confident first', () => {
    open(
      stubRec([
        reco({ id: 'l', confidenceBand: 'LOW', accountName: 'Low one' }),
        reco({ id: 'h', confidenceBand: 'HIGH', accountName: 'High one' }),
      ]),
    );

    // Anchored, or it also matches the "Accept all high confidence (n)" button.
    const headings = screen
      .getAllByText(/^(HIGH|MEDIUM|LOW) confidence \(\d\)$/)
      .map((n) => n.textContent);
    expect(headings[0]).toMatch(/HIGH/);
    expect(headings[1]).toMatch(/LOW/);
  });

  it('says so plainly when there is nothing to review', () => {
    open(stubRec([]));
    expect(screen.getByText(/No classifications need review/)).toBeTruthy();
    expect(screen.getByText(/looks reasonable/)).toBeTruthy();
  });

  it('shows a loading state rather than an empty one', () => {
    // An empty list and a list that has not arrived say opposite things.
    open(stubRec([], { loading: true }));
    expect(screen.getByText(/Loading/)).toBeTruthy();
    expect(screen.queryByText(/looks reasonable/)).toBeNull();
  });

  it('renders an em dash for a missing hierarchy rather than crashing', () => {
    open(stubRec([reco({ recommendedHierarchy: null })]));
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('accepting', () => {
  it('applies the recommendation', () => {
    const rec = stubRec([reco()]);
    open(rec);

    fireEvent.click(screen.getByTitle(/Apply this recommendation/));

    expect(rec.accept).toHaveBeenCalledWith('r1');
  });

  it('disables both actions while a decision is in flight', () => {
    const rec = stubRec([reco()], { decidingId: 'r1' });
    open(rec);

    expect(screen.getByTitle(/Apply this recommendation/).disabled).toBe(true);
    expect(screen.getByTitle(/Leave the Chart of Accounts unchanged/).disabled).toBe(true);
  });
});

describe('rejecting', () => {
  it('takes two steps, so a misclick cannot discard a recommendation', () => {
    const rec = stubRec([reco()]);
    open(rec);

    fireEvent.click(screen.getByTitle(/Leave the Chart of Accounts unchanged/));
    expect(rec.ignore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Confirm reject'));
    expect(rec.ignore).toHaveBeenCalledWith('r1', null);
  });

  it('passes a trimmed reason, and null when it is blank', async () => {
    const rec = stubRec([reco()]);
    open(rec);
    fireEvent.click(screen.getByTitle(/Leave the Chart of Accounts unchanged/));

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  intentional  ' } });
    fireEvent.click(screen.getByText('Confirm reject'));

    await waitFor(() => expect(rec.ignore).toHaveBeenCalledWith('r1', 'intentional'));
  });

  it('can be cancelled without deciding anything', () => {
    const rec = stubRec([reco()]);
    open(rec);

    fireEvent.click(screen.getByTitle(/Leave the Chart of Accounts unchanged/));
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText('Confirm reject')).toBeNull();
    expect(rec.ignore).not.toHaveBeenCalled();
  });
});

describe('bulk actions', () => {
  const two = [
    reco({ id: 'h1', accountName: 'One' }),
    reco({ id: 'h2', accountName: 'Two' }),
  ];

  it('accepts every high-confidence recommendation, one at a time', async () => {
    // Sequential is the point: `decidingId` is one scalar and each accept
    // refetches, so concurrency would thrash the indicator and stack up loads.
    const order = [];
    const rec = stubRec(two, {
      accept: vi.fn(async (id) => {
        order.push(`start:${id}`);
        await Promise.resolve();
        order.push(`end:${id}`);
        return true;
      }),
    });
    open(rec);

    fireEvent.click(screen.getByText(/Accept all high confidence \(2\)/));

    await waitFor(() => expect(rec.accept).toHaveBeenCalledTimes(2));
    expect(order).toEqual(['start:h1', 'end:h1', 'start:h2', 'end:h2']);
  });

  it('asks before acting, and does nothing when refused', () => {
    const rec = stubRec(two);
    render(
      <RecommendedChangesPanel isOpen onClose={vi.fn()} rec={rec} confirm={() => false} />,
    );

    fireEvent.click(screen.getByText(/Accept all high confidence/));

    expect(rec.accept).not.toHaveBeenCalled();
  });

  it('rejects every pending recommendation, not just the confident ones', async () => {
    const rec = stubRec([...two, reco({ id: 'l1', confidenceBand: 'LOW' })]);
    open(rec);

    fireEvent.click(screen.getByText(/Reject all/));

    await waitFor(() => expect(rec.ignore).toHaveBeenCalledTimes(3));
  });

  it('offers no bulk action when there is nothing high-confidence to accept', () => {
    const rec = stubRec([reco({ confidenceBand: 'LOW' })]);
    open(rec);
    expect(screen.getByText(/Accept all high confidence \(0\)/).disabled).toBe(true);
  });

  it('hides the bulk actions entirely when the queue is empty', () => {
    open(stubRec([]));
    expect(screen.queryByText(/Accept all high confidence/)).toBeNull();
  });
});
