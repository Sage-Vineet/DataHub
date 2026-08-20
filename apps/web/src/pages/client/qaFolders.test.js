import { describe, expect, it } from 'vitest';
import { defaultFolderFor, flattenFolders } from './qaFolders';

/**
 * The seller's folder picker, tested against the payload the server actually
 * sends. `listFolderTree` ends in `.then(ensureArray)`, so it resolves to an
 * ARRAY of roots whose nodes carry no `type` field — a fixture invented from the
 * component's point of view would have hidden both facts, and an empty picker
 * fails silently: no folder_id means the attach is skipped, not reported.
 */
const TREE = [
  { id: 'f-fin', name: 'Financials', children: [{ id: 'f-tax', name: 'Tax Returns', children: [] }] },
  { id: 'f-legal', name: 'Legal', children: [] },
];

describe('flattenFolders', () => {
  it('flattens an array of roots, indenting by depth', () => {
    expect(flattenFolders(TREE)).toEqual([
      { id: 'f-fin', name: 'Financials', depth: 0 },
      { id: 'f-tax', name: 'Tax Returns', depth: 1 },
      { id: 'f-legal', name: 'Legal', depth: 0 },
    ]);
  });

  it('survives the empty and missing cases the first render sees', () => {
    expect(flattenFolders([])).toEqual([]);
    expect(flattenFolders(undefined)).toEqual([]);
  });
});

describe('defaultFolderFor', () => {
  const folders = flattenFolders(TREE);

  // The live category vocabulary, from GET /qa/companies/:id/categories.
  it.each([
    ['Legal', 'f-legal'],
    ['Finance', 'f-fin'], // "Finance" the category vs "Financials" the folder
    ['Tax', 'f-tax'], // "Tax" vs "Tax Returns"
    ['M&A', 'f-legal'], // punctuation stripped before the synonym lookup
  ])('points %s at the right folder', (label, expected) => {
    expect(defaultFolderFor(label, folders)).toBe(expected);
  });

  // Never blank: folder_id is required by the contract, so an unmatched category
  // must still choose something rather than leave the seller a broken submit.
  it.each([['HR'], ['Compliance'], [null], [undefined], ['']])(
    'falls back to the first folder for %s',
    (label) => {
      expect(defaultFolderFor(label, folders)).toBe('f-fin');
    },
  );

  it('returns empty only when there are genuinely no folders', () => {
    expect(defaultFolderFor('Legal', [])).toBe('');
  });
});
