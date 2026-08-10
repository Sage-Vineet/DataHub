// Structural guards for the Tax Reconciliation grid's frozen header.
//
// Run: node --test src/pages/broker/workspace/WorkspaceTaxReconciliation.frozenHeader.test.js
//
// WHAT THESE PROTECT
// ──────────────────────────────────────────────────────────────────────────────
// The client asked for two things that pull against each other in CSS:
//
//   (a) the year row and the P&L / Tax Return / TR Variance row stay visible
//       while the page scrolls, and
//   (b) the grid must NOT have a vertical scrollbar of its own.
//
// The only structure that delivers both is: the header rows in their OWN table,
// in an element that is a SIBLING of the horizontally-scrolling body and is
// `position: sticky; top: 0`. Its sticky context is then the layout's <main>
// (`overflow-y-auto` in ClientWorkspaceLayout), i.e. the page scrollbar the user
// already has, while the body keeps `overflow-x-auto` with no height cap so it
// never grows a second scrollbar.
//
// Two regressions are easy to reintroduce and invisible in review, so they are
// asserted here rather than left to memory:
//
//   1. Making the header a sticky <thead> INSIDE the body again. CSS forces
//      `overflow-y` to compute to `auto` whenever `overflow-x` is `auto`, so the
//      body is unavoidably a scroll container on both axes; a `top: 0` inside it
//      resolves against the body's own scrollport, which never scrolls
//      vertically. It silently does nothing.
//   2. Capping the body's height (max-height / maxHeight) to give a sticky
//      <thead> something to stick to. That works, and it is exactly the second
//      scrollbar the client rejected.
//
// These are source-level assertions, the same approach as
// balanceSheetExtractionService.detectedYears.test.js. They verify STRUCTURE, not
// rendered pixels — the visual result still needs a look in the running app.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'WorkspaceTaxReconciliation.jsx');

/**
 * Comments are stripped before any structural assertion. Without this, the very
 * comments that EXPLAIN these invariants ("`overflow-y-auto` in
 * ClientWorkspaceLayout", "relying on a <thead> of its own") match the patterns
 * that are supposed to prove the invariant holds — the test would fail on its own
 * documentation.
 */
function stripComments(text) {
  return text
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ') // JSX {/* … */}
    .replace(/\/\*[\s\S]*?\*\//g, ' ')            // block comments
    .replace(/^[ \t]*\/\/.*$/gm, ' ');            // whole-line // comments
}

/**
 * The `className` of each of the two grid container elements, found by walking
 * back from its `ref={…}` to that element's own opening tag. Scoping assertions
 * to these two elements is what keeps unrelated scrollable popovers elsewhere in
 * the page from reading as a grid scrollbar.
 */
function containerClasses() {
  const classOf = (refName) => {
    const at = src.indexOf(`ref={${refName}}`);
    assert.ok(at > -1, `${refName} must exist`);
    const tagStart = src.lastIndexOf('<div', at);
    const tagEnd = src.indexOf('>', at);
    const tag = src.slice(tagStart, tagEnd);
    const m = tag.match(/className=(?:"([^"]*)"|\{[^}]*"([^"]*)"[^}]*\})/);
    assert.ok(m, `${refName}'s element must carry a className`);
    return m[1] || m[2] || '';
  };
  return { header: classOf('headerScrollRef'), body: classOf('bodyScrollRef') };
}

let src = '';       // comment-stripped whole file
let raw = '';       // verbatim, for asserting the comments themselves exist
let grid = '';      // comment-stripped grid region only
let headerIdx = -1;
let bodyIdx = -1;

before(() => {
  raw = fs.readFileSync(SOURCE, 'utf8');
  src = stripComments(raw);
  headerIdx = src.indexOf('ref={headerScrollRef}');
  bodyIdx = src.indexOf('ref={bodyScrollRef}');

  // The grid region only. The page also renders an unrelated "Add Schedule K
  // Item" dropdown whose own small list is legitimately `max-h-60
  // overflow-y-auto`; scoping keeps that from reading as a grid scrollbar.
  const start = src.indexOf('ref={headerScrollRef}');
  const end = src.indexOf('!isLoading && !hasSourceData');
  assert.ok(start > -1 && end > start, 'the grid region must be locatable');
  grid = src.slice(start, end);
});

describe('the grid never adds a vertical scrollbar of its own', () => {
  test('no height cap anywhere in the component', () => {
    assert.ok(!/maxHeight/.test(src),
      'a maxHeight on the grid brings back the second vertical scrollbar the client rejected');
    assert.ok(!/\bmax-h-\[/.test(src), 'same for a Tailwind max-h-[…] utility');
    assert.ok(!/\bh-\[calc\(100vh/.test(src), 'same for a viewport-height cap');
  });

  test('the scrolling body constrains the HORIZONTAL axis only', () => {
    assert.ok(bodyIdx > -1, 'the body scroller must exist');
    // Assert on the two GRID CONTAINER elements specifically. A region-wide scan
    // would also catch the "Add Schedule K Item" dropdown, whose own small popup
    // list is legitimately `max-h-60 overflow-y-auto` and is not a grid scroller.
    for (const [name, className] of Object.entries(containerClasses())) {
      assert.ok(!/\boverflow-auto\b/.test(className),
        `${name}: overflow-auto would scroll vertically too`);
      assert.ok(!/\boverflow-y-(auto|scroll)\b/.test(className),
        `${name}: the grid must never own the vertical axis — the page does`);
    }
    assert.match(containerClasses().body, /\boverflow-x-auto\b/,
      'the body must scroll horizontally');
    assert.match(containerClasses().header, /\boverflow-hidden\b/,
      'the header is scrolled programmatically, never by the user');
  });
});

describe('the frozen header is a sibling of the body, not a child of it', () => {
  test('both scroll elements exist and the header comes first', () => {
    assert.ok(headerIdx > -1, 'the frozen header element must exist');
    assert.ok(bodyIdx > -1, 'the body scroller must exist');
    assert.ok(headerIdx < bodyIdx, 'the header must be rendered before the body');
  });

  test('the header element closes before the body element opens', () => {
    // If the header were nested inside the body, the body's ref would appear
    // between the header's ref and the header's closing tag.
    const between = src.slice(headerIdx, bodyIdx);
    const opensBody = /className="relative overflow-x-auto"/.test(between);
    assert.equal(opensBody, false,
      'the body scroller must not open before the header block has closed');
    // The header block must contain a complete table of its own.
    assert.ok(/<thead>/.test(between), 'the header block owns the <thead>');
    assert.ok(/<\/table>/.test(between), 'the header block closes its own table');
  });

  test('the header is sticky to the top with no vertical overflow of its own', () => {
    const headerTag = src.slice(headerIdx, headerIdx + 300);
    assert.ok(/sticky top-0/.test(headerTag),
      'the header must be sticky to the page scrollport top');
    assert.ok(/overflow-hidden/.test(headerTag),
      'the header clips horizontally and is scrolled programmatically, never by the user');
  });

  test('the body table has NO thead — the header table is the only one', () => {
    const body = grid.slice(grid.indexOf('ref={bodyScrollRef}'));
    assert.equal(body.indexOf('<thead>'), -1,
      'a <thead> in the body would render a second, non-frozen header row set');
    // Exactly one <thead> in the whole grid, and it is in the header block.
    assert.equal((grid.match(/<thead>/g) || []).length, 1);
  });

  test('the grid renders exactly two tables', () => {
    const tables = grid.match(/<table\b/g) || [];
    assert.equal(tables.length, 2, 'one header table + one body table');
  });

  test('the explanation of WHY the structure is split is kept with the code', () => {
    // This one deliberately reads the verbatim source: the next person to touch
    // this will otherwise "simplify" it straight back into a sticky <thead>.
    assert.ok(/FROZEN HEADER, ONE SCROLLBAR/.test(raw));
    assert.ok(/overflow-y` to compute to\s*\n?\s*`auto`/.test(raw),
      'the CSS reason the naive approach fails must stay documented');
  });
});

describe('the two tables are kept in column lock-step', () => {
  test('both use table-layout: fixed so the colgroup is authoritative', () => {
    const fixed = src.match(/tableLayout: "fixed"/g) || [];
    assert.equal(fixed.length, 2,
      'content-based sizing would let the header and body columns disagree');
  });

  test('both use the same computed minWidth', () => {
    const minWidths = src.match(/minWidth: gridMinWidth/g) || [];
    assert.equal(minWidths.length, 2, 'both tables must share one width');
    assert.ok(/const gridMinWidth = LABEL_COL_WIDTH \+ activeYears\.length \* VALUE_COL_WIDTH \* 3/.test(src),
      'gridMinWidth must be derived from the shared column-width constants');
  });

  test('both colgroups are built from the shared width constants', () => {
    assert.ok(/const LABEL_COL_WIDTH = \d+/.test(src));
    assert.ok(/const VALUE_COL_WIDTH = \d+/.test(src));
    const labelCols = src.match(/\$\{LABEL_COL_WIDTH\}px/g) || [];
    const valueCols = src.match(/\$\{VALUE_COL_WIDTH\}px/g) || [];
    assert.equal(labelCols.length, 2, 'one label col per table');
    assert.equal(valueCols.length, 6, 'three value cols per year group, per table');
    // No stray hardcoded widths that could drift from the constants.
    assert.ok(!/width: "260px"/.test(src) && !/width: "110px"/.test(src),
      'column widths must come from the constants, not literals');
  });

  test('horizontal scroll is mirrored from the body onto the header', () => {
    assert.ok(/onScroll=\{syncHeaderScroll\}/.test(src), 'the body must drive the sync');
    assert.ok(/header\.scrollLeft = body\.scrollLeft/.test(src),
      'the header follows the body, never the reverse');
    assert.ok(/const syncHeaderScroll = useCallback\(/.test(src),
      'the handler must be stable so it is not re-bound every render');
    // Re-sync after a column-set change, where the browser can clamp scrollLeft
    // without firing a scroll event.
    assert.ok(/syncHeaderScroll\(\);\s*\n\s*\}, \[activeYears, syncHeaderScroll\]\)/.test(src),
      'the header must be re-synced when the year columns change');
  });
});

describe('the frozen label column survives', () => {
  test('the label column is sticky on the axis the grid actually scrolls', () => {
    assert.ok(/const LABEL_CELL = "sticky left-0/.test(src));
    assert.ok(/const LABEL_CELL_TINT = "sticky left-0/.test(src));
    // And in the header table's own Source cell.
    const headerBlock = src.slice(headerIdx, bodyIdx);
    assert.ok(/sticky left-0 z-40/.test(headerBlock),
      'the header\'s Source cell must freeze horizontally too');
  });

  test('the header paints above the sticky body labels', () => {
    const headerTag = src.slice(headerIdx, headerIdx + 300);
    const headerZ = Number((headerTag.match(/z-(\d+)/) || [])[1]);
    const labelZ = Number((src.match(/const LABEL_CELL = "sticky left-0 z-(\d+)/) || [])[1]);
    assert.ok(Number.isFinite(headerZ) && Number.isFinite(labelZ));
    assert.ok(headerZ > labelZ,
      `header z-${headerZ} must sit above the sticky row labels z-${labelZ} so rows scroll behind it`);
  });
});
