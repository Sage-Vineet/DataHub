import { describe, expect, it } from 'vitest';
import { plural } from './plural';

/**
 * The product rendered "1 requests", "1 items" and "1 request(s)" — three ways
 * of not making the noun agree. The last is the worst: `(s)` is visible on every
 * row, including the ones where it is simply wrong.
 */
describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'request')).toBe('1 request');
    expect(plural(1, 'item')).toBe('1 item');
  });

  it('uses the plural for zero and for many', () => {
    expect(plural(0, 'request')).toBe('0 requests');
    expect(plural(2, 'request')).toBe('2 requests');
    expect(plural(11, 'item')).toBe('11 items');
  });

  it('accepts an irregular plural', () => {
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(3, 'person', 'people')).toBe('3 people');
  });

  it('treats a missing or non-numeric count as zero rather than printing NaN', () => {
    expect(plural(undefined, 'item')).toBe('0 items');
    expect(plural(null, 'item')).toBe('0 items');
    expect(plural('x', 'item')).toBe('0 items');
  });
});
