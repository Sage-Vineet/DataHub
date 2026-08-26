#!/usr/bin/env node
/**
 * Seed Northwind Logistics' CIM — the Acme deck's shape, a different business.
 *
 * Same two-version story as seed-cim.mjs: v1 published with a real PDF already
 * sitting in the data room, v2 an open draft about 60% filled. A second deck
 * matters because the CIM screen is the one surface where a visitor asking "can
 * I see it on another deal?" would otherwise hit an empty state.
 *
 * The OUTLINE structure — section keys, layout keys, block keys and the question
 * labels — is deliberately identical to seed-cim.mjs, because those mirror
 * `apps/api/src/modules/cim/outline.ts` and the app renders against them. Only
 * the seeded ANSWERS differ, which is what makes this a different company rather
 * than a copy with the names changed.
 *
 * Idempotent: re-running replaces the seeded deck rather than accumulating.
 *
 *   DATABASE_URL=... node tools/demo/seed-cim-northwind.mjs
 */
import { createHash } from "node:crypto";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("seed-cim-northwind: DATABASE_URL is required");
  process.exit(1);
}

const NORTHWIND = "a0000000-0000-4000-8000-000000000002";
const BROKER = "b0000000-0000-4000-8000-000000000002";
// Tom Reyes — the seller-side persona seed-northwind.sql uses for this deal.
const SELLER = "91000000-0000-4000-8000-000000000008";

/**
 * Filled blocks are the ones a seller has actually answered; nulls are the gaps
 * the builder's "what is missing" list exists to show. Roughly 60% filled, and
 * the gaps are chosen to be the genuinely hard questions on this deal — owner
 * dependence, concentration commentary, transaction structure — so the gap list
 * reads like a real one rather than a random scatter.
 */
const OUTLINE = [
  ["executive-summary", "Executive Summary", "source-slide-02", 2, [
    ["2:headline", "In one sentence, what is this business?",
     "A regional less-than-truckload and dedicated freight carrier operating 41 power units across the Pacific Northwest, founded in 2009."],
    ["2:investment_highlights", "What are the three strongest reasons to buy it?",
     "Seventeen years of profitable operation with an operating ratio of 0.92, 81% of revenue from customers retained five years or longer, and a satisfactory DOT rating with CSA scores below regional averages on every BASIC."],
    ["2:transaction_rationale", "Why is the owner selling now?", null],
  ]],
  ["business-overview", "Business Overview", "source-slide-04", 4, [
    ["4:history", "When was the company founded, and how has it evolved?",
     "Founded 2009 with four owner-operators running produce out of the Yakima Valley. Added the Kent cross-dock in 2014, the Spokane satellite in 2019, and moved from pure brokerage into asset-based dedicated freight in 2021."],
    ["4:what_we_do", "What does the business actually do, day to day?",
     "Runs scheduled dry van and reefer freight on regional lanes across Washington, Oregon, Idaho and Montana, with dedicated fleet arrangements for four grocery and building-supply customers and a cross-dock operation in Kent."],
    ["4:differentiation", "What can this business do that competitors cannot?", null],
  ]],
  ["products-services", "Products & Services", "source-slide-07", 7, [
    ["7:product_lines", "What are the main product or service lines?",
     "Dedicated contract freight (58% of revenue), regional LTL (27%), cross-dock and short-term warehousing (9%), and brokered overflow capacity (6%)."],
    ["7:pricing_model", "How is the work priced and billed?",
     "Per-mile rates on published tariffs, revised annually on contract renewal, with a fuel surcharge indexed weekly to the DOE national average. Cross-dock is billed per pallet-day."],
    ["7:recurring_revenue", "How much of the revenue recurs, and under what terms?", null],
  ]],
  ["market-competition", "Market & Competition", "source-slide-10", 10, [
    ["10:market_size", "How large is the addressable market, and how fast is it growing?", null],
    ["10:competitors", "Who are the main competitors, and how do you win against them?",
     "Two regional carriers of similar size and the asset-light brokerages. We win on service consistency into the grocery DCs, where a missed appointment window costs the customer more than the freight, and on holding dedicated capacity they cannot guarantee."],
    ["10:barriers", "What makes it hard for a new entrant to take this business?", null],
  ]],
  ["customers", "Customers", "source-slide-13", 13, [
    ["13:customer_profile", "Who buys from you, and why do they choose you?",
     "Regional grocery co-operatives, food distributors and building-supply wholesalers, almost all within a single day's drive of the Kent hub."],
    ["13:concentration_commentary", "How would you explain the customer concentration?", null],
    ["13:retention", "How long does a typical customer stay, and why do any leave?",
     "The top ten average nine years. Two accounts were lost in FY2025, both under 200k and both to in-housing rather than to a competitor. Gross revenue retention is 91.4% and net 103.8%."],
  ]],
  ["operations", "Operations & Facilities", "source-slide-16", 16, [
    ["16:facilities", "What facilities does the business operate from?",
     "A 62,000 sq ft cross-dock in Kent, Washington on a lease running to 2031 with one five-year option, and an 18,000 sq ft satellite terminal in Spokane expiring 2027."],
    ["16:supply_chain", "Who are the critical suppliers, and how replaceable are they?", null],
    ["16:systems", "What systems and technology does the business run on?",
     "McLeod PowerBroker for transport management, Samsara for ELD and telematics, Sage Intacct for accounting, and EDI through SPS Commerce. All are commodity platforms with transferable licences."],
  ]],
  ["management", "Management & Employees", "source-slide-19", 19, [
    ["19:leadership", "Who runs the business, and what does each of them own?",
     "The founder holds 74.5% and remains chief executive; the VP of Operations holds 12.0% and the CFO 8.5%, with a 5.0% ESOP pool. Both minority holders have been with the business more than eight years."],
    ["19:owner_dependence", "What happens to the business the day the owner leaves?", null],
    ["19:headcount", "How is the workforce made up, and how is turnover?",
     "118 people: 52 company drivers, 38 owner-operators, 14 dock and 14 administration and dispatch. Voluntary driver turnover is 22.4% against a regional industry figure of roughly 31%."],
  ]],
  ["growth", "Growth Opportunities", "source-slide-22", 22, [
    ["22:organic_growth", "What could a new owner grow without spending capital?", null],
    ["22:investment_growth", "What would you do with capital you have not had?",
     "Add twelve reefer trailers and a second shift at the Kent cross-dock. Reefer demand from the existing grocery base is currently turned away or brokered out at a thin margin."],
    ["22:adjacencies", "What adjacent markets or products are within reach?", null],
  ]],
  ["financial-summary", "Financial Summary", "source-slide-25", 25, [
    ["25:performance_commentary", "How would you explain the last three years of results?",
     "Revenue grew in each of the last three years to 18.4m in FY2025, with the operating ratio improving from 0.94 to 0.92 on a mix of contract rate increases and a reduction in empty miles from 14.2% to 11.8%."],
    ["25:addback_rationale", "What costs would not continue under a new owner?", null],
  ]],
  ["transaction", "Transaction Overview", "source-slide-28", 28, [
    ["28:structure", "What transaction structure is the seller looking for?", null],
    ["28:transition", "What transition support is the owner willing to provide?",
     "Nine months, full time for the first four, with the VP of Operations and CFO both under retention agreements running twelve months past close."],
  ]],
  ["appendix", "Appendix", "source-slide-31", 31, [
    ["31:notes", "Anything else a buyer should know?", null],
  ]],
];

/** A small but structurally valid PDF, so the data room preview genuinely opens it. */
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

  // Idempotent by replacement, exactly as seed-cim.mjs does it: the deck cascade
  // clears versions, slides, blocks and publications, but the published PDF is a
  // plain data-room document that nothing cascades to, so it is cleared by name
  // first. Skipping that is how Acme accumulated seven copies of its own CIM.
  await client.query("DELETE FROM cim_decks WHERE company_id = $1", [NORTHWIND]);

  const stale = await client.query(
    `SELECT id, upload_id FROM documents WHERE company_id = $1 AND name LIKE 'Project Compass CIM v%'`,
    [NORTHWIND],
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
    [NORTHWIND, "Project Compass CIM", BROKER],
  );
  const deckId = deck.rows[0].id;

  async function buildVersion(versionNo, status) {
    const version = await client.query(
      `INSERT INTO cim_versions (deck_id, version_no, status, cover)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        deckId,
        versionNo,
        status,
        JSON.stringify({
          company_name: "Project Compass",
          sector: "Freight & Logistics",
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
            content ? SELLER : null,
          ],
        );
      }
    }
    return versionId;
  }

  const v1 = await buildVersion(1, "published");
  const pdf = demoPdf("Project Compass - Confidential Information Memorandum");
  const sha256 = createHash("sha256").update(pdf).digest("hex");

  const upload = await client.query(
    `INSERT INTO uploads (file_name, content_type, size_bytes, data, prefix, uploaded_by)
     VALUES ($1, 'application/pdf', $2, $3, 'documents', $4) RETURNING id`,
    ["Project Compass CIM v1.pdf", pdf.length, pdf, BROKER],
  );
  const folder = await client.query(
    `SELECT id FROM folders WHERE company_id = $1 AND name ILIKE '%financial%' AND parent_id IS NULL LIMIT 1`,
    [NORTHWIND],
  );
  const folderId = folder.rows[0]?.id;
  if (!folderId) throw new Error("no Financials folder on Northwind to publish into");

  const document = await client.query(
    `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by, version_count)
     VALUES ($1, $2, $3, '', $4, $5, 'pdf', 'under-review', $6, 1) RETURNING id`,
    [NORTHWIND, folderId, "Project Compass CIM v1.pdf", upload.rows[0].id, String(pdf.length), BROKER],
  );
  const documentVersion = await client.query(
    `INSERT INTO document_versions (document_id, version_no, upload_id, file_name, size_bytes, content_type, created_by)
     VALUES ($1, 1, $2, $3, $4, 'application/pdf', $5) RETURNING id`,
    [document.rows[0].id, upload.rows[0].id, "Project Compass CIM v1.pdf", pdf.length, BROKER],
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
    `UPDATE cim_versions SET published_by = $1, published_at = now() - interval '6 days' WHERE id = $2`,
    [BROKER, v1],
  );

  const v2 = await buildVersion(2, "draft");

  await client.query("COMMIT");

  const filled = await client.query(
    `SELECT count(*) FILTER (WHERE populated_by IS NOT NULL)::int AS filled, count(*)::int AS total
     FROM cim_blocks WHERE version_id = $1`,
    [v2],
  );
  const { filled: f, total } = filled.rows[0];
  console.warn(
    `cim seed (northwind): deck ${deckId} — v1 published (${pdf.length} bytes, sha ${sha256.slice(0, 12)}…), ` +
      `v2 draft ${f}/${total} blocks filled`,
  );
} catch (err) {
  await client.query("ROLLBACK");
  console.error(`seed-cim-northwind: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
