#!/usr/bin/env node
/**
 * Seed a CIM that looks like work in progress.
 *
 * Two versions per demo company: v1 already published, with a real PDF sitting
 * in the data room, and v2 an open draft about 60% filled. That shape matters
 * more than it looks — the end state of the demo (a published CIM you can open
 * from the data room) exists before anyone touches the machine, so nothing about
 * the story depends on a live render succeeding on conference wifi.
 *
 * Idempotent: re-running replaces the seeded decks rather than accumulating.
 *
 *   DATABASE_URL=... node tools/demo/seed-cim.mjs
 */
import { createHash } from "node:crypto";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("seed-cim: DATABASE_URL is required");
  process.exit(1);
}

const ACME = "a0000000-0000-4000-8000-000000000001";
const BROKER = "b0000000-0000-4000-8000-000000000002";
const SELLER = "b0000000-0000-4000-8000-000000000003";

/**
 * The outline the API creates for a new deck, mirrored here.
 *
 * Fourteen slides rather than the full thirty-eight: a shorter deck renders
 * faster, reads better on a tablet, and is a better demo. The section keys match
 * `apps/api/src/modules/cim/outline.ts`.
 */
const OUTLINE = [
  ["executive-summary", "Executive Summary", "source-slide-02", 2, [
    ["2:headline", "In one sentence, what is this business?",
     "A precision fastener manufacturer serving aerospace and industrial OEMs since 1987."],
    ["2:investment_highlights", "What are the three strongest reasons to buy it?",
     "Thirty-eight year operating history, 71% of revenue under multi-year contract, and a replacement cost of tooling well above the asking price."],
    ["2:transaction_rationale", "Why is the owner selling now?", null],
  ]],
  ["business-overview", "Business Overview", "source-slide-04", 4, [
    ["4:history", "When was the company founded, and how has it evolved?",
     "Founded 1987 as a two-press job shop; moved into aerospace-qualified work in 2004 and has run AS9100 certification since 2009."],
    ["4:what_we_do", "What does the business actually do, day to day?",
     "Cold-forms and machines fasteners to customer drawings, in runs of 5,000 to 400,000, with in-house heat treat and plating."],
    ["4:differentiation", "What can this business do that competitors cannot?", null],
  ]],
  ["products-services", "Products & Services", "source-slide-07", 7, [
    ["7:product_lines", "What are the main product or service lines?",
     "Threaded fasteners (62% of revenue), precision-machined components (28%), and contract heat treat (10%)."],
    ["7:pricing_model", "How is the work priced and billed?", null],
    ["7:recurring_revenue", "How much of the revenue recurs, and under what terms?", null],
  ]],
  ["market-competition", "Market & Competition", "source-slide-10", 10, [
    ["10:market_size", "How large is the addressable market, and how fast is it growing?", null],
    ["10:competitors", "Who are the main competitors, and how do you win against them?",
     "Three regional shops of similar size. We win on lead time and on holding AS9100, which two of them do not."],
    ["10:barriers", "What makes it hard for a new entrant to take this business?", null],
  ]],
  ["customers", "Customers", "source-slide-13", 13, [
    ["13:customer_profile", "Who buys from you, and why do they choose you?",
     "Tier-two aerospace suppliers and industrial OEMs, mostly within a day's freight."],
    ["13:concentration_commentary", "How would you explain the customer concentration?", null],
    ["13:retention", "How long does a typical customer stay, and why do any leave?", null],
  ]],
  ["operations", "Operations & Facilities", "source-slide-16", 16, [
    ["16:facilities", "What facilities does the business operate from?",
     "One 44,000 sq ft leased facility, Unit 4, with a renewal option running to 2034."],
    ["16:supply_chain", "Who are the critical suppliers, and how replaceable are they?", null],
    ["16:systems", "What systems and technology does the business run on?", null],
  ]],
  ["management", "Management & Employees", "source-slide-19", 19, [
    ["19:leadership", "Who runs the business, and what does each of them own?",
     "Owner-operator plus a plant manager of eleven years and a quality lead of six."],
    ["19:owner_dependence", "What happens to the business the day the owner leaves?", null],
    ["19:headcount", "How is the workforce made up, and how is turnover?", null],
  ]],
  ["growth", "Growth Opportunities", "source-slide-22", 22, [
    ["22:organic_growth", "What could a new owner grow without spending capital?", null],
    ["22:investment_growth", "What would you do with capital you have not had?",
     "A second cold-former would take us from one shift to two on the highest-margin line."],
    ["22:adjacencies", "What adjacent markets or products are within reach?", null],
  ]],
  ["financial-summary", "Financial Summary", "source-slide-25", 25, [
    ["25:performance_commentary", "How would you explain the last three years of results?",
     "Revenue grew each year to FY2024; margin dipped in FY2023 on a tooling write-off that does not recur."],
    ["25:addback_rationale", "What costs would not continue under a new owner?", null],
  ]],
  ["transaction", "Transaction Overview", "source-slide-28", 28, [
    ["28:structure", "What transaction structure is the seller looking for?", null],
    ["28:transition", "What transition support is the owner willing to provide?",
     "Twelve months, full time for the first three."],
  ]],
  ["appendix", "Appendix", "source-slide-31", 31, [
    ["31:notes", "Anything else a buyer should know?", null],
  ]],
];

/**
 * A small but structurally valid PDF.
 *
 * A real file rather than a placeholder string, so the data room's preview opens
 * it and the demo's end state is genuinely reachable.
 */
function demoPdf(title) {
  const content = `BT /F1 24 Tf 72 700 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  await client.query("BEGIN");

  // Idempotent by replacement: cascades clear versions, slides, blocks and the
  // publication record, so a re-run leaves exactly one seeded deck.
  await client.query("DELETE FROM cim_decks WHERE company_id = $1", [ACME]);

  // ...but the published PDF this script writes into the DATA ROOM is a plain
  // document, and nothing cascaded to it. Every run therefore added another
  // "Project Atlas CIM v1.pdf" beside the last: seven had piled up in Acme's
  // Financials folder here, which on a projector reads as a broken data room.
  // The freeze checklist has the bringup run twice over the weekend, so this
  // compounds exactly when nobody is looking.
  //
  // Order matters. `file_references.document_id` is ON DELETE RESTRICT, so the
  // references go first; `documents.upload_id` is ON DELETE SET NULL, so the
  // uploads have to go after the documents or the link is lost before we can
  // find the blob. `document_versions` cascades from `documents` on its own.
  const stale = await client.query(
    `SELECT id, upload_id FROM documents WHERE company_id = $1 AND name LIKE 'Project Atlas CIM v%'`,
    [ACME],
  );
  if (stale.rows.length > 0) {
    const documentIds = stale.rows.map((r) => r.id);
    const uploadIds = stale.rows.map((r) => r.upload_id).filter(Boolean);
    await client.query("DELETE FROM file_references WHERE document_id = ANY($1)", [documentIds]);
    await client.query("DELETE FROM documents WHERE id = ANY($1)", [documentIds]);
    if (uploadIds.length > 0) {
      await client.query("DELETE FROM uploads WHERE id = ANY($1)", [uploadIds]);
    }
  }

  const deck = await client.query(
    `INSERT INTO cim_decks (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [ACME, "Project Atlas CIM", BROKER],
  );
  const deckId = deck.rows[0].id;

  /** Build one version's structure, filling whichever blocks carry seed text. */
  async function buildVersion(versionNo, status) {
    const version = await client.query(
      `INSERT INTO cim_versions (deck_id, version_no, status, cover)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        deckId,
        versionNo,
        status,
        JSON.stringify({
          company_name: "Project Atlas",
          sector: "Industrial Manufacturing",
          prepared_by: "Centuriuum",
        }),
      ],
    );
    const versionId = version.rows[0].id;

    let sortOrder = 0;
    for (const [index, [sectionKey, title, layoutKey, slideNo, blocks]] of OUTLINE.entries()) {
      const section = await client.query(
        `INSERT INTO cim_sections (version_id, section_key, title, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [versionId, sectionKey, title, index + 1],
      );
      sortOrder += 1;
      const slide = await client.query(
        `INSERT INTO cim_slides (version_id, section_id, layout_key, slide_no, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [versionId, section.rows[0].id, layoutKey, slideNo, sortOrder],
      );
      for (const [blockKey, label, content] of blocks) {
        await client.query(
          `INSERT INTO cim_blocks (version_id, slide_id, block_key, label, content, populated_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            versionId,
            slide.rows[0].id,
            blockKey,
            label,
            JSON.stringify(content ?? ""),
            content ? "author" : null,
            content ? BROKER : null,
          ],
        );
      }
    }
    return versionId;
  }

  // v1: published, with its PDF in the data room. The demo's end state, present
  // before anyone touches the machine.
  const v1 = await buildVersion(1, "published");
  const pdf = demoPdf("Project Atlas - Confidential Information Memorandum");
  const sha256 = createHash("sha256").update(pdf).digest("hex");

  const upload = await client.query(
    `INSERT INTO uploads (file_name, content_type, size_bytes, data, prefix, uploaded_by)
     VALUES ($1, 'application/pdf', $2, $3, 'documents', $4) RETURNING id`,
    ["Project Atlas CIM v1.pdf", pdf.length, pdf, BROKER],
  );
  const folder = await client.query(
    `SELECT id FROM folders WHERE company_id = $1 AND name ILIKE '%financial%' LIMIT 1`,
    [ACME],
  );
  const folderId = folder.rows[0]?.id;
  const document = await client.query(
    `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by, version_count)
     VALUES ($1, $2, $3, '', $4, $5, 'pdf', 'under-review', $6, 1) RETURNING id`,
    [ACME, folderId, "Project Atlas CIM v1.pdf", upload.rows[0].id, String(pdf.length), BROKER],
  );
  const documentVersion = await client.query(
    `INSERT INTO document_versions (document_id, version_no, upload_id, file_name, size_bytes, content_type, created_by)
     VALUES ($1, 1, $2, $3, $4, 'application/pdf', $5) RETURNING id`,
    [document.rows[0].id, upload.rows[0].id, "Project Atlas CIM v1.pdf", pdf.length, BROKER],
  );
  await client.query(`UPDATE documents SET current_version_id = $1 WHERE id = $2`, [
    documentVersion.rows[0].id,
    document.rows[0].id,
  ]);
  await client.query(
    `INSERT INTO cim_publications (version_id, upload_id, document_id, sha256, page_count, byte_size, published_by)
     VALUES ($1, $2, $3, $4, 1, $5, $6)`,
    [v1, upload.rows[0].id, document.rows[0].id, sha256, pdf.length, BROKER],
  );
  await client.query(
    `UPDATE cim_versions SET published_by = $1, published_at = now() - interval '3 days' WHERE id = $2`,
    [BROKER, v1],
  );

  // v2: the open draft the demo actually works in.
  const v2 = await buildVersion(2, "draft");

  await client.query("COMMIT");

  const filled = await client.query(
    `SELECT count(*) FILTER (WHERE populated_by IS NOT NULL)::int AS filled, count(*)::int AS total
     FROM cim_blocks WHERE version_id = $1`,
    [v2],
  );
  const { filled: f, total } = filled.rows[0];
  console.warn(
    `cim seed: deck ${deckId} — v1 published (${pdf.length} bytes, sha ${sha256.slice(0, 12)}…), ` +
      `v2 draft ${f}/${total} blocks filled`,
  );
  console.warn(`cim seed: published PDF is document ${document.rows[0].id} in the data room`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error(`seed-cim: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
