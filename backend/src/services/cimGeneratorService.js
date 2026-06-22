const PptxGenJS = require("pptxgenjs");

// ---------------------------------------------------------------------------
// Color palette — matches the approved brand feel.
// Replace hex values here when the actual template is supplied.
// ---------------------------------------------------------------------------
const BRAND = {
  navy:    "1B2A4A",
  green:   "4C9A2A",
  lightGreen: "EEF6E0",
  white:   "FFFFFF",
  gray:    "6B7280",
  lightGray: "F3F4F6",
  border:  "E5E7EB",
  text:    "111827",
  subtext: "6B7280",
};

const FONT = "Calibri";

// ---------------------------------------------------------------------------
// Helper: currency formatter
// ---------------------------------------------------------------------------
function fmt(val) {
  if (val === null || val === undefined || val === "") return "—";
  const n = Number(String(val).replace(/[^0-9.-]/g, ""));
  if (isNaN(n)) return String(val);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtNum(val) {
  if (val === null || val === undefined || val === "") return "—";
  const n = Number(val);
  if (isNaN(n)) return String(val);
  return new Intl.NumberFormat("en-US").format(n);
}

function str(val) {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

// ---------------------------------------------------------------------------
// Slide builders
// ---------------------------------------------------------------------------

function addCoverSlide(pptx, d) {
  const slide = pptx.addSlide();
  // Background split: left navy, right white
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 5, h: "100%", fill: { color: BRAND.navy } });
  slide.addShape(pptx.ShapeType.rect, { x: 5, y: 0, w: 5, h: "100%", fill: { color: BRAND.white } });

  // Left: company name + tagline
  slide.addText("Confidential Information\nMemorandum", {
    x: 0.4, y: 1.2, w: 4.4, h: 1.4,
    fontSize: 22, bold: true, color: BRAND.white, fontFace: FONT,
    valign: "top",
  });
  slide.addText(str(d.legal_name) || str(d.company_name) || "Company Name", {
    x: 0.4, y: 2.8, w: 4.4, h: 0.7,
    fontSize: 28, bold: true, color: BRAND.green, fontFace: FONT,
  });
  if (d.industry) {
    slide.addText(str(d.industry), {
      x: 0.4, y: 3.5, w: 4.4, h: 0.4,
      fontSize: 13, color: "AABBD0", fontFace: FONT, italic: true,
    });
  }

  // Confidential notice
  slide.addText("STRICTLY CONFIDENTIAL\nFor Authorized Recipients Only", {
    x: 0.4, y: 6.5, w: 4.4, h: 0.7,
    fontSize: 9, color: "7A9CC0", fontFace: FONT, align: "left",
  });

  // Right: key stats
  const stats = [
    ["Industry", str(d.industry) || "—"],
    ["Founded", str(d.founded_year) || "—"],
    ["Employees", str(d.employee_count) || "—"],
    ["Locations", str(d.location_count) || "—"],
    ["Asking Price", fmt(d.asking_price)],
  ];
  let yPos = 1.5;
  for (const [label, value] of stats) {
    slide.addText(label, { x: 5.3, y: yPos, w: 1.8, h: 0.3, fontSize: 9, color: BRAND.subtext, fontFace: FONT });
    slide.addText(value, { x: 5.3, y: yPos + 0.3, w: 4.2, h: 0.4, fontSize: 14, bold: true, color: BRAND.text, fontFace: FONT });
    yPos += 0.9;
  }
}

function addSectionDivider(pptx, title) {
  const slide = pptx.addSlide();
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: "100%", fill: { color: BRAND.navy } });
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 3.4, w: "100%", h: 0.08, fill: { color: BRAND.green } });
  slide.addText(title, {
    x: 1, y: 2.5, w: 8, h: 1.2,
    fontSize: 36, bold: true, color: BRAND.white, fontFace: FONT, align: "center",
  });
}

function addContentSlide(pptx, title, bodyText, options = {}) {
  const slide = pptx.addSlide();

  // Header bar
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: 0.65, fill: { color: BRAND.navy } });
  slide.addText(title, {
    x: 0.3, y: 0, w: 9.4, h: 0.65,
    fontSize: 16, bold: true, color: BRAND.white, fontFace: FONT, valign: "middle",
  });

  // Green accent line
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0.65, w: "100%", h: 0.04, fill: { color: BRAND.green } });

  if (typeof bodyText === "string") {
    slide.addText(bodyText || "—", {
      x: 0.4, y: 0.9, w: 9.2, h: 6.1,
      fontSize: options.fontSize || 11, color: BRAND.text, fontFace: FONT,
      valign: "top", wrap: true,
    });
  } else if (Array.isArray(bodyText)) {
    // Array of {text, options} paragraphs
    slide.addText(bodyText, {
      x: 0.4, y: 0.9, w: 9.2, h: 6.1,
      fontSize: 11, color: BRAND.text, fontFace: FONT, valign: "top",
    });
  }
}

function addTableSlide(pptx, title, headers, rows) {
  const slide = pptx.addSlide();

  // Header bar
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: "100%", h: 0.65, fill: { color: BRAND.navy } });
  slide.addText(title, {
    x: 0.3, y: 0, w: 9.4, h: 0.65,
    fontSize: 16, bold: true, color: BRAND.white, fontFace: FONT, valign: "middle",
  });
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0.65, w: "100%", h: 0.04, fill: { color: BRAND.green } });

  if (!rows.length) {
    slide.addText("No data provided.", { x: 0.4, y: 1, w: 9.2, h: 0.4, fontSize: 11, color: BRAND.subtext, fontFace: FONT });
    return;
  }

  const tableRows = [
    headers.map((h) => ({ text: h, options: { bold: true, color: BRAND.white, fill: BRAND.navy, fontSize: 10, fontFace: FONT, align: "center" } })),
    ...rows.map((row, i) =>
      row.map((cell) => ({
        text: String(cell ?? "—"),
        options: { fontSize: 10, fontFace: FONT, fill: i % 2 === 0 ? BRAND.white : BRAND.lightGray, color: BRAND.text, align: "right" },
      }))
    ),
  ];

  slide.addTable(tableRows, {
    x: 0.3, y: 0.85, w: 9.4,
    border: { pt: 0.5, color: BRAND.border },
    rowH: 0.32,
  });
}

function buildBulletParagraphs(items) {
  return items
    .filter(Boolean)
    .map((text) => ({ text: `• ${str(text)}`, options: { breakLine: true } }));
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------
async function generateCim(cimRecord, companyName) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33" x 7.5"
  pptx.title = `CIM – ${companyName || "Company"}`;
  pptx.author = "M&A Hub";

  const sd = cimRecord.section_data || {};

  // Convenience references to each section. The first keys are the new fixed
  // CIM Prep tabs; fallbacks preserve older records created by the prior flow.
  const coNew = sd.company_overview || {};
  const finPerf = sd.financial_performance || {};
  const finProj = sd.financial_projection || {};
  const market = sd.market_overview || sd.market_information || {};
  const txn = sd.transaction_overview || {};

  const ci = { ...(sd.company_info || {}), ...coNew };
  const ch = { ...(sd.company_history || {}), narrative: coNew.history || sd.company_history?.narrative, milestones: coNew.milestones || sd.company_history?.milestones || [] };
  const own = { ...(sd.ownership || {}), owners: coNew.owners || sd.ownership?.owners || [] };
  const es = {
    ...(sd.executive_summary || {}),
    overview: sd.executive_summary?.investment_thesis || sd.executive_summary?.overview,
    investment_highlights: sd.executive_summary?.key_highlights || sd.executive_summary?.investment_highlights || [],
  };
  const ps = {
    ...(sd.products_services || {}),
    description: sd.products_services?.portfolio_overview || sd.products_services?.description,
    items: sd.products_services?.products || sd.products_services?.items || [],
    differentiators: sd.products_services?.differentiators || [],
  };
  const mt = {
    ...(sd.management_team || {}),
    overview: sd.management_team?.team_overview || sd.management_team?.overview,
    members: sd.management_team?.members || [],
  };
  const ops = sd.operations || {};
  const hf = finPerf.historical_financials || sd.historical_financials || {};
  const ae = { adjustments: finPerf.ebitda_adjustments || sd.adjusted_ebitda?.adjustments || [], notes: sd.adjusted_ebitda?.notes };
  const bs = finPerf.balance_sheet || sd.balance_sheet || {};
  const cf = finPerf.cash_flow || sd.cash_flow || {};
  const nwc = finPerf.net_working_capital || sd.net_working_capital || {};
  const fp = finProj.projected_financials || sd.financial_projections || {};
  const gs = {
    ...(sd.growth_strategy || {}),
    organic_initiatives: sd.growth_strategy?.initiatives || sd.growth_strategy?.organic_initiatives || [],
  };
  const to = txn;
  const ai = {
    ...(sd.advisor_information || {}),
    firm: txn.advisor_firm || sd.advisor_information?.firm,
    name: txn.lead_advisor || sd.advisor_information?.name,
    email: txn.advisor_email || sd.advisor_information?.email,
    phone: txn.advisor_phone || sd.advisor_information?.phone,
  };

  const coverData = {
    legal_name:      ci.legal_name || companyName,
    company_name:    companyName,
    industry:        ci.industry || sd.executive_summary?.company_descriptor,
    founded_year:    ci.founded_year,
    employee_count:  ci.employee_count,
    location_count:  ci.location_count || ci.headquarters,
    asking_price:    to.asking_price,
  };

  // 1. Cover
  addCoverSlide(pptx, coverData);
  addContentSlide(
    pptx,
    "Disclaimer & Confidentiality Notice",
    `This Confidential Information Memorandum has been prepared on behalf of ${coverData.legal_name || "the Company"} solely for prospective buyers who have executed a Non-Disclosure Agreement.\n\nThis document contains forward-looking statements and financial projections based on management assumptions and estimates. Prospective buyers are expected to conduct their own due diligence and should not rely solely on this document.\n\nThis CIM is strictly confidential and may not be reproduced, distributed, or disclosed without prior written consent.`
  );
  addTableSlide(
    pptx,
    "Table of Contents",
    ["#", "Section", "Coverage"],
    [
      ["01", "Executive Summary", "Investment highlights, key financial metrics, transaction rationale"],
      ["02", "Company Overview", "History, milestones, structure, ownership"],
      ["03", "Products & Services", "Portfolio, differentiation, positioning"],
      ["04", "Management Team", "Biographies, retention, organizational readiness"],
      ["05", "Market Overview", "Market size, growth trends, competitive landscape"],
      ["06", "Operations", "Business model, revenue streams, infrastructure"],
      ["07", "Financial Performance", "Historical financials, EBITDA, balance sheet, cash flow, NWC, bank and tax notes"],
      ["08", "Financial Projection", "Projected financials and assumptions"],
      ["09", "Growth Strategy", "Strategic initiatives and M&A opportunities"],
      ["10", "Transaction Overview", "Deal terms, structure, timeline"],
    ]
  );

  // 2. Executive Summary
  addSectionDivider(pptx, "Executive Summary");

  const esLines = [str(es.overview)];
  if ((es.investment_highlights || []).length) {
    esLines.push("\nInvestment Highlights:");
    (es.investment_highlights || []).forEach((h) => esLines.push(`• ${str(h)}`));
  }
  addContentSlide(pptx, "Executive Summary", esLines.filter(Boolean).join("\n"));

  // 3. Company Overview
  addSectionDivider(pptx, "Company Overview");

  const companyDetails = [
    ci.legal_name    && `Legal Name: ${ci.legal_name}`,
    ci.dba           && `DBA: ${ci.dba}`,
    (ci.address || ci.headquarters) && `Address: ${ci.headquarters || [ci.address, ci.city, ci.state, ci.zip].filter(Boolean).join(", ")}`,
    ci.phone         && `Phone: ${ci.phone}`,
    ci.website       && `Website: ${ci.website}`,
    ci.industry      && `Industry: ${ci.industry}`,
    ci.founded_year  && `Founded: ${ci.founded_year}`,
    ci.employee_count && `Employees: ${fmtNum(ci.employee_count)}`,
    ci.customer_count && `Customers / Clients: ${fmtNum(ci.customer_count)}`,
    ci.legal_structure && `Legal Structure: ${ci.legal_structure}`,
  ].filter(Boolean).join("\n");

  addContentSlide(pptx, "Company Information", companyDetails);
  addContentSlide(pptx, "Company History", str(ch.narrative));

  if ((ch.milestones || []).length) {
    const milestoneHeaders = ["Year", "Milestone"];
    const milestoneRows = (ch.milestones || [])
      .sort((a, b) => Number(a.year) - Number(b.year))
      .map((m) => [str(m.year), str(m.description)]);
    addTableSlide(pptx, "Key Milestones", milestoneHeaders, milestoneRows);
  }

  addContentSlide(pptx, "Ownership Structure", str(own.structure));

  if ((own.owners || []).length) {
    addTableSlide(
      pptx, "Ownership Summary",
      ["Shareholder", "Ownership %", "Role"],
      (own.owners || []).map((o) => [str(o.name), `${str(o.ownership_pct)}%`, str(o.role || o.title)])
    );
  }

  // 5. Products & Services
  addSectionDivider(pptx, "Products & Services");
  addContentSlide(pptx, "Products & Services Overview", str(ps.description));

  if ((ps.items || []).length) {
    addTableSlide(
      pptx, "Product & Service Lines",
      ["Name", "Category / Description", "% of Revenue"],
      (ps.items || []).map((p) => [str(p.name), [str(p.category), str(p.description)].filter(Boolean).join(" — "), str(p.revenue_pct) + "%"])
    );
  }

  if ((ps.differentiators || []).length) {
    addTableSlide(
      pptx,
      "Competitive Differentiation",
      ["Differentiator", "Why It Matters"],
      (ps.differentiators || []).map((d) => [str(d.title), str(d.description)])
    );
  }

  if ((market.competitors || []).length) {
    addTableSlide(
      pptx, "Key Competitors",
      ["Competitor", "Size", "Key Differentiator"],
      (market.competitors || []).map((c) => [str(c.name), str(c.size), str(c.differentiator)])
    );
  }

  // 7. Management Team
  addSectionDivider(pptx, "Management Team");
  if ((mt.members || []).length) {
    addTableSlide(
      pptx, "Management Team",
      ["Name", "Title", "Years Experience", "Background"],
      (mt.members || []).map((m) => [str(m.name), str(m.title), str(m.experience_years || m.years_with_company), str(m.bio || m.background)])
    );
  } else {
    addContentSlide(pptx, "Management Team", str(mt.overview));
  }

  // 8. Market Overview
  addSectionDivider(pptx, "Market Overview");
  const marketText = [
    market.market_name && `Market: ${str(market.market_name)}`,
    (market.tam || market.total_addressable_market) && `Total Addressable Market: ${str(market.tam || market.total_addressable_market)}`,
    market.sam && `Serviceable Addressable Market: ${str(market.sam)}`,
    market.cagr && `Market CAGR: ${str(market.cagr)}`,
    market.target_market && `Target Market: ${str(market.target_market)}`,
    market.growth_trends && `Growth Trends: ${str(market.growth_trends)}`,
    market.competitive_landscape && `Competitive Landscape: ${str(market.competitive_landscape)}`,
  ].filter(Boolean).join("\n\n");
  addContentSlide(pptx, "Market Overview", marketText);
  if ((market.tailwinds || []).length) {
    addContentSlide(pptx, "Key Market Tailwinds", buildBulletParagraphs(market.tailwinds));
  }

  // 9. Operations
  addSectionDivider(pptx, "Operations");
  addContentSlide(pptx, "Operations Overview", str(ops.business_model || ops.overview));
  if ((ops.revenue_streams || []).length) {
    addTableSlide(
      pptx,
      "Revenue Streams",
      ["Stream", "% of Revenue", "Type", "Description"],
      (ops.revenue_streams || []).map((r) => [str(r.name), `${str(r.revenue_pct)}%`, str(r.type), str(r.description)])
    );
  }
  if (ops.delivery_process) {
    addContentSlide(pptx, "Delivery Process", str(ops.delivery_process));
  }
  if (ops.facilities || ops.technology_stack || ops.technology_systems) {
    addContentSlide(pptx, "Facilities & Technology", [ops.facilities && `Facilities:\n${ops.facilities}`, (ops.technology_stack || ops.technology_systems) && `Technology & Systems:\n${ops.technology_stack || ops.technology_systems}`].filter(Boolean).join("\n\n"));
  }

  // 10. Financial Performance
  addSectionDivider(pptx, "Financial Performance");
  if (finPerf.performance_summary) {
    addContentSlide(pptx, "Financial Performance Summary", str(finPerf.performance_summary));
  }

  if ((hf.data || []).length) {
    const hfHeaders = ["Year", "Revenue", "Gross Profit", "Op. Expenses", "EBITDA", "Net Income"];
    const hfRows = (hf.data || []).map((r) => [
      str(r.year), fmt(r.revenue), fmt(r.gross_profit),
      fmt(r.op_expenses), fmt(r.ebitda), fmt(r.net_income),
    ]);
    addTableSlide(pptx, "Historical Financials (USD)", hfHeaders, hfRows);
  }

  // 11. Adjusted EBITDA
  if ((ae.adjustments || []).length) {
    addTableSlide(
      pptx, "Adjusted EBITDA",
      ["Description", "Type", "Year", "Amount"],
      (ae.adjustments || []).map((a) => [str(a.description), str(a.type), str(a.year), fmt(a.amount)])
    );
  }

  // 12. Balance Sheet
  if ((bs.data || []).length) {
    const bsHeaders = ["Year", "Current Assets", "Total Assets", "Current Liabilities", "Total Liabilities", "Equity"];
    const bsRows = (bs.data || []).map((r) => [
      str(r.year), fmt(r.current_assets), fmt(r.total_assets),
      fmt(r.current_liabilities), fmt(r.total_liabilities), fmt(r.equity),
    ]);
    addTableSlide(pptx, "Balance Sheet Summary (USD)", bsHeaders, bsRows);
  }

  // 13. Cash Flow
  if ((cf.data || []).length) {
    addTableSlide(
      pptx, "Cash Flow Summary (USD)",
      ["Year", "Operating", "Investing", "Financing", "Net Change"],
      (cf.data || []).map((r) => [str(r.year), fmt(r.operating), fmt(r.investing), fmt(r.financing), fmt(r.net_change)])
    );
  }

  if (finPerf.bank_reconciliation_notes) addContentSlide(pptx, "Bank Reconciliation", str(finPerf.bank_reconciliation_notes));
  if (finPerf.tax_notes) addContentSlide(pptx, "Tax Information", str(finPerf.tax_notes));

  // 14. Financial Projections
  addSectionDivider(pptx, "Financial Projection");
  if (finProj.projection_summary) {
    addContentSlide(pptx, "Projection Summary", str(finProj.projection_summary));
  }
  if ((fp.data || []).length) {
    const fpHeaders = ["Year", "Revenue", "Gross Profit", "EBITDA", "Net Income"];
    const fpRows = (fp.data || []).map((r) => [str(r.year), fmt(r.revenue), fmt(r.gross_profit), fmt(r.ebitda), fmt(r.net_income)]);
    addTableSlide(pptx, "Financial Projections (USD)", fpHeaders, fpRows);
  }

  if ((finProj.assumptions || []).length) {
    addTableSlide(
      pptx,
      "Key Projection Assumptions",
      ["Category", "Assumption"],
      (finProj.assumptions || []).map((a) => [str(a.category), str(a.assumption)])
    );
  }
  if (finProj.risks) addContentSlide(pptx, "Projection Risks", str(finProj.risks));
  // 15. Growth Strategy
  addSectionDivider(pptx, "Growth Strategy");
  if ((gs.organic_initiatives || []).length) {
    addTableSlide(
      pptx, "Growth Initiatives",
      ["Initiative", "Description", "Timeline", "Expected Impact"],
      (gs.organic_initiatives || []).map((g) => [str(g.title), str(g.description), str(g.timeframe || g.timeline), str(g.expected_impact)])
    );
  }
  if (gs.strategy_summary) {
    addContentSlide(pptx, "Growth Strategy Summary", str(gs.strategy_summary));
  }
  if (gs.ma_opportunities || gs.ma_strategy || gs.new_markets) {
    addContentSlide(pptx, "M&A & Market Expansion", [
      (gs.ma_opportunities || gs.ma_strategy) && `M&A Strategy:\n${gs.ma_opportunities || gs.ma_strategy}`,
      gs.new_markets && `New Markets:\n${gs.new_markets}`,
    ].filter(Boolean).join("\n\n"));
  }

  // 16. Transaction Overview
  addSectionDivider(pptx, "Transaction Overview");
  const txDetails = [
    to.transaction_type && `Transaction Type: ${to.transaction_type}`,
    to.ownership_offered && `Ownership Offered: ${to.ownership_offered}`,
    to.consideration && `Consideration: ${to.consideration}`,
    to.asking_price         && `Asking Price: ${fmt(to.asking_price)}`,
    to.transaction_structure && `Structure: ${to.transaction_structure}`,
    to.seller_financing     && `Seller Financing: ${to.seller_financing_terms || to.seller_financing}`,
    to.transition_support   && `Transition Support: ${to.transition_support}`,
    to.expected_timeline    && `Expected Timeline: ${to.expected_timeline}`,
    to.transition_period    && `Transition Period: ${to.transition_period}`,
    to.reason_for_selling   && `Reason for Selling: ${to.reason_for_selling}`,
    to.use_of_proceeds      && `Use of Proceeds: ${to.use_of_proceeds}`,
  ].filter(Boolean).join("\n");
  addContentSlide(pptx, "Transaction Details", txDetails);

  // 17. Contact / Advisor
  if (ai.name || ai.firm) {
    const contactText = [
      ai.firm  && `Firm: ${ai.firm}`,
      ai.name  && `Advisor: ${ai.name}`,
      ai.title && `Title: ${ai.title}`,
      ai.phone && `Phone: ${ai.phone}`,
      ai.email && `Email: ${ai.email}`,
      ai.confidentiality_statement && `\n${ai.confidentiality_statement}`,
    ].filter(Boolean).join("\n");
    addContentSlide(pptx, "Advisor Contact Information", contactText);
  }

  // Return as buffer
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return buffer;
}

module.exports = { generateCim };
