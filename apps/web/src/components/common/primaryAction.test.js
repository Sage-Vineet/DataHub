import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One primary action colour, enforced by reading the source.
 *
 * The audit found four different colours all used as the primary action —
 * green, navy, orange and blue — with the Deal Team page putting three filled
 * accent buttons on one small screen, none of which was the main thing to do.
 * The design-system baseline already required the primary token (#8BC53D); the
 * app simply did not follow it.
 *
 * This is a source scan rather than a rendering test because the violation is a
 * literal in a className, and this package has no DOM to render into. It is
 * deliberately narrow: it bans the specific competing accents that were being
 * used as filled primaries, and says nothing about the many legitimate uses of
 * colour for status, identity, and semantic meaning.
 */

const SRC = new URL('../../', import.meta.url).pathname;

/** Filled backgrounds that were standing in for the primary action. */
const BANNED = [
  { pattern: /bg-blue-600/, why: 'blue was used as a fourth primary — use the primary token' },
  { pattern: /bg-blue-700(?!.*hover)/, why: 'blue was used as a fourth primary' },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|tsx?)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

describe('primary action colour', () => {
  const files = walk(SRC);

  it('finds source to scan (guards against a broken glob silently passing)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(BANNED)('never uses $pattern as a filled button background', ({ pattern, why }) => {
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC, ''));
    expect(offenders, `${why}. Offending files:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('does not paint a filled button from a per-card accent variable', () => {
    // `style={{ background: color }}` on a button is how the Deal Team page ended
    // up with an orange primary next to a navy one: the card's identity colour
    // was driving a filled action. Identity belongs on the border and the text.
    const offenders = files
      .filter((f) => /<button[^>]*style=\{\{\s*background:\s*color\s*\}\}/s.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC, ''));
    expect(offenders).toEqual([]);
  });
});
