import { describe, expect, it } from 'vitest';
import { buildCimPdf } from './cimPdfExport';

/**
 * The CIM renderer.
 *
 * Testable because it is text primitives rather than a screenshot of the DOM —
 * which is most of the reason it was built that way. A rasterising renderer
 * could only have been checked by eye.
 */

const block = (label, content) => ({ id: label, label, content });

const section = (title, blocks) => ({
  id: title,
  section_key: title.toLowerCase().replace(/\s+/g, '-'),
  title,
  sort_order: 1,
  slides: [{ id: `${title}-s`, blocks }],
});

const base = {
  deckName: 'Project Atlas CIM',
  cover: { company_name: 'Project Atlas', sector: 'Manufacturing' },
  versionNo: 1,
  status: 'draft',
  sections: [
    section('Executive Summary', [block('What is this business?', 'A fastener manufacturer.')]),
  ],
};

/** jsPDF blobs are binary; the text stream is readable enough to assert on. */
async function asText(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return new TextDecoder('latin1').decode(buf);
}

describe('buildCimPdf', () => {
  it('produces a PDF', async () => {
    const { blob } = buildCimPdf(base);

    expect(blob.size).toBeGreaterThan(0);
    expect(await asText(blob)).toMatch(/^%PDF-/);
  });

  it('counts the pages it produced, so the server can record them', () => {
    const { pageCount } = buildCimPdf(base);

    // Cover, contents, and one section.
    expect(pageCount).toBe(3);
  });

  it('adds a page per written section', () => {
    const many = {
      ...base,
      sections: [
        section('One', [block('a', 'x')]),
        section('Two', [block('b', 'y')]),
        section('Three', [block('c', 'z')]),
      ],
    };

    expect(buildCimPdf(many).pageCount).toBe(5);
  });

  it('omits a section with nothing written', () => {
    // A heading over a blank page tells a buyer the deck is unfinished more
    // loudly than the missing section would have.
    const partial = {
      ...base,
      sections: [
        section('Written', [block('a', 'has content')]),
        section('Empty', [block('b', ''), block('c', '   ')]),
      ],
    };

    expect(buildCimPdf(partial).pageCount).toBe(3);
  });

  it('treats whitespace as unwritten', () => {
    const blank = { ...base, sections: [section('Blank', [block('a', '\n  \t ')])] };

    // Cover and contents only.
    expect(buildCimPdf(blank).pageCount).toBe(2);
  });

  it('watermarks a draft', async () => {
    const text = await asText(buildCimPdf({ ...base, status: 'draft' }).blob);

    expect(text).toContain('DRAFT');
  });

  it('does not watermark a published version', async () => {
    const text = await asText(buildCimPdf({ ...base, status: 'published' }).blob);

    expect(text).not.toContain('DRAFT');
  });

  it('carries the confidentiality legend', async () => {
    const text = await asText(buildCimPdf(base).blob);

    expect(text).toContain('Confidential');
  });

  it('survives a section with no cover fields', () => {
    expect(() => buildCimPdf({ ...base, cover: {} })).not.toThrow();
  });

  it('wraps long prose rather than overflowing the page', () => {
    const long = {
      ...base,
      sections: [section('Long', [block('a', 'word '.repeat(3000))])],
    };

    // Thousands of words cannot fit on one page; if the count were 3 the text
    // would be running off the bottom rather than flowing.
    expect(buildCimPdf(long).pageCount).toBeGreaterThan(4);
  });

  it('keeps the output small, because it is text rather than images', async () => {
    const { blob } = buildCimPdf(base);

    // A rasterised equivalent is megabytes; this is the difference that makes it
    // fast enough to render on a tablet.
    expect(blob.size).toBeLessThan(200 * 1024);
  });
});
