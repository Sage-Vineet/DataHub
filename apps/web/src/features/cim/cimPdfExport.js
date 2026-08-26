import { jsPDF } from 'jspdf';

/**
 * Render a CIM to PDF.
 *
 * Text primitives throughout, not a rasterised screenshot. `CM - 0001` requires a
 * cover, a table of contents, page numbers, a footer and a confidentiality
 * legend on every page, and all five are text — drawing them as text keeps them
 * crisp at any zoom, keeps the output selectable and searchable, and produces a
 * file measured in kilobytes rather than megabytes.
 *
 * It also removes the single biggest risk in this path. The obvious approach —
 * html2canvas over the on-screen deck — is slow (hundreds of milliseconds per
 * slide), unreliable on iPad Safari, and memory-hungry on exactly the device
 * least able to spare it. A narrative CIM is text; rasterising text to draw it is
 * work done to make the result worse.
 *
 * What this deliberately does not do is lay out the 38 branded slide templates.
 * Those live in the existing CIM Prep screen and its .pptx writer. This produces
 * the narrative document, which is what the builder holds.
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, in points
const MARGIN = { top: 72, bottom: 64, left: 64, right: 64 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const NAVY = [5, 22, 77];
const INK = [17, 24, 39];
const MUTED = [107, 114, 128];
const RULE = [229, 231, 235];

const LEGEND =
  'Confidential. This document is provided on the terms of the confidentiality ' +
  'agreement under which it was received and may not be reproduced or distributed.';

function text(doc, value, x, y, opts = {}) {
  doc.setFont('helvetica', opts.style || 'normal');
  doc.setFontSize(opts.size || 11);
  doc.setTextColor(...(opts.color || INK));
  doc.text(value, x, y, opts.align ? { align: opts.align } : undefined);
}

/**
 * Cover page.
 *
 * Draft exports carry a watermark on every page — `CM - 0001` requires that
 * anything not yet published announce itself, because the failure it prevents is
 * a draft circulating as though it were final.
 */
function drawCover(doc, { deckName, cover, versionNo, status }) {
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE.width, 220, 'F');

  text(doc, String(cover.company_name || deckName), MARGIN.left, 120, {
    size: 26,
    style: 'bold',
    color: [255, 255, 255],
  });
  if (cover.sector) {
    text(doc, String(cover.sector), MARGIN.left, 150, { size: 13, color: [200, 214, 255] });
  }

  text(doc, 'Confidential Information Memorandum', MARGIN.left, 300, {
    size: 16,
    style: 'bold',
    color: NAVY,
  });
  text(doc, `Version ${versionNo} · ${status.replace(/_/g, ' ')}`, MARGIN.left, 322, {
    size: 10,
    color: MUTED,
  });
  text(
    doc,
    `Prepared ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`,
    MARGIN.left,
    340,
    { size: 10, color: MUTED },
  );
  if (cover.prepared_by) {
    text(doc, `by ${cover.prepared_by}`, MARGIN.left, 358, { size: 10, color: MUTED });
  }

  const legend = doc.splitTextToSize(LEGEND, CONTENT_WIDTH);
  text(doc, legend, MARGIN.left, PAGE.height - 120, { size: 8, color: MUTED });
}

/** Page furniture, applied to every page except the cover. */
function drawFurniture(doc, pageNumber, deckName, isDraft) {
  doc.setDrawColor(...RULE);
  doc.line(MARGIN.left, PAGE.height - 48, PAGE.width - MARGIN.right, PAGE.height - 48);
  text(doc, deckName, MARGIN.left, PAGE.height - 32, { size: 8, color: MUTED });
  text(doc, String(pageNumber), PAGE.width - MARGIN.right, PAGE.height - 32, {
    size: 8,
    color: MUTED,
    align: 'right',
  });
  text(doc, 'Confidential', PAGE.width / 2, PAGE.height - 32, {
    size: 8,
    color: MUTED,
    align: 'center',
  });

  if (isDraft) {
    // Faint, rotated, and on every page: a draft that escapes should say so
    // wherever the reader happens to be looking.
    doc.saveGraphicsState();
    doc.setGState(new doc.GState({ opacity: 0.1 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(46);
    doc.setTextColor(...NAVY);
    doc.text('DRAFT — NOT FOR DISTRIBUTION', PAGE.width / 2, PAGE.height / 2, {
      align: 'center',
      angle: 32,
    });
    doc.restoreGraphicsState();
  }
}

/** What a section contributes to the document: its heading and its written blocks. */
function sectionContent(section) {
  const blocks = section.slides
    .flatMap((slide) => slide.blocks)
    .filter((block) => typeof block.content === 'string' && block.content.trim().length > 0);
  return { title: section.title, blocks };
}

export function buildCimPdf({ deckName, cover = {}, versionNo, status, sections }) {
  const isDraft = status !== 'published';
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  drawCover(doc, { deckName, cover, versionNo, status });

  // Sections with nothing written are omitted from both the contents and the
  // body: a heading over a blank page tells a buyer the deck is unfinished more
  // loudly than the missing section would have.
  const written = sections.map(sectionContent).filter((s) => s.blocks.length > 0);

  doc.addPage();
  let page = 2;
  drawFurniture(doc, page, deckName, isDraft);
  text(doc, 'Contents', MARGIN.left, MARGIN.top, { size: 18, style: 'bold', color: NAVY });

  let y = MARGIN.top + 34;
  const contentsAt = [];
  written.forEach((section, index) => {
    contentsAt.push({ title: section.title, y });
    text(doc, `${String(index + 1).padStart(2, '0')}   ${section.title}`, MARGIN.left, y, {
      size: 11,
    });
    y += 22;
  });

  const pageNumbers = [];
  for (const section of written) {
    doc.addPage();
    page += 1;
    pageNumbers.push(page);
    drawFurniture(doc, page, deckName, isDraft);

    let cursor = MARGIN.top;
    text(doc, section.title, MARGIN.left, cursor, { size: 18, style: 'bold', color: NAVY });
    cursor += 12;
    doc.setDrawColor(...NAVY);
    doc.line(MARGIN.left, cursor, MARGIN.left + 48, cursor);
    cursor += 28;

    for (const block of section.blocks) {
      if (block.label) {
        const label = doc.splitTextToSize(block.label, CONTENT_WIDTH);
        // A new heading with no room for its own body belongs on the next page,
        // not stranded at the bottom of this one.
        if (cursor + label.length * 13 + 40 > PAGE.height - MARGIN.bottom) {
          doc.addPage();
          page += 1;
          drawFurniture(doc, page, deckName, isDraft);
          cursor = MARGIN.top;
        }
        text(doc, label, MARGIN.left, cursor, { size: 10, style: 'bold', color: MUTED });
        cursor += label.length * 13 + 4;
      }

      const body = doc.splitTextToSize(String(block.content).trim(), CONTENT_WIDTH);
      for (const line of body) {
        if (cursor > PAGE.height - MARGIN.bottom) {
          doc.addPage();
          page += 1;
          drawFurniture(doc, page, deckName, isDraft);
          cursor = MARGIN.top;
        }
        text(doc, line, MARGIN.left, cursor, { size: 11 });
        cursor += 15;
      }
      cursor += 16;
    }
  }

  // Page numbers are only known once the body has been laid out, so the contents
  // are completed afterwards rather than guessed at.
  doc.setPage(2);
  contentsAt.forEach((entry, index) => {
    text(doc, String(pageNumbers[index] ?? ''), PAGE.width - MARGIN.right, entry.y, {
      size: 11,
      color: MUTED,
      align: 'right',
    });
  });

  return { blob: doc.output('blob'), pageCount: page };
}

export default buildCimPdf;
