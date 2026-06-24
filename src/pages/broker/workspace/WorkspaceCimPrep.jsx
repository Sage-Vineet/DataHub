import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  Eye,
  FileText,
  ImagePlus,
  Loader2,
  MessageSquareText,
  PanelLeft,
  Plus,
  Send,
  Trash2,
  Upload,
  Save,
  X,
} from "lucide-react";
import {
  getCimQuestionnaireRequest,
  getCompanyRequest,
  getWorkspacePageStateRequest,
  saveCimQuestionnaireRequest,
  saveWorkspacePageStateRequest,
} from "../../../lib/api";
import { exportCimPptx } from "../../../lib/cimPptxExport";
import { useToast } from "../../../context/ToastContext";

const SLIDE_WIDTH = 1280;
const PAGE_KEY = "cim-prep";
const TEMPLATE_SLIDE_COUNT = 38;

const SECTION_SLIDES = [
  { id: "executive-summary", number: "01", title: "Executive Summary", slides: [4, 5, 6] },
  { id: "company-overview", number: "02", title: "Company Overview", slides: [7, 8, 9, 10] },
  { id: "products-services", number: "03", title: "Products & Services", slides: [11, 12, 13] },
  { id: "management-team", number: "04", title: "Management Team", slides: [14, 15] },
  { id: "market-overview", number: "05", title: "Market Overview", slides: [16, 17, 18] },
  { id: "operations", number: "06", title: "Operations", slides: [19, 20, 21] },
  { id: "financial-performance", number: "07", title: "Financial Performance", slides: [22, 23, 24, 25, 26, 27, 28, 29, 30] },
  { id: "financial-projections", number: "08", title: "Financial Projections", slides: [31, 32, 33] },
  { id: "growth-strategy", number: "09", title: "Growth Strategy", slides: [34, 35] },
  { id: "transaction-overview", number: "10", title: "Transaction Overview", slides: [36, 37] },
];

const BASIC_DETAILS_SECTION = {
  id: "basic-details",
  number: "BD",
  title: "Basic Details",
  type: "basic",
  slides: [1, 2, 3, 4],
};

const NAV_SECTIONS = [BASIC_DETAILS_SECTION, ...SECTION_SLIDES];

const BASIC_DETAIL_FIELDS = [
  ["companyName", "Company name"],
  ["projectName", "Project name"],
  ["companyLegalName", "Company legal name"],
  ["descriptor", "Company descriptor"],
  ["monthYear", "Month year"],
  ["advisorFirm", "Advisor firm"],
  ["advisorAddress", "Advisor address"],
  ["advisorCityPhone", "City / phone"],
  ["leadAdvisor", "Lead advisor"],
  ["leadAdvisorTitle", "Lead advisor title"],
  ["leadAdvisorEmail", "Lead advisor email"],
  ["leadAdvisorPhone", "Lead advisor phone"],
  ["coAdvisor", "Co-advisor"],
  ["coAdvisorTitle", "Co-advisor title"],
  ["coAdvisorEmail", "Co-advisor email"],
  ["coAdvisorPhone", "Co-advisor phone"],
];

const PREVIEW_SLIDES = [
  1,
  2,
  3,
  ...SECTION_SLIDES.flatMap((section) => section.slides),
  38,
];

const CHART_TYPES = [
  ["bar", "Bar"],
  ["line", "Line"],
  ["pie", "Pie"],
  ["waterfall", "Waterfall"],
];

const CHART_COLORS = ["#8BC53D", "#476E2C", "#A5A5A5", "#6D6E71", "#243F18"];

const QUESTIONNAIRE_STATUS_META = {
  open: { label: "Open", color: "#A86F0B", bg: "#FEF3C7" },
  answered: { label: "Answered", color: "#2563EB", bg: "#DBEAFE" },
  resolved: { label: "Resolved", color: "#166534", bg: "#DCFCE7" },
};

const SECTION_QUESTION_BANK = {
  "basic-details": [
    ["company-profile", "Confirm the legal company name, operating/trade name, headquarters address, website, and primary contact details."],
    ["project-name", "Confirm the preferred project name and whether it should appear with or without the word Project."],
    ["company-logo", "Provide the latest company logo file and any usage guidance for the CIM."],
    ["advisor-logo", "Provide the advisor logo and preferred advisor contact block for the cover/back pages."],
    ["confidentiality", "Confirm any confidentiality wording, disclaimers, or recipient restrictions that should be reflected."],
  ],
  "executive-summary": [
    ["highlights", "List the top investment highlights that a buyer should understand immediately."],
    ["metrics", "Provide the key financial metrics, operating KPIs, and latest LTM figures to feature."],
    ["rationale", "Summarize the strategic rationale for the transaction and preferred buyer profile."],
    ["risks", "Call out any key risks, sensitivities, or diligence topics the CIM should address carefully."],
    ["one-liner", "Provide a concise one-line description of the business and market position."],
  ],
  "company-overview": [
    ["history", "Provide the founding story, ownership history, major milestones, and current ownership structure."],
    ["business-model", "Describe how the company makes money, customer types served, and key revenue streams."],
    ["legal-structure", "Provide legal entity names, subsidiaries, ownership percentages, and jurisdiction details."],
    ["geography", "List operating locations, served geographies, and any planned expansion regions."],
    ["differentiation", "Explain what makes the company distinctive versus competitors."],
  ],
  "products-services": [
    ["offering", "Describe the main products and services, including pricing model and delivery model."],
    ["mix", "Provide revenue mix by product/service line and any margin differences by offering."],
    ["customers", "Identify the core customer segments, use cases, and buyer decision makers."],
    ["pipeline", "Provide upcoming product/service launches or roadmap items relevant to growth."],
    ["case-studies", "Share representative customer wins, case studies, or proof points."],
  ],
  "management-team": [
    ["bios", "Provide short bios for key management team members, including tenure and prior experience."],
    ["org-chart", "Provide the current organization chart and reporting lines."],
    ["retention", "Describe management retention plans, succession risks, or key-person dependencies."],
    ["headcount", "Provide headcount by function, location, and employee/contractor split."],
    ["incentives", "Summarize compensation, incentive plans, or equity participation relevant to a buyer."],
  ],
  "market-overview": [
    ["market-size", "Provide market size, growth rate, TAM/SAM/SOM, and source references."],
    ["tailwinds", "List the key industry tailwinds supporting future growth."],
    ["competitive-landscape", "Identify key competitors and how the company is positioned against them."],
    ["segmentation", "Provide market segmentation by geography, customer type, product, or channel."],
    ["regulation", "Describe regulatory, technology, or macro trends that may affect the business."],
  ],
  "operations": [
    ["process", "Describe the end-to-end operating workflow or value chain from lead/source to delivery."],
    ["systems", "List major systems, tools, vendors, facilities, and infrastructure used by the business."],
    ["capacity", "Provide utilization, capacity constraints, service levels, and scalability considerations."],
    ["suppliers", "Identify critical suppliers, partners, dependencies, or concentration risks."],
    ["quality", "Describe quality control, certifications, compliance processes, and operating KPIs."],
  ],
  "financial-performance": [
    ["historicals", "Provide historical revenue, gross profit, EBITDA, and margin details for the requested periods."],
    ["adjustments", "List EBITDA add-backs, normalizations, and one-time items with support."],
    ["revenue-drivers", "Explain growth drivers, pricing changes, volume trends, and recurring revenue dynamics."],
    ["working-capital", "Provide working capital trends, seasonality, and proposed target NWC peg assumptions."],
    ["debt-tax", "Provide bank debt, tax, cash, and other balance sheet items relevant to the transaction."],
  ],
  "financial-projections": [
    ["forecast", "Provide management forecast by year for revenue, gross profit, EBITDA, capex, and cash flow."],
    ["assumptions", "Explain the key forecast assumptions, growth levers, and margin expansion drivers."],
    ["scenario", "Provide downside/upside sensitivities or scenario assumptions if available."],
    ["backlog-pipeline", "Provide backlog, pipeline, contracted revenue, or bookings support for the forecast."],
    ["investment", "Identify investments required to achieve the forecast, including hiring, capex, and systems."],
  ],
  "growth-strategy": [
    ["organic", "Describe the primary organic growth initiatives and expected impact."],
    ["geographic", "Identify geographic expansion opportunities and required investment."],
    ["product-expansion", "Describe product/service expansion opportunities and cross-sell potential."],
    ["ma", "List potential acquisition targets, M&A strategy, or consolidation opportunities."],
    ["partnerships", "Identify channel, vendor, or strategic partnerships that can accelerate growth."],
  ],
  "transaction-overview": [
    ["process", "Confirm the proposed transaction process, timing, milestones, and diligence expectations."],
    ["structure", "Provide preferred transaction structure, rollover expectations, and any excluded assets/liabilities."],
    ["use-of-proceeds", "Summarize owner objectives, use of proceeds, and post-closing involvement expectations."],
    ["buyer-criteria", "Describe ideal buyer attributes and any buyers that should be included or excluded."],
    ["contacts", "Confirm transaction contacts, data room process, and communication protocol."],
  ],
};

const GLOBAL_DETAIL_SENTINELS = Object.freeze({
  companyName: "__company_name__",
  companyLegalName: "__company_legal_name__",
  projectName: "__project_name__",
  descriptor: "__company_descriptor__",
  monthYear: "__month_year__",
  advisorFirm: "__advisor_firm__",
  advisorAddress: "__advisor_address__",
  advisorCityPhone: "__advisor_city_phone__",
  leadAdvisor: "__lead_advisor__",
  leadAdvisorTitle: "__lead_advisor_title__",
  leadAdvisorEmail: "__lead_advisor_email__",
  leadAdvisorPhone: "__lead_advisor_phone__",
  coAdvisor: "__co_advisor__",
  coAdvisorTitle: "__co_advisor_title__",
  coAdvisorEmail: "__co_advisor_email__",
  coAdvisorPhone: "__co_advisor_phone__",
});

function padSlide(slideNumber) {
  return String(slideNumber).padStart(2, "0");
}

function getSlideLayoutPath(slideNumber) {
  return `/cim-template/layouts/source-slide-${padSlide(slideNumber)}.layout.json`;
}

function getDefaultMonthYear() {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(new Date());
}

function createDefaultGlobalDetails(company = null) {
  const companyName = company?.name || "";

  return {
    companyName,
    companyLegalName: companyName,
    projectName: company?.project_name || companyName,
    descriptor: company?.industry ? `${company.industry} business` : "",
    monthYear: getDefaultMonthYear(),
    advisorFirm: "",
    advisorAddress: "",
    advisorCityPhone: "",
    leadAdvisor: "",
    leadAdvisorTitle: "",
    leadAdvisorEmail: "",
    leadAdvisorPhone: "",
    coAdvisor: "",
    coAdvisorTitle: "",
    coAdvisorEmail: "",
    coAdvisorPhone: "",
  };
}

function getLocalStorageKey(clientId) {
  return `datahub:cim-prep:${clientId || "default"}`;
}

function getQuestionnaireLocalStorageKey(clientId) {
  return `datahub:cim-questionnaire:${clientId || "default"}`;
}

function sanitizeFileName(value) {
  const cleaned = String(value || "cim-prep")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "cim-prep";
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function containsTemplateToken(text) {
  return /\[[^\]]+\]/.test(String(text || ""));
}

function cssColor(value, fallback = "#333333") {
  if (!value || value === "tx1") return fallback;
  if (String(value).startsWith("rgba(")) return value;
  if (String(value).startsWith("#")) return value;
  return fallback;
}

function getRuns(element) {
  return (element.paragraphs || []).flatMap((paragraph) => paragraph.runs || []);
}

function getElementStyle(element) {
  const runs = getRuns(element);
  const firstRun = runs.find((run) => normalizeText(run.text)) || {};
  const firstParagraph = element.paragraphs?.[0] || {};
  const resolved = element.resolvedTextStyle || {};
  const alignment =
    firstParagraph.resolvedTextStyle?.alignment ||
    resolved.alignment ||
    "left";

  return {
    fontSize: Number(firstRun.fontSize || element.resolvedFontSize || 12),
    fontFamily: `${firstRun.typeface || resolved.typeface || "Calibri"}, Calibri, Aptos, Arial, sans-serif`,
    fontWeight: firstRun.bold || runs.some((run) => run.bold) ? 700 : 400,
    fontStyle: firstRun.italic ? "italic" : "normal",
    color: cssColor(firstRun.color, "#333333"),
    textAlign: alignment === "center" ? "center" : alignment === "right" ? "right" : "left",
    verticalAlignment: resolved.verticalAlignment || "top",
    insets: resolved.insets || { top: 0, right: 0, bottom: 0, left: 0 },
    lineHeight: 1.08,
  };
}

function makeFieldId(slideNumber, element) {
  return `${slideNumber}:${element.aid || element.id || element.order}`;
}

function extractTemplateFields(slideNumber, layout) {
  const elements = layout?.elements || [];

  return elements
    .filter((element) => {
      if (!element.text || !containsTemplateToken(element.text)) return false;
      const [left, top, width, height] = element.bbox || [];
      return width > 12 && height > 8 && left >= 0 && top >= 0;
    })
    .map((element) => ({
      id: makeFieldId(slideNumber, element),
      slideNumber,
      order: element.order,
      text: element.text,
      label: getFieldLabel(element.text),
      bbox: element.bbox,
      style: getElementStyle(element),
    }));
}

function getFieldLabel(text) {
  const clean = normalizeText(text);
  const token = clean.match(/\[([^\]]+)\]/)?.[1];
  if (token) return token;
  return clean.slice(0, 42) || "Field";
}

function tokenValue(token, details, sourceText = "") {
  const key = normalizeText(token).toLowerCase();
  const source = normalizeText(sourceText).toLowerCase();
  const companyName = details.companyName || "";
  const isCoAdvisorField = source.includes("co-advisor");

  if (key === "company name" || key === "company") return companyName;
  if (key === "company legal name") return details.companyLegalName || companyName;
  if (key === "name") return details.projectName || companyName;
  if (key === "month year" || key === "year") return details.monthYear || "";
  if (key === "one-line company descriptor - industry, geography, business model") {
    return details.descriptor || "";
  }
  if (key === "advisor firm name" || key === "advisor firm") return details.advisorFirm || "";
  if (key === "address line 1") return details.advisorAddress || "";
  if (key === "city, province/state | phone") return details.advisorCityPhone || "";
  if (key === "lead advisor name" || key === "lead advisor") return details.leadAdvisor || "";
  if (key === "co-advisor name" || key === "co-advisor") return details.coAdvisor || "";
  if (key === "title") return isCoAdvisorField ? details.coAdvisorTitle || "" : details.leadAdvisorTitle || "";
  if (key === "email") return isCoAdvisorField ? details.coAdvisorEmail || "" : details.leadAdvisorEmail || "";
  if (key === "phone") return isCoAdvisorField ? details.coAdvisorPhone || "" : details.leadAdvisorPhone || "";

  return "";
}

function applyGlobalDetails(text, details) {
  const clean = normalizeText(text);
  if (/^Project\s+\[NAME\]$/i.test(clean) && normalizeText(details.projectName)) {
    return details.projectName;
  }

  return String(text || "").replace(/\[([^\]]+)\]/g, (match, token) => {
    const value = tokenValue(token, details, text);
    return value || match;
  });
}

function getFieldKind(fieldOrText) {
  const source = typeof fieldOrText === "string" ? fieldOrText : fieldOrText?.text || "";
  const clean = normalizeText(source).toLowerCase();

  if (/^\[(advisor|adviser|company)?\s*logo\]$/i.test(clean) || /^\[(photo|image|picture)\]$/i.test(clean)) {
    return "asset";
  }

  if (
    /^\[(chart|graph)/i.test(clean) ||
    /\b(chart|graph|matrix|flow diagram|diagram)\s+placeholder\b/i.test(clean) ||
    /\bwaterfall\b/i.test(clean)
  ) {
    return "chart";
  }

  return "text";
}

function isAssetField(field) {
  return getFieldKind(field) === "asset";
}

function isChartField(field) {
  return getFieldKind(field) === "chart";
}

function isMediaField(field) {
  const kind = getFieldKind(field);
  return kind === "asset" || kind === "chart";
}

function getAssetKey(field) {
  const clean = normalizeText(field?.text).toLowerCase();
  if (clean.includes("advisor logo") || clean.includes("adviser logo")) return "advisor-logo";
  if (clean.includes("company logo")) return "company-logo";
  return field?.id || clean;
}

function getKnownGlobalTokens(text) {
  return Array.from(String(text || "").matchAll(/\[([^\]]+)\]/g), (match) => match[1]).filter(
    (token) => tokenValue(token, GLOBAL_DETAIL_SENTINELS, text),
  );
}

function isHandledByGlobalDetails(field) {
  if (!field?.text || isMediaField(field)) return false;
  const tokens = Array.from(String(field.text).matchAll(/\[([^\]]+)\]/g), (match) => match[1]);
  return tokens.length > 0 && tokens.length === getKnownGlobalTokens(field.text).length;
}

function getFieldValue(field, fieldValues, globalDetails) {
  const saved = fieldValues[field.id];
  if (typeof saved === "string" && saved.trim()) return saved;
  return applyGlobalDetails(field.text, globalDetails);
}

function isResolvedByGlobalDetails(field, globalDetails) {
  return isHandledByGlobalDetails(field) || !containsTemplateToken(applyGlobalDetails(field.text, globalDetails));
}

function parseChartNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const negative = /^\(.+\)$/.test(raw) || raw.startsWith("-");
  const parsed = Number(raw.replace(/[($,%)]/g, "").replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function getDefaultChartType(field) {
  const clean = normalizeText(field?.text).toLowerCase();
  if (clean.includes("waterfall")) return "waterfall";
  if (clean.includes("pie") || clean.includes("segmentation")) return "pie";
  if (clean.includes("line") || clean.includes("trend") || clean.includes("monthly") || clean.includes("nwc")) {
    return "line";
  }
  return "bar";
}

function getDefaultChartData(field, type = getDefaultChartType(field)) {
  const clean = normalizeText(field?.text).toLowerCase();

  if (type === "pie" || clean.includes("segmentation")) {
    return "Segment A,45\nSegment B,30\nSegment C,15\nOther,10";
  }
  if (type === "waterfall" || clean.includes("waterfall")) {
    return "Reported EBITDA,5.2\nOwner add-back,0.4\nOne-time fees,0.3\nOther add-backs,0.2\nAdjusted EBITDA,6.1";
  }
  if (clean.includes("monthly") || clean.includes("nwc")) {
    return "Jan,4.2\nFeb,4.6\nMar,4.0\nApr,4.8\nMay,5.1\nJun,4.7\nJul,5.3\nAug,5.0";
  }
  if (clean.includes("ebitda") && clean.includes("revenue")) {
    return "FY2023A,18.0,3.2\nFY2024A,21.5,4.1\nFY2025E,25.0,5.0\nFY2026E,29.0,6.2\nFY2027E,33.5,7.5";
  }
  if (clean.includes("market")) {
    return "FY2023,120\nFY2024,145\nFY2025,172\nFY2026,205\nFY2027,242";
  }
  return "FY2021,12.0\nFY2022,14.5\nFY2023,17.0\nFY2024,20.5\nLTM,23.0";
}

function parseChartData(dataText, fallbackText) {
  const source = normalizeText(dataText) ? dataText : fallbackText;
  const rows = String(source || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[,\t|]/).map((part) => part.trim()).filter(Boolean));

  const data = rows
    .map((parts) => {
      const values = parts.slice(1).map(parseChartNumber).filter((value) => value !== null);
      return {
        label: parts[0] || "",
        values: values.length ? values : [0],
      };
    })
    .filter((row) => row.label);

  if (data.length) return data;
  if (source === fallbackText || !fallbackText) return [{ label: "Value", values: [1] }];
  return parseChartData(fallbackText, "");
}

function escapeSvg(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatChartValue(value) {
  const numeric = Number(value || 0);
  const absolute = Math.abs(numeric);
  if (absolute >= 1000) return `${Math.round(numeric / 100) / 10}k`;
  if (absolute >= 100) return String(Math.round(numeric));
  return String(Math.round(numeric * 10) / 10);
}

function getChartTitle(field) {
  const text = normalizeText(field?.text)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/^CHART[:\s-]*/i, "")
    .replace(/PLACEHOLDER/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 72) || field?.label || "Chart";
}

function chartGrid(plot, minValue, maxValue) {
  const lines = [];
  const range = maxValue - minValue || 1;

  for (let index = 0; index <= 4; index += 1) {
    const value = minValue + (range * index) / 4;
    const y = plot.y + plot.height - ((value - minValue) / range) * plot.height;
    lines.push(`
      <line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="#E5E7EB" stroke-width="1"/>
      <text x="${plot.x - 10}" y="${y + 4}" text-anchor="end" font-size="18" fill="#6D6E71">${escapeSvg(formatChartValue(value))}</text>
    `);
  }

  return lines.join("");
}

function buildBarChart(data, plot) {
  const seriesCount = Math.max(1, ...data.map((row) => row.values.length));
  const maxValue = Math.max(1, ...data.flatMap((row) => row.values.map((value) => Math.max(0, value))));
  const groupWidth = plot.width / Math.max(data.length, 1);
  const barWidth = Math.min(42, (groupWidth * 0.68) / seriesCount);

  const bars = data.flatMap((row, rowIndex) =>
    Array.from({ length: seriesCount }, (_, seriesIndex) => {
      const value = row.values[seriesIndex] || 0;
      const barHeight = Math.max(2, (Math.max(0, value) / maxValue) * plot.height);
      const x =
        plot.x +
        rowIndex * groupWidth +
        (groupWidth - barWidth * seriesCount) / 2 +
        seriesIndex * barWidth;
      const y = plot.y + plot.height - barHeight;
      return `
        <rect x="${x}" y="${y}" width="${barWidth - 3}" height="${barHeight}" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}"/>
        <text x="${x + (barWidth - 3) / 2}" y="${y - 7}" text-anchor="middle" font-size="17" font-weight="700" fill="#476E2C">${escapeSvg(formatChartValue(value))}</text>
      `;
    }),
  ).join("");

  const labels = data.map((row, rowIndex) => {
    const x = plot.x + rowIndex * groupWidth + groupWidth / 2;
    return `<text x="${x}" y="${plot.y + plot.height + 32}" text-anchor="middle" font-size="18" fill="#6D6E71">${escapeSvg(row.label)}</text>`;
  }).join("");

  return `${chartGrid(plot, 0, maxValue)}${bars}${labels}`;
}

function buildLineChart(data, plot) {
  const seriesCount = Math.max(1, ...data.map((row) => row.values.length));
  const values = data.flatMap((row) => row.values);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(1, ...values);
  const range = maxValue - minValue || 1;
  const step = data.length > 1 ? plot.width / (data.length - 1) : plot.width;
  const labels = data.map((row, rowIndex) => {
    const x = plot.x + rowIndex * step;
    return `<text x="${x}" y="${plot.y + plot.height + 32}" text-anchor="middle" font-size="18" fill="#6D6E71">${escapeSvg(row.label)}</text>`;
  }).join("");
  const series = Array.from({ length: seriesCount }, (_, seriesIndex) => {
    const points = data.map((row, rowIndex) => {
      const value = row.values[seriesIndex] ?? row.values[0] ?? 0;
      const x = plot.x + rowIndex * step;
      const y = plot.y + plot.height - ((value - minValue) / range) * plot.height;
      return [x, y, value];
    });
    const pointList = points.map(([x, y]) => `${x},${y}`).join(" ");
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
    const dots = points.map(([x, y, value]) => `
      <circle cx="${x}" cy="${y}" r="5" fill="${color}"/>
      <text x="${x}" y="${y - 12}" text-anchor="middle" font-size="17" font-weight="700" fill="#476E2C">${escapeSvg(formatChartValue(value))}</text>
    `).join("");
    return `<polyline points="${pointList}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join("");

  return `${chartGrid(plot, minValue, maxValue)}${series}${labels}`;
}

function polarToCartesian(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

function piePath(cx, cy, radius, startAngle, endAngle) {
  const [startX, startY] = polarToCartesian(cx, cy, radius, endAngle);
  const [endX, endY] = polarToCartesian(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${cx} ${cy} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 0 ${endX} ${endY} Z`;
}

function buildPieChart(data) {
  const total = data.reduce((sum, row) => sum + Math.abs(row.values[0] || 0), 0) || 1;
  let angle = 0;
  const slices = data.map((row, index) => {
    const value = Math.abs(row.values[0] || 0);
    const endAngle = angle + (value / total) * 360;
    const middle = angle + (endAngle - angle) / 2;
    const [labelX, labelY] = polarToCartesian(330, 278, 172, middle);
    const path = piePath(330, 278, 145, angle, endAngle);
    angle = endAngle;
    return `
      <path d="${path}" fill="${CHART_COLORS[index % CHART_COLORS.length]}" stroke="#FFFFFF" stroke-width="3"/>
      <text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="18" font-weight="700" fill="#243F18">${Math.round((value / total) * 100)}%</text>
    `;
  }).join("");
  const legend = data.map((row, index) => `
    <rect x="575" y="${175 + index * 42}" width="22" height="22" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/>
    <text x="612" y="${193 + index * 42}" font-size="22" fill="#333333">${escapeSvg(row.label)}</text>
  `).join("");

  return `${slices}${legend}`;
}

function buildWaterfallChart(data, plot) {
  const steps = [];
  let running = 0;

  data.forEach((row, index) => {
    const value = row.values[0] || 0;
    const isTotal = index === 0 || index === data.length - 1;
    const start = isTotal ? 0 : running;
    const end = isTotal ? value : running + value;
    steps.push({ ...row, value, start, end, isTotal });
    running = end;
  });

  const minValue = Math.min(0, ...steps.flatMap((step) => [step.start, step.end]));
  const maxValue = Math.max(1, ...steps.flatMap((step) => [step.start, step.end]));
  const range = maxValue - minValue || 1;
  const groupWidth = plot.width / Math.max(steps.length, 1);
  const barWidth = Math.min(72, groupWidth * 0.58);
  const yFor = (value) => plot.y + plot.height - ((value - minValue) / range) * plot.height;

  const bars = steps.map((step, index) => {
    const x = plot.x + index * groupWidth + (groupWidth - barWidth) / 2;
    const y = Math.min(yFor(step.start), yFor(step.end));
    const height = Math.max(2, Math.abs(yFor(step.start) - yFor(step.end)));
    const color = step.isTotal ? "#476E2C" : step.value >= 0 ? "#8BC53D" : "#A5A5A5";
    const labelX = plot.x + index * groupWidth + groupWidth / 2;
    const connector = index < steps.length - 1
      ? `<line x1="${x + barWidth}" y1="${yFor(step.end)}" x2="${plot.x + (index + 1) * groupWidth + (groupWidth - barWidth) / 2}" y2="${yFor(step.end)}" stroke="#A5A5A5" stroke-width="2" stroke-dasharray="5 4"/>`
      : "";
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${color}"/>
      <text x="${labelX}" y="${y - 8}" text-anchor="middle" font-size="17" font-weight="700" fill="#476E2C">${escapeSvg(formatChartValue(step.end))}</text>
      <text x="${labelX}" y="${plot.y + plot.height + 32}" text-anchor="middle" font-size="16" fill="#6D6E71">${escapeSvg(step.label)}</text>
      ${connector}
    `;
  }).join("");

  return `${chartGrid(plot, minValue, maxValue)}${bars}`;
}

function buildChartSvg(field, chartConfig = {}) {
  const type = chartConfig.type || getDefaultChartType(field);
  const data = parseChartData(chartConfig.dataText || "", getDefaultChartData(field, type));
  const plot = { x: 86, y: 105, width: 780, height: 290 };
  const chart =
    type === "pie"
      ? buildPieChart(data)
      : type === "line"
        ? buildLineChart(data, plot)
        : type === "waterfall"
          ? buildWaterfallChart(data, plot)
          : buildBarChart(data, plot);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520">
    <rect width="960" height="520" fill="#FFFFFF"/>
    <text x="48" y="56" font-family="Calibri, Arial, sans-serif" font-size="28" font-weight="700" fill="#476E2C">${escapeSvg(getChartTitle(field))}</text>
    <line x1="48" y1="76" x2="912" y2="76" stroke="#8BC53D" stroke-width="3"/>
    <g font-family="Calibri, Arial, sans-serif">${chart}</g>
  </svg>`;
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getChartConfig(field, chartValues) {
  const saved = chartValues?.[field.id] || {};
  return {
    type: saved.type || getDefaultChartType(field),
    dataText: saved.dataText || "",
  };
}

function getChartDataUrl(field, chartValues) {
  return svgToDataUrl(buildChartSvg(field, getChartConfig(field, chartValues)));
}

function getElementContent(slideNumber, element, fieldsById, fieldValues, assetValues, chartValues, globalDetails) {
  if (!element?.text) return { kind: "text", text: "" };
  const fieldId = getElementFieldId(slideNumber, element);
  const field = fieldId ? fieldsById[fieldId] : null;

  if (field && isAssetField(field)) {
    const asset = assetValues?.[getAssetKey(field)];
    if (asset?.dataUrl) {
      return { kind: "image", dataUrl: asset.dataUrl, name: asset.name || field.label };
    }
  }

  if (field && isChartField(field)) {
    return { kind: "chart", dataUrl: getChartDataUrl(field, chartValues), name: field.label };
  }

  return {
    kind: "text",
    text: getElementDisplayText(slideNumber, element, fieldsById, fieldValues, globalDetails),
  };
}

function isFieldComplete(field, fieldValues, assetValues, chartValues, globalDetails) {
  if (isHandledByGlobalDetails(field)) return isResolvedByGlobalDetails(field, globalDetails);
  if (isAssetField(field)) return Boolean(assetValues?.[getAssetKey(field)]?.dataUrl);
  if (isChartField(field)) return Boolean(normalizeText(chartValues?.[field.id]?.dataText));
  return Boolean(normalizeText(fieldValues[field.id]));
}

function createDefaultQuestion(field) {
  if (isAssetField(field)) return `Please provide the ${field.label.toLowerCase()} or confirm what should be used.`;
  if (isChartField(field)) return `Please provide the source figures, labels, or notes needed to build ${field.label}.`;
  return `Please provide the information needed for ${field.label}.`;
}

function getSectionForSlide(slideNumber) {
  return NAV_SECTIONS.find((section) => section.slides.includes(slideNumber)) || BASIC_DETAILS_SECTION;
}

function buildQuestionnaireItem(field, existingItem = null) {
  const section = getSectionForSlide(field.slideNumber);
  const now = new Date().toISOString();

  return {
    ...(existingItem || {}),
    id: field.id,
    fieldId: field.id,
    slideNumber: field.slideNumber,
    sectionId: section.id,
    sectionTitle: section.title,
    label: field.label,
    fieldKind: getFieldKind(field),
    prompt: existingItem?.prompt || createDefaultQuestion(field),
    sourceText: field.text,
    status: existingItem?.clientNote ? "answered" : existingItem?.status || "open",
    archived: false,
    createdAt: existingItem?.createdAt || now,
    requestedAt: existingItem?.requestedAt || now,
    updatedAt: now,
  };
}

function normalizeQuestionnaireState(state) {
  return {
    version: 1,
    items: state?.items && typeof state.items === "object" ? state.items : {},
    createdAt: state?.createdAt || new Date().toISOString(),
    sentAt: state?.sentAt || "",
    sentBy: state?.sentBy || null,
    clientSubmittedAt: state?.clientSubmittedAt || "",
    clientSubmittedBy: state?.clientSubmittedBy || null,
    updatedAt: state?.updatedAt || "",
    updatedBy: state?.updatedBy || null,
  };
}

function getQuestionnaireItems(questionnaireState, { includeArchived = false } = {}) {
  return Object.values(questionnaireState?.items || {})
    .filter((item) => includeArchived || !item.archived)
    .sort((a, b) => {
      if (a.slideNumber !== b.slideNumber) return Number(a.slideNumber || 0) - Number(b.slideNumber || 0);
      return String(a.label || "").localeCompare(String(b.label || ""));
    });
}

function getQuestionnaireCounts(questionnaireState) {
  const items = getQuestionnaireItems(questionnaireState);
  return {
    total: items.length,
    answered: items.filter((item) => item.status === "answered" || normalizeText(item.clientNote)).length,
    resolved: items.filter((item) => item.status === "resolved").length,
  };
}

function makeBankQuestionId(sectionId, questionId) {
  return `${sectionId}:question:${questionId}`;
}

function makeCustomQuestionId(sectionId) {
  return `${sectionId}:custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function getQuestionBankForSection(sectionId) {
  return SECTION_QUESTION_BANK[sectionId] || [];
}

function buildQuestionBankItem(section, questionId, prompt, existingItem = null) {
  const now = new Date().toISOString();
  const id = makeBankQuestionId(section.id, questionId);

  return {
    ...(existingItem || {}),
    id,
    fieldId: existingItem?.fieldId || null,
    questionId,
    slideNumber: section.slides[0],
    sectionId: section.id,
    sectionTitle: section.title,
    label: existingItem?.label || prompt.slice(0, 72),
    fieldKind: "question",
    prompt: existingItem?.prompt || prompt,
    sourceText: existingItem?.sourceText || "",
    status: existingItem?.clientNote ? "answered" : existingItem?.status || "open",
    archived: false,
    createdAt: existingItem?.createdAt || now,
    requestedAt: existingItem?.requestedAt || now,
    updatedAt: now,
  };
}

function buildCustomQuestionItem(section, prompt, existingItem = null) {
  const now = new Date().toISOString();
  const id = existingItem?.id || makeCustomQuestionId(section.id);

  return {
    ...(existingItem || {}),
    id,
    fieldId: existingItem?.fieldId || null,
    questionId: existingItem?.questionId || null,
    slideNumber: section.slides[0],
    sectionId: section.id,
    sectionTitle: section.title,
    label: existingItem?.label || "Custom question",
    fieldKind: "custom",
    prompt,
    sourceText: existingItem?.sourceText || "",
    status: existingItem?.clientNote ? "answered" : existingItem?.status || "open",
    archived: false,
    custom: true,
    createdAt: existingItem?.createdAt || now,
    requestedAt: existingItem?.requestedAt || now,
    updatedAt: now,
  };
}

function parseTableText(text = "", rows = 0, cols = 0) {
  const lines = String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matrix = lines.map((line) => line.split("|").map((cell) => cell.trim()));

  return Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => matrix[rowIndex]?.[colIndex] ?? ""),
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function useElementWidth(ref) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current) return undefined;
    const element = ref.current;
    const update = () => setWidth(element.getBoundingClientRect().width || 0);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function getElementFieldId(slideNumber, element) {
  if (!element?.text || !containsTemplateToken(element.text)) return null;
  const [left, top, width, height] = element.bbox || [];
  if (!(width > 12 && height > 8 && left >= 0 && top >= 0)) return null;
  return makeFieldId(slideNumber, element);
}

function getElementDisplayText(slideNumber, element, fieldsById, fieldValues, globalDetails) {
  if (!element?.text) return "";
  const fieldId = getElementFieldId(slideNumber, element);
  const field = fieldId ? fieldsById[fieldId] : null;

  if (field) return getFieldValue(field, fieldValues, globalDetails);
  if (containsTemplateToken(element.text)) return applyGlobalDetails(element.text, globalDetails);
  return element.text;
}

function getVerticalAlignment(value) {
  if (value === "middle") return "center";
  if (value === "bottom") return "flex-end";
  return "flex-start";
}

function getHorizontalAlignment(value) {
  if (value === "center") return "center";
  if (value === "right") return "flex-end";
  return "flex-start";
}

function SlideCanvas({
  slideNumber,
  layout,
  fields,
  fieldValues,
  assetValues,
  chartValues,
  globalDetails,
  activeFieldId,
  onFieldFocus,
  onFieldChange,
  previewMode = false,
}) {
  const stageRef = useRef(null);
  const stageWidth = useElementWidth(stageRef);
  const scale = stageWidth > 0 ? stageWidth / SLIDE_WIDTH : 1;
  const fieldsById = useMemo(
    () => Object.fromEntries(fields.map((field) => [field.id, field])),
    [fields],
  );
  const elements = layout?.elements || [];
  const resolvedAssetValues = assetValues || {};
  const resolvedChartValues = chartValues || {};

  return (
    <div
      ref={stageRef}
      className="relative mx-auto w-full overflow-hidden bg-white shadow-card"
      style={{ aspectRatio: "16 / 9" }}
    >
      {elements.map((element) => {
        const [left = 0, top = 0, width = 0, height = 0] = element.bbox || [];
        const isRule = width === 0 || height === 0;
        const ruleWidth = Math.max(Number(element.lineWidth || 1) * scale, 1);
        const elementWidth = Math.max(width * scale, width === 0 ? ruleWidth : 1);
        const elementHeight = Math.max(height * scale, height === 0 ? ruleWidth : 1);
        const fieldId = getElementFieldId(slideNumber, element);
        const field = fieldId ? fieldsById[fieldId] : null;
        const isEditable = field && !previewMode && !isResolvedByGlobalDetails(field, globalDetails);
        const displayText = getElementDisplayText(
          slideNumber,
          element,
          fieldsById,
          fieldValues,
          globalDetails,
        );
        const style = field?.style || (element.text ? getElementStyle(element) : null);
        const fillColor = isRule
          ? cssColor(element.lineColor || element.fillColor, "transparent")
          : cssColor(element.fillColor, "transparent");
        const borderColor = !isRule && element.lineColor ? cssColor(element.lineColor, "#E5E7EB") : "transparent";
        const borderWidth = !isRule && element.lineColor ? Math.max(Number(element.lineWidth || 0) * scale, 0) : 0;
        const commonStyle = {
          left: left * scale,
          top: top * scale,
          width: elementWidth,
          height: elementHeight,
          zIndex: element.order || 1,
          backgroundColor: fillColor,
          border: borderWidth ? `${borderWidth}px solid ${borderColor}` : "none",
          borderRadius: element.geometry === "ellipse" ? "50%" : undefined,
        };

        if (element.kind === "table" && Array.isArray(element.cells)) {
          const tableText = field
            ? getFieldValue(field, fieldValues, globalDetails)
            : applyGlobalDetails(element.text, globalDetails);
          const matrix = parseTableText(tableText, element.rows, element.cols);

          return (
            <div
              key={`${slideNumber}-${element.order}-${element.id}`}
              className="absolute"
              onClick={() => {
                if (isEditable) onFieldFocus(field.id);
              }}
              style={{
                ...commonStyle,
                backgroundColor: "transparent",
                border:
                  isEditable && activeFieldId === field?.id
                    ? `${Math.max(2 * scale, 1)}px solid #8BC53D`
                    : "none",
              }}
            >
              {element.cells.map((cell) => {
                const [cellLeft = 0, cellTop = 0, cellWidth = 0, cellHeight = 0] = cell.bbox || [];
                const cellStyle = getElementStyle(cell);
                const cellInsets = cellStyle.insets || {};
                const rowIndex = Number(cell.row || 1) - 1;
                const colIndex = Number(cell.column || 1) - 1;
                const cellText = matrix[rowIndex]?.[colIndex] || applyGlobalDetails(cell.text, globalDetails);

                return (
                  <div
                    key={`${slideNumber}-${element.id}-cell-${cell.index}`}
                    className="absolute overflow-hidden"
                    style={{
                      left: cellLeft * scale - left * scale,
                      top: cellTop * scale - top * scale,
                      width: Math.max(cellWidth * scale, 1),
                      height: Math.max(cellHeight * scale, 1),
                      display: "flex",
                      alignItems: getVerticalAlignment(cellStyle.verticalAlignment),
                      justifyContent: getHorizontalAlignment(cellStyle.textAlign),
                      paddingTop: Math.max(Number(cellInsets.top || 0) * scale, 0),
                      paddingRight: Math.max(Number(cellInsets.right || 0) * scale, 0),
                      paddingBottom: Math.max(Number(cellInsets.bottom || 0) * scale, 0),
                      paddingLeft: Math.max(Number(cellInsets.left || 0) * scale, 0),
                      backgroundColor: cssColor(cell.fillColor, "transparent"),
                      border: `${Math.max(0.5 * scale, 0.5)}px solid ${cssColor(cell.lineColor, "#FFFFFF")}`,
                      fontFamily: cellStyle.fontFamily,
                      fontSize: Math.max(cellStyle.fontSize * scale, 5),
                      fontWeight: cellStyle.fontWeight,
                      fontStyle: cellStyle.fontStyle,
                      color: cellStyle.color,
                      textAlign: cellStyle.textAlign,
                      lineHeight: cellStyle.lineHeight,
                      whiteSpace: "pre-wrap",
                      letterSpacing: 0,
                    }}
                  >
                    <span className="block w-full">{cellText}</span>
                  </div>
                );
              })}
            </div>
          );
        }

        if (!element.text) {
          return (
            <div
              key={`${slideNumber}-${element.order}-${element.id}`}
              className="absolute"
              style={commonStyle}
            />
          );
        }

        const insets = style.insets || {};
        const textStyle = {
          ...commonStyle,
          display: "flex",
          alignItems: getVerticalAlignment(style.verticalAlignment),
          justifyContent: getHorizontalAlignment(style.textAlign),
          paddingTop: Math.max(Number(insets.top || 0) * scale, 0),
          paddingRight: Math.max(Number(insets.right || 0) * scale, 0),
          paddingBottom: Math.max(Number(insets.bottom || 0) * scale, 0),
          paddingLeft: Math.max(Number(insets.left || 0) * scale, 0),
          fontFamily: style.fontFamily,
          fontSize: Math.max(style.fontSize * scale, 5),
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          color: style.color,
          textAlign: style.textAlign,
          lineHeight: style.lineHeight,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
          letterSpacing: 0,
        };
        const content = getElementContent(
          slideNumber,
          element,
          fieldsById,
          fieldValues,
          resolvedAssetValues,
          resolvedChartValues,
          globalDetails,
        );

        if ((content.kind === "image" || content.kind === "chart") && content.dataUrl) {
          return (
            <div
              key={`${slideNumber}-${element.order}-${element.id}`}
              className={`absolute overflow-hidden ${
                !previewMode && field ? "cursor-pointer" : ""
              }`}
              onClick={() => {
                if (!previewMode && field) onFieldFocus(field.id);
              }}
              style={{
                ...commonStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: fillColor === "transparent" ? "#FFFFFF" : fillColor,
                padding: Math.max(4 * scale, 2),
                boxShadow:
                  !previewMode && field && activeFieldId === field.id
                    ? "0 0 0 2px rgba(139, 197, 61, 0.5)"
                    : undefined,
              }}
            >
              <img
                src={content.dataUrl}
                alt={content.name || field?.label || "CIM visual"}
                className="block h-full w-full object-contain"
                draggable={false}
              />
            </div>
          );
        }

        if (field && isMediaField(field)) {
          return (
            <button
              key={`${slideNumber}-${element.order}-${element.id}`}
              type="button"
              onClick={() => onFieldFocus(field.id)}
              className={`absolute overflow-hidden rounded-[2px] border border-dashed outline-none transition ${
                activeFieldId === field.id
                  ? "border-[#8BC53D] ring-2 ring-[#8BC53D]/30"
                  : "border-[#8BC53D]/60 hover:border-[#8BC53D]"
              }`}
              style={{
                ...textStyle,
                backgroundColor: fillColor === "transparent" ? "rgba(255,255,255,0.88)" : fillColor,
              }}
            >
              <span className="block w-full">{displayText}</span>
            </button>
          );
        }

        if (!isEditable) {
          return (
            <div
              key={`${slideNumber}-${element.order}-${element.id}`}
              className="absolute"
              style={textStyle}
            >
              <span className="block w-full">{displayText}</span>
            </div>
          );
        }

        const userValue = fieldValues[field.id] || "";

        return (
          <textarea
            key={`${slideNumber}-${element.order}-${element.id}`}
            aria-label={field.label}
            value={userValue}
            onFocus={() => onFieldFocus(field.id)}
            onClick={() => onFieldFocus(field.id)}
            onChange={(event) => onFieldChange(field.id, event.target.value)}
            className={`absolute resize-none overflow-hidden rounded-[2px] border px-1 py-0.5 outline-none transition ${
              activeFieldId === field.id
                ? "border-[#8BC53D] ring-2 ring-[#8BC53D]/30"
                : "border-[#8BC53D]/45 hover:border-[#8BC53D]"
            }`}
            style={{
              ...textStyle,
              display: "block",
              backgroundColor: fillColor === "transparent" ? "rgba(255,255,255,0.76)" : fillColor,
            }}
            placeholder={displayText}
            spellCheck={false}
          />
        );
      })}
    </div>
  );
}

function SectionDrawer({
  sections,
  activeSectionId,
  fieldValues,
  assetValues,
  chartValues,
  fieldsBySlide,
  globalDetails,
  onSelectSection,
}) {
  return (
    <aside className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto rounded-lg border border-border bg-white p-3 shadow-card">
      <div className="mb-3 flex items-center gap-2 px-1 text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">
        <PanelLeft size={14} />
        CIM Sections
      </div>
      <nav className="space-y-1">
        {sections.map((section) => {
          const isBasic = section.type === "basic";
          const sectionFields = section.slides.flatMap((slide) => fieldsBySlide[slide] || []);
          const editableFields = sectionFields.filter(
            (field) => !isResolvedByGlobalDetails(field, globalDetails),
          );
          const basicCompleted = BASIC_DETAIL_FIELDS.filter(([key]) => normalizeText(globalDetails[key])).length;
          const completed = isBasic
            ? basicCompleted +
              editableFields.filter((field) =>
                isFieldComplete(field, fieldValues, assetValues, chartValues, globalDetails),
              ).length
            : editableFields.filter((field) =>
                isFieldComplete(field, fieldValues, assetValues, chartValues, globalDetails),
              ).length;
          const total = (isBasic ? BASIC_DETAIL_FIELDS.length : 0) + editableFields.length;
          const isActive = activeSectionId === section.id;

          return (
            <button
              key={section.id}
              onClick={() => onSelectSection(section.id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition ${
                isActive
                  ? "bg-[#EEF6E0] text-[#476E2C]"
                  : "text-[#6D6E71] hover:bg-[#F0F7E6] hover:text-[#1A1A2E]"
              }`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#476E2C] text-xs font-bold text-white">
                {section.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{section.title}</span>
                <span className="block text-[11px] text-[#A5A5A5]">
                  {completed}/{total} fields
                </span>
              </span>
              <ChevronRight size={14} className={isActive ? "text-[#8BC53D]" : "text-[#A5A5A5]"} />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function GlobalDetailsPanel({ globalDetails, onChange, compact = false }) {
  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-card">
      <h3 className="text-sm font-bold text-[#050505]">Basic Details</h3>
      <div className={`mt-4 grid gap-3 ${compact ? "" : "md:grid-cols-2"}`}>
        {BASIC_DETAIL_FIELDS.map(([key, label]) => (
          <label key={key} className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
              {label}
            </span>
            <input
              value={globalDetails[key] || ""}
              onChange={(event) => onChange(key, event.target.value)}
              className="theme-input h-9 text-[13px]"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function fieldCardClass(active) {
  return `block rounded-md border p-3 transition ${
    active ? "border-[#8BC53D] bg-[#F7FBF1]" : "border-border bg-white"
  }`;
}

function AssetFieldControl({
  field,
  asset,
  active,
  onFieldFocus,
  onAssetUpload,
  onAssetRemove,
  questionnaireItem,
  onQuestionnaireToggle,
  onQuestionPromptChange,
}) {
  return (
    <div
      className={fieldCardClass(active)}
      onFocusCapture={() => onFieldFocus(field.id)}
      onClick={() => onFieldFocus(field.id)}
    >
      <span className="mb-2 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
        {field.label}
      </span>
      <div className="flex items-center gap-3">
        <div className="flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-[#F7F8FA]">
          {asset?.dataUrl ? (
            <img src={asset.dataUrl} alt={asset.name || field.label} className="h-full w-full object-contain" />
          ) : (
            <ImagePlus size={24} className="text-[#A5A5A5]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-[#050505]">
            {asset?.name || "PNG or JPG"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]">
              <Upload size={13} />
              Upload
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onAssetUpload(field, file);
                  event.target.value = "";
                }}
              />
            </label>
            {asset?.dataUrl && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAssetRemove(field);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs font-bold text-[#6D6E71] transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 size={13} />
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
      <QuestionnaireFieldActions
        field={field}
        item={questionnaireItem}
        onToggle={onQuestionnaireToggle}
        onPromptChange={onQuestionPromptChange}
      />
    </div>
  );
}

function ChartFieldControl({
  field,
  active,
  chartValues,
  onFieldFocus,
  onChartChange,
  questionnaireItem,
  onQuestionnaireToggle,
  onQuestionPromptChange,
}) {
  const config = getChartConfig(field, chartValues);
  const dataUrl = getChartDataUrl(field, chartValues);

  return (
    <div
      className={fieldCardClass(active)}
      onFocusCapture={() => onFieldFocus(field.id)}
      onClick={() => onFieldFocus(field.id)}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="block min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
          {field.label}
        </span>
        <BarChart3 size={15} className="shrink-0 text-[#8BC53D]" />
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-white">
        <img src={dataUrl} alt={field.label} className="aspect-[16/9] w-full object-contain" draggable={false} />
      </div>
      <div className="mt-3 grid grid-cols-[104px_minmax(0,1fr)] gap-2">
        <select
          value={config.type}
          onChange={(event) => onChartChange(field.id, { ...config, type: event.target.value })}
          className="h-9 rounded-md border border-border bg-white px-2 text-xs font-semibold text-[#050505] outline-none focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
        >
          {CHART_TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <textarea
          value={config.dataText}
          onChange={(event) => onChartChange(field.id, { ...config, dataText: event.target.value })}
          placeholder={getDefaultChartData(field, config.type)}
          className="min-h-[92px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-[12px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
          spellCheck={false}
        />
      </div>
      <QuestionnaireFieldActions
        field={field}
        item={questionnaireItem}
        onToggle={onQuestionnaireToggle}
        onPromptChange={onQuestionPromptChange}
      />
    </div>
  );
}

function QuestionnaireStatusPill({ status }) {
  const meta = QUESTIONNAIRE_STATUS_META[status] || QUESTIONNAIRE_STATUS_META.open;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]"
      style={{ backgroundColor: meta.bg, color: meta.color }}
    >
      {meta.label}
    </span>
  );
}

function QuestionnaireFieldActions({ field, item, onToggle, onPromptChange }) {
  const requested = Boolean(item && !item.archived);

  return (
    <div className="mt-3 rounded-md border border-dashed border-border bg-[#FAFBFC] p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
          <MessageSquareText size={13} className="text-[#8BC53D]" />
          Client Questionnaire
        </div>
        {requested ? <QuestionnaireStatusPill status={item.status} /> : null}
      </div>

      {requested ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={item.prompt || ""}
            onChange={(event) => onPromptChange(field, event.target.value)}
            className="min-h-[58px] w-full resize-y rounded-md border border-border bg-white px-2.5 py-2 text-[12px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            spellCheck={false}
          />
          {normalizeText(item.clientNote) && (
            <div className="rounded-md bg-white p-2 text-[12px] leading-snug text-[#050505]">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                Client note
              </p>
              <p className="line-clamp-3 whitespace-pre-wrap">{item.clientNote}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => onToggle(field)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs font-bold text-[#6D6E71] transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 size={13} />
            Remove request
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(field)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
        >
          <Send size={13} />
          Ask client
        </button>
      )}
    </div>
  );
}

function FieldPanel({
  activeSlide,
  fields,
  fieldValues,
  assetValues,
  chartValues,
  questionnaireState,
  globalDetails,
  activeFieldId,
  onFieldFocus,
  onFieldChange,
  onAssetUpload,
  onAssetRemove,
  onChartChange,
  onQuestionnaireToggle,
  onQuestionPromptChange,
}) {
  const editableFields = fields.filter(
    (field) => !isResolvedByGlobalDetails(field, globalDetails),
  );

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-[#050505]">Slide {activeSlide} Fields</h3>
        <span className="rounded-md bg-[#EEF6E0] px-2 py-1 text-[11px] font-bold text-[#476E2C]">
          {editableFields.length}
        </span>
      </div>

      <div className="mt-3 max-h-[520px] space-y-3 overflow-y-auto pr-1">
        {editableFields.length > 0 ? (
          editableFields.map((field) => {
            const questionnaireItem = questionnaireState?.items?.[field.id];
            if (isAssetField(field)) {
              return (
                <AssetFieldControl
                  key={field.id}
                  field={field}
                  asset={assetValues[getAssetKey(field)]}
                  active={activeFieldId === field.id}
                  onFieldFocus={onFieldFocus}
                  onAssetUpload={onAssetUpload}
                  onAssetRemove={onAssetRemove}
                  questionnaireItem={questionnaireItem}
                  onQuestionnaireToggle={onQuestionnaireToggle}
                  onQuestionPromptChange={onQuestionPromptChange}
                />
              );
            }

            if (isChartField(field)) {
              return (
                <ChartFieldControl
                  key={field.id}
                  field={field}
                  active={activeFieldId === field.id}
                  chartValues={chartValues}
                  onFieldFocus={onFieldFocus}
                  onChartChange={onChartChange}
                  questionnaireItem={questionnaireItem}
                  onQuestionnaireToggle={onQuestionnaireToggle}
                  onQuestionPromptChange={onQuestionPromptChange}
                />
              );
            }

            return (
              <label
                key={field.id}
                className={fieldCardClass(activeFieldId === field.id)}
                onFocus={() => onFieldFocus(field.id)}
              >
                <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                  {field.label}
                </span>
                <textarea
                  value={fieldValues[field.id] || ""}
                  onChange={(event) => onFieldChange(field.id, event.target.value)}
                  placeholder={applyGlobalDetails(field.text, globalDetails)}
                  className="min-h-[86px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-[13px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                  spellCheck={false}
                />
                <QuestionnaireFieldActions
                  field={field}
                  item={questionnaireItem}
                  onToggle={onQuestionnaireToggle}
                  onPromptChange={onQuestionPromptChange}
                />
              </label>
            );
          })
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-[#A5A5A5]">
            No editable placeholders on this slide.
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewModal({
  open,
  previewSlideIndex,
  onClose,
  onSlideIndexChange,
  layouts,
  fieldsBySlide,
  fieldValues,
  assetValues,
  chartValues,
  globalDetails,
}) {
  if (!open) return null;

  const activeSlide = PREVIEW_SLIDES[previewSlideIndex] || PREVIEW_SLIDES[0];
  const prevDisabled = previewSlideIndex <= 0;
  const nextDisabled = previewSlideIndex >= PREVIEW_SLIDES.length - 1;

  return (
    <div className="fixed inset-0 z-[99999] bg-[#111827]/70 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-lg bg-[#F7F8FA] shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <FileText size={17} className="text-[#476E2C]" />
            <div>
              <h2 className="text-sm font-bold text-[#050505]">PPT Preview</h2>
              <p className="text-xs text-[#6D6E71]">
                Slide {previewSlideIndex + 1} of {PREVIEW_SLIDES.length}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-[#6D6E71] transition hover:bg-bg-page hover:text-[#050505]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[180px_minmax(0,1fr)]">
          <div className="hidden overflow-y-auto rounded-lg border border-border bg-white p-2 lg:block">
            <div className="space-y-2">
              {PREVIEW_SLIDES.map((slideNumber, index) => (
                <button
                  key={slideNumber}
                  onClick={() => onSlideIndexChange(index)}
                  className={`block w-full overflow-hidden rounded-md border text-left transition ${
                    index === previewSlideIndex
                      ? "border-[#8BC53D] ring-2 ring-[#8BC53D]/25"
                      : "border-border hover:border-[#8BC53D]/60"
                  }`}
                >
                  <div className="pointer-events-none">
                    <SlideCanvas
                      slideNumber={slideNumber}
                      layout={layouts[slideNumber]}
                      fields={fieldsBySlide[slideNumber] || []}
                      fieldValues={fieldValues}
                      assetValues={assetValues}
                      chartValues={chartValues}
                      globalDetails={globalDetails}
                      previewMode
                    />
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
              <SlideCanvas
                slideNumber={activeSlide}
                layout={layouts[activeSlide]}
                fields={fieldsBySlide[activeSlide] || []}
                fieldValues={fieldValues}
                assetValues={assetValues}
                chartValues={chartValues}
                globalDetails={globalDetails}
                previewMode
              />
            </div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                onClick={() => onSlideIndexChange(Math.max(0, previewSlideIndex - 1))}
                disabled={prevDisabled}
                className="theme-btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft size={16} />
                Previous
              </button>
              <button
                onClick={() =>
                  onSlideIndexChange(Math.min(PREVIEW_SLIDES.length - 1, previewSlideIndex + 1))
                }
                disabled={nextDisabled}
                className="theme-btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionnaireReviewModal({
  onClose,
  sections,
  questionnaireState,
  onSendQuestionnaire,
  onUseClientNote,
  onCopyNote,
}) {
  const [builderSectionId, setBuilderSectionId] = useState(BASIC_DETAILS_SECTION.id);
  const [draftItems, setDraftItems] = useState(() => normalizeQuestionnaireState(questionnaireState).items);
  const [customQuestion, setCustomQuestion] = useState("");
  const activeSection =
    sections.find((section) => section.id === builderSectionId) || BASIC_DETAILS_SECTION;
  const sectionQuestions = getQuestionBankForSection(activeSection.id);
  const activeDraftState = normalizeQuestionnaireState({
    ...questionnaireState,
    items: draftItems,
  });
  const items = getQuestionnaireItems(activeDraftState);
  const sectionItems = items.filter((item) => item.sectionId === activeSection.id);
  const counts = getQuestionnaireCounts(activeDraftState);
  const selectedForSection = sectionItems.length;

  const isQuestionSelected = (questionId) => {
    const id = makeBankQuestionId(activeSection.id, questionId);
    return Boolean(draftItems[id] && !draftItems[id].archived);
  };

  const toggleQuestion = (questionId, prompt) => {
    const id = makeBankQuestionId(activeSection.id, questionId);
    setDraftItems((previous) => {
      const current = previous[id];
      if (current && !current.archived) {
        return {
          ...previous,
          [id]: {
            ...current,
            archived: true,
            status: "resolved",
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return {
        ...previous,
        [id]: buildQuestionBankItem(activeSection, questionId, prompt, current),
      };
    });
  };

  const addCustomQuestion = () => {
    const prompt = customQuestion.trim();
    if (!prompt) return;
    const item = buildCustomQuestionItem(activeSection, prompt);
    setDraftItems((previous) => ({
      ...previous,
      [item.id]: item,
    }));
    setCustomQuestion("");
  };

  const updatePrompt = (itemId, prompt) => {
    setDraftItems((previous) => {
      const current = previous[itemId];
      if (!current) return previous;
      return {
        ...previous,
        [itemId]: {
          ...current,
          prompt,
          label: current.custom ? "Custom question" : current.label,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  };

  const updateStatus = (itemId, status) => {
    setDraftItems((previous) => {
      const current = previous[itemId];
      if (!current) return previous;
      const nextStatus = status === "open" && normalizeText(current.clientNote) ? "answered" : status;
      return {
        ...previous,
        [itemId]: {
          ...current,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  };

  const archiveItem = (itemId) => {
    setDraftItems((previous) => {
      const current = previous[itemId];
      if (!current) return previous;
      return {
        ...previous,
        [itemId]: {
          ...current,
          archived: true,
          status: "resolved",
          updatedAt: new Date().toISOString(),
        },
      };
    });
  };

  const sendQuestionnaire = () => {
    onSendQuestionnaire({
      ...questionnaireState,
      items: draftItems,
      sentAt: new Date().toISOString(),
    });
  };

  return (
    <div className="fixed inset-0 z-[99999] bg-[#111827]/70 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-lg bg-[#F7F8FA] shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <ClipboardList size={17} className="text-[#476E2C]" />
            <div>
              <h2 className="text-sm font-bold text-[#050505]">CIM Questionnaire</h2>
              <p className="text-xs text-[#6D6E71]">
                {counts.total} selected · {counts.answered} answered · {counts.resolved} resolved
                {questionnaireState.sentAt ? ` · Sent ${new Date(questionnaireState.sentAt).toLocaleString("en-IN")}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={sendQuestionnaire}
              className="theme-btn-primary"
            >
              <Send size={16} />
              Send Questionnaire
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-2 text-[#6D6E71] transition hover:bg-bg-page hover:text-[#050505]"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[230px_minmax(0,1fr)_420px]">
          <aside className="min-h-0 overflow-y-auto rounded-lg border border-border bg-white p-3 shadow-card">
            <p className="mb-3 px-1 text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">
              Select Section
            </p>
            <div className="space-y-1">
              {sections.map((section) => {
                const sectionCount = items.filter((item) => item.sectionId === section.id).length;
                const active = activeSection.id === section.id;

                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setBuilderSectionId(section.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left transition ${
                      active
                        ? "bg-[#EEF6E0] text-[#476E2C]"
                        : "text-[#6D6E71] hover:bg-[#F0F7E6] hover:text-[#050505]"
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#476E2C] text-xs font-bold text-white">
                      {section.number}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{section.title}</span>
                      <span className="block text-[11px] text-[#A5A5A5]">{sectionCount} selected</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto rounded-lg border border-border bg-white p-4 shadow-card">
            <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#8BC53D]">
                  {activeSection.number === "BD" ? "Basic Details" : `Section ${activeSection.number}`}
                </p>
                <h3 className="mt-1 text-lg font-bold text-[#050505]">{activeSection.title}</h3>
                <p className="mt-1 text-sm text-[#6D6E71]">
                  Select the questions to send to the client for this section.
                </p>
              </div>
              <span className="rounded-md bg-[#EEF6E0] px-3 py-2 text-xs font-bold text-[#476E2C]">
                {selectedForSection} selected
              </span>
            </div>

            <div className="mt-4 space-y-2">
              {sectionQuestions.map(([questionId, prompt]) => {
                const selected = isQuestionSelected(questionId);
                const itemId = makeBankQuestionId(activeSection.id, questionId);
                const item = draftItems[itemId];

                return (
                  <div
                    key={questionId}
                    className={`rounded-lg border p-3 transition ${
                      selected ? "border-[#8BC53D] bg-[#F7FBF1]" : "border-border bg-white"
                    }`}
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleQuestion(questionId, prompt)}
                        className="mt-1 h-4 w-4 accent-[#8BC53D]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold leading-snug text-[#050505]">
                          {prompt}
                        </span>
                      </span>
                    </label>
                    {selected && item && (
                      <textarea
                        value={item.prompt || ""}
                        onChange={(event) => updatePrompt(item.id, event.target.value)}
                        className="mt-3 min-h-[72px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-[13px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                        spellCheck={false}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-5 rounded-lg border border-dashed border-[#8BC53D]/50 bg-[#F7FBF1] p-4">
              <div className="flex items-center gap-2">
                <Plus size={16} className="text-[#476E2C]" />
                <h4 className="text-sm font-bold text-[#050505]">Add custom question</h4>
              </div>
              <textarea
                value={customQuestion}
                onChange={(event) => setCustomQuestion(event.target.value)}
                placeholder={`Ask for extra information related to ${activeSection.title}...`}
                className="mt-3 min-h-[86px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-sm leading-relaxed text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={addCustomQuestion}
                disabled={!customQuestion.trim()}
                className="theme-btn-secondary mt-3 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={16} />
                Add Question
              </button>
            </div>
          </section>

          <aside className="min-h-0 overflow-y-auto rounded-lg border border-border bg-white p-4 shadow-card">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-[#050505]">Selected Questions & Answers</h3>
                <p className="mt-1 text-xs text-[#6D6E71]">
                  Review client answers after submission.
                </p>
              </div>
              <ClipboardList size={18} className="text-[#8BC53D]" />
            </div>

            {items.length > 0 ? (
              <div className="space-y-3">
                {items.map((item) => {
                const note = normalizeText(item.clientNote);
                const canUseNote = note && item.fieldKind === "text";

                return (
                  <article key={item.id} className="rounded-lg border border-border bg-[#FAFBFC] p-3">
                    <div className="flex flex-col gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <QuestionnaireStatusPill status={item.status} />
                          <span className="text-xs font-semibold text-[#6D6E71]">
                            {item.sectionTitle}
                          </span>
                        </div>
                        <h3 className="mt-2 text-sm font-bold text-[#050505]">{item.label}</h3>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[#6D6E71]">
                          {item.prompt}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {canUseNote && (
                          <button
                            type="button"
                            onClick={() => onUseClientNote(item)}
                            className="theme-btn-secondary h-9 px-3 text-xs"
                          >
                            <FileText size={14} />
                            Use Note
                          </button>
                        )}
                        {note && (
                          <button
                            type="button"
                            onClick={() => onCopyNote(item)}
                            className="theme-btn-secondary h-9 px-3 text-xs"
                          >
                            <Copy size={14} />
                            Copy
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => updateStatus(item.id, item.status === "resolved" ? "open" : "resolved")}
                          className="theme-btn-secondary h-9 px-3 text-xs"
                        >
                          <CheckCircle2 size={14} />
                          {item.status === "resolved" ? "Reopen" : "Resolve"}
                        </button>
                        <button
                          type="button"
                          onClick={() => archiveItem(item.id)}
                          className="theme-btn-secondary h-9 px-3 text-xs text-red-600 hover:border-red-200 hover:bg-red-50"
                        >
                          <Trash2 size={14} />
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 rounded-md border border-border bg-white p-3">
                      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                        Client response
                      </p>
                      {note ? (
                        <div>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#050505]">
                            {item.clientNote}
                          </p>
                          <p className="mt-2 text-xs text-[#A5A5A5]">
                            Updated {item.clientUpdatedAt ? new Date(item.clientUpdatedAt).toLocaleString("en-IN") : "recently"}
                            {item.clientUpdatedBy?.name ? ` by ${item.clientUpdatedBy.name}` : ""}
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-[#A5A5A5]">No client note yet.</p>
                      )}
                    </div>
                  </article>
                );
              })}
              </div>
          ) : (
            <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-white text-center">
              <div>
                <ClipboardList size={30} className="mx-auto mb-3 text-[#8BC53D]" />
                <h3 className="text-sm font-bold text-[#050505]">No selected questions yet</h3>
                <p className="mt-1 text-sm text-[#6D6E71]">
                  Select prepared questions or add a custom question.
                </p>
              </div>
            </div>
          )}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceCimPrep() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [company, setCompany] = useState(null);
  const [layouts, setLayouts] = useState({});
  const [globalDetails, setGlobalDetails] = useState(() => createDefaultGlobalDetails());
  const [fieldValues, setFieldValues] = useState({});
  const [assetValues, setAssetValues] = useState({});
  const [chartValues, setChartValues] = useState({});
  const [questionnaireState, setQuestionnaireState] = useState(() => normalizeQuestionnaireState());
  const [activeSectionId, setActiveSectionId] = useState(BASIC_DETAILS_SECTION.id);
  const [activeSlide, setActiveSlide] = useState(BASIC_DETAILS_SECTION.slides[0]);
  const [activeFieldId, setActiveFieldId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSlideIndex, setPreviewSlideIndex] = useState(0);
  const [questionnaireOpen, setQuestionnaireOpen] = useState(false);

  const fieldsBySlide = useMemo(() => {
    const result = {};
    for (let slideNumber = 1; slideNumber <= TEMPLATE_SLIDE_COUNT; slideNumber += 1) {
      result[slideNumber] = extractTemplateFields(slideNumber, layouts[slideNumber]);
    }
    return result;
  }, [layouts]);

  const activeSection = useMemo(
    () => NAV_SECTIONS.find((section) => section.id === activeSectionId) || BASIC_DETAILS_SECTION,
    [activeSectionId],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadCompany() {
      try {
        const payload = await getCompanyRequest(clientId);
        if (cancelled) return;
        setCompany(payload);
        setGlobalDetails((previous) => ({
          ...createDefaultGlobalDetails(payload),
          ...previous,
          companyName: previous.companyName || payload?.name || "",
          companyLegalName: previous.companyLegalName || payload?.name || "",
          projectName: previous.projectName || payload?.project_name || payload?.name || "",
          descriptor: previous.descriptor || (payload?.industry ? `${payload.industry} business` : ""),
        }));
      } catch {
        if (!cancelled) setCompany(null);
      }
    }

    loadCompany();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;

    async function loadLayouts() {
      try {
        const entries = await Promise.all(
          Array.from({ length: TEMPLATE_SLIDE_COUNT }, async (_, index) => {
            const slideNumber = index + 1;
            const response = await fetch(getSlideLayoutPath(slideNumber), { cache: "no-store" });
            if (!response.ok) return [slideNumber, null];
            return [slideNumber, await response.json()];
          }),
        );
        if (!cancelled) setLayouts(Object.fromEntries(entries));
      } catch {
        if (!cancelled) setLayouts({});
      }
    }

    loadLayouts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSavedState() {
      setLoading(true);
      const localKey = getLocalStorageKey(clientId);

      try {
        const payload = await getWorkspacePageStateRequest(PAGE_KEY, { clientId });
        if (cancelled) return;
        const state = payload?.state || null;
        if (state) {
          setGlobalDetails((previous) => ({ ...previous, ...(state.globalDetails || {}) }));
          setFieldValues(state.fieldValues || {});
          setAssetValues(state.assetValues || {});
          setChartValues(state.chartValues || {});
          setUpdatedAt(payload?.updatedAt || state.updatedAt || "");
          window.localStorage.setItem(localKey, JSON.stringify(state));
        } else {
          const local = window.localStorage.getItem(localKey);
          if (local) {
            const parsed = JSON.parse(local);
            setGlobalDetails((previous) => ({ ...previous, ...(parsed.globalDetails || {}) }));
            setFieldValues(parsed.fieldValues || {});
            setAssetValues(parsed.assetValues || {});
            setChartValues(parsed.chartValues || {});
            setUpdatedAt(parsed.updatedAt || "");
          }
        }
      } catch {
        try {
          const local = window.localStorage.getItem(localKey);
          if (local && !cancelled) {
            const parsed = JSON.parse(local);
            setGlobalDetails((previous) => ({ ...previous, ...(parsed.globalDetails || {}) }));
            setFieldValues(parsed.fieldValues || {});
            setAssetValues(parsed.assetValues || {});
            setChartValues(parsed.chartValues || {});
            setUpdatedAt(parsed.updatedAt || "");
          }
        } catch {
          // Ignore malformed local drafts.
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSavedState();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;

    async function loadQuestionnaireState() {
      const localKey = getQuestionnaireLocalStorageKey(clientId);

      try {
        const payload = await getCimQuestionnaireRequest({ clientId });
        if (cancelled) return;
        const state = normalizeQuestionnaireState(payload?.state || {});
        setQuestionnaireState(state);
        window.localStorage.setItem(localKey, JSON.stringify(state));
      } catch {
        try {
          const local = window.localStorage.getItem(localKey);
          if (local && !cancelled) {
            setQuestionnaireState(normalizeQuestionnaireState(JSON.parse(local)));
          }
        } catch {
          // Ignore malformed local questionnaire drafts.
        }
      }
    }

    loadQuestionnaireState();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const handleSectionSelect = useCallback((sectionId) => {
    const nextSection = NAV_SECTIONS.find((section) => section.id === sectionId) || BASIC_DETAILS_SECTION;
    setActiveSectionId(sectionId);
    setActiveSlide(nextSection.slides[0] || null);
    setActiveFieldId("");
  }, []);

  const handleGlobalChange = useCallback((key, value) => {
    setGlobalDetails((previous) => ({ ...previous, [key]: value }));
  }, []);

  const handleFieldChange = useCallback((fieldId, value) => {
    setFieldValues((previous) => ({ ...previous, [fieldId]: value }));
  }, []);

  const handleAssetUpload = useCallback(async (field, file) => {
    if (!file.type || !["image/png", "image/jpeg"].includes(file.type)) {
      showToast({
        type: "error",
        title: "Logo Upload Failed",
        message: "Please upload a PNG or JPG image.",
      });
      return;
    }

    if (file.size > 4 * 1024 * 1024) {
      showToast({
        type: "error",
        title: "Logo Upload Failed",
        message: "Please use an image under 4 MB.",
      });
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setAssetValues((previous) => ({
        ...previous,
        [getAssetKey(field)]: {
          dataUrl,
          name: file.name,
          mimeType: file.type,
          updatedAt: new Date().toISOString(),
        },
      }));
      setActiveFieldId(field.id);
    } catch {
      showToast({
        type: "error",
        title: "Logo Upload Failed",
        message: "The selected image could not be read.",
      });
    }
  }, [showToast]);

  const handleAssetRemove = useCallback((field) => {
    setAssetValues((previous) => {
      const next = { ...previous };
      delete next[getAssetKey(field)];
      return next;
    });
    setActiveFieldId(field.id);
  }, []);

  const handleChartChange = useCallback((fieldId, nextConfig) => {
    setChartValues((previous) => ({
      ...previous,
      [fieldId]: {
        ...(previous[fieldId] || {}),
        ...nextConfig,
      },
    }));
    setActiveFieldId(fieldId);
  }, []);

  const persistQuestionnaireState = useCallback(async (nextState, toastOptions = null) => {
    const state = normalizeQuestionnaireState(nextState);
    const localKey = getQuestionnaireLocalStorageKey(clientId);
    window.localStorage.setItem(localKey, JSON.stringify(state));

    try {
      const payload = await saveCimQuestionnaireRequest(state, { clientId });
      const savedState = normalizeQuestionnaireState(payload?.state || state);
      setQuestionnaireState(savedState);
      window.localStorage.setItem(localKey, JSON.stringify(savedState));
      if (toastOptions?.success) {
        showToast({
          type: "success",
          title: toastOptions.success,
          message: toastOptions.message || "The client questionnaire was updated.",
        });
      }
    } catch {
      if (toastOptions?.local) {
        showToast({
          type: "info",
          title: toastOptions.local,
          message: "Backend save failed, so a local questionnaire draft was kept in this browser.",
        });
      }
    }
  }, [clientId, showToast]);

  const updateQuestionnaireState = useCallback((updater, toastOptions = null) => {
    const nextState = normalizeQuestionnaireState(updater(normalizeQuestionnaireState(questionnaireState)));
    setQuestionnaireState(nextState);
    void persistQuestionnaireState(nextState, toastOptions);
  }, [persistQuestionnaireState, questionnaireState]);

  const handleQuestionnaireToggle = useCallback((field) => {
    updateQuestionnaireState((previous) => {
      const current = previous.items[field.id];
      const nextItems = { ...previous.items };

      if (current && !current.archived) {
        nextItems[field.id] = {
          ...current,
          archived: true,
          status: "resolved",
          updatedAt: new Date().toISOString(),
        };
      } else {
        nextItems[field.id] = buildQuestionnaireItem(field, current);
      }

      return { ...previous, items: nextItems };
    }, {
      success: "Questionnaire Updated",
      local: "Questionnaire Saved Locally",
    });
    setActiveFieldId(field.id);
  }, [updateQuestionnaireState]);

  const handleQuestionPromptChange = useCallback((field, prompt) => {
    updateQuestionnaireState((previous) => {
      const current = previous.items[field.id] || buildQuestionnaireItem(field);
      return {
        ...previous,
        items: {
          ...previous.items,
          [field.id]: {
            ...current,
            prompt,
            archived: false,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    });
  }, [updateQuestionnaireState]);

  const handleSendQuestionnaire = useCallback((nextState) => {
    const now = new Date().toISOString();
    const activeItems = Object.values(nextState.items || {}).filter((item) => !item.archived);

    updateQuestionnaireState((previous) => ({
      ...previous,
      ...nextState,
      items: nextState.items || {},
      sentAt: nextState.sentAt || now,
      updatedAt: now,
    }), {
      success: "Questionnaire Sent",
      local: "Questionnaire Saved Locally",
      message: `${activeItems.length} question${activeItems.length === 1 ? "" : "s"} are now available to the client.`,
    });
  }, [updateQuestionnaireState]);

  const handleUseClientNote = useCallback((item) => {
    if (!normalizeText(item.clientNote)) return;
    setFieldValues((previous) => ({ ...previous, [item.fieldId]: item.clientNote }));
    setActiveSectionId(item.sectionId || BASIC_DETAILS_SECTION.id);
    setActiveSlide(item.slideNumber);
    setActiveFieldId(item.fieldId);
    showToast({
      type: "success",
      title: "Client Note Added",
      message: "The note was placed into the CIM field. Review and save your CIM changes.",
    });
  }, [showToast]);

  const handleCopyQuestionNote = useCallback(async (item) => {
    if (!normalizeText(item.clientNote) || !navigator?.clipboard) return;
    await navigator.clipboard.writeText(item.clientNote);
    showToast({
      type: "success",
      title: "Copied",
      message: "Client note copied to clipboard.",
    });
  }, [showToast]);

  const getExportElementContent = useCallback((slideNumber, element) => {
    const fieldsForSlide = fieldsBySlide[slideNumber] || [];
    const fieldsById = Object.fromEntries(fieldsForSlide.map((field) => [field.id, field]));
    return getElementContent(
      slideNumber,
      element,
      fieldsById,
      fieldValues,
      assetValues,
      chartValues,
      globalDetails,
    );
  }, [assetValues, chartValues, fieldValues, fieldsBySlide, globalDetails]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const state = {
      version: 1,
      globalDetails,
      fieldValues,
      assetValues,
      chartValues,
      updatedAt: new Date().toISOString(),
    };
    const localKey = getLocalStorageKey(clientId);

    try {
      const payload = await saveWorkspacePageStateRequest(PAGE_KEY, state, { clientId });
      const savedAt = payload?.updatedAt || state.updatedAt;
      setUpdatedAt(savedAt);
      window.localStorage.setItem(localKey, JSON.stringify({ ...state, updatedAt: savedAt }));
      showToast({
        type: "success",
        title: "CIM Prep Saved",
        message: "Your CIM changes were saved for this company.",
      });
    } catch (error) {
      window.localStorage.setItem(localKey, JSON.stringify(state));
      setUpdatedAt(state.updatedAt);
      showToast({
        type: "info",
        title: "CIM Prep Saved Locally",
        message: error?.message
          ? "Backend save failed, so a local draft was kept in this browser."
          : "A local draft was kept in this browser.",
      });
    } finally {
      setSaving(false);
    }
  }, [assetValues, chartValues, clientId, fieldValues, globalDetails, showToast]);

  const handleExport = useCallback(() => {
    const missingSlides = PREVIEW_SLIDES.filter((slideNumber) => !layouts[slideNumber]);
    if (missingSlides.length > 0) {
      showToast({
        type: "error",
        title: "Export Not Ready",
        message: "The CIM template is still loading. Please try again in a moment.",
      });
      return;
    }

    const baseName = sanitizeFileName(
      globalDetails.projectName || globalDetails.companyLegalName || company?.name || "cim-prep",
    );
    exportCimPptx({
      layouts,
      slideNumbers: PREVIEW_SLIDES,
      getElementContent: getExportElementContent,
      filename: `${baseName}-CIM.pptx`,
    });
    showToast({
      type: "success",
      title: "PPT Export Started",
      message: "Your editable CIM PowerPoint is downloading.",
    });
  }, [company?.name, getExportElementContent, globalDetails, layouts, showToast]);

  const isBasicSection = activeSection.type === "basic";
  const activeFields = activeSlide ? fieldsBySlide[activeSlide] || [] : [];
  const sectionEditableFields = activeSection.slides
    .flatMap((slideNumber) => fieldsBySlide[slideNumber] || [])
    .filter((field) => !isResolvedByGlobalDetails(field, globalDetails));
  const basicCompleted = BASIC_DETAIL_FIELDS.filter(([key]) => normalizeText(globalDetails[key])).length;
  const sectionCompleted = isBasicSection
    ? basicCompleted +
      sectionEditableFields.filter((field) =>
        isFieldComplete(field, fieldValues, assetValues, chartValues, globalDetails),
      ).length
    : sectionEditableFields.filter((field) =>
        isFieldComplete(field, fieldValues, assetValues, chartValues, globalDetails),
      ).length;
  const sectionFieldTotal = (isBasicSection ? BASIC_DETAIL_FIELDS.length : 0) + sectionEditableFields.length;
  const questionnaireCounts = getQuestionnaireCounts(questionnaireState);

  return (
    <div className="min-h-screen bg-bg-page p-4 text-text-primary lg:p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/broker/client/${clientId}/analytics`)}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-white text-[#6D6E71] shadow-card transition hover:bg-[#EEF6E0] hover:text-[#476E2C]"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-[#050505]">CIM Prep</h1>
            <p className="mt-0.5 text-sm text-[#6D6E71]">
              {company?.name || "Company"} confidential information memorandum
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {updatedAt && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-[#6D6E71]">
              <CheckCircle2 size={14} className="text-[#8BC53D]" />
              Saved {new Date(updatedAt).toLocaleString("en-IN")}
            </span>
          )}
          <button
            onClick={() => setQuestionnaireOpen(true)}
            className="theme-btn-secondary"
          >
            <ClipboardList size={16} />
            Questionnaire
            {questionnaireCounts.total > 0 && (
              <span className="ml-1 rounded-full bg-[#EEF6E0] px-1.5 py-0.5 text-[11px] font-bold text-[#476E2C]">
                {questionnaireCounts.total}
              </span>
            )}
          </button>
          <button
            onClick={() => {
              const index = PREVIEW_SLIDES.indexOf(activeSlide);
              setPreviewSlideIndex(index >= 0 ? index : 0);
              setPreviewOpen(true);
            }}
            className="theme-btn-secondary"
          >
            <Eye size={16} />
            Preview PPT
          </button>
          <button
            onClick={handleExport}
            className="theme-btn-secondary"
          >
            <Download size={16} />
            Export PPT
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-70"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save Changes
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[230px_minmax(0,1fr)_310px]">
        <SectionDrawer
          sections={NAV_SECTIONS}
          activeSectionId={activeSectionId}
          fieldValues={fieldValues}
          assetValues={assetValues}
          chartValues={chartValues}
          fieldsBySlide={fieldsBySlide}
          globalDetails={globalDetails}
          onSelectSection={handleSectionSelect}
        />

        <section className="min-w-0 space-y-3">
          <div className="rounded-lg border border-border bg-white p-4 shadow-card">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#8BC53D]">
                  {isBasicSection ? "Setup" : `Section ${activeSection.number}`}
                </p>
                <h2 className="mt-1 text-xl font-bold text-[#050505]">
                  {activeSection.title}
                </h2>
                <p className="mt-1 text-sm text-[#6D6E71]">
                  {sectionCompleted}/{sectionFieldTotal} fields completed
                </p>
              </div>

              {activeSection.slides.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {activeSection.slides.map((slideNumber) => (
                    <button
                      key={slideNumber}
                      onClick={() => {
                        setActiveSlide(slideNumber);
                        setActiveFieldId("");
                      }}
                      className={`shrink-0 rounded-md border px-3 py-2 text-xs font-bold transition ${
                        activeSlide === slideNumber
                          ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                          : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
                      }`}
                    >
                      Slide {slideNumber}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-white p-2 shadow-card">
            {loading ? (
              <div className="flex aspect-video items-center justify-center text-sm font-semibold text-[#6D6E71]">
                <Loader2 size={18} className="mr-2 animate-spin text-[#8BC53D]" />
                Loading CIM template
              </div>
            ) : (
              <SlideCanvas
                slideNumber={activeSlide}
                layout={layouts[activeSlide]}
                fields={activeFields}
                fieldValues={fieldValues}
                assetValues={assetValues}
                chartValues={chartValues}
                globalDetails={globalDetails}
                activeFieldId={activeFieldId}
                onFieldFocus={setActiveFieldId}
                onFieldChange={handleFieldChange}
              />
            )}
          </div>
        </section>

        <aside className="sticky top-6 max-h-[calc(100vh-3rem)] space-y-4 overflow-y-auto">
          {isBasicSection && (
            <GlobalDetailsPanel
              globalDetails={globalDetails}
              onChange={handleGlobalChange}
              compact
            />
          )}
          <FieldPanel
            activeSlide={activeSlide}
            fields={activeFields}
            fieldValues={fieldValues}
            assetValues={assetValues}
            chartValues={chartValues}
            questionnaireState={questionnaireState}
            globalDetails={globalDetails}
            activeFieldId={activeFieldId}
            onFieldFocus={setActiveFieldId}
            onFieldChange={handleFieldChange}
            onAssetUpload={handleAssetUpload}
            onAssetRemove={handleAssetRemove}
            onChartChange={handleChartChange}
            onQuestionnaireToggle={handleQuestionnaireToggle}
            onQuestionPromptChange={handleQuestionPromptChange}
          />
        </aside>
      </div>

      {questionnaireOpen && (
        <QuestionnaireReviewModal
          onClose={() => setQuestionnaireOpen(false)}
          sections={NAV_SECTIONS}
          questionnaireState={questionnaireState}
          onSendQuestionnaire={handleSendQuestionnaire}
          onUseClientNote={handleUseClientNote}
          onCopyNote={handleCopyQuestionNote}
        />
      )}

      <PreviewModal
        open={previewOpen}
        previewSlideIndex={previewSlideIndex}
        onClose={() => setPreviewOpen(false)}
        onSlideIndexChange={setPreviewSlideIndex}
        layouts={layouts}
        fieldsBySlide={fieldsBySlide}
        fieldValues={fieldValues}
        assetValues={assetValues}
        chartValues={chartValues}
        globalDetails={globalDetails}
      />
    </div>
  );
}
