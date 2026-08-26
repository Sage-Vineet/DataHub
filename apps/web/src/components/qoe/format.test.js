import { describe, expect, it } from 'vitest';
import { footedSubtotal, money } from './format';

/**
 * The engine is exact; presentation rounds to whole dollars. Rounding each
 * figure independently can leave a column not footing — FY2023's components
 * round to 715,930 while its true subtotal 715,929.37 rounds to 715,929. A
 * broker adding the column up finds a dollar missing, and a quality-of-earnings
 * bridge that does not foot is a credibility problem out of all proportion to
 * the amount.
 */
describe('footedSubtotal', () => {
  it('foots the FY2023 column that previously drifted by a dollar', () => {
    const components = [104079.12, 85991.69, -1679.44, 527538];
    const exactSubtotal = 715929.37;

    // The defect: rounding the exact subtotal disagrees with the rounded parts.
    expect(Math.round(exactSubtotal)).toBe(715929);
    expect(footedSubtotal(components)).toBe(715930);

    // What the reader can now verify by adding up the displayed column.
    const displayedParts = components.map((v) => Math.round(v));
    expect(displayedParts.reduce((a, b) => a + b, 0)).toBe(footedSubtotal(components));
  });

  it('agrees with the exact subtotal when no rounding drift exists', () => {
    for (const [components, exact] of [
      [[115896.38, 51109.26, -1019.45, 650875], 816861.19],
      [[47568.23, 87176.03, -5115.91, 217775], 347403.35],
      [[169495.9, 77233.2, -11992.05, 69687], 304424.05],
    ]) {
      expect(footedSubtotal(components)).toBe(Math.round(exact));
    }
  });

  it('ignores values that are not finite rather than producing NaN', () => {
    expect(footedSubtotal([100.4, undefined, null, 'x', 50.4])).toBe(150);
  });

  it('is zero for an empty or missing column', () => {
    expect(footedSubtotal([])).toBe(0);
    expect(footedSubtotal(undefined)).toBe(0);
  });
});

describe('money', () => {
  it('renders negatives in parentheses and zero as an em dash', () => {
    expect(money(-11992.05)).toBe('($11,992)');
    expect(money(0)).toBe('—');
    expect(money(304424.05)).toBe('$304,424');
  });
});
