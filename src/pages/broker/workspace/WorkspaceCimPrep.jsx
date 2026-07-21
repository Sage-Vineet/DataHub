import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  Eye,
  FileText,
  Flag,
  ImagePlus,
  Loader2,
  MessageSquareText,
  Palette,
  PanelLeft,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Trash2,
  Upload,
  Save,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  getCimQuestionnaireRequest,
  getCimReviewRequest,
  getCimStyleProfilesRequest,
  getCompanyRequest,
  getWorkspacePageStateRequest,
  listUsersRequest,
  saveCimQuestionnaireRequest,
  saveCimReviewRequest,
  saveCimStyleProfilesRequest,
  saveWorkspacePageStateRequest,
} from "../../../lib/api";
import { exportCimPptx } from "../../../lib/cimPptxExport";
import {
  DEFAULT_CIM_STYLE_PROFILE,
  DEFAULT_CIM_STYLE_PROFILE_ID,
  applyCimTemplateStyleProfile,
  applyCimTemplateStyleProfilesToLayouts,
  getActiveCimStyleProfile,
  isDefaultCimStyleProfile,
  normalizeCimStyleProfilesState,
} from "../../../lib/cimTemplateStyleProfiles";
import { useAuth } from "../../../context/AuthContext";
import { useDataSource } from "../../../context/DataSourceContext";
import { useToast } from "../../../context/ToastContext";
import { CLIENT_SUB_ROLES } from "../../../lib/roles";
import { REPORT_SOURCE_KEYS, getReportSourceLabel, normalizeReportSourceKey } from "../../../lib/report-source";
import { loadCimFinancialAutofillSnapshot } from "../../../services/cimFinancialAutofillService";
import { useDatasetVersionStore } from "../../../store/useDatasetVersionStore";
import { useKeyReportContextStore } from "../../../store/useKeyReportContextStore";
import Modal from "../../../components/common/Modal";
import CimFieldNoteThread from "../../../components/cim/CimFieldNoteThread";
import CimTemplateStyleEditor from "../../../components/cim/CimTemplateStyleEditor";
import CimNativeBuilderCanvas, {
  CimBuilderPagePreview,
} from "../../../components/cim/CimNativeBuilderCanvas";
import { createBlankBuilderPage, normalizeBuilderImageSource } from "../../../lib/cimNativeBuilderModel";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;
const PAGE_KEY = "cim-prep";
const SLIDE_25_BRIDGE_FIELD_ID = "25:structured:ebitda-bridge";
const SLIDE_27_CASHFLOW_FIELD_ID = "27:structured:cashflow-statement";
export const TEMPLATE_SLIDE_COUNT = 38;
export const TEMPLATE_SLIDES = Array.from({ length: TEMPLATE_SLIDE_COUNT }, (_, index) => index + 1);
const CIM_FINANCIAL_MAX_DECIMALS = 3;

export const SECTION_SLIDES = [
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
  { id: "closing", number: "11", title: "Closing", slides: [38] },
];

export const BASIC_DETAILS_SECTION = {
  id: "basic-details",
  number: "BD",
  title: "Basic Details",
  type: "basic",
  slides: [1, 2, 3],
};

const SLIDE_25_BRIDGE_FIELD = Object.freeze({
  id: SLIDE_25_BRIDGE_FIELD_ID,
  parentId: SLIDE_25_BRIDGE_FIELD_ID,
  slideNumber: 25,
  order: 8,
  label: "EBITDA bridge",
  prompt: "Provide reported EBITDA and any EBITDA adjustments.",
  fieldKind: "ebitdaBridge",
  sourceText: "Reported EBITDA, adjustments, and adjusted EBITDA",
  excludeFromQuestionnaire: true,
});

const SLIDE_27_CASHFLOW_FIELD = Object.freeze({
  id: SLIDE_27_CASHFLOW_FIELD_ID,
  parentId: SLIDE_27_CASHFLOW_FIELD_ID,
  slideNumber: 27,
  order: 7,
  label: "Cash flow statement by period",
  fieldKind: "cashflowStatement",
  sourceText: "Cash Flow report rows by selected period",
  excludeFromQuestionnaire: true,
});

export const NAV_SECTIONS = [BASIC_DETAILS_SECTION, ...SECTION_SLIDES];

const BASIC_DETAIL_FIELD_DEFINITIONS = [
  { key: "companyName", label: "Company name", slides: [1], maxLength: 70 },
  { key: "projectName", label: "Project name", slides: [1], maxLength: 70 },
  { key: "descriptor", label: "Company descriptor", slides: [1], maxLength: 140 },
  { key: "monthYear", label: "Month year", slides: [1], maxLength: 32 },
  { key: "advisorFirm", label: "Broker / advisor firm", slides: [1], maxLength: 70 },
  { key: "advisorAddress", label: "Broker address", slides: [1], maxLength: 90 },
  { key: "advisorCityPhone", label: "City / phone", slides: [1], maxLength: 90 },
  { key: "leadAdvisor", label: "Lead advisor", slides: [1], maxLength: 60 },
  { key: "leadAdvisorTitle", label: "Lead advisor title", slides: [1], maxLength: 60 },
  { key: "leadAdvisorEmail", label: "Lead advisor email", slides: [1], maxLength: 80 },
  { key: "leadAdvisorPhone", label: "Lead advisor phone", slides: [1], maxLength: 40 },
  { key: "coAdvisor", label: "Co-advisor", slides: [1], maxLength: 60 },
  { key: "coAdvisorTitle", label: "Co-advisor title", slides: [1], maxLength: 60 },
  { key: "coAdvisorEmail", label: "Co-advisor email", slides: [1], maxLength: 80 },
  { key: "coAdvisorPhone", label: "Co-advisor phone", slides: [1], maxLength: 40 },
];

const BASIC_DETAIL_FIELDS = BASIC_DETAIL_FIELD_DEFINITIONS.map(({ key, label }) => [key, label]);

const PREVIEW_SLIDES = TEMPLATE_SLIDES;

const CHART_TYPES = [
  ["bar", "Bar"],
  ["line", "Line"],
  ["pie", "Pie"],
  ["waterfall", "Waterfall"],
];

const CHART_COLORS = ["#8BC53D", "#476E2C", "#A5A5A5", "#6D6E71", "#243F18"];

function getCimChartStyle(styleProfile = null) {
  if (!styleProfile || isDefaultCimStyleProfile(styleProfile)) {
    return {
      palette: CHART_COLORS,
      backgroundColor: "#FFFFFF",
      gridColor: "#E5E7EB",
      labelColor: "#6D6E71",
      titleColor: "#476E2C",
      axisFontFamily: "Calibri",
      legendPosition: "right",
    };
  }
  const profile = normalizeCimStyleProfilesState({
    activeProfileId: styleProfile.id,
    profiles: [DEFAULT_CIM_STYLE_PROFILE, styleProfile],
  }).profiles.find((item) => item.id === styleProfile.id) || styleProfile;
  return {
    palette: profile.charts?.palette?.length ? profile.charts.palette : CHART_COLORS,
    backgroundColor: profile.charts?.backgroundColor || "#FFFFFF",
    gridColor: profile.charts?.gridColor || "#E5E7EB",
    labelColor: profile.charts?.labelColor || "#6D6E71",
    titleColor: profile.charts?.titleColor || "#476E2C",
    axisFontFamily: profile.charts?.axisFontFamily || profile.typography?.roles?.body?.fontFamily || "Calibri",
    legendPosition: profile.charts?.legendPosition || "right",
  };
}

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

function makeLabelOverride(slide, order, tokenIndex, label, extra = {}) {
  return { slide, order, tokenIndex, label, ...extra };
}

const SLIDE_24_HISTORICAL_PERIODS = ["FY[Y-4]", "FY[Y-3]", "FY[Y-2]", "FY[Y-1]", "FY[Y]"];
const SLIDE_24_ALL_PERIODS = [...SLIDE_24_HISTORICAL_PERIODS, "LTM"];
const SLIDE_26_ALL_PERIODS = ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "LTM"];
const TWO_YEAR_LTM_PERIODS = ["FY[Y-1]", "FY[Y]", "LTM"];
const FY_LTM_PERIODS = ["FY[Y]", "LTM"];
const PROJECTION_PERIODS = ["FY[Y]A (Base)", "FY[Y+1]E", "FY[Y+2]E", "FY[Y+3]E", "FY[Y+4]E"];
const FORWARD_PROJECTION_PERIODS = ["FY[Y+1]E", "FY[Y+2]E", "FY[Y+3]E", "FY[Y+4]E"];

function makeSlide24MetricRowOverrides(startTokenIndex, questionPrefix, periodLabels = SLIDE_24_ALL_PERIODS) {
  return periodLabels.map((period, index) =>
    makeLabelOverride(
      24,
      7,
      startTokenIndex + index,
      period === "LTM"
        ? `${questionPrefix} for LTM?`
        : `${questionPrefix} in ${period}?`,
    ),
  );
}

function makePeriodMetricOverrides(slide, order, startTokenIndex, questionPrefix, periodLabels) {
  return periodLabels.map((period, index) =>
    makeLabelOverride(
      slide,
      order,
      startTokenIndex + index,
      period === "LTM"
        ? `${questionPrefix} for LTM?`
        : `${questionPrefix} in ${period}?`,
    ),
  );
}

const FIELD_LABEL_OVERRIDES = [
  { slide: 5, order: 5, tokenIndex: 1, label: "Key Investment Themes" },
  { slide: 5, order: 11, tokenIndex: 1, label: "What is the company's current market share (%)?" },
  { slide: 5, order: 11, tokenIndex: 2, label: "Which market or industry segment does the company operate in?" },
  { slide: 5, order: 11, tokenIndex: 3, label: "What is the company's current market ranking (e.g., #1, Top 3, #4)?" },
  { slide: 5, order: 11, tokenIndex: 4, label: "Which geography, region, or market does this ranking and market share apply to?" },
  { slide: 5, order: 16, tokenIndex: 0, label: "What percentage of the company's revenue is recurring or contractual?" },
  { slide: 5, order: 21, tokenIndex: 0, label: "What is the combined industry experience of the company's leadership team (in years)?" },
  { slide: 5, order: 26, tokenIndex: 0, label: "What is the company's gross margin (%)?" },
  { slide: 5, order: 26, tokenIndex: 1, label: "What is the company's EBITDA margin (%)?" },
  {
    slide: 6,
    order: 6,
    tokenIndex: 0,
    label: "Do these metrics represent Trailing Twelve Months (TTM) or a Fiscal Year (FY)?",
    inputType: "select",
    options: ["Trailing Twelve Months (TTM)", "Fiscal Year (FY)"],
  },
  { slide: 6, order: 6, tokenIndex: 1, label: "What is the reporting date (as of)?" },
  { slide: 6, order: 9, tokenIndex: 0, label: "What is the company's total revenue (in USD millions)?" },
  {
    slide: 6,
    order: 11,
    tokenIndex: 0,
    label: "What is the year-over-year (YoY) revenue growth (%)?",
    displayTemplate: "YoY growth: +{value}%",
    displayFormat: "unsignedPercent",
    replaceFullText: true,
  },
  { slide: 6, order: 14, tokenIndex: 0, label: "What is the current gross margin (%)?" },
  {
    slide: 6,
    order: 16,
    tokenIndex: 0,
    label: "How many percentage points has the gross margin changed vs. the prior year?",
    displayTemplate: "vs. {value}% prior year",
    displayFormat: "unsignedPercent",
    replaceFullText: true,
  },
  { slide: 6, order: 19, tokenIndex: 0, label: "What is the company's EBITDA (in USD millions)?" },
  { slide: 6, order: 21, tokenIndex: 0, label: "What is the company's EBITDA margin (%)?" },
  { slide: 6, order: 24, tokenIndex: 0, label: "What is the company's current revenue multiple (x)?" },
  {
    slide: 6,
    order: 26,
    tokenIndex: 0,
    label: "What is the comparable revenue multiple range (min-max x)?",
    displayTemplate: "Comparable range: {value}",
    replaceFullText: true,
  },
  { slide: 6, order: 31, tokenIndex: 0, label: "What is the company's revenue CAGR (%)?" },
  { slide: 6, order: 31, tokenIndex: 1, label: "Which financial years does this CAGR cover?" },
  { slide: 6, order: 31, tokenIndex: 2, label: "How many percentage points has the EBITDA margin improved?" },
  { slide: 6, order: 31, tokenIndex: 3, label: "What is the primary growth driver?" },
  { slide: 8, order: 5, tokenIndex: 2, label: "Which customer segment does the company primarily serve?" },
  { slide: 8, order: 5, tokenIndex: 3, label: "Which geography or region does the company primarily operate in?" },
  { slide: 8, order: 6, tokenIndex: 1, label: "In which year was the company founded?" },
  { slide: 8, order: 6, tokenIndex: 2, label: "Provide a brief statement describing the company's current market position." },
  {
    slide: 8,
    order: 9,
    tokenIndex: 0,
    label: "Provide a brief company overview (2-3 paragraphs) covering what the company does, who it serves, how it generates revenue, and what differentiates it from competitors.",
  },
  {
    slide: 8,
    order: 9,
    tokenIndex: 1,
    label: "Provide the company's key business metrics, including customer count, geographies served, team size, and years in operation.",
  },
  {
    slide: 8,
    order: 9,
    tokenIndex: 2,
    label: "Describe the company's ownership structure (e.g., founder-led, PE-backed, family-owned) and explain the rationale for the transaction.",
  },
  { slide: 8, order: 16, tokenIndex: 0, label: "How many employees does the company have?" },
  { slide: 8, order: 20, tokenIndex: 0, label: "How many customers or clients does the company serve?" },
  { slide: 8, order: 24, tokenIndex: 0, label: "Where is the company's headquarters located (City, Country)?" },
  { slide: 8, order: 28, tokenIndex: 0, label: "What is the company's legal structure or entity type?" },
  { slide: 8, order: 32, tokenIndex: 0, label: "Who are the company's current shareholders? Please list all major shareholders." },
  { slide: 9, order: 5, tokenIndex: 0, label: "Briefly describe the company's founding context (how and why it was established)." },
  { slide: 9, order: 5, tokenIndex: 1, label: "What is the company's current scale or market position? (1 short sentence)" },
  { slide: 9, order: 5, tokenIndex: 2, label: "How many years has the company been in operation?" },
  { slide: 9, order: 34, tokenIndex: 0, label: "What is the company's current annual revenue (in USD millions)?" },
  { slide: 9, order: 36, tokenIndex: 0, label: "What is the company's current EBITDA margin (%)?" },
  { slide: 9, order: 38, tokenIndex: 0, label: "How many active customers does the company currently have?" },
  { slide: 9, order: 40, tokenIndex: 0, label: "How many products or SKUs does the company currently offer?" },
  { slide: 9, order: 42, tokenIndex: 0, label: "How many full-time employees (FTEs) does the company currently have?" },
  {
    slide: 10,
    order: 5,
    tokenIndex: 1,
    label: "What is the company's ownership structure? (e.g., Founder-led, PE-backed, Family-owned, Publicly listed, Subsidiary)",
  },
  { slide: 10, order: 6, tokenIndex: 0, label: "As of what date does this legal structure and ownership chart apply?" },
  {
    slide: 10,
    order: 11,
    tokenIndex: 0,
    label: "Source reference (e.g., Corporate records, Shareholders' Agreement)",
  },
  { slide: 12, order: 5, tokenIndex: 1, label: "How many core products or services are offered?" },
  { slide: 12, order: 5, tokenIndex: 2, label: "How many product or service categories are offered?" },
  { slide: 12, order: 5, tokenIndex: 3, label: "Which customer profiles use these offerings?" },
  { slide: 12, order: 6, tokenIndex: 0, label: "What customer outcome does the portfolio deliver?" },
  { slide: 12, order: 6, tokenIndex: 1, label: "How has the offering portfolio evolved?" },
  { slide: 12, order: 6, tokenIndex: 2, label: "How was the portfolio developed or expanded?" },
  { slide: 12, order: 11, tokenIndex: 0, label: "What is the first product or service name?" },
  { slide: 12, order: 12, tokenIndex: 0, label: "Which category does the first offering belong to?" },
  { slide: 12, order: 13, tokenIndex: 0, label: "Describe the first product or service offering." },
  { slide: 12, order: 14, tokenIndex: 0, label: "What is first offering ARR (USD millions)?" },
  { slide: 12, order: 15, tokenIndex: 0, label: "What revenue share comes from the first offering (%)?" },
  { slide: 12, order: 17, tokenIndex: 0, label: "What right-side revenue metric applies to first offering (%)?" },
  { slide: 12, order: 23, tokenIndex: 0, label: "What is the second product or service name?" },
  { slide: 12, order: 24, tokenIndex: 0, label: "Which category does the second offering belong to?" },
  { slide: 12, order: 25, tokenIndex: 0, label: "Describe the second product or service offering." },
  { slide: 12, order: 26, tokenIndex: 0, label: "What is second offering ARR (USD millions)?" },
  { slide: 12, order: 27, tokenIndex: 0, label: "What revenue share comes from the second offering (%)?" },
  { slide: 12, order: 29, tokenIndex: 0, label: "What right-side revenue metric applies to second offering (%)?" },
  { slide: 12, order: 35, tokenIndex: 0, label: "What is the third product or service name?" },
  { slide: 12, order: 36, tokenIndex: 0, label: "Which category does the third offering belong to?" },
  { slide: 12, order: 37, tokenIndex: 0, label: "Describe the third product or service offering." },
  { slide: 12, order: 38, tokenIndex: 0, label: "What is third offering ARR (USD millions)?" },
  { slide: 12, order: 39, tokenIndex: 0, label: "What revenue share comes from the third offering (%)?" },
  { slide: 12, order: 41, tokenIndex: 0, label: "What right-side revenue metric applies to third offering (%)?" },
  { slide: 12, order: 43, tokenIndex: 0, label: "What period ending date supports this product data?" },
  { slide: 13, order: 5, tokenIndex: 1, label: "Which key dimensions differentiate the company?" },
  { slide: 13, order: 6, tokenIndex: 0, label: "Which competitors or alternatives are being compared?" },
  { slide: 13, order: 9, tokenIndex: 0, label: "What is the first differentiator?" },
  { slide: 13, order: 10, tokenIndex: 0, label: "Why does the first differentiator matter?" },
  { slide: 13, order: 13, tokenIndex: 0, label: "What is the second differentiator?" },
  { slide: 13, order: 14, tokenIndex: 0, label: "Why does the second differentiator matter?" },
  { slide: 13, order: 17, tokenIndex: 0, label: "What is the third differentiator?" },
  { slide: 13, order: 18, tokenIndex: 0, label: "Why does the third differentiator matter?" },
  { slide: 13, order: 21, tokenIndex: 0, label: "What is the fourth differentiator?" },
  { slide: 13, order: 22, tokenIndex: 0, label: "Why does the fourth differentiator matter?" },
  { slide: 13, order: 23, tokenIndex: 0, label: "What source supports these differentiators?" },
  { slide: 15, order: 5, tokenIndex: 1, label: "What is combined management experience in years?" },
  { slide: 15, order: 6, tokenIndex: 0, label: "What capability has management demonstrated?" },
  { slide: 15, order: 10, tokenIndex: 0, label: "What is the first executive's full name?" },
  { slide: 15, order: 11, tokenIndex: 0, label: "What is the first executive's title?" },
  { slide: 15, order: 12, tokenIndex: 0, label: "How many years of experience does the first executive have?" },
  { slide: 15, order: 14, tokenIndex: 0, label: "Provide the first executive's short bio." },
  { slide: 15, order: 18, tokenIndex: 0, label: "What is the second executive's full name?" },
  { slide: 15, order: 19, tokenIndex: 0, label: "What is the second executive's title?" },
  { slide: 15, order: 20, tokenIndex: 0, label: "How many years of experience does the second executive have?" },
  { slide: 15, order: 22, tokenIndex: 0, label: "Provide the second executive's short bio." },
  { slide: 15, order: 26, tokenIndex: 0, label: "What is the third executive's full name?" },
  { slide: 15, order: 27, tokenIndex: 0, label: "What is the third executive's title?" },
  { slide: 15, order: 28, tokenIndex: 0, label: "How many years of experience does the third executive have?" },
  { slide: 15, order: 30, tokenIndex: 0, label: "Provide the third executive's short bio." },
  { slide: 15, order: 34, tokenIndex: 0, label: "What is the fourth executive's full name?" },
  { slide: 15, order: 35, tokenIndex: 0, label: "What is the fourth executive's title?" },
  { slide: 15, order: 36, tokenIndex: 0, label: "How many years of experience does the fourth executive have?" },
  { slide: 15, order: 38, tokenIndex: 0, label: "Provide the fourth executive's short bio." },
  { slide: 15, order: 39, tokenIndex: 0, label: "What source supports the management bios?" },
  { slide: 17, order: 5, tokenIndex: 0, label: "What is the relevant market name?" },
  { slide: 17, order: 5, tokenIndex: 1, label: "What is the addressable market size (USD billions)?" },
  { slide: 17, order: 5, tokenIndex: 2, label: "What is the market CAGR (%)?" },
  { slide: 17, order: 5, tokenIndex: 3, label: "What key tailwinds drive market growth?" },
  { slide: 17, order: 6, tokenIndex: 0, label: "Which primary growth driver applies to this market?" },
  { slide: 17, order: 9, tokenIndex: 0, label: "What is TAM size (USD billions)?" },
  { slide: 17, order: 11, tokenIndex: 0, label: "Which year is the TAM estimate for?" },
  { slide: 17, order: 14, tokenIndex: 0, label: "What is serviceable market size (USD billions)?" },
  { slide: 17, order: 16, tokenIndex: 0, label: "Which geography or segment defines this market?" },
  { slide: 17, order: 19, tokenIndex: 0, label: "What is the market growth rate (%)?" },
  { slide: 17, order: 21, tokenIndex: 0, label: "What is the market CAGR base year?" },
  { slide: 17, order: 21, tokenIndex: 1, label: "What is the market CAGR forecast year?" },
  { slide: 17, order: 24, tokenIndex: 0, label: "How many competitors operate in this market?" },
  { slide: 17, order: 26, tokenIndex: 0, label: "Describe market fragmentation or consolidation." },
  { slide: 17, order: 30, tokenIndex: 0, label: "Describe the first market tailwind." },
  { slide: 17, order: 30, tokenIndex: 1, label: "Describe the second market tailwind." },
  { slide: 17, order: 30, tokenIndex: 2, label: "Describe the third market tailwind." },
  { slide: 17, order: 30, tokenIndex: 3, label: "Describe the fourth market tailwind." },
  { slide: 17, order: 31, tokenIndex: 0, label: "Which market research source supports this data?" },
  { slide: 17, order: 31, tokenIndex: 1, label: "What year was the market source published?" },
  { slide: 18, order: 5, tokenIndex: 1, label: "How is the company positioned versus competitors?" },
  { slide: 18, order: 5, tokenIndex: 2, label: "What key dimension differentiates the company?" },
  { slide: 18, order: 6, tokenIndex: 1, label: "What is the first positioning matrix dimension?" },
  { slide: 18, order: 6, tokenIndex: 2, label: "What is the second positioning matrix dimension?" },
  { slide: 18, order: 10, tokenIndex: 1, label: "What is the company's size (USD millions)?" },
  { slide: 18, order: 10, tokenIndex: 2, label: "What is the company's key differentiation?" },
  { slide: 18, order: 10, tokenIndex: 3, label: "What is the first competitor's name?" },
  { slide: 18, order: 10, tokenIndex: 4, label: "What is the first competitor's size (USD millions)?" },
  { slide: 18, order: 10, tokenIndex: 5, label: "Describe the first competitor's differentiation." },
  { slide: 18, order: 10, tokenIndex: 6, label: "What is the second competitor's name?" },
  { slide: 18, order: 10, tokenIndex: 7, label: "What is the second competitor's size (USD millions)?" },
  { slide: 18, order: 10, tokenIndex: 8, label: "Describe the second competitor's differentiation." },
  { slide: 18, order: 10, tokenIndex: 9, label: "What is the third competitor's name?" },
  { slide: 18, order: 10, tokenIndex: 10, label: "What is the third competitor's size (USD millions)?" },
  { slide: 18, order: 10, tokenIndex: 11, label: "Describe the third competitor's differentiation." },
  { slide: 18, order: 10, tokenIndex: 12, label: "What is the fourth competitor's name?" },
  { slide: 18, order: 10, tokenIndex: 13, label: "What is the fourth competitor's size (USD millions)?" },
  { slide: 18, order: 10, tokenIndex: 14, label: "Describe the fourth competitor's differentiation." },
  { slide: 18, order: 11, tokenIndex: 0, label: "What year supports the competitive analysis?" },
  { slide: 20, order: 5, tokenIndex: 1, label: "What is the company's primary revenue model?" },
  { slide: 20, order: 6, tokenIndex: 0, label: "What operating characteristic defines the model?" },
  { slide: 20, order: 6, tokenIndex: 1, label: "What gross margin does the model generate (%)?" },
  { slide: 20, order: 28, tokenIndex: 0, label: "What period supports the revenue model data?" },
  { slide: 21, order: 5, tokenIndex: 1, label: "What key characteristic defines the operating model?" },
  { slide: 21, order: 10, tokenIndex: 0, label: "What is average operational cycle time in days?" },
  { slide: 21, order: 13, tokenIndex: 0, label: "What is current utilization rate (%)?" },
  { slide: 21, order: 16, tokenIndex: 0, label: "How many FTEs support operations?" },
  { slide: 21, order: 19, tokenIndex: 0, label: "How many platforms support operations?" },
  { slide: 21, order: 21, tokenIndex: 0, label: "What source supports the operations data?" },
  { slide: 23, order: 5, tokenIndex: 1, label: "What is the company's revenue CAGR (%)?" },
  { slide: 23, order: 5, tokenIndex: 2, label: "Which financial years does this CAGR cover? (e.g., FY23-FY26)" },
  { slide: 23, order: 5, tokenIndex: 3, label: "What was the EBITDA margin at the beginning of this period (%)?" },
  { slide: 23, order: 5, tokenIndex: 4, label: "What is the current EBITDA margin (%)?" },
  {
    slide: 23,
    order: 6,
    tokenIndex: 0,
    label: "What are the primary factors driving the company's financial performance?",
  },
  { slide: 23, order: 9, tokenIndex: 0, label: "What is the company's revenue for the selected financial year?" },
  { slide: 23, order: 10, tokenIndex: 0, label: "Which financial year does this revenue correspond to?" },
  { slide: 23, order: 11, tokenIndex: 0, label: "What was the company's revenue in the previous financial year?" },
  { slide: 23, order: 11, tokenIndex: 1, label: "Which is the previous financial year (FY-1)?" },
  { slide: 23, order: 14, tokenIndex: 0, label: "What is the company's current gross margin (%)?" },
  { slide: 23, order: 16, tokenIndex: 0, label: "What was the company's gross margin in the previous financial year (%)?" },
  { slide: 23, order: 16, tokenIndex: 1, label: "Which is the previous financial year (FY-1)?" },
  { slide: 23, order: 19, tokenIndex: 0, label: "What is the company's EBITDA?" },
  { slide: 23, order: 21, tokenIndex: 0, label: "What is the company's EBITDA margin (%)?" },
  { slide: 23, order: 24, tokenIndex: 0, label: "What is the company's Free Cash Flow?" },
  { slide: 23, order: 26, tokenIndex: 0, label: "What is the company's Free Cash Flow (FCF) conversion (%)?" },
  { slide: 23, order: 29, tokenIndex: 0, label: "What is the company's Net Debt / EBITDA ratio (x)?" },
  { slide: 23, order: 31, tokenIndex: 0, label: "As of what date does this ratio apply?" },
  { slide: 23, order: 36, tokenIndex: 2, label: "Which accounting firm audited these financial statements?" },
  { slide: 24, order: 5, tokenIndex: 0, label: "What is the first financial year shown?" },
  { slide: 24, order: 5, tokenIndex: 1, label: "What is the last financial year shown?" },
  { slide: 24, order: 6, tokenIndex: 0, label: "Which accounting basis are figures presented on?" },
  { slide: 24, order: 7, tokenIndex: 0, label: "What is the first financial year column?" },
  { slide: 24, order: 7, tokenIndex: 1, label: "What is the second financial year column?" },
  { slide: 24, order: 7, tokenIndex: 2, label: "What is the third financial year column?" },
  { slide: 24, order: 7, tokenIndex: 3, label: "What is the fourth financial year column?" },
  { slide: 24, order: 7, tokenIndex: 4, label: "What is the fifth financial year column?" },
  { slide: 24, order: 7, tokenIndex: 5, label: "What is the LTM period end date?" },
  ...makeSlide24MetricRowOverrides(6, "What was revenue"),
  ...makeSlide24MetricRowOverrides(12, "What was YoY revenue growth", SLIDE_24_HISTORICAL_PERIODS),
  ...makeSlide24MetricRowOverrides(17, "What was cost of goods sold"),
  ...makeSlide24MetricRowOverrides(23, "What was gross profit"),
  ...makeSlide24MetricRowOverrides(29, "What was gross margin"),
  ...makeSlide24MetricRowOverrides(35, "What were operating expenses"),
  ...makeSlide24MetricRowOverrides(41, "What was adjusted EBITDA"),
  ...makeSlide24MetricRowOverrides(47, "What was adjusted EBITDA margin"),
  ...makeSlide24MetricRowOverrides(53, "What was depreciation and amortization"),
  ...makeSlide24MetricRowOverrides(59, "What was adjusted EBIT"),
  ...makeSlide24MetricRowOverrides(65, "What was net income"),
  { slide: 24, order: 8, tokenIndex: 0, label: "List any add-backs or normalizations." },
  { slide: 25, order: 5, tokenIndex: 0, label: "What is adjusted EBITDA (USD millions)?" },
  { slide: 25, order: 5, tokenIndex: 1, label: "How many EBITDA adjustments are included?" },
  { slide: 25, order: 5, tokenIndex: 2, label: "What is the total EBITDA adjustment value (USD millions)?" },
  { slide: 25, order: 13, tokenIndex: 0, label: "Explain the primary EBITDA adjustment rationale." },
  { slide: 25, order: 13, tokenIndex: 1, label: "Explain the second EBITDA adjustment rationale." },
  { slide: 25, order: 13, tokenIndex: 2, label: "Explain the third EBITDA adjustment rationale." },
  { slide: 26, order: 5, tokenIndex: 0, label: "What is the balance sheet date?" },
  { slide: 26, order: 5, tokenIndex: 1, label: "What are total assets (USD millions)?" },
  { slide: 26, order: 5, tokenIndex: 2, label: "How would you describe the capital structure?" },
  { slide: 26, order: 6, tokenIndex: 0, label: "What balance sheet quality does the company reflect?" },
  { slide: 26, order: 7, tokenIndex: 0, label: "What is the first year column?" },
  { slide: 26, order: 7, tokenIndex: 1, label: "What is the second year column?" },
  { slide: 26, order: 7, tokenIndex: 2, label: "What is the third year column?" },
  { slide: 26, order: 7, tokenIndex: 3, label: "What is the fourth year column?" },
  { slide: 26, order: 7, tokenIndex: 4, label: "What is the fifth year column?" },
  { slide: 26, order: 7, tokenIndex: 5, label: "What is the LTM balance sheet date?" },
  ...makePeriodMetricOverrides(26, 7, 6, "What were cash and equivalents", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 12, "What were accounts receivable", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 18, "What was inventory", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 24, "What were prepaid and other current assets", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 30, "What were total current assets", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 36, "What was net PP&E", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 42, "What were intangibles and goodwill", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 48, "What were total assets", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 54, "What were accounts payable", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 60, "What were accrued liabilities", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 66, "What was deferred revenue", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 72, "What was current portion of debt", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 78, "What were total current liabilities", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 84, "What was long-term debt", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 90, "What was total shareholders' equity", SLIDE_26_ALL_PERIODS),
  ...makePeriodMetricOverrides(26, 7, 96, "What were total liabilities and equity", SLIDE_26_ALL_PERIODS),
  { slide: 26, order: 8, tokenIndex: 0, label: "What is the first audited financial year?" },
  { slide: 26, order: 8, tokenIndex: 1, label: "What is the last audited financial year?" },
  { slide: 27, order: 5, tokenIndex: 0, label: "What is cumulative free cash flow (USD millions)?" },
  { slide: 27, order: 5, tokenIndex: 1, label: "Which financial years does cumulative FCF cover?" },
  { slide: 27, order: 6, tokenIndex: 0, label: "What is free cash flow conversion (%)?" },
  { slide: 28, order: 5, tokenIndex: 0, label: "What is average net working capital (USD millions)?" },
  { slide: 28, order: 5, tokenIndex: 1, label: "How many trailing months are measured?" },
  { slide: 28, order: 5, tokenIndex: 2, label: "What is the NWC cycle in days?" },
  { slide: 28, order: 6, tokenIndex: 0, label: "How seasonal is net working capital?" },
  { slide: 28, order: 6, tokenIndex: 1, label: "Which quarter has peak working capital?" },
  { slide: 28, order: 6, tokenIndex: 2, label: "What drives peak working capital?" },
  { slide: 28, order: 9, tokenIndex: 0, label: "What is current net working capital (USD millions)?" },
  { slide: 28, order: 11, tokenIndex: 0, label: "What is target NWC at close (USD millions)?" },
  { slide: 28, order: 14, tokenIndex: 0, label: "What is days sales outstanding (DSO)?" },
  { slide: 28, order: 16, tokenIndex: 0, label: "What is industry average DSO?" },
  { slide: 28, order: 19, tokenIndex: 0, label: "What is days payable outstanding (DPO)?" },
  { slide: 28, order: 21, tokenIndex: 0, label: "What is industry average DPO?" },
  { slide: 28, order: 24, tokenIndex: 0, label: "What are inventory days?" },
  { slide: 28, order: 26, tokenIndex: 0, label: "What working capital notes should be shown?" },
  { slide: 28, order: 30, tokenIndex: 0, label: "Which fiscal year is the FY[Y]A column?" },
  ...makePeriodMetricOverrides(28, 30, 1, "What were accounts receivable", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 3, "What was inventory", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 5, "What were prepaid and other assets", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 7, "What were current assets", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 9, "What were accounts payable", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 11, "What were accrued liabilities", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 13, "What was deferred revenue", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 15, "What were current liabilities", FY_LTM_PERIODS),
  ...makePeriodMetricOverrides(28, 30, 17, "What was net working capital", FY_LTM_PERIODS),
  { slide: 29, order: 6, tokenIndex: 0, label: "What is the reconciliation date?" },
  { slide: 29, order: 9, tokenIndex: 0, label: "What is book GL cash balance (USD millions)?" },
  { slide: 29, order: 14, tokenIndex: 0, label: "What is bank statement cash balance (USD millions)?" },
  { slide: 29, order: 16, tokenIndex: 0, label: "Which bank statement supports the balance?" },
  { slide: 29, order: 16, tokenIndex: 1, label: "What is the bank statement date?" },
  { slide: 29, order: 19, tokenIndex: 0, label: "What are unresolved reconciling items (USD thousands)?" },
  { slide: 29, order: 21, tokenIndex: 0, label: "How many reconciling items were identified?" },
  { slide: 29, order: 26, tokenIndex: 0, label: "Who prepared the bank reconciliation?" },
  { slide: 29, order: 28, tokenIndex: 0, label: "What is book GL cash balance (USD millions)?" },
  { slide: 29, order: 28, tokenIndex: 1, label: "What deposits in transit remain (USD thousands)?" },
  { slide: 29, order: 28, tokenIndex: 2, label: "When did deposits in transit clear?" },
  { slide: 29, order: 28, tokenIndex: 3, label: "What outstanding cheques remain (USD thousands)?" },
  { slide: 29, order: 28, tokenIndex: 4, label: "When did outstanding cheques clear?" },
  { slide: 29, order: 28, tokenIndex: 5, label: "What bank charges were not recorded (USD thousands)?" },
  { slide: 29, order: 28, tokenIndex: 6, label: "What interest remains unrecorded (USD thousands)?" },
  { slide: 29, order: 28, tokenIndex: 7, label: "What other reconciling items remain (USD thousands)?" },
  { slide: 29, order: 28, tokenIndex: 8, label: "What is the status of other reconciling items?" },
  { slide: 29, order: 28, tokenIndex: 9, label: "What is bank statement balance (USD millions)?" },
  { slide: 29, order: 31, tokenIndex: 0, label: "Describe reconciliation quality and unresolved items." },
  { slide: 29, order: 31, tokenIndex: 1, label: "Confirm independent review of reconciliations." },
  { slide: 29, order: 32, tokenIndex: 0, label: "Which bank provided the source statement?" },
  { slide: 29, order: 32, tokenIndex: 1, label: "What is the bank statement source date?" },
  { slide: 29, order: 32, tokenIndex: 2, label: "What is the general ledger date?" },
  { slide: 29, order: 32, tokenIndex: 3, label: "Who prepared the source reconciliation?" },
  { slide: 30, order: 5, tokenIndex: 0, label: "What is the effective tax rate (%)?" },
  { slide: 30, order: 6, tokenIndex: 0, label: "Which accounting firm prepares tax filings?" },
  { slide: 30, order: 9, tokenIndex: 0, label: "What is the current effective tax rate (%)?" },
  { slide: 30, order: 11, tokenIndex: 0, label: "What is the statutory tax rate (%)?" },
  { slide: 30, order: 14, tokenIndex: 0, label: "What is current tax provision (USD millions)?" },
  { slide: 30, order: 16, tokenIndex: 0, label: "What date applies to current tax provision?" },
  { slide: 30, order: 19, tokenIndex: 0, label: "What is deferred tax balance (USD millions)?" },
  { slide: 30, order: 21, tokenIndex: 0, label: "What date applies to deferred tax balance?" },
  { slide: 30, order: 24, tokenIndex: 0, label: "Which tax year is currently open?" },
  { slide: 30, order: 26, tokenIndex: 0, label: "Which tax jurisdiction is relevant?" },
  { slide: 30, order: 28, tokenIndex: 0, label: "Which fiscal year is the FY[Y-1]A column?" },
  { slide: 30, order: 28, tokenIndex: 1, label: "Which fiscal year is the FY[Y]A column?" },
  ...makePeriodMetricOverrides(30, 28, 2, "What was pre-tax income", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 5, "What was statutory tax rate", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 8, "What was tax at statutory rate", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 11, "What were non-deductible expenses", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 14, "What were tax credits or incentives", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 17, "What were temporary differences", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 20, "What were other tax adjustments", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 23, "What was current tax provision", TWO_YEAR_LTM_PERIODS),
  ...makePeriodMetricOverrides(30, 28, 26, "What was effective tax rate", TWO_YEAR_LTM_PERIODS),
  { slide: 30, order: 31, tokenIndex: 0, label: "List federal, state, and international jurisdictions." },
  { slide: 30, order: 31, tokenIndex: 1, label: "Which tax years remain open to audit?" },
  { slide: 30, order: 31, tokenIndex: 2, label: "Describe key deferred tax sources." },
  { slide: 30, order: 32, tokenIndex: 0, label: "What is the first tax return year?" },
  { slide: 30, order: 32, tokenIndex: 1, label: "What is the last tax return year?" },
  { slide: 30, order: 32, tokenIndex: 2, label: "Who is the tax advisor?" },
  { slide: 30, order: 32, tokenIndex: 3, label: "What date confirms no open assessments?" },
  { slide: 32, order: 5, tokenIndex: 1, label: "What is projected revenue (USD millions)?" },
  { slide: 32, order: 5, tokenIndex: 2, label: "What is the target projection fiscal year?" },
  { slide: 32, order: 5, tokenIndex: 3, label: "What is projected revenue CAGR (%)?" },
  { slide: 32, order: 5, tokenIndex: 4, label: "What is target EBITDA margin (%)?" },
  { slide: 32, order: 6, tokenIndex: 0, label: "What key macro assumption underpins projections?" },
  { slide: 32, order: 7, tokenIndex: 0, label: "Which fiscal year is the base year?" },
  { slide: 32, order: 7, tokenIndex: 1, label: "Which fiscal year is projection year one?" },
  { slide: 32, order: 7, tokenIndex: 2, label: "Which fiscal year is projection year two?" },
  { slide: 32, order: 7, tokenIndex: 3, label: "Which fiscal year is projection year three?" },
  { slide: 32, order: 7, tokenIndex: 4, label: "Which fiscal year is projection year four?" },
  ...makePeriodMetricOverrides(32, 7, 5, "What is projected revenue", PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 10, "What is projected YoY revenue growth", FORWARD_PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 14, "What is projected gross profit", PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 19, "What is projected gross margin", PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 24, "What is projected EBITDA", PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 29, "What is projected EBITDA margin", PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 34, "What is projected free cash flow", PROJECTION_PERIODS),
  ...makePeriodMetricOverrides(32, 7, 39, "What is projected CapEx", PROJECTION_PERIODS),
  { slide: 33, order: 10, tokenIndex: 0, label: "What is the organic revenue growth assumption (%)?" },
  { slide: 33, order: 14, tokenIndex: 0, label: "What is the projected minimum gross margin (%)?" },
  { slide: 33, order: 14, tokenIndex: 1, label: "What is the projected maximum gross margin (%)?" },
  { slide: 33, order: 18, tokenIndex: 0, label: "What is starting EBITDA margin (%)?" },
  { slide: 33, order: 18, tokenIndex: 1, label: "What is ending EBITDA margin (%)?" },
  { slide: 33, order: 22, tokenIndex: 0, label: "What is minimum annual CapEx (USD millions)?" },
  { slide: 33, order: 22, tokenIndex: 1, label: "What is maximum annual CapEx (USD millions)?" },
  { slide: 33, order: 26, tokenIndex: 0, label: "What are expected NWC days?" },
  { slide: 33, order: 30, tokenIndex: 0, label: "What is the first downside risk?" },
  { slide: 33, order: 30, tokenIndex: 1, label: "What is the second downside risk?" },
  { slide: 35, order: 5, tokenIndex: 1, label: "How many organic growth levers are identified?" },
  { slide: 35, order: 5, tokenIndex: 2, label: "What is the post-close execution timeline?" },
  { slide: 35, order: 10, tokenIndex: 0, label: "What is the first growth initiative?" },
  { slide: 35, order: 11, tokenIndex: 0, label: "Describe first initiative action, outcome, and impact." },
  { slide: 35, order: 12, tokenIndex: 0, label: "What is first initiative impact (USD millions)?" },
  { slide: 35, order: 17, tokenIndex: 0, label: "What is the second growth initiative?" },
  { slide: 35, order: 18, tokenIndex: 0, label: "Describe second initiative action and margin lever." },
  { slide: 35, order: 19, tokenIndex: 0, label: "What margin improvement does initiative two deliver (%)?" },
  { slide: 35, order: 24, tokenIndex: 0, label: "What is the third growth initiative?" },
  { slide: 35, order: 25, tokenIndex: 0, label: "Describe third initiative market opportunity." },
  { slide: 35, order: 26, tokenIndex: 0, label: "What is third initiative impact (USD millions)?" },
  { slide: 35, order: 31, tokenIndex: 0, label: "What is the fourth growth initiative?" },
  { slide: 35, order: 32, tokenIndex: 0, label: "Describe fourth initiative strategic rationale." },
  { slide: 35, order: 33, tokenIndex: 0, label: "What multiple impact does initiative four deliver (x)?" },
  { slide: 37, order: 5, tokenIndex: 1, label: "What buyer type is being targeted?" },
  { slide: 37, order: 6, tokenIndex: 0, label: "What transaction type is contemplated?" },
  { slide: 37, order: 6, tokenIndex: 1, label: "What consideration structure is contemplated?" },
  { slide: 37, order: 6, tokenIndex: 2, label: "Is the consideration structure available or contemplated?" },
  { slide: 37, order: 10, tokenIndex: 0, label: "What transaction structure should be shown?" },
  { slide: 37, order: 14, tokenIndex: 0, label: "What ownership percentage or control level is offered?" },
  { slide: 37, order: 18, tokenIndex: 0, label: "What consideration mix should be shown?" },
  { slide: 37, order: 22, tokenIndex: 0, label: "What financing or regulatory conditions apply?" },
  { slide: 37, order: 26, tokenIndex: 0, label: "What seller financing amount is available?" },
  { slide: 37, order: 26, tokenIndex: 1, label: "What seller financing interest rate applies (%)?" },
  { slide: 37, order: 26, tokenIndex: 2, label: "What seller financing term applies in years?" },
  { slide: 37, order: 30, tokenIndex: 0, label: "How many months will management remain?" },
  { slide: 37, order: 34, tokenIndex: 0, label: "What is the first-round bid date?" },
  { slide: 37, order: 34, tokenIndex: 1, label: "What is the LOI due date?" },
  { slide: 37, order: 34, tokenIndex: 2, label: "What is the target closing date?" },
  { slide: 38, order: 11, tokenIndex: 0, label: "What copyright year should appear?" },
];

const MERGED_FIELD_OVERRIDES = [
  {
    slide: 6,
    order: 32,
    key: "audited-financial-reporting-period",
    label: "What is the audited financial reporting period (e.g., FY23-FY26)?",
    replaceText: "[FY+X] – [FY+Y]",
    placeholder: "FY23-FY26",
    maxLength: 40,
  },
  {
    slide: 23,
    order: 36,
    key: "audited-financial-statement-period",
    label: "Which financial years do the audited financial statements cover? (e.g., FY23-FY26)",
    replaceText: "[FY+X]–[FY+Y]",
    placeholder: "FY23-FY26",
    tokenIndexes: [0, 1],
    maxLength: 40,
  },
];

const MIRRORED_FIELD_OVERRIDES = [
  {
    slide: 8,
    order: 12,
    tokenIndex: 0,
    sourceSlide: 8,
    sourceOrder: 6,
    sourceTokenIndex: 1,
  },
  {
    slide: 23,
    order: 16,
    tokenIndex: 1,
    sourceSlide: 23,
    sourceOrder: 11,
    sourceTokenIndex: 1,
  },
  {
    slide: 23,
    order: 21,
    tokenIndex: 0,
    sourceSlide: 23,
    sourceOrder: 5,
    sourceTokenIndex: 4,
  },
  {
    slide: 26,
    order: 7,
    tokenIndex: 3,
    sourceSlide: 26,
    sourceOrder: 5,
    sourceTokenIndex: 0,
  },
  {
    slide: 26,
    order: 7,
    tokenIndex: 35,
    sourceSlide: 26,
    sourceOrder: 5,
    sourceTokenIndex: 1,
  },
  {
    slide: 29,
    order: 28,
    tokenIndex: 0,
    sourceSlide: 29,
    sourceOrder: 9,
    sourceTokenIndex: 0,
  },
  {
    slide: 29,
    order: 28,
    tokenIndex: 9,
    sourceSlide: 29,
    sourceOrder: 14,
    sourceTokenIndex: 0,
  },
  {
    slide: 29,
    order: 32,
    tokenIndex: 0,
    sourceSlide: 29,
    sourceOrder: 16,
    sourceTokenIndex: 0,
  },
  {
    slide: 29,
    order: 32,
    tokenIndex: 1,
    sourceSlide: 29,
    sourceOrder: 16,
    sourceTokenIndex: 1,
  },
  {
    slide: 29,
    order: 32,
    tokenIndex: 3,
    sourceSlide: 29,
    sourceOrder: 26,
    sourceTokenIndex: 0,
  },
  {
    slide: 30,
    order: 9,
    tokenIndex: 0,
    sourceSlide: 30,
    sourceOrder: 5,
    sourceTokenIndex: 0,
  },
  {
    slide: 32,
    order: 7,
    tokenIndex: 4,
    sourceSlide: 32,
    sourceOrder: 5,
    sourceTokenIndex: 2,
  },
  {
    slide: 32,
    order: 7,
    tokenIndex: 9,
    sourceSlide: 32,
    sourceOrder: 5,
    sourceTokenIndex: 1,
  },
  {
    slide: 32,
    order: 7,
    tokenIndex: 33,
    sourceSlide: 32,
    sourceOrder: 5,
    sourceTokenIndex: 4,
  },
];

const REPEATABLE_FIELD_OVERRIDES = [
  {
    slide: 12,
    key: "offerings",
    fieldKind: "offerings",
    label: "Products and services",
    prompt: "Add each product or service with its complete CIM profile.",
    addLabel: "Add product / service",
    visibleOrder: 11,
    pageSize: 3,
    slotElementRanges: [[7, 18], [19, 30], [31, 42]],
    fields: [
      { key: "image", label: "Logo or icon", inputType: "asset" },
      { key: "name", label: "Product or service name", placeholder: "Offering name" },
      { key: "category", label: "Category", placeholder: "Category" },
      { key: "description", label: "Description, customer and benefit", placeholder: "What it does, who buys it, and the key benefit", inputType: "textarea" },
      { key: "arr", label: "ARR (USD millions)", placeholder: "0.0" },
      { key: "revenueShare", label: "Revenue share (%)", placeholder: "0" },
      { key: "rightMetric", label: "Additional revenue metric (%)", placeholder: "0" },
    ],
    entries: [
      { image: 10, name: 11, category: 12, description: 13, arr: 14, revenueShare: 15, rightMetric: 17 },
      { image: 22, name: 23, category: 24, description: 25, arr: 26, revenueShare: 27, rightMetric: 29 },
      { image: 34, name: 35, category: 36, description: 37, arr: 38, revenueShare: 39, rightMetric: 41 },
    ],
  },
  {
    slide: 13,
    key: "differentiators",
    fieldKind: "differentiators",
    label: "Company differentiators",
    prompt: "Add each differentiator and explain why it matters to customers.",
    addLabel: "Add differentiator",
    visibleOrder: 9,
    pageSize: 4,
    slotElementRanges: [[7, 10], [11, 14], [15, 18], [19, 22]],
    fields: [
      { key: "title", label: "Differentiator", placeholder: "Distinct capability or advantage" },
      {
        key: "description",
        label: "Why it matters",
        placeholder: "Customer value, defensibility, pricing power, or competitive impact",
        inputType: "textarea",
      },
    ],
    entries: [
      { title: 9, description: 10 },
      { title: 13, description: 14 },
      { title: 17, description: 18 },
      { title: 21, description: 22 },
    ],
  },
  {
    slide: 20,
    key: "revenue-streams",
    fieldKind: "revenueStreams",
    label: "Revenue streams",
    prompt: "Add each revenue stream with its share of total revenue and how it scales. Additional groups of three use continuation slides.",
    addLabel: "Add revenue stream",
    visibleOrder: 9,
    pageSize: 3,
    slotElementRanges: [[7, 13], [14, 20], [21, 27]],
    fields: [
      { key: "name", label: "Revenue stream", placeholder: "Revenue stream name" },
      { key: "share", label: "Share of revenue (%)", placeholder: "35" },
      {
        key: "description",
        label: "How this revenue scales",
        placeholder: "2-3 sentences describing how this revenue is generated, what drives growth, and retention dynamics",
        inputType: "textarea",
      },
    ],
    entries: [
      { name: 9, share: 10, description: 13 },
      { name: 16, share: 17, description: 20 },
      { name: 23, share: 24, description: 27 },
    ],
  },
  {
    slide: 15,
    key: "management-team",
    fieldKind: "people",
    label: "Management team members",
    prompt: "Add each team member's complete profile. Additional groups of four use continuation slides.",
    addLabel: "Add person",
    visibleOrder: 10,
    pageSize: 4,
    slotElementRanges: [[7, 14], [15, 22], [23, 30], [31, 38]],
    fields: [
      { key: "photo", label: "Photo", inputType: "asset" },
      { key: "name", label: "Full name", placeholder: "Full name" },
      { key: "title", label: "Title", placeholder: "CEO / President" },
      { key: "experience", label: "Years of experience", placeholder: "15" },
      { key: "bio", label: "Short bio", placeholder: "Prior roles, expertise, and key achievements", inputType: "textarea" },
    ],
    entries: [
      { photo: 9, name: 10, title: 11, experience: 12, bio: 14 },
      { photo: 17, name: 18, title: 19, experience: 20, bio: 22 },
      { photo: 25, name: 26, title: 27, experience: 28, bio: 30 },
      { photo: 33, name: 34, title: 35, experience: 36, bio: 38 },
    ],
  },
  {
    slide: 9,
    key: "milestones",
    fieldKind: "milestones",
    label: "Company growth milestones",
    prompt: "Add each milestone year and a brief description of the key event.",
    addLabel: "Add milestone",
    visibleOrder: 9,
    fields: [
      { key: "year", label: "What is the year of this milestone or key event?", placeholder: "FY2024" },
      {
        key: "description",
        label: "Briefly describe the milestone or key event (e.g., founding, product launch, customer win, expansion, acquisition, revenue milestone, current scale).",
        placeholder: "Expanded into a new region",
      },
    ],
    entries: [
      { yearOrder: 9, descriptionOrder: 11 },
      { yearOrder: 15, descriptionOrder: 13 },
      { yearOrder: 17, descriptionOrder: 19 },
      { yearOrder: 23, descriptionOrder: 21 },
      { yearOrder: 25, descriptionOrder: 27 },
      { yearOrder: 31, descriptionOrder: 29 },
    ],
  },
  {
    slide: 10,
    key: "shareholders",
    fieldKind: "shareholders",
    label: "Ownership summary",
    prompt: "Add each shareholder's name, ownership percentage, and role or designation.",
    addLabel: "Add shareholder",
    visibleOrder: 10,
    tableOrder: 10,
    chartOrder: 8,
    pageSize: 4,
    fields: [
      { key: "name", label: "Enter the shareholder's name.", placeholder: "Founder / Name" },
      { key: "ownership", label: "What percentage of the company does this shareholder own (%)?", placeholder: "45" },
      { key: "role", label: "What is this shareholder's role or designation?", placeholder: "Founder & CEO" },
    ],
  },
  {
    slide: 18,
    key: "competitors",
    fieldKind: "competitors",
    label: "Competitive landscape",
    prompt: "Add each company once with its chart position and summary details.",
    addLabel: "Add company",
    visibleOrder: 10,
    tableOrder: 10,
    chartOrder: 8,
    pageSize: 5,
    fields: [
      { key: "name", label: "Company / competitor", placeholder: "Company name" },
      { key: "xScore", label: "X-axis score", placeholder: "8" },
      { key: "yScore", label: "Y-axis score", placeholder: "9" },
      { key: "size", label: "Size (USD millions)", placeholder: "25" },
      {
        key: "differentiation",
        label: "Key differentiator",
        placeholder: "Short description of its market position",
        inputType: "textarea",
      },
    ],
  },
  {
    slide: 35,
    key: "initiatives",
    fieldKind: "initiatives",
    label: "Growth initiatives",
    prompt: "Add each initiative with its timing, action, and expected impact.",
    addLabel: "Add initiative",
    visibleOrder: 10,
    pageSize: 4,
    slotElementRanges: [[7, 13], [14, 20], [21, 27], [28, 34]],
    fields: [
      { key: "timeframe", label: "Timeframe", placeholder: "Near-Term (0-12 mo)" },
      { key: "title", label: "Initiative", placeholder: "Initiative name" },
      {
        key: "description",
        label: "Action and expected outcome",
        placeholder: "Specific action, target outcome, and strategic or financial impact",
        inputType: "textarea",
      },
      { key: "metricValue", label: "Impact value", placeholder: "$5M / 3% / 1.5x" },
      { key: "metricLabel", label: "Impact metric", placeholder: "Revenue Opportunity" },
    ],
    entries: [
      { timeframe: 9, title: 10, description: 11, metricValue: 12, metricLabel: 13 },
      { timeframe: 16, title: 17, description: 18, metricValue: 19, metricLabel: 20 },
      { timeframe: 23, title: 24, description: 25, metricValue: 26, metricLabel: 27 },
      { timeframe: 30, title: 31, description: 32, metricValue: 33, metricLabel: 34 },
    ],
  },
];

const CHART_FIELD_OVERRIDES = [
  {
    slide: 6,
    order: 28,
    label: "Revenue / EBITDA trend by fiscal year",
    prompt: "Enter one row per period: fiscal year, revenue in USD millions, EBITDA in USD millions.",
    chartHelp: "Enter one row per period: Fiscal Year, Revenue (USDm), EBITDA (USDm).",
    chartDataPlaceholder: "FY2023,18.0,3.2\nFY2024,21.5,4.1\nFY2025,25.0,5.0\nFY2026,29.0,6.2",
  },
  {
    slide: 12,
    order: 10,
    label: "First product or service logo",
    prompt: "Upload the logo or icon for the first product or service.",
  },
  {
    slide: 12,
    order: 22,
    label: "Second product or service logo",
    prompt: "Upload the logo or icon for the second product or service.",
  },
  {
    slide: 12,
    order: 34,
    label: "Third product or service logo",
    prompt: "Upload the logo or icon for the third product or service.",
  },
  {
    slide: 15,
    order: 9,
    label: "First executive photo",
    prompt: "Upload the first executive's headshot.",
  },
  {
    slide: 15,
    order: 17,
    label: "Second executive photo",
    prompt: "Upload the second executive's headshot.",
  },
  {
    slide: 15,
    order: 25,
    label: "Third executive photo",
    prompt: "Upload the third executive's headshot.",
  },
  {
    slide: 15,
    order: 33,
    label: "Fourth executive photo",
    prompt: "Upload the fourth executive's headshot.",
  },
  {
    slide: 17,
    order: 28,
    label: "Market size or segmentation chart",
    prompt: "Enter market chart data by year, segment, or category.",
    chartHelp: "Use simple rows: label, value. Add a third column for a second series if needed.",
    chartDataPlaceholder: "FY2023,12.0\nFY2024,13.5\nFY2025,15.0\nFY2026,16.8",
  },
  {
    slide: 18,
    order: 8,
    label: "Competitive positioning matrix",
    prompt: "Enter each company with X-axis score, Y-axis score, and label.",
    chartHelp: "Use rows: company, x score, y score. Keep scores on a consistent scale.",
    chartDataPlaceholder: "Company,8,9\nCompetitor A,6,7\nCompetitor B,7,5\nCompetitor C,4,6",
  },
  {
    slide: 21,
    order: 8,
    label: "Operations flow diagram",
    prompt: "Enter each operating step and supporting systems or partners.",
    chartHelp: "Use rows: step, description. Keep step names short.",
    chartDataPlaceholder: "Acquire,Lead generation and qualification\nOnboard,Customer setup and implementation\nDeliver,Service delivery and support\nRetain,Renewals and expansion",
  },
  {
    slide: 23,
    order: 33,
    label: "Revenue trend chart",
    prompt: "Enter one row per fiscal year: year, revenue in USD millions.",
    chartHelp: "Keep this chart simple: fiscal year and revenue in USD millions.",
    chartDataPlaceholder: "FY2023,18.0\nFY2024,21.5\nFY2025,25.0\nFY2026,29.0",
  },
  {
    slide: 23,
    order: 35,
    label: "EBITDA and margin chart",
    prompt: "Enter one row per fiscal year: year, EBITDA in USD millions, EBITDA margin percent.",
    chartHelp: "Keep this chart simple: fiscal year, EBITDA in USD millions, and margin percent.",
    chartDataPlaceholder: "FY2023,3.2,17.8\nFY2024,4.1,19.1\nFY2025,5.0,20.0\nFY2026,6.2,21.4",
  },
  {
    slide: 28,
    order: 28,
    label: "Monthly net working capital chart",
    prompt: "Enter monthly NWC balances and optional target NWC peg.",
    chartHelp: "Use rows: month, NWC balance. Add target as a separate row if needed.",
    chartDataPlaceholder: "Jan-2025,2.1\nFeb-2025,2.3\nMar-2025,2.0\nTarget NWC,2.2",
  },
  {
    slide: 32,
    order: 9,
    label: "Revenue and EBITDA projection chart",
    prompt: "Enter projection data by fiscal year for revenue and EBITDA.",
    chartHelp: "Use rows: fiscal year, revenue, EBITDA.",
    chartDataPlaceholder: "FY2026A,25.0,5.0\nFY2027E,29.0,6.1\nFY2028E,33.5,7.4\nFY2029E,38.0,8.8",
  },
  {
    slide: 38,
    order: 5,
    label: "Closing page advisor logo",
    prompt: "Upload the advisor logo for the closing page.",
  },
];

function padSlide(slideNumber) {
  return String(slideNumber).padStart(2, "0");
}

export function getSlideLayoutPath(slideNumber) {
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

function getBrokerAdvisorDefaults(user = null) {
  const brokerFirm = user?.broker_company || user?.brokerCompany || user?.company || "";
  const leadAdvisor = user?.name || user?.full_name || "";
  const leadAdvisorTitle = user?.designation || user?.occupation || "";
  const leadAdvisorEmail = user?.email || "";
  const leadAdvisorPhone = user?.phone || "";
  const advisorAddress = user?.address || "";

  return {
    advisorFirm: brokerFirm,
    advisorAddress,
    advisorCityPhone: leadAdvisorPhone,
    leadAdvisor,
    leadAdvisorTitle,
    leadAdvisorEmail,
    leadAdvisorPhone,
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

function normalizeSlide25Bridge(value) {
  let parsed = value;
  if (typeof value === "string" && value.trim()) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = {};

  return {
    reportedEbitda: normalizeText(parsed.reportedEbitda),
    adjustments: (Array.isArray(parsed.adjustments) ? parsed.adjustments : [])
      .map((adjustment, index) => ({
        id: adjustment?.id || `adjustment-${index + 1}`,
        label: normalizeText(adjustment?.label),
        amount: normalizeText(adjustment?.amount),
        nature: normalizeText(adjustment?.nature),
        commentary: normalizeText(adjustment?.commentary),
      })),
  };
}

function stringifySlide25Bridge(value) {
  return JSON.stringify(normalizeSlide25Bridge(value));
}

function getSlide25BridgeFigures(value) {
  const bridge = normalizeSlide25Bridge(value);
  const reported = parseChartNumber(bridge.reportedEbitda);
  const adjustments = bridge.adjustments
    .map((adjustment) => ({ ...adjustment, numericAmount: parseChartNumber(adjustment.amount) }))
    .filter((adjustment) => adjustment.label && adjustment.numericAmount !== null);
  const adjustmentTotal = adjustments.reduce((sum, adjustment) => sum + adjustment.numericAmount, 0);
  return {
    ...bridge,
    reported,
    adjustments,
    adjustmentTotal,
    adjusted: reported === null ? null : reported + adjustmentTotal,
  };
}

function formatSlide25Millions(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const formatted = formatAutoFillNumber(Math.abs(numeric));
  return numeric < 0 ? `($${formatted}M)` : `$${formatted}M`;
}

function normalizeSlide27Cashflow(value) {
  let parsed = value;
  if (typeof value === "string" && value.trim()) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = {};

  const columns = (Array.isArray(parsed.columns) ? parsed.columns : []).map((column, index) => ({
    key: normalizeText(column?.key) || `period-${index + 1}`,
    label: normalizeText(column?.label) || `Period ${index + 1}`,
  }));
  const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).map((row, index) => ({
    key: normalizeText(row?.key) || `cashflow-row-${index + 1}`,
    label: normalizeText(row?.label),
    type: normalizeText(row?.type) || "data",
    depth: Math.max(0, Number(row?.depth || 0)),
    manual: Boolean(row?.manual),
    values: Object.fromEntries(columns.map((column) => [
      column.key,
      normalizeText(row?.values?.[column.key]) || "-",
    ])),
  })).filter((row) => row.label);

  return { columns, rows, placeholder: Boolean(parsed.placeholder) };
}

function stringifySlide27Cashflow(value) {
  return JSON.stringify(normalizeSlide27Cashflow(value));
}

function mergeSlide27ManualRows(existingValue, nextValue) {
  const existing = normalizeSlide27Cashflow(existingValue);
  const next = normalizeSlide27Cashflow(nextValue);
  const manualRows = existing.rows.filter((row) => row.manual);
  if (!manualRows.length) return stringifySlide27Cashflow(next);

  const existingColumnByLabel = new Map(existing.columns.map((column) => [column.label, column]));
  const rows = [...next.rows];
  manualRows.forEach((row) => {
    if (rows.some((candidate) => candidate.key === row.key)) return;
    rows.push({
      ...row,
      values: Object.fromEntries(next.columns.map((column) => {
        const previousColumn = existingColumnByLabel.get(column.label);
        return [column.key, row.values[column.key] || row.values[previousColumn?.key] || "-"];
      })),
    });
  });
  return stringifySlide27Cashflow({ ...next, rows });
}

function formatSlide27CashflowValue(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const numeric = Number(value);
  if (Math.abs(numeric) < 0.0001) return "0";
  const formatted = formatAutoFillNumber(Math.abs(numeric) / 1_000_000);
  return numeric < 0 ? `($${formatted}M)` : `$${formatted}M`;
}

function normalizeCashflowRowLabel(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildSlide27CashflowRows(periods = []) {
  const rowsFor = (period) => period.metrics?.cashflowReportRows || [];
  const mostCompleteRows = [...periods]
    .sort((first, second) => rowsFor(second).length - rowsFor(first).length)
    .flatMap((period, index) => index === 0 ? rowsFor(period) : []);

  const sectionDetails = { investing: [], financing: [] };
  const seenDetails = { investing: new Set(), financing: new Set() };
  const collectDetails = (rows) => {
    let section = "";
    rows.forEach((row) => {
      const normalized = normalizeCashflowRowLabel(row.label);
      if (/operating activit/.test(normalized) && !normalized.startsWith("net ")) {
        section = "operating";
        return;
      }
      if (/investing activit/.test(normalized) && !normalized.startsWith("net ")) {
        section = "investing";
        return;
      }
      if (/financing activit/.test(normalized) && !normalized.startsWith("net ")) {
        section = "financing";
        return;
      }
      if (/^(beginning|opening|net increase|net change|ending)\b/.test(normalized)) section = "";
      if (!sectionDetails[section] || row.type === "total" || normalized.startsWith("net cash")) return;
      if (!normalized || seenDetails[section].has(normalized)) return;
      seenDetails[section].add(normalized);
      sectionDetails[section].push({
        key: `${section}:${normalized.replace(/\s+/g, "-")}`,
        label: row.label,
        type: row.type || "data",
        depth: Math.max(1, Number(row.depth || 1)),
        matcher: (candidate) => normalizeCashflowRowLabel(candidate.label) === normalized,
      });
    });
  };
  collectDetails(mostCompleteRows);
  periods.forEach((period) => collectDetails(rowsFor(period)));

  if (!sectionDetails.investing.length) {
    ["Purchase of Fixed Assets", "Sale of Fixed Assets", "Security Deposits", "Investments"].forEach((label) => {
      const normalized = normalizeCashflowRowLabel(label);
      sectionDetails.investing.push({
        key: `investing:${normalized.replace(/\s+/g, "-")}`,
        label,
        type: "data",
        depth: 1,
        matcher: (row) => normalizeCashflowRowLabel(row.label) === normalized,
      });
    });
  }
  if (!sectionDetails.financing.length) {
    ["Equity Contribution", "Dividends"].forEach((label) => {
      const normalized = normalizeCashflowRowLabel(label);
      sectionDetails.financing.push({
        key: `financing:${normalized.replace(/\s+/g, "-")}`,
        label,
        type: "data",
        depth: 1,
        matcher: (row) => normalizeCashflowRowLabel(row.label) === normalized,
      });
    });
  }

  const fixedRows = [
    {
      key: "operating-section",
      label: "Cash Flows from Operating Activities",
      type: "header",
      depth: 0,
      matcher: (row) => /operating activit/.test(normalizeCashflowRowLabel(row.label)) && !normalizeCashflowRowLabel(row.label).startsWith("net "),
    },
    { key: "net-income", label: "Net Income", type: "data", depth: 1, matcher: (row) => normalizeCashflowRowLabel(row.label) === "net income" },
    { key: "depreciation", label: "Depreciation", type: "data", depth: 1, matcher: (row) => normalizeCashflowRowLabel(row.label) === "depreciation" },
    { key: "amortization", label: "Amortization", type: "data", depth: 1, matcher: (row) => normalizeCashflowRowLabel(row.label) === "amortization" },
    { key: "net-working-capital", label: "Net changes in working capital", type: "data", depth: 1, matcher: (row) => normalizeCashflowRowLabel(row.label) === "net changes in working capital" },
    {
      key: "net-operating",
      label: "Net Cash from Operating Activities",
      type: "total",
      depth: 0,
      matcher: (row) => /^net cash.*operating activit/.test(normalizeCashflowRowLabel(row.label)),
    },
    {
      key: "investing-section",
      label: "Cash Flows from Investing Activities",
      type: "header",
      depth: 0,
      matcher: (row) => /investing activit/.test(normalizeCashflowRowLabel(row.label)) && !normalizeCashflowRowLabel(row.label).startsWith("net "),
    },
    ...sectionDetails.investing,
    {
      key: "net-investing",
      label: "Net Cash from Investing Activities",
      type: "total",
      depth: 0,
      matcher: (row) => /^net cash.*investing activit/.test(normalizeCashflowRowLabel(row.label)),
    },
    {
      key: "financing-section",
      label: "Cash Flows from Financing Activities",
      type: "header",
      depth: 0,
      matcher: (row) => /financing activit/.test(normalizeCashflowRowLabel(row.label)) && !normalizeCashflowRowLabel(row.label).startsWith("net "),
    },
    ...sectionDetails.financing,
    {
      key: "net-financing",
      label: "Net Cash from Financing Activities",
      type: "total",
      depth: 0,
      matcher: (row) => /^net cash.*financing activit/.test(normalizeCashflowRowLabel(row.label)),
    },
    {
      key: "beginning-cash",
      label: "Beginning Cash Balance",
      type: "data",
      depth: 0,
      matcher: (row) => /^(beginning|opening) cash( balance)?$/.test(normalizeCashflowRowLabel(row.label)),
    },
    {
      key: "net-increase-cash",
      label: "Net Increase (Decrease) in Cash",
      type: "total",
      depth: 0,
      matcher: (row) => /^net (increase|change|decrease).*cash/.test(normalizeCashflowRowLabel(row.label)),
    },
    {
      key: "ending-cash",
      label: "Ending Cash Balance",
      type: "total",
      depth: 0,
      matcher: (row) => /^ending cash( balance)?$/.test(normalizeCashflowRowLabel(row.label)),
    },
  ];

  return fixedRows.map(({ matcher, ...row }) => ({
    ...row,
    manual: false,
    values: Object.fromEntries(periods.map((period) => {
      const sourceRow = rowsFor(period).find(matcher);
      return [period.key, formatSlide27CashflowValue(sourceRow?.amount)];
    })),
  }));
}

function buildSlide27PlaceholderCashflow(range = {}) {
  const startYear = Number(String(range.startDate || "").slice(0, 4));
  const periodType = range.periodType === "fiscal" ? "fiscal" : "calendar";
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);
  const columns = Array.from({ length: annualCount }, (_, index) => {
    const year = periodType === "fiscal" ? startYear + index + 1 : startYear + index;
    return { key: `fy-${year}`, label: formatSlide24Year(year, periodType) };
  });
  const ltmDate = formatAutoFillDate(range.endDate, "short");
  columns.push({ key: "ltm", label: ltmDate ? `LTM ${ltmDate}` : "LTM" });
  const periods = columns.map((column) => ({ ...column, metrics: { cashflowReportRows: [] } }));
  return {
    columns,
    rows: buildSlide27CashflowRows(periods),
    placeholder: true,
  };
}

function normalizeTokenKey(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function getTemplateTokens(text) {
  const counters = {};
  return Array.from(String(text || "").matchAll(/\[([^\]]+)\]/g), (match, index) => {
    const token = normalizeText(match[1]);
    const key = normalizeTokenKey(token);
    const occurrence = counters[key] || 0;
    counters[key] = occurrence + 1;
    return {
      token,
      key,
      index,
      occurrence,
      raw: match[0],
    };
  });
}

function containsTemplateToken(text) {
  return /\[[^\]]+\]/.test(String(text || ""));
}

function hasEditableTextBounds(element) {
  const [left = 0, top = 0, width = 0, height = 0] = element?.bbox || [];
  return width > 12 && height > 8 && left >= 0 && top >= 0;
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
    textDecoration: firstRun.underline ? "underline" : "none",
    color: cssColor(firstRun.color, "#333333"),
    textAlign: alignment === "center" ? "center" : alignment === "right" ? "right" : "left",
    verticalAlignment: resolved.verticalAlignment || "top",
    insets: resolved.insets || { top: 0, right: 0, bottom: 0, left: 0 },
    lineHeight: Number(firstParagraph.resolvedTextStyle?.lineSpacing || resolved.lineSpacing || 1.08),
    paragraphSpacing: Number(firstParagraph.resolvedTextStyle?.paragraphSpacing || resolved.paragraphSpacing || 0),
    letterSpacing: Number(firstRun.letterSpacing || 0),
    wrap: resolved.wrap !== false,
  };
}

function restructureSlide24Table(layout) {
  if (!layout?.elements) return layout;

  const table = layout.elements.find((element) => element.order === 7 && element.kind === "table");
  if (!table?.cells) return layout;

  const rowCount = 12;
  const columnCount = 7;
  const tableLeft = Number(table.bbox?.[0] || 0);
  const tableWidth = Number(table.bbox?.[2] || 0);
  const rowHeight = Number(table.bbox?.[3] || 0) / rowCount;
  const tableTop = Number(table.bbox?.[1] || 0);
  const labelWidth = Number(table.cells.find((cell) => Number(cell.column) === 1)?.bbox?.[2] || tableWidth * 0.24);
  const valueWidth = (tableWidth - labelWidth) / (columnCount - 1);
  const summaryRows = new Set([5, 8, 11, 12]);
  const ratioRows = new Set([3, 6, 9]);
  const detailRows = new Set([4, 7, 10]);
  const rowLabels = {
    7: "Operating Expenses",
    8: "Adjusted EBITDA",
    9: "Adjusted EBITDA Margin",
    11: "Adjusted EBIT",
  };

  const sourceCellsByPosition = new Map(
    table.cells.map((cell) => [`${Number(cell.row || 1)}:${Number(cell.column || 1)}`, cell]),
  );
  const cells = Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => {
      const sourceRow = rowIndex + 1;
      const column = columnIndex + 1;
      const sourceCell = sourceCellsByPosition.get(`${sourceRow}:${Math.min(column, 6)}`) || {};
      const isHeader = sourceRow === 1;
      const isSummary = summaryRows.has(sourceRow);
      const isRatio = ratioRows.has(sourceRow);
      const isRevenue = sourceRow === 2;
      const text = column === 1
        ? (sourceRow === 1 ? "Historical Income Statement" : rowLabels[sourceRow] || sourceCell.text || "")
        : (sourceRow === 1 && column === 7 ? "LTM [Date]" : sourceCell.text || "");
      const color = isHeader ? "#FFFFFF" : isSummary || isRevenue ? "#2F3033" : "#6D6E71";
      const bold = isHeader || isSummary || isRevenue;
      const italic = isRatio;
      const left = column === 1 ? tableLeft : tableLeft + labelWidth + (column - 2) * valueWidth;
      const width = column === 1 ? labelWidth : valueWidth;

      return {
        ...sourceCell,
        index: rowIndex * columnCount + column,
        row: sourceRow,
        column,
        bbox: [left, tableTop + (sourceRow - 1) * rowHeight, width, rowHeight],
        text,
        textPreview: text.replace(/\s+/g, " ").trim(),
        fillColor: isHeader ? "#476E2C" : isSummary ? "#EFEFF1" : "#FFFFFF",
        resolvedTextStyle: {
          ...(sourceCell.resolvedTextStyle || {}),
          verticalAlignment: "middle",
          insets: {
            top: 0,
            right: 8,
            bottom: 0,
            left: column === 1 && detailRows.has(sourceRow) ? 20 : 8,
          },
        },
        paragraphs: [{
          index: 1,
          text,
          marginLeft: 0,
          indent: 0,
          resolvedTextStyle: { alignment: column === 1 ? "left" : "center" },
          runs: [{
            index: 1,
            text,
            fontSize: 12.67,
            typeface: "Calibri",
            color,
            ...(bold ? { bold: true } : {}),
            ...(italic ? { italic: true } : {}),
          }],
        }],
      };
    }),
  ).flat();

  const text = [
    "Historical Income Statement | [FY] | [FY] | [FY] | [FY] | [FY] | LTM [Date]",
    "Revenue | [Revenue] | [Revenue] | [Revenue] | [Revenue] | [Revenue] | [Revenue]",
    "YoY Growth | [YoY] | [YoY] | [YoY] | [YoY] | [YoY] | -",
    "COGS | [COGS] | [COGS] | [COGS] | [COGS] | [COGS] | [COGS]",
    "Gross Profit | [Gross Profit] | [Gross Profit] | [Gross Profit] | [Gross Profit] | [Gross Profit] | [Gross Profit]",
    "Gross Margin | [Gross Margin] | [Gross Margin] | [Gross Margin] | [Gross Margin] | [Gross Margin] | [Gross Margin]",
    "Operating Expenses | [Operating Expenses] | [Operating Expenses] | [Operating Expenses] | [Operating Expenses] | [Operating Expenses] | [Operating Expenses]",
    "Adjusted EBITDA | [Adjusted EBITDA] | [Adjusted EBITDA] | [Adjusted EBITDA] | [Adjusted EBITDA] | [Adjusted EBITDA] | [Adjusted EBITDA]",
    "Adjusted EBITDA Margin | [Adjusted EBITDA Margin] | [Adjusted EBITDA Margin] | [Adjusted EBITDA Margin] | [Adjusted EBITDA Margin] | [Adjusted EBITDA Margin] | [Adjusted EBITDA Margin]",
    "D&A | [D&A] | [D&A] | [D&A] | [D&A] | [D&A] | [D&A]",
    "Adjusted EBIT | [Adjusted EBIT] | [Adjusted EBIT] | [Adjusted EBIT] | [Adjusted EBIT] | [Adjusted EBIT] | [Adjusted EBIT]",
    "Net Income | [Net Income] | [Net Income] | [Net Income] | [Net Income] | [Net Income] | [Net Income]",
  ].join("\n");

  return {
    ...layout,
    elements: layout.elements.map((element) =>
      element === table
        ? {
          ...element,
          rows: rowCount,
          cols: columnCount,
          text,
          textPreview: text.replace(/\n/g, " | "),
          cells,
        }
        : element,
    ),
  };
}

function restructureSlide26Table(layout) {
  if (!layout?.elements) return layout;

  const table = layout.elements.find((element) => element.order === 7 && element.kind === "table");
  if (!table?.cells) return layout;

  const rowCount = 19;
  const columnCount = 7;
  const tableLeft = Number(table.bbox?.[0] || 0);
  const tableTop = Number(table.bbox?.[1] || 0);
  const tableWidth = Number(table.bbox?.[2] || 0);
  const rowHeight = Number(table.bbox?.[3] || 0) / rowCount;
  const labelWidth = Number(table.cells.find((cell) => Number(cell.column) === 1)?.bbox?.[2] || tableWidth * 0.32);
  const valueWidth = (tableWidth - labelWidth) / (columnCount - 1);
  const sectionRows = new Set([2, 11]);
  const totalRows = new Set([7, 10, 16, 19]);
  const rowLabels = [
    "Balance Sheet",
    "ASSETS",
    "Cash & Equivalents",
    "Accounts Receivable",
    "Inventory",
    "Prepaid & Other Current",
    "Total Current Assets",
    "PP&E (net)",
    "Intangibles & Goodwill",
    "Total Assets",
    "LIABILITIES & EQUITY",
    "Accounts Payable",
    "Accrued Liabilities",
    "Deferred Revenue",
    "Current Portion of Debt",
    "Total Current Liabilities",
    "Long-Term Debt",
    "Total Shareholders Equity",
    "Total Liabilities & Equity",
  ];

  const sourceCellsByPosition = new Map(
    table.cells.map((cell) => [`${Number(cell.row || 1)}:${Number(cell.column || 1)}`, cell]),
  );
  const getCellText = (row, column) => {
    if (column === 1) return rowLabels[row - 1] || "";
    if (row === 1) return column === 7 ? "LTM [Date]" : "[Year]";
    if (sectionRows.has(row)) return "";
    return "$[Amount]M";
  };

  const cells = Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => {
      const row = rowIndex + 1;
      const column = columnIndex + 1;
      const sourceCell = sourceCellsByPosition.get(`${row}:${Math.min(column, 5)}`) || {};
      const isHeader = row === 1;
      const isSection = sectionRows.has(row);
      const isTotal = totalRows.has(row);
      const text = getCellText(row, column);
      const left = column === 1 ? tableLeft : tableLeft + labelWidth + (column - 2) * valueWidth;
      const width = column === 1 ? labelWidth : valueWidth;
      const color = isHeader ? "#FFFFFF" : isSection ? "#476E2C" : isTotal ? "#2F3033" : "#6D6E71";
      const bold = isHeader || isSection || isTotal || column === 1;

      return {
        ...sourceCell,
        index: rowIndex * columnCount + column,
        row,
        column,
        bbox: [left, tableTop + rowIndex * rowHeight, width, rowHeight],
        text,
        textPreview: text.replace(/\s+/g, " ").trim(),
        fillColor: isHeader ? "#476E2C" : isSection ? "#EEF6E0" : isTotal ? "#EFEFF1" : "#FFFFFF",
        resolvedTextStyle: {
          ...(sourceCell.resolvedTextStyle || {}),
          verticalAlignment: "middle",
          insets: {
            top: 0,
            right: 7,
            bottom: 0,
            left: column === 1 && !isHeader && !isSection ? 14 : 7,
          },
        },
        paragraphs: [{
          index: 1,
          text,
          marginLeft: 0,
          indent: 0,
          resolvedTextStyle: { alignment: column === 1 ? "left" : "center" },
          runs: [{
            index: 1,
            text,
            fontSize: column === 1 ? 10.8 : 10.4,
            typeface: "Calibri",
            color,
            ...(bold ? { bold: true } : {}),
          }],
        }],
      };
    }),
  ).flat();

  const valueCells = Array.from({ length: 6 }, () => "$[Amount]M").join(" | ");
  const text = [
    "Balance Sheet | [Year] | [Year] | [Year] | [Year] | [Year] | LTM [Date]",
    "ASSETS | | | | | |",
    `Cash & Equivalents | ${valueCells}`,
    `Accounts Receivable | ${valueCells}`,
    `Inventory | ${valueCells}`,
    `Prepaid & Other Current | ${valueCells}`,
    `Total Current Assets | ${valueCells}`,
    `PP&E (net) | ${valueCells}`,
    `Intangibles & Goodwill | ${valueCells}`,
    `Total Assets | ${valueCells}`,
    "LIABILITIES & EQUITY | | | | | |",
    `Accounts Payable | ${valueCells}`,
    `Accrued Liabilities | ${valueCells}`,
    `Deferred Revenue | ${valueCells}`,
    `Current Portion of Debt | ${valueCells}`,
    `Total Current Liabilities | ${valueCells}`,
    `Long-Term Debt | ${valueCells}`,
    `Total Shareholders Equity | ${valueCells}`,
    `Total Liabilities & Equity | ${valueCells}`,
  ].join("\n");

  return {
    ...layout,
    elements: layout.elements.map((element) =>
      element === table
        ? {
          ...element,
          rows: rowCount,
          cols: columnCount,
          text,
          textPreview: text.replace(/\n/g, " | "),
          cells,
        }
        : element,
    ),
  };
}

function restructureSlide27Table(layout) {
  if (!layout?.elements) return layout;
  const table = layout.elements.find((element) => element.order === 7 && element.kind === "table");
  if (!table?.cells) return layout;

  const rowCount = 24;
  const columnCount = 7;
  const tableLeft = Number(table.bbox?.[0] || 0);
  const tableTop = Number(table.bbox?.[1] || 0);
  const tableWidth = Number(table.bbox?.[2] || 0);
  const rowHeight = Number(table.bbox?.[3] || 0) / rowCount;
  const labelWidth = Number(table.cells.find((cell) => Number(cell.column) === 1)?.bbox?.[2] || tableWidth * 0.28);
  const valueWidth = (tableWidth - labelWidth) / (columnCount - 1);
  const sourceCellsByPosition = new Map(
    table.cells.map((cell) => [`${Number(cell.row || 1)}:${Number(cell.column || 1)}`, cell]),
  );
  const cells = Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => {
      const row = rowIndex + 1;
      const column = columnIndex + 1;
      const sourceStyleRow = row <= 18 ? row : 3;
      const sourceCell = sourceCellsByPosition.get(`${sourceStyleRow}:${Math.min(column, 5)}`) || {};
      const left = column === 1 ? tableLeft : tableLeft + labelWidth + (column - 2) * valueWidth;
      return {
        ...sourceCell,
        index: rowIndex * columnCount + column,
        row,
        column,
        bbox: [left, tableTop + rowIndex * rowHeight, column === 1 ? labelWidth : valueWidth, rowHeight],
        resolvedTextStyle: {
          ...(sourceCell.resolvedTextStyle || {}),
          alignment: column === 1 ? "left" : "center",
        },
        paragraphs: (sourceCell.paragraphs || []).map((paragraph) => ({
          ...paragraph,
          resolvedTextStyle: {
            ...(paragraph.resolvedTextStyle || {}),
            alignment: column === 1 ? "left" : "center",
          },
          runs: (paragraph.runs || []).map((run) => ({ ...run, fontSize: Math.min(Number(run.fontSize || 10.5), 10.5) })),
        })),
      };
    }),
  ).flat();

  return {
    ...layout,
    elements: layout.elements.map((element) =>
      element === table
        ? { ...element, rows: rowCount, cols: columnCount, cells }
        : element,
    ),
  };
}

const SLIDE_30_TAX_ROW_DEFS = [
  { label: "Total Revenue", matchKeys: ["total revenue"] },
  { label: "Total Cost of Goods Sold", matchKeys: ["total cost of goods sold"] },
  { label: "Gross Profit", matchKeys: ["gross profit"] },
  { label: "Officer Wages / Guaranteed Payments", matchKeys: ["officer wages", "guaranteed payments"] },
  { label: "Depreciation Expense", matchKeys: ["depreciation expense"] },
  { label: "Amortization Expense", matchKeys: ["amortization expense"] },
  { label: "Total Interest Expense", matchKeys: ["total interest expense"] },
  { label: "All Other Expenses", matchKeys: ["all other expenses"] },
  { label: "All Other Income", matchKeys: ["all other income"] },
  { label: "Net Income", matchKeys: ["net income"] },
];
const SLIDE_30_TAX_HIGHLIGHT_ROW_INDEXES = new Set([2, 9]);
const SLIDE_30_TAX_TABLE_COLUMN_COUNT = 7;

function restructureSlide30TaxTable(layout) {
  if (!layout?.elements) return layout;
  const table = layout.elements.find((element) => element.order === 28 && element.kind === "table");
  if (!table?.cells) return layout;

  const columnCount = SLIDE_30_TAX_TABLE_COLUMN_COUNT;
  const rowCount = SLIDE_30_TAX_ROW_DEFS.length + 1;
  const tableLeft = 33.6;
  const tableTop = Number(table.bbox?.[1] || 336);
  const tableWidth = 1212.48;
  const rowHeight = 26.4;
  const labelWidth = tableWidth * 0.26;
  const valueWidth = (tableWidth - labelWidth) / (columnCount - 1);

  const cells = Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => {
      const row = rowIndex + 1;
      const column = columnIndex + 1;
      const isHeader = row === 1;
      const dataIndex = row - 2;
      const isHighlight = !isHeader && SLIDE_30_TAX_HIGHLIGHT_ROW_INDEXES.has(dataIndex);
      const left = column === 1 ? tableLeft : tableLeft + labelWidth + (column - 2) * valueWidth;
      const width = column === 1 ? labelWidth : valueWidth;

      return {
        index: rowIndex * columnCount + column,
        row,
        column,
        bbox: [left, tableTop + rowIndex * rowHeight, width, rowHeight],
        fillColor: isHeader ? "#476E2C" : isHighlight ? "#EFEFF1" : "#FFFFFF",
        lineColor: "#E5E7EB",
        resolvedTextStyle: { alignment: column === 1 ? "left" : "center" },
        paragraphs: [{
          index: 1,
          resolvedTextStyle: { alignment: column === 1 ? "left" : "center" },
          runs: [{
            index: 1,
            fontSize: 11.5,
            typeface: "Calibri",
            color: isHeader ? "#FFFFFF" : isHighlight ? "#2F3033" : "#6D6E71",
            ...((isHeader || isHighlight || column === 1) ? { bold: true } : {}),
          }],
        }],
      };
    }),
  ).flat();

  return {
    ...layout,
    elements: layout.elements.map((element) =>
      element === table
        ? { ...element, bbox: [tableLeft, tableTop, tableWidth, rowCount * rowHeight], rows: rowCount, cols: columnCount, cells }
        : element,
    ),
  };
}

function getSlide30TaxFiscalYears(currentPeriod) {
  const startDate = currentPeriod?.startDate;
  const endDate = currentPeriod?.endDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ""))) {
    return [];
  }
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  const isFullYearEnd = endDate.slice(5) === "12-31";
  const lastCompleteYear = isFullYearEnd ? endYear : endYear - 1;
  if (!Number.isFinite(startYear) || !Number.isFinite(lastCompleteYear) || lastCompleteYear < startYear) return [];
  const years = [];
  for (let year = startYear; year <= lastCompleteYear; year += 1) years.push(year);
  return years.slice(-(SLIDE_30_TAX_TABLE_COLUMN_COUNT - 2));
}

function normalizeSlide35InitiativeDescriptions(layout) {
  if (!layout?.elements) return layout;
  const override = REPEATABLE_FIELD_OVERRIDES.find((item) => item.slide === 35 && item.key === "initiatives");
  const descriptionOrders = new Set((override?.entries || []).map((entry) => entry.description));
  if (!descriptionOrders.size) return layout;

  return {
    ...layout,
    elements: layout.elements.map((element) => {
      if (!descriptionOrders.has(element.order)) return element;
      return {
        ...element,
        paragraphs: (element.paragraphs || []).map((paragraph) => ({
          ...paragraph,
          runs: (paragraph.runs || []).map((run) => ({ ...run, fontSize: 12.67, bold: false })),
        })),
      };
    }),
  };
}

export function prepareCimLayout(slideNumber, layout) {
  if (slideNumber === 24) return restructureSlide24Table(layout);
  if (slideNumber === 26) return restructureSlide26Table(layout);
  if (slideNumber === 27) return restructureSlide27Table(layout);
  if (slideNumber === 30) return restructureSlide30TaxTable(layout);
  if (slideNumber === 35) return normalizeSlide35InitiativeDescriptions(layout);
  return layout;
}

function makeFieldId(slideNumber, element) {
  return `${slideNumber}:${element.aid || element.id || element.order}`;
}

function makeTokenFieldId(slideNumber, element, tokenInfo) {
  return `${makeFieldId(slideNumber, element)}:token:${tokenInfo.index}:${tokenInfo.key}`;
}

function makePptTextFieldId(slideNumber, element) {
  return `${makeFieldId(slideNumber, element)}:ppt-text`;
}

function makeRepeatableFieldId(slideNumber, key) {
  return `${slideNumber}:repeatable:${key}`;
}

function getRepeatableOverrideByVisibleOrder(slideNumber, element) {
  return REPEATABLE_FIELD_OVERRIDES.find((override) =>
    override.slide === slideNumber && override.visibleOrder === element.order,
  ) || null;
}

function getRepeatableOverrideByTableOrder(slideNumber, element) {
  return REPEATABLE_FIELD_OVERRIDES.find((override) =>
    override.slide === slideNumber && override.tableOrder === element.order,
  ) || null;
}

function getRepeatableOverrideByChartOrder(slideNumber, element) {
  return REPEATABLE_FIELD_OVERRIDES.find((override) =>
    override.slide === slideNumber && override.chartOrder === element.order,
  ) || null;
}

function getMilestoneBinding(override, element) {
  const entryIndex = override.entries.findIndex((entry) =>
    entry.yearOrder === element.order || entry.descriptionOrder === element.order,
  );
  if (entryIndex < 0) return null;
  const entry = override.entries[entryIndex];
  return {
    entryIndex,
    entryKey: entry.yearOrder === element.order ? "year" : "description",
  };
}

function getRepeatableOverrideForTimelineElement(slideNumber, element) {
  const override = REPEATABLE_FIELD_OVERRIDES.find((item) =>
    item.slide === slideNumber && item.fieldKind === "milestones",
  );
  if (!override) return null;
  const binding = getMilestoneBinding(override, element);
  return binding ? { override, binding } : null;
}

function getStructuredRepeatableBinding(slideNumber, element) {
  for (const override of REPEATABLE_FIELD_OVERRIDES) {
    if (override.slide !== slideNumber || !Array.isArray(override.entries)) continue;
    for (let entryIndex = 0; entryIndex < (override.entries || []).length; entryIndex += 1) {
      const entry = override.entries[entryIndex] || {};
      const entryKey = Object.keys(entry).find((key) => (
        !key.endsWith("Order") && Number(entry[key]) === Number(element.order)
      ));
      if (entryKey) return { override, entryIndex, entryKey };
    }
  }
  return null;
}

function isPptTextEditableElement(element) {
  return Boolean(
    element?.text &&
    normalizeText(element.text) &&
    element.kind !== "table" &&
    hasEditableTextBounds(element) &&
    !isTopRightSlideNumberElement(element),
  );
}

function buildPptTextField(slideNumber, element, baseField) {
  const cleanText = normalizeText(element.text);
  return {
    ...baseField,
    id: makePptTextFieldId(slideNumber, element),
    text: element.text,
    label: cleanText.length > 72 ? `${cleanText.slice(0, 69)}...` : cleanText || "PPT text",
    fieldKind: "text",
    pptOnly: true,
    fullText: true,
    excludeFromQuestionnaire: true,
  };
}

function isPptTextField(field) {
  return Boolean(field?.pptOnly && field?.fullText);
}

export function extractTemplateFields(slideNumber, layout) {
  const elements = layout?.elements || [];

  return elements
    .filter((element) => {
      if (!element.text || !hasEditableTextBounds(element)) return false;
      return containsTemplateToken(element.text) || isPptTextEditableElement(element);
    })
    .flatMap((element) => {
      const fieldKind = getFieldKind(element.text);
      const parentId = makeFieldId(slideNumber, element);
      const baseField = {
        parentId,
        slideNumber,
        order: element.order,
        bbox: element.bbox,
        style: getElementStyle(element),
        sourceText: element.text,
      };
      const pptTextField = fieldKind === "text" && isPptTextEditableElement(element)
        ? [buildPptTextField(slideNumber, element, baseField)]
        : [];

      if (!containsTemplateToken(element.text)) return pptTextField;

      const repeatableVisible = getRepeatableOverrideByVisibleOrder(slideNumber, element);
      const repeatableTimeline = getRepeatableOverrideForTimelineElement(slideNumber, element);
      const repeatableTable = getRepeatableOverrideByTableOrder(slideNumber, element);
      const repeatableChart = getRepeatableOverrideByChartOrder(slideNumber, element);
      const structuredRepeatable = getStructuredRepeatableBinding(slideNumber, element);

      if (structuredRepeatable) {
        const { override, entryIndex, entryKey } = structuredRepeatable;
        const entryConfig = (override.fields || []).find((item) => item.key === entryKey) || {};
        const tokenInfo = getTemplateTokens(element.text)[0] || {};
        const structuredField = {
          ...baseField,
          id: `${parentId}:structured:${override.key}:${entryIndex}:${entryKey}`,
          text: element.text,
          token: tokenInfo.token,
          tokenKey: tokenInfo.key,
          occurrence: tokenInfo.occurrence || 0,
          label: entryConfig.label || override.label,
          fieldKind: entryConfig.inputType === "asset" ? "asset" : "text",
          hidden: true,
          structuredSourceId: makeRepeatableFieldId(slideNumber, override.key),
          structuredEntryIndex: entryIndex,
          structuredEntryKey: entryKey,
          legacyFieldId: tokenInfo.token ? makeTokenFieldId(slideNumber, element, tokenInfo) : parentId,
          legacyAssetKey: parentId,
        };
        if (element.order !== override.visibleOrder) return [structuredField];
        return [{
          ...baseField,
          id: makeRepeatableFieldId(slideNumber, override.key),
          text: element.text,
          label: override.label,
          prompt: override.prompt,
          fieldKind: override.fieldKind,
          repeatableConfig: override,
        }, structuredField, ...pptTextField];
      }

      if (repeatableChart) {
        return [{
          ...baseField,
          id: `${parentId}:chart:${repeatableChart.key}`,
          text: element.text,
          label: `${repeatableChart.label} chart`,
          fieldKind: "chart",
          hidden: true,
          chartKind: repeatableChart.fieldKind === "competitors" ? "positioningMatrix" : "ownershipPie",
          structuredSourceId: makeRepeatableFieldId(slideNumber, repeatableChart.key),
        }];
      }

      if (repeatableTable) {
        return [{
          ...baseField,
          id: makeRepeatableFieldId(slideNumber, repeatableTable.key),
          text: element.text,
          label: repeatableTable.label,
          prompt: repeatableTable.prompt,
          fieldKind: repeatableTable.fieldKind,
          repeatableConfig: repeatableTable,
          structuredTable: true,
        }];
      }

      if (repeatableTimeline) {
        const { override, binding } = repeatableTimeline;
        const fields = [{
          ...baseField,
          id: `${parentId}:structured:${override.key}:${binding.entryIndex}:${binding.entryKey}`,
          text: element.text,
          token: getTemplateTokens(element.text)[0]?.token,
          tokenKey: getTemplateTokens(element.text)[0]?.key,
          occurrence: 0,
          label: override.label,
          fieldKind: "text",
          hidden: true,
          structuredSourceId: makeRepeatableFieldId(slideNumber, override.key),
          structuredEntryIndex: binding.entryIndex,
          structuredEntryKey: binding.entryKey,
        }];

        if (repeatableVisible?.key === override.key) {
          fields.unshift({
            ...baseField,
            id: makeRepeatableFieldId(slideNumber, override.key),
            text: element.text,
            label: override.label,
            prompt: override.prompt,
            fieldKind: override.fieldKind,
            repeatableConfig: override,
          });
        }

        return fields;
      }

      if (fieldKind === "asset" || fieldKind === "chart") {
        const override = getChartFieldOverride(slideNumber, element);
        return [{
          ...baseField,
          id: parentId,
          text: element.text,
          label: override?.label || getFieldLabel(element.text),
          prompt: override?.prompt,
          chartHelp: override?.chartHelp,
          chartDataPlaceholder: override?.chartDataPlaceholder,
          fieldKind,
        }];
      }

      const mergedOverride = getMergedFieldOverride(slideNumber, element);
      if (mergedOverride) {
        const tokens = getTemplateTokens(element.text);
        const mergedTokenIndexes = Array.isArray(mergedOverride.tokenIndexes)
          ? new Set(mergedOverride.tokenIndexes)
          : new Set(
            getTemplateTokens(mergedOverride.replaceText).map((mergedToken) =>
              tokens.find((tokenInfo) =>
                tokenInfo.index >= 0 &&
                tokenInfo.raw === mergedToken.raw &&
                tokenInfo.token === mergedToken.token,
              )?.index,
            ).filter((index) => index !== undefined),
          );
        const mergedField = {
          ...baseField,
          id: `${parentId}:merged:${mergedOverride.key}`,
          text: mergedOverride.replaceText,
          label: mergedOverride.label,
          prompt: mergedOverride.prompt || mergedOverride.label,
          fieldKind: "text",
          replaceText: mergedOverride.replaceText,
          placeholder: mergedOverride.placeholder,
          maxLength: mergedOverride.maxLength,
        };
        const remainingTokenFields = tokens
          .filter((tokenInfo) => !mergedTokenIndexes.has(tokenInfo.index))
          .filter((tokenInfo) => !tokenValue(tokenInfo.token, GLOBAL_DETAIL_SENTINELS, element.text))
          .map((tokenInfo) => {
            const override = getFieldLabelOverride(slideNumber, element, tokenInfo);
            const mirror = getMirroredFieldOverride(slideNumber, element, tokenInfo);
            const mirrorElement = mirror
              ? elements.find((candidate) => candidate.order === mirror.sourceOrder)
              : null;
            const mirrorToken = mirrorElement
              ? getTemplateTokens(mirrorElement.text)[mirror.sourceTokenIndex]
              : null;
            return {
              ...baseField,
              id: makeTokenFieldId(slideNumber, element, tokenInfo),
              text: tokenInfo.raw,
              token: tokenInfo.token,
              tokenKey: tokenInfo.key,
              tokenIndex: tokenInfo.index,
              occurrence: tokenInfo.occurrence,
              label: override?.label || getFieldLabel(tokenInfo.raw),
              prompt: override?.prompt || override?.label,
              fieldKind: "text",
              inputType: override?.inputType,
              options: override?.options,
              displayTemplate: override?.displayTemplate,
              displayFormat: override?.displayFormat,
              replaceFullText: override?.replaceFullText,
              valueFieldId: mirrorElement && mirrorToken
                ? makeTokenFieldId(mirror.sourceSlide, mirrorElement, mirrorToken)
                : undefined,
              hidden: Boolean(mirror?.hidden ?? mirror),
              maxLength: override?.maxLength || getTokenMaxLength(tokenInfo.token),
            };
          });

        return [...pptTextField, mergedField, ...remainingTokenFields];
      }

      return [
        ...pptTextField,
        ...getTemplateTokens(element.text)
        .filter((tokenInfo) => !tokenValue(tokenInfo.token, GLOBAL_DETAIL_SENTINELS, element.text))
        .map((tokenInfo) => {
          const override = getFieldLabelOverride(slideNumber, element, tokenInfo);
          const mirror = getMirroredFieldOverride(slideNumber, element, tokenInfo);
          const mirrorElement = mirror
            ? elements.find((candidate) => candidate.order === mirror.sourceOrder)
            : null;
          const mirrorToken = mirrorElement
            ? getTemplateTokens(mirrorElement.text)[mirror.sourceTokenIndex]
            : null;
          return {
            ...baseField,
            id: makeTokenFieldId(slideNumber, element, tokenInfo),
            text: tokenInfo.raw,
            token: tokenInfo.token,
            tokenKey: tokenInfo.key,
            tokenIndex: tokenInfo.index,
            occurrence: tokenInfo.occurrence,
            label: override?.label || getFieldLabel(tokenInfo.raw),
            prompt: override?.prompt || override?.label,
            fieldKind: "text",
            inputType: override?.inputType,
            options: override?.options,
            displayTemplate: override?.displayTemplate,
            displayFormat: override?.displayFormat,
            replaceFullText: override?.replaceFullText,
            valueFieldId: mirrorElement && mirrorToken
              ? makeTokenFieldId(mirror.sourceSlide, mirrorElement, mirrorToken)
              : undefined,
            hidden: Boolean(mirror?.hidden ?? mirror),
            maxLength: override?.maxLength || getTokenMaxLength(tokenInfo.token),
          };
        }),
      ];
    });
}

function getFieldLabel(text) {
  const clean = normalizeText(text);
  const token = clean.match(/\[([^\]]+)\]/)?.[1];
  if (token) return token;
  return clean.slice(0, 42) || "Field";
}

function getFieldLabelOverride(slideNumber, element, tokenInfo) {
  return FIELD_LABEL_OVERRIDES.find((override) =>
    override.slide === slideNumber &&
    override.order === element.order &&
    override.tokenIndex === tokenInfo.index,
  ) || null;
}

function getMirroredFieldOverride(slideNumber, element, tokenInfo) {
  return MIRRORED_FIELD_OVERRIDES.find((override) =>
    override.slide === slideNumber &&
    override.order === element.order &&
    override.tokenIndex === tokenInfo.index,
  ) || null;
}

function getMergedFieldOverride(slideNumber, element) {
  return MERGED_FIELD_OVERRIDES.find((override) =>
    override.slide === slideNumber && override.order === element.order,
  ) || null;
}

function getChartFieldOverride(slideNumber, element) {
  return CHART_FIELD_OVERRIDES.find((override) =>
    override.slide === slideNumber && override.order === element.order,
  ) || null;
}

function tokenValue(token, details, sourceText = "") {
  const key = normalizeText(token).toLowerCase();
  const source = normalizeText(sourceText).toLowerCase();
  const companyName = details.companyName || "";
  const isCoAdvisorField = source.includes("co-advisor");

  if (key === "company name" || key === "company") return companyName;
  if (key === "company legal name") return companyName;
  if (key === "name") return details.projectName || companyName;
  if (key === "month year") return details.monthYear || "";
  if (key === "one-line company descriptor - industry, geography, business model") {
    return details.descriptor || "";
  }
  if (key === "descriptor" || key === "company descriptor") return details.descriptor || "";
  if (key === "advisor firm name" || key === "advisor firm" || key === "adviser firm") return details.advisorFirm || "";
  if (key === "address line 1") return details.advisorAddress || "";
  if (key === "city, province/state | phone" || key === "address | city | phone | website") return details.advisorCityPhone || "";
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

export function getFieldKind(fieldOrText) {
  if (fieldOrText && typeof fieldOrText === "object" && fieldOrText.fieldKind) {
    return fieldOrText.fieldKind;
  }
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

function getPlaceholderAssetKey(text) {
  const clean = normalizeText(text).toLowerCase();
  if (clean.includes("advisor logo") || clean.includes("adviser logo")) return "advisor-logo";
  if (clean.includes("company logo")) return "company-logo";
  return "";
}

const ASSET_SCALE_MIN = 0.4;
const ASSET_SCALE_MAX = 2.5;

function normalizeAssetScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.min(ASSET_SCALE_MAX, Math.max(ASSET_SCALE_MIN, numeric));
}

// Grows/shrinks a placeholder box around its own center so a resized logo
// never changes aspect ratio -- both dimensions scale by the same factor.
function scaleBboxAroundCenter(bbox, scale) {
  const [left = 0, top = 0, width = 0, height = 0] = bbox || [];
  if (scale === 1 || width <= 0 || height <= 0) return bbox;
  const nextWidth = width * scale;
  const nextHeight = height * scale;
  return [
    left + (width - nextWidth) / 2,
    top + (height - nextHeight) / 2,
    nextWidth,
    nextHeight,
  ];
}

function hasSameBbox(first, second, tolerance = 1) {
  const firstBox = first?.bbox || [];
  const secondBox = second?.bbox || [];
  if (firstBox.length < 4 || secondBox.length < 4) return false;
  return firstBox.every((value, index) => Math.abs(Number(value || 0) - Number(secondBox[index] || 0)) <= tolerance);
}

function isLogoPlaceholderText(element) {
  return /^\[((advisor|adviser)|company)\s+logo\]$/i.test(normalizeText(element?.text));
}

function getMatchingLogoElement(elements, index) {
  const element = elements[index];
  if (!element || element.text) return null;
  return elements.slice(index + 1).find((candidate) =>
    isLogoPlaceholderText(candidate) && hasSameBbox(element, candidate),
  ) || null;
}

function shouldHideLogoPlaceholderShape(elements, index, assetValues) {
  const logoElement = getMatchingLogoElement(elements, index);
  if (!logoElement) return false;
  const assetKey = getPlaceholderAssetKey(logoElement.text);
  return Boolean(assetKey && assetValues?.[assetKey]?.dataUrl);
}

function isTopRightSlideNumberElement(element) {
  const clean = normalizeText(element?.text);
  if (!/^\d{1,3}$/.test(clean)) return false;
  const [left = 0, top = 0, width = 0, height = 0] = element.bbox || [];
  return left >= SLIDE_WIDTH - 96 && top <= 48 && width <= 80 && height <= 40;
}

function getKnownGlobalTokens(text) {
  return getTemplateTokens(text).map((item) => item.token).filter(
    (token) => tokenValue(token, GLOBAL_DETAIL_SENTINELS, text),
  );
}

function isHandledByGlobalDetails(field) {
  if (isPptTextField(field)) return false;
  if (!field?.text || isMediaField(field)) return false;
  const tokens = getTemplateTokens(field.text).map((item) => item.token);
  return tokens.length > 0 && tokens.length === getKnownGlobalTokens(field.text).length;
}

function getFieldValue(field, fieldValues, globalDetails) {
  const saved = getStoredFieldValue(field, fieldValues);
  if (typeof saved === "string" && saved.trim()) return saved;
  if (field.placeholder) return field.placeholder;
  if (field.token) return tokenValue(field.token, globalDetails, field.sourceText || field.text) || "";
  return applyGlobalDetails(field.text, globalDetails);
}

function isResolvedByGlobalDetails(field, globalDetails) {
  if (isPptTextField(field)) return false;
  if (field?.token) return Boolean(tokenValue(field.token, globalDetails, field.sourceText || field.text));
  return isHandledByGlobalDetails(field) || !containsTemplateToken(applyGlobalDetails(field.text, globalDetails));
}

function getTokenMaxLength(token) {
  const clean = normalizeText(token).toLowerCase();
  if (clean === "company" || clean === "company name") return 70;
  if (clean === "descriptor" || clean.includes("descriptor")) return 80;
  if (clean.includes("geography") || clean.includes("city") || clean.includes("country")) return 60;
  if (clean.includes("customer segment")) return 70;
  if (clean === "#" || clean === "x" || clean.includes("%") || clean.includes("$")) return 24;
  if (clean.includes("source")) return 110;
  return 180;
}

function groupFieldsByElement(fields = []) {
  return fields.reduce((acc, field) => {
    const parentId = field.parentId || field.id;
    if (!acc[parentId]) acc[parentId] = [];
    acc[parentId].push(field);
    return acc;
  }, {});
}

function getElementFields(slideNumber, element, fieldsById) {
  const fieldId = getElementFieldId(slideNumber, element);
  if (!fieldId) return [];
  return Object.values(fieldsById || {}).filter((field) => (field.parentId || field.id) === fieldId);
}

function hasStoredFieldValue(field, fieldValues = {}) {
  const key = getFieldValueKey(field);
  return Boolean(key && Object.prototype.hasOwnProperty.call(fieldValues || {}, key));
}

function getFieldValueKey(field) {
  return field?.valueFieldId || field?.id || "";
}

function getStoredFieldValue(field, fieldValues) {
  const key = getFieldValueKey(field);
  return key ? fieldValues[key] : undefined;
}

function parseRepeatableEntries(value, _config = null) {
  if (Array.isArray(value)) return value;
  if (!normalizeText(value)) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((entry) => (entry && typeof entry === "object" ? entry : {}))
      : [];
  } catch {
    return [];
  }
}

function stringifyRepeatableEntries(entries) {
  return JSON.stringify(entries || []);
}

function hasRepeatableEntryValue(entry) {
  return Object.values(entry || {}).some((value) => (
    value && typeof value === "object" ? Boolean(value.dataUrl) : Boolean(normalizeText(value))
  ));
}

export function buildCimExportSlides(fieldValues = {}) {
  return TEMPLATE_SLIDES.flatMap((sourceSlideNumber) => {
    const config = getRepeatableSlideConfig(sourceSlideNumber);
    if (!config) return [{ sourceSlideNumber, instanceIndex: 0 }];
    const entries = parseRepeatableEntries(fieldValues[makeRepeatableFieldId(sourceSlideNumber, config.key)])
      .filter(hasRepeatableEntryValue);
    const pageCount = Math.max(1, Math.ceil(entries.length / config.pageSize));
    return Array.from({ length: pageCount }, (_, instanceIndex) => ({ sourceSlideNumber, instanceIndex }));
  });
}

function getRepeatableSlideConfig(slideNumber) {
  const config = REPEATABLE_FIELD_OVERRIDES.find((item) => (
    item.slide === slideNumber && Number(item.pageSize || 0) > 0
  ));
  return config ? { key: config.key, pageSize: config.pageSize } : null;
}

function getEditorSlideRefs(slideNumbers = [], fieldValues = {}) {
  return slideNumbers.flatMap((sourceSlideNumber) => {
    const config = getRepeatableSlideConfig(sourceSlideNumber);
    if (!config) return [{ sourceSlideNumber, instanceIndex: 0 }];
    const entries = parseRepeatableEntries(
      fieldValues[makeRepeatableFieldId(sourceSlideNumber, config.key)],
    );
    const pageCount = Math.max(1, Math.ceil(entries.length / config.pageSize));
    return Array.from({ length: pageCount }, (_, instanceIndex) => ({ sourceSlideNumber, instanceIndex }));
  });
}

function getFieldValuesForEditorSlide(fieldValues = {}, slideRef) {
  const sourceSlideNumber = slideRef?.sourceSlideNumber || slideRef;
  const instanceIndex = Number(slideRef?.instanceIndex || 0);
  const config = getRepeatableSlideConfig(sourceSlideNumber);
  if (!config) return fieldValues;
  const fieldId = makeRepeatableFieldId(sourceSlideNumber, config.key);
  const entries = parseRepeatableEntries(fieldValues[fieldId]);
  return {
    ...fieldValues,
    [fieldId]: stringifyRepeatableEntries(
      entries.slice(instanceIndex * config.pageSize, (instanceIndex + 1) * config.pageSize),
    ),
  };
}

function shouldHideUnusedRepeatableSlot(slideNumber, element, fieldValues = {}) {
  const config = REPEATABLE_FIELD_OVERRIDES.find((item) => (
    item.slide === slideNumber && Array.isArray(item.slotElementRanges)
  ));
  if (!config) return false;
  const order = Number(element?.order || 0);
  const slotIndex = config.slotElementRanges.findIndex(([start, end]) => order >= start && order <= end);
  if (slotIndex < 0) return false;
  const entries = parseRepeatableEntries(fieldValues[makeRepeatableFieldId(slideNumber, config.key)]);
  return !hasRepeatableEntryValue(entries[slotIndex]);
}

export function getFieldValuesForExportSlide(fieldValues = {}, slideRef) {
  const sourceSlideNumber = slideRef?.sourceSlideNumber || slideRef;
  const instanceIndex = Number(slideRef?.instanceIndex || 0);
  const config = getRepeatableSlideConfig(sourceSlideNumber);
  if (!config) return fieldValues;
  const fieldId = makeRepeatableFieldId(sourceSlideNumber, config.key);
  const entries = parseRepeatableEntries(fieldValues[fieldId]).filter(hasRepeatableEntryValue);
  return {
    ...fieldValues,
    [fieldId]: stringifyRepeatableEntries(
      entries.slice(instanceIndex * config.pageSize, (instanceIndex + 1) * config.pageSize),
    ),
  };
}

function getStructuredFieldValue(field, fieldValues) {
  const entries = parseRepeatableEntries(fieldValues[field.structuredSourceId]);
  const entry = entries[field.structuredEntryIndex] || {};
  return normalizeText(entry[field.structuredEntryKey]) || normalizeText(fieldValues[field.legacyFieldId]);
}

function getStructuredTableContent(field, entries) {
  const rows = entries.filter(hasRepeatableEntryValue).slice(0, field.repeatableConfig?.pageSize || 5);
  if (field.fieldKind === "shareholders") {
    const matrix = Array.from({ length: 6 }, () => ["", "", ""]);
    matrix[0] = ["Shareholder", "Ownership %", "Role"];
    rows.forEach((entry, index) => {
      const ownership = normalizeText(entry.ownership).replace(/%$/, "");
      matrix[index + 1] = [
        normalizeText(entry.name),
        ownership ? `${ownership}%` : "",
        normalizeText(entry.role),
      ];
    });
    matrix[5] = ["Total", "100%", ""];
    return {
      kind: "table",
      tableMatrix: matrix,
      visibleTableRows: [1, ...rows.map((_, index) => index + 2), 6],
      suppressTemplateFallback: true,
      compactTableRows: true,
    };
  }

  const matrix = Array.from({ length: 6 }, () => ["", "", ""]);
  matrix[0] = ["Competitor", "Size", "Key Differentiator"];
  rows.forEach((entry, index) => {
    const size = normalizeText(entry.size);
    matrix[index + 1] = [
      normalizeText(entry.name),
      size ? `$${size.replace(/^\$/, "").replace(/M$/i, "")}M` : "",
      normalizeText(entry.differentiation),
    ];
  });
  return {
    kind: "table",
    tableMatrix: matrix,
    visibleTableRows: [1, ...rows.map((_, index) => index + 2)],
    suppressTemplateFallback: true,
    compactTableRows: true,
  };
}

function getShareholderChartDataText(entries) {
  return entries
    .filter((entry) => normalizeText(entry.name) && normalizeText(entry.ownership))
    .map((entry) => `${normalizeText(entry.name)},${normalizeText(entry.ownership).replace(/%$/, "")}`)
    .join("\n");
}

export function formatFieldDisplayValue(field, value) {
  const raw = String(value || "").trim();
  if (field.displayFormat === "unsignedPercent") {
    return raw.replace(/^\+/, "").replace(/%$/, "").trim();
  }
  return raw;
}

function renderFieldDisplayTemplate(field, value) {
  if (!field?.displayTemplate) return value;
  return field.displayTemplate.replace("{value}", formatFieldDisplayValue(field, value));
}

function applyFieldValues(text, elementFields, fieldValues, globalDetails) {
  const clean = normalizeText(text);
  if (/^Project\s+\[NAME\]$/i.test(clean) && normalizeText(globalDetails.projectName)) {
    return globalDetails.projectName;
  }

  const fullTextField = elementFields.find((field) =>
    field.replaceFullText && typeof getStoredFieldValue(field, fieldValues) === "string" && getStoredFieldValue(field, fieldValues).trim(),
  );
  if (fullTextField) {
    return renderFieldDisplayTemplate(fullTextField, getStoredFieldValue(fullTextField, fieldValues));
  }

  let output = String(text || "");
  elementFields.forEach((field) => {
    const saved = getStoredFieldValue(field, fieldValues);
    if (!field.replaceText || typeof saved !== "string" || !saved.trim()) return;
    output = output.replace(field.replaceText, renderFieldDisplayTemplate(field, saved));
  });

  const counters = {};
  return output.replace(/\[([^\]]+)\]/g, (match, token) => {
    const globalValue = tokenValue(token, globalDetails, output);
    if (globalValue) return globalValue;

    const key = normalizeTokenKey(token);
    const occurrence = counters[key] || 0;
    counters[key] = occurrence + 1;
    const field = elementFields.find((candidate) =>
      candidate.tokenKey === key && Number(candidate.occurrence || 0) === occurrence,
    ) || elementFields.find((candidate) => candidate.tokenKey === key);
    if (!field) return match;
    const saved = field.structuredSourceId
      ? getStructuredFieldValue(field, fieldValues)
      : getStoredFieldValue(field, fieldValues);
    if (!normalizeText(saved) && field.slideNumber === 38 && field.order === 11) {
      return String(new Date().getFullYear());
    }
    return typeof saved === "string" && saved.trim()
      ? renderFieldDisplayTemplate(field, saved)
      : match;
  });
}

function isWholeElementToken(element, field) {
  const clean = normalizeText(element?.text);
  return Boolean(field?.token && clean === `[${field.token}]`);
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
  if (field?.chartDataPlaceholder) return field.chartDataPlaceholder;
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
  if (absolute >= 1000) return `${formatAutoFillNumber(numeric / 1000)}k`;
  return formatAutoFillNumber(numeric);
}

function getChartTitle(field) {
  if (field?.label && field.label !== getFieldLabel(field.text || "")) return field.label;
  const text = normalizeText(field?.text)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/^CHART[:\s-]*/i, "")
    .replace(/PLACEHOLDER/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 72) || field?.label || "Chart";
}

function chartGrid(plot, minValue, maxValue, chartStyle = getCimChartStyle()) {
  const lines = [];
  const range = maxValue - minValue || 1;

  for (let index = 0; index <= 4; index += 1) {
    const value = minValue + (range * index) / 4;
    const y = plot.y + plot.height - ((value - minValue) / range) * plot.height;
    lines.push(`
      <line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="${chartStyle.gridColor}" stroke-width="1"/>
      <text x="${plot.x - 10}" y="${y + 4}" text-anchor="end" font-size="18" fill="${chartStyle.labelColor}">${escapeSvg(formatChartValue(value))}</text>
    `);
  }

  return lines.join("");
}

function buildBarChart(data, plot, chartStyle = getCimChartStyle()) {
  const seriesCount = Math.max(1, ...data.map((row) => row.values.length));
  const maxValue = Math.max(1, ...data.flatMap((row) => row.values.map((value) => Math.max(0, value))));
  const groupWidth = plot.width / Math.max(data.length, 1);
  const barWidth = Math.min(42, (groupWidth * 0.68) / seriesCount);
  const palette = chartStyle.palette || CHART_COLORS;

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
        <rect x="${x}" y="${y}" width="${barWidth - 3}" height="${barHeight}" fill="${palette[seriesIndex % palette.length]}"/>
        <text x="${x + (barWidth - 3) / 2}" y="${y - 7}" text-anchor="middle" font-size="17" font-weight="700" fill="${chartStyle.titleColor}">${escapeSvg(formatChartValue(value))}</text>
      `;
    }),
  ).join("");

  const labels = data.map((row, rowIndex) => {
    const x = plot.x + rowIndex * groupWidth + groupWidth / 2;
    return `<text x="${x}" y="${plot.y + plot.height + 32}" text-anchor="middle" font-size="18" fill="${chartStyle.labelColor}">${escapeSvg(row.label)}</text>`;
  }).join("");

  return `${chartGrid(plot, 0, maxValue, chartStyle)}${bars}${labels}`;
}

function buildLineChart(data, plot, chartStyle = getCimChartStyle()) {
  const seriesCount = Math.max(1, ...data.map((row) => row.values.length));
  const values = data.flatMap((row) => row.values);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(1, ...values);
  const range = maxValue - minValue || 1;
  const step = data.length > 1 ? plot.width / (data.length - 1) : plot.width;
  const palette = chartStyle.palette || CHART_COLORS;
  const labels = data.map((row, rowIndex) => {
    const x = plot.x + rowIndex * step;
    return `<text x="${x}" y="${plot.y + plot.height + 32}" text-anchor="middle" font-size="18" fill="${chartStyle.labelColor}">${escapeSvg(row.label)}</text>`;
  }).join("");
  const series = Array.from({ length: seriesCount }, (_, seriesIndex) => {
    const points = data.map((row, rowIndex) => {
      const value = row.values[seriesIndex] ?? row.values[0] ?? 0;
      const x = plot.x + rowIndex * step;
      const y = plot.y + plot.height - ((value - minValue) / range) * plot.height;
      return [x, y, value];
    });
    const pointList = points.map(([x, y]) => `${x},${y}`).join(" ");
    const color = palette[seriesIndex % palette.length];
    const dots = points.map(([x, y, value]) => `
      <circle cx="${x}" cy="${y}" r="5" fill="${color}"/>
      <text x="${x}" y="${y - 12}" text-anchor="middle" font-size="17" font-weight="700" fill="${chartStyle.titleColor}">${escapeSvg(formatChartValue(value))}</text>
    `).join("");
    return `<polyline points="${pointList}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join("");

  return `${chartGrid(plot, minValue, maxValue, chartStyle)}${series}${labels}`;
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

function buildPieChart(data, chartStyle = getCimChartStyle()) {
  const total = data.reduce((sum, row) => sum + Math.abs(row.values[0] || 0), 0) || 1;
  let angle = 0;
  const palette = chartStyle.palette || CHART_COLORS;
  const slices = data.map((row, index) => {
    const value = Math.abs(row.values[0] || 0);
    const endAngle = angle + (value / total) * 360;
    const middle = angle + (endAngle - angle) / 2;
    const [labelX, labelY] = polarToCartesian(330, 278, 172, middle);
    const path = piePath(330, 278, 145, angle, endAngle);
    angle = endAngle;
    return `
      <path d="${path}" fill="${palette[index % palette.length]}" stroke="#FFFFFF" stroke-width="3"/>
      <text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="18" font-weight="700" fill="${chartStyle.titleColor}">${formatAutoFillNumber((value / total) * 100)}%</text>
    `;
  }).join("");
  const legend = data.map((row, index) => `
    <rect x="575" y="${175 + index * 42}" width="22" height="22" fill="${palette[index % palette.length]}"/>
    <text x="612" y="${193 + index * 42}" font-size="22" fill="${chartStyle.labelColor}">${escapeSvg(row.label)}</text>
  `).join("");

  return `${slices}${chartStyle.legendPosition === "none" ? "" : legend}`;
}

function buildWaterfallChart(data, plot, chartStyle = getCimChartStyle()) {
  const steps = [];
  let running = 0;
  const palette = chartStyle.palette || CHART_COLORS;

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
    const color = step.isTotal ? palette[1 % palette.length] : step.value >= 0 ? palette[0] : palette[2 % palette.length];
    const labelX = plot.x + index * groupWidth + groupWidth / 2;
    const connector = index < steps.length - 1
      ? `<line x1="${x + barWidth}" y1="${yFor(step.end)}" x2="${plot.x + (index + 1) * groupWidth + (groupWidth - barWidth) / 2}" y2="${yFor(step.end)}" stroke="${chartStyle.gridColor}" stroke-width="2" stroke-dasharray="5 4"/>`
      : "";
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" fill="${color}"/>
      <text x="${labelX}" y="${y - 8}" text-anchor="middle" font-size="17" font-weight="700" fill="${chartStyle.titleColor}">${escapeSvg(formatChartValue(step.end))}</text>
      <text x="${labelX}" y="${plot.y + plot.height + 32}" text-anchor="middle" font-size="16" fill="${chartStyle.labelColor}">${escapeSvg(step.label)}</text>
      ${connector}
    `;
  }).join("");

  return `${chartGrid(plot, minValue, maxValue, chartStyle)}${bars}`;
}

function buildChartSvg(field, chartConfig = {}, styleProfile = null) {
  const type = chartConfig.type || getDefaultChartType(field);
  const data = parseChartData(chartConfig.dataText || "", getDefaultChartData(field, type));
  const plot = { x: 86, y: 105, width: 780, height: 290 };
  const chartStyle = getCimChartStyle(styleProfile);
  const chart =
    type === "pie"
      ? buildPieChart(data, chartStyle)
      : type === "line"
        ? buildLineChart(data, plot, chartStyle)
        : type === "waterfall"
          ? buildWaterfallChart(data, plot, chartStyle)
          : buildBarChart(data, plot, chartStyle);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520">
    <rect width="960" height="520" fill="${chartStyle.backgroundColor}"/>
    <text x="48" y="56" font-family="${escapeSvg(chartStyle.axisFontFamily)}, Arial, sans-serif" font-size="28" font-weight="700" fill="${chartStyle.titleColor}">${escapeSvg(getChartTitle(field))}</text>
    <line x1="48" y1="76" x2="912" y2="76" stroke="${chartStyle.palette?.[0] || "#8BC53D"}" stroke-width="3"/>
    <g font-family="${escapeSvg(chartStyle.axisFontFamily)}, Arial, sans-serif">${chart}</g>
  </svg>`;
}

function wrapSvgText(value, maxCharacters = 24, maxLines = 3) {
  const words = normalizeText(value).split(" ").filter(Boolean);
  const lines = [];
  words.forEach((word) => {
    const current = lines[lines.length - 1] || "";
    if (!current || `${current} ${word}`.length > maxCharacters) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  });
  if (lines.length > maxLines) {
    const clipped = lines.slice(0, maxLines);
    clipped[maxLines - 1] = `${clipped[maxLines - 1].slice(0, Math.max(1, maxCharacters - 1))}…`;
    return clipped;
  }
  return lines;
}

function buildTimelineSvg(entries, styleProfile = null) {
  const rows = entries.filter(hasRepeatableEntryValue);
  const chartStyle = getCimChartStyle(styleProfile);
  const width = 1200;
  const height = 210;
  const lineY = 104;
  const sidePadding = Math.min(80, Math.max(36, width / Math.max(rows.length * 3, 1)));
  const usableWidth = width - sidePadding * 2;
  const step = rows.length > 1 ? usableWidth / (rows.length - 1) : 0;
  const labelWidth = Math.max(92, Math.min(190, usableWidth / Math.max(rows.length, 1)));
  const maxCharacters = Math.max(12, Math.floor(labelWidth / 7));

  const milestones = rows.map((entry, index) => {
    const x = rows.length === 1 ? width / 2 : sidePadding + index * step;
    const above = index % 2 === 0;
    const descriptionLines = wrapSvgText(entry.description, maxCharacters, 3);
    const descriptionY = above ? 135 : 28;
    const yearY = above ? 42 : 180;
    const connectorY = above ? 67 : 128;
    const lineHeight = 17;
    const description = descriptionLines.map((line, lineIndex) => (
      `<tspan x="${x}" dy="${lineIndex === 0 ? 0 : lineHeight}">${escapeSvg(line)}</tspan>`
    )).join("");
    return `
      <line x1="${x}" y1="${lineY}" x2="${x}" y2="${connectorY}" stroke="${chartStyle.palette[0]}" stroke-width="2"/>
      <circle cx="${x}" cy="${lineY}" r="8" fill="${chartStyle.palette[0]}" stroke="${chartStyle.titleColor}" stroke-width="2"/>
      <text x="${x}" y="${yearY}" text-anchor="middle" font-size="18" font-weight="700" fill="${chartStyle.titleColor}">${escapeSvg(entry.year || "")}</text>
      <text x="${x}" y="${descriptionY}" text-anchor="middle" font-size="14" fill="${chartStyle.labelColor}">${description}</text>
    `;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${chartStyle.backgroundColor}"/>
    <line x1="${sidePadding}" y1="${lineY}" x2="${width - sidePadding}" y2="${lineY}" stroke="${chartStyle.titleColor}" stroke-width="3"/>
    <g font-family="${escapeSvg(chartStyle.axisFontFamily)}, Arial, sans-serif">${milestones}</g>
  </svg>`;
}

function buildPositioningMatrixSvg(entries, styleProfile = null) {
  const rows = entries.filter((entry) => normalizeText(entry.name));
  const chartStyle = getCimChartStyle(styleProfile);
  const plot = { x: 110, y: 55, width: 760, height: 365 };
  const grid = Array.from({ length: 6 }, (_, index) => {
    const x = plot.x + (plot.width * index) / 5;
    const y = plot.y + (plot.height * index) / 5;
    return `<line x1="${x}" y1="${plot.y}" x2="${x}" y2="${plot.y + plot.height}" stroke="${chartStyle.gridColor}" stroke-width="1"/>
      <line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="${chartStyle.gridColor}" stroke-width="1"/>`;
  }).join("");
  const points = rows.map((entry, index) => {
    const xScore = Math.max(0, Math.min(10, parseChartNumber(entry.xScore) ?? 5));
    const yScore = Math.max(0, Math.min(10, parseChartNumber(entry.yScore) ?? 5));
    const x = plot.x + (xScore / 10) * plot.width;
    const y = plot.y + plot.height - (yScore / 10) * plot.height;
    const color = chartStyle.palette[index % chartStyle.palette.length];
    return `<circle cx="${x}" cy="${y}" r="11" fill="${color}" stroke="#FFFFFF" stroke-width="3"/>
      <text x="${x + 15}" y="${y - 13}" font-size="18" font-weight="700" fill="${chartStyle.titleColor}">${escapeSvg(entry.name)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520">
    <rect width="960" height="520" fill="${chartStyle.backgroundColor}"/>
    <g font-family="${escapeSvg(chartStyle.axisFontFamily)}, Arial, sans-serif">${grid}${points}</g>
    <line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="${chartStyle.titleColor}" stroke-width="3"/>
    <line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="${chartStyle.titleColor}" stroke-width="3"/>
    <text x="${plot.x + plot.width / 2}" y="485" text-anchor="middle" font-family="${escapeSvg(chartStyle.axisFontFamily)}, Arial, sans-serif" font-size="20" font-weight="700" fill="${chartStyle.titleColor}">Dimension A</text>
    <text x="32" y="${plot.y + plot.height / 2}" text-anchor="middle" transform="rotate(-90 32 ${plot.y + plot.height / 2})" font-family="${escapeSvg(chartStyle.axisFontFamily)}, Arial, sans-serif" font-size="20" font-weight="700" fill="${chartStyle.titleColor}">Dimension B</text>
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

function getCimBuilderTemplateElementId(slideNumber, element, suffix = "") {
  const base = element?.id || element?.aid || element?.order || "element";
  return `template:${slideNumber}:${base}${suffix ? `:${suffix}` : ""}`;
}

// Native CIM Builder: builds a flat, editable element model for one slide.
// Walks layout.elements the same way SlideCanvas does, so filtering, asset
// resolution, chart images, repeatable slots, and token resolution share one
// source of truth.
export function buildCimBuilderElementSpecs(slideNumber, layout, fields, fieldValues, assetValues, chartValues, globalDetails, styleProfile) {
  const elements = layout?.elements || [];
  const resolvedAssetValues = assetValues || {};
  const resolvedChartValues = chartValues || {};
  const fieldsById = Object.fromEntries((fields || []).map((field) => [field.id, field]));
  const fieldsByElement = groupFieldsByElement(fields || []);
  const specs = [{
    cimKind: "background",
    x: 0,
    y: 0,
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    fill: "#FFFFFF",
    stroke: "transparent",
    strokeWidth: 0,
    editable: false,
  }];

  elements.forEach((element, elementIndex) => {
    if (shouldHideUnusedRepeatableSlot(slideNumber, element, fieldValues)) return;
    if (shouldHideLogoPlaceholderShape(elements, elementIndex, resolvedAssetValues)) return;

    const content = getElementContent(
      slideNumber, element, fieldsById, fieldValues, resolvedAssetValues, resolvedChartValues, globalDetails, styleProfile,
    );
    if (content.kind === "hidden") return;

    const [left = 0, top = 0, width = 0, height = 0] = content.bbox || element.bbox || [];
    const fieldId = getElementFieldId(slideNumber, element);
    const elementFields = fieldId ? (fieldsByElement[fieldId] || []) : [];
    const mediaField = elementFields.find((candidate) => isAssetField(candidate) || isChartField(candidate));
    const editableElementFields = elementFields.filter((candidate) => !candidate.hidden && candidate.fieldKind === "text");
    const linkedElementFields = elementFields.filter((candidate) => (
      candidate.fieldKind === "text" && !isPptTextField(candidate)
    ));
    const editableLinkedElementFields = linkedElementFields.filter((candidate) => !candidate.hidden);
    const pptTextField = editableElementFields.find(isPptTextField);
    const inlineTokenField = editableLinkedElementFields.length === 1 && isWholeElementToken(element, editableLinkedElementFields[0])
      ? editableLinkedElementFields[0]
      : null;
    const inlineTextField = !mediaField
      ? inlineTokenField || (linkedElementFields.length === 0 ? pptTextField : null)
      : null;

    if (element.kind === "table" && Array.isArray(element.cells)) {
      const matrix = content.tableMatrix || parseTableText(content.text ?? "", element.rows, element.cols);
      const visibleRows = content.visibleTableRows || Array.from(
        { length: Number(element.rows || 0) },
        (_, index) => index + 1,
      );
      const visibleColumns = content.visibleTableColumns || Array.from(
        { length: Number(element.cols || 0) },
        (_, index) => index + 1,
      );
      const sourceTableLeft = Number(element.bbox?.[0] || 0);
      const targetLeft = Number(left || sourceTableLeft);
      const targetTop = Number(top || element.bbox?.[1] || 0);
      const tableScaleX = Number(content.tableScaleX || 1);
      const sourceLabelWidth = Number(
        element.cells.find((cell) => Number(cell.column || 1) === 1)?.bbox?.[2] || 0,
      );
      const compactValueWidth = visibleColumns.length > 1
        ? (Number(element.bbox?.[2] || 0) - sourceLabelWidth) / (visibleColumns.length - 1)
        : 0;

      (element.cells || []).filter((cell) => (
        visibleRows.includes(Number(cell.row || 1)) &&
        visibleColumns.includes(Number(cell.column || 1))
      )).forEach((cell) => {
        const [cellLeft = 0, cellTop = 0, cellWidth = 0, cellHeight = 0] = cell.bbox || [];
        const rowIndex = Number(cell.row || 1) - 1;
        const colIndex = Number(cell.column || 1) - 1;
        const compactRowIndex = visibleRows.indexOf(Number(cell.row || 1));
        const compactColumnIndex = visibleColumns.indexOf(Number(cell.column || 1));
        const effectiveCellLeft = content.compactTableColumns
          ? targetLeft + (compactColumnIndex === 0
            ? 0
            : sourceLabelWidth + (compactColumnIndex - 1) * compactValueWidth)
          : targetLeft + (cellLeft - sourceTableLeft) * tableScaleX;
        const effectiveCellTop = content.compactTableRows
          ? targetTop + compactRowIndex * cellHeight
          : cellTop;
        const effectiveCellWidth = content.compactTableColumns
          ? (compactColumnIndex === 0 ? sourceLabelWidth : compactValueWidth)
          : cellWidth * tableScaleX;
        const matrixValue = matrix[rowIndex]?.[colIndex];
        const cellText = content.suppressTemplateFallback
          ? (matrixValue ?? "")
          : (matrixValue || applyGlobalDetails(cell.text, globalDetails));
        const cellStyle = getElementStyle(cell);
        const cellInsets = cellStyle.insets || {};
        specs.push({
          id: getCimBuilderTemplateElementId(slideNumber, element, `cell-bg-${cell.index || `${cell.row}-${cell.column}`}`),
          type: "shape",
          subType: "rect",
          cimKind: "tableRect",
          x: effectiveCellLeft,
          y: effectiveCellTop,
          width: effectiveCellWidth,
          height: cellHeight,
          fill: cssColor(cell.fillColor, "transparent"),
          stroke: cssColor(cell.lineColor, "transparent"),
          strokeWidth: Math.max(Number(cell.lineWidth || 0), 0),
          zIndex: Number(element.order || 1) * 100 + Number(cell.index || 0),
          editable: false,
        });
        specs.push({
          id: getCimBuilderTemplateElementId(slideNumber, element, `cell-text-${cell.index || `${cell.row}-${cell.column}`}`),
          type: "text",
          cimKind: "tableCell",
          cimLinkedFieldIds: linkedElementFields.map(getFieldValueKey).filter(Boolean),
          x: effectiveCellLeft,
          y: effectiveCellTop,
          width: effectiveCellWidth,
          height: cellHeight,
          text: cellText, fontFamily: cellStyle.fontFamily, fontSize: cellStyle.fontSize,
          fill: cellStyle.color, align: cellStyle.textAlign,
          fontWeight: cellStyle.fontWeight,
          fontStyle: cellStyle.fontStyle,
          textDecoration: cellStyle.textDecoration,
          verticalAlign: cellStyle.verticalAlignment,
          lineHeight: cellStyle.lineHeight,
          letterSpacing: cellStyle.letterSpacing,
          wrap: cellStyle.wrap,
          insets: {
            top: Number(cellInsets.top || 0),
            right: Number(cellInsets.right || 0),
            bottom: Number(cellInsets.bottom || 0),
            left: Number(cellInsets.left || 0),
          },
          zIndex: Number(element.order || 1) * 100 + Number(cell.index || 0) + 1,
          editable: false,
        });
      });
      return;
    }

    if ((content.kind === "image" || content.kind === "chart") && content.dataUrl) {
      specs.push({
        id: getCimBuilderTemplateElementId(slideNumber, element),
        type: "image",
        cimKind: content.kind,
        cimAssetKey: content.kind === "image" && mediaField ? getAssetKey(mediaField) : null,
        x: left, y: top, width, height,
        src: content.dataUrl,
        fit: content.fit || element.imageFit || element.fit || "contain",
        objectPosition: content.objectPosition || element.objectPosition || "center center",
        zIndex: Number(element.order || 1),
      });
      return;
    }

    // Decorative shapes (background bars, dividers, theme-colored panels) --
    // same condition SlideCanvas uses at its bare-<div> branch. These already
    // carry theme-resolved colors by the time this runs (applyCimTemplateStyleProfile
    // rewrites fillColor/lineColor before layout reaches either renderer).
    if (!element.text && content.kind !== "image" && content.kind !== "chart") {
      const isRule = width === 0 || height === 0;
      specs.push({
        id: getCimBuilderTemplateElementId(slideNumber, element),
        type: isRule ? "line" : "shape",
        subType: element.geometry === "ellipse" ? "ellipse" : "rect",
        cimKind: "shape",
        x: left, y: top, width, height,
        fill: cssColor(isRule ? (element.lineColor || element.fillColor) : element.fillColor, "transparent"),
        stroke: element.lineColor ? cssColor(element.lineColor, "transparent") : "transparent",
        strokeWidth: element.lineColor ? Math.max(Number(element.lineWidth || 0), 0) : 0,
        isEllipse: element.geometry === "ellipse",
        zIndex: Number(element.order || 1),
        editable: false,
      });
      return;
    }

    const displayText = content.text ?? element.text ?? "";
    if (!normalizeText(displayText) && !inlineTextField) return;
    const style = elementFields[0]?.style || getElementStyle(element);
    const insets = style.insets || {};
    const isRule = width === 0 || height === 0;
    specs.push({
      id: getCimBuilderTemplateElementId(slideNumber, element),
      type: "text",
      cimKind: "text",
      cimFieldId: inlineTextField ? getFieldValueKey(inlineTextField) : null,
      cimLinkedFieldIds: linkedElementFields.map(getFieldValueKey).filter(Boolean),
      x: left, y: top, width, height,
      text: displayText,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fill: style.color,
      align: style.textAlign,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      textDecoration: style.textDecoration,
      verticalAlign: style.verticalAlignment,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      wrap: style.wrap,
      insets: {
        top: Number(insets.top || 0),
        right: Number(insets.right || 0),
        bottom: Number(insets.bottom || 0),
        left: Number(insets.left || 0),
      },
      backgroundFill: isRule ? "transparent" : cssColor(element.fillColor, "transparent"),
      stroke: element.lineColor ? cssColor(element.lineColor, "transparent") : "transparent",
      strokeWidth: element.lineColor ? Math.max(Number(element.lineWidth || 0), 0) : 0,
      zIndex: Number(element.order || 1),
      editable: Boolean(inlineTextField),
    });
  });

  return specs;
}

// Inverse of buildCimBuilderElementSpecs for field-bound text.
export function applyCimBuilderElementsToFieldValues(builderElements = []) {
  const fieldValues = {};
  (builderElements || []).forEach((element) => {
    const cimFieldId = element?.cimFieldId;
    if (!cimFieldId) return;
    if (element.type === "text") fieldValues[cimFieldId] = element.text ?? "";
  });
  return fieldValues;
}

function getChartDataUrl(field, chartValues, fieldValues = {}, styleProfile = null) {
  if (field.chartKind === "ownershipPie" || field.chartKind === "positioningMatrix") {
    const entries = parseRepeatableEntries(fieldValues[field.structuredSourceId]);
    if (field.chartKind === "positioningMatrix") {
      return svgToDataUrl(buildPositioningMatrixSvg(entries, styleProfile));
    }
    const dataText = getShareholderChartDataText(entries);
    return svgToDataUrl(buildChartSvg(
      { ...field, label: "Ownership Summary", text: "[Ownership Summary]" },
      { type: "pie", dataText },
      styleProfile,
    ));
  }

  return svgToDataUrl(buildChartSvg(field, getChartConfig(field, chartValues), styleProfile));
}

function getElementLayoutOverride(slideNumber, element) {
  const order = Number(element?.order || 0);
  const metricCards = {
    6: {
      values: [9, 14, 19, 24],
      labels: [10, 15, 20, 25],
      details: [11, 16, 21, 26],
      valueBox: [null, 158.4, null, 56],
      labelBox: [null, 228, null, 24],
      detailBox: [null, 258, null, 26],
    },
    17: {
      values: [9, 14, 19, 24],
      labels: [10, 15, 20, 25],
      details: [11, 16, 21, 26],
      valueBox: [null, 158.4, null, 54],
      labelBox: [null, 226, null, 24],
      detailBox: [null, 255, null, 24],
    },
    28: {
      values: [9, 14, 19, 24],
      labels: [10, 15, 20, 25],
      details: [11, 16, 21, 26],
      valueBox: [null, 158.4, null, 54],
      labelBox: [null, 226, null, 24],
      detailBox: [null, 255, null, 24],
    },
    29: {
      values: [9, 14, 19, 24],
      labels: [10, 15, 20, 25],
      details: [11, 16, 21, 26],
      valueBox: [null, 158.4, null, 52],
      labelBox: [null, 220, null, 24],
      detailBox: [null, 250, null, 24],
    },
    30: {
      values: [9, 14, 19, 24],
      labels: [10, 15, 20, 25],
      details: [11, 16, 21, 26],
      valueBox: [null, 158.4, null, 52],
      labelBox: [null, 220, null, 24],
      detailBox: [null, 250, null, 24],
    },
  };
  const metricConfig = metricCards[slideNumber];
  if (metricConfig) {
    const sourceBox = element.bbox || [0, 0, 0, 0];
    const template = metricConfig.values.includes(order)
      ? metricConfig.valueBox
      : metricConfig.labels.includes(order)
        ? metricConfig.labelBox
        : metricConfig.details.includes(order)
          ? metricConfig.detailBox
          : null;
    if (template) {
      return {
        bbox: template.map((value, index) => value === null ? sourceBox[index] : value),
      };
    }
  }

  if (slideNumber === 32 && order === 7) {
    return { bbox: [33.6, 148.8, 590.4, 441.6], tableScaleX: 590.4 / 816 };
  }
  if (slideNumber === 32 && order === 9) {
    return { bbox: [652.8, 148.8, 592.32, 441.6] };
  }
  return {};
}

function withElementLayout(slideNumber, element, content) {
  return { ...content, ...getElementLayoutOverride(slideNumber, element) };
}

function getElementAutofillKey(kind, slideNumber, order) {
  return `__cim_${kind}__:${slideNumber}:${order}`;
}

function getSlide25ElementContent(element, fieldValues = {}, styleProfile = null) {
  const order = Number(element?.order || 0);
  if (![5, 8, 9, 10].includes(order)) return null;

  const bridge = getSlide25BridgeFigures(fieldValues[SLIDE_25_BRIDGE_FIELD_ID]);
  if (order === 5) {
    if (bridge.reported === null || bridge.adjustments.length) return null;
    return {
      kind: "text",
      text: `Adjusted EBITDA of ${formatSlide25Millions(bridge.adjusted)} equals reported EBITDA`,
    };
  }
  if (bridge.reported === null) {
    return { kind: "hidden" };
  }

  const adjustmentCount = bridge.adjustments.length;
  const reportedText = formatSlide25Millions(bridge.reported);
  const adjustedText = formatSlide25Millions(bridge.adjusted);

  if (order === 8) {
    const chartData = [
      `Reported EBITDA,${bridge.reported}`,
      ...bridge.adjustments.map((adjustment) =>
        `${adjustment.label.replace(/[,|]/g, " ")},${adjustment.numericAmount}`,
      ),
      `Adjusted EBITDA,${bridge.adjusted}`,
    ].join("\n");
    return {
      kind: "chart",
      dataUrl: svgToDataUrl(buildChartSvg(
        { ...SLIDE_25_BRIDGE_FIELD, text: "Adjusted EBITDA waterfall", label: "Adjusted EBITDA bridge" },
        { type: "waterfall", dataText: chartData },
        styleProfile,
      )),
      name: "Adjusted EBITDA bridge",
    };
  }
  if (order === 9) {
    return { kind: "text", text: adjustmentCount ? "ADJUSTMENT SCHEDULE" : "EBITDA RECONCILIATION" };
  }
  if (order === 10) {
    const scheduleAdjustments = bridge.adjustments.slice(0, 6);
    const matrix = Array.from({ length: 9 }, () => ["", "", ""]);
    matrix[0] = ["Item", "$M", "Nature"];
    matrix[1] = ["Reported EBITDA", reportedText, "Reported"];
    scheduleAdjustments.forEach((adjustment, index) => {
      matrix[index + 2] = [
        adjustment.label,
        formatSlide25Millions(adjustment.numericAmount),
        adjustment.nature,
      ];
    });
    matrix[8] = ["Adjusted EBITDA", adjustedText, adjustmentCount ? "After adjustments" : "Equals reported EBITDA"];
    return {
      kind: "table",
      tableMatrix: matrix,
      visibleTableRows: [
        1,
        2,
        ...scheduleAdjustments.map((_, index) => index + 3),
        9,
      ],
      compactTableRows: true,
      suppressTemplateFallback: true,
    };
  }

  return null;
}

function getSlide27ElementContent(element, fieldValues = {}) {
  const order = Number(element?.order || 0);
  if (order !== 7) return null;

  const cashflow = normalizeSlide27Cashflow(fieldValues[SLIDE_27_CASHFLOW_FIELD_ID]);
  const columns = cashflow.columns.slice(0, 6);

  const rows = cashflow.rows.slice(0, 23);
  const matrix = Array.from({ length: 24 }, () => Array.from({ length: 7 }, () => ""));
  matrix[0] = ["Cash Flow Classification", ...columns.map((column) => column.label)];
  rows.forEach((row, rowIndex) => {
    matrix[rowIndex + 1] = [
      `${"  ".repeat(Math.min(row.depth, 3))}${row.label}`,
      ...columns.map((column) => row.values[column.key] || "-"),
    ];
  });

  return {
    kind: "table",
    tableMatrix: matrix,
    visibleTableRows: Array.from({ length: rows.length + 1 }, (_, index) => index + 1),
    visibleTableColumns: Array.from({ length: columns.length + 1 }, (_, index) => index + 1),
    compactTableRows: true,
    compactTableColumns: true,
    suppressTemplateFallback: true,
  };
}

function getElementContent(slideNumber, element, fieldsById, fieldValues, assetValues, chartValues, globalDetails, styleProfile = null) {
  if (element?.kind === "styleImage" && element.dataUrl) {
    return { kind: "image", dataUrl: element.dataUrl, name: element.name || "Brand image" };
  }
  if (element?.kind === "styleText") {
    return { kind: "text", text: element.text || "" };
  }
  if (slideNumber === 9 && Number(element?.order || 0) >= 8 && Number(element?.order || 0) <= 31) {
    return { kind: "hidden" };
  }
  if (slideNumber === 9 && Number(element?.order || 0) === 7) {
    const entries = parseRepeatableEntries(fieldValues?.[makeRepeatableFieldId(9, "milestones")])
      .filter(hasRepeatableEntryValue);
    return entries.length
      ? {
        kind: "chart",
        dataUrl: svgToDataUrl(buildTimelineSvg(entries, styleProfile)),
        name: "Company growth milestones",
        bbox: [28.8, 142, 1222.08, 216],
      }
      : { kind: "hidden" };
  }
  if (slideNumber === 30 && [29, 30, 31].includes(Number(element?.order || 0))) {
    return { kind: "hidden" };
  }
  if (slideNumber === 25) {
    const bridgeContent = getSlide25ElementContent(element, fieldValues, styleProfile);
    if (bridgeContent) return withElementLayout(slideNumber, element, bridgeContent);
  }
  if (slideNumber === 27) {
    const cashflowContent = getSlide27ElementContent(element, fieldValues);
    if (cashflowContent) return withElementLayout(slideNumber, element, cashflowContent);
  }
  if (!element?.text) return withElementLayout(slideNumber, element, { kind: "text", text: "" });
  const elementFields = getElementFields(slideNumber, element, fieldsById);
  const structuredTableField = elementFields.find((field) => field.structuredTable);
  if (structuredTableField) {
    const entries = parseRepeatableEntries(
      fieldValues?.[structuredTableField.id],
      structuredTableField.repeatableConfig,
    );
    return withElementLayout(
      slideNumber,
      element,
      getStructuredTableContent(structuredTableField, entries),
    );
  }
  const mediaField = elementFields.find((field) => isAssetField(field) || isChartField(field));

  if (mediaField?.structuredSourceId && isAssetField(mediaField)) {
    const entries = parseRepeatableEntries(fieldValues?.[mediaField.structuredSourceId]);
    const media = entries[mediaField.structuredEntryIndex]?.[mediaField.structuredEntryKey];
    if (media?.dataUrl) {
      return withElementLayout(slideNumber, element, { kind: "image", dataUrl: media.dataUrl, name: media.name || mediaField.label });
    }
  }

  if (mediaField && isAssetField(mediaField)) {
    const asset = assetValues?.[getAssetKey(mediaField)] || assetValues?.[mediaField.legacyAssetKey];
    if (asset?.dataUrl) {
      return withElementLayout(slideNumber, element, {
        kind: "image",
        dataUrl: asset.dataUrl,
        name: asset.name || mediaField.label,
        bbox: scaleBboxAroundCenter(element.bbox, normalizeAssetScale(asset.scale)),
      });
    }
  }

  if (mediaField && isChartField(mediaField)) {
    if (mediaField.structuredSourceId) {
      const entries = parseRepeatableEntries(fieldValues?.[mediaField.structuredSourceId]).filter(hasRepeatableEntryValue);
      if (!entries.length) return { kind: "hidden" };
    }
    return withElementLayout(slideNumber, element, {
      kind: "chart",
      dataUrl: getChartDataUrl(mediaField, chartValues, fieldValues, styleProfile),
      name: mediaField.label,
    });
  }

  const displayText = getElementDisplayText(slideNumber, element, fieldsById, fieldValues, globalDetails);
  const override = fieldValues?.[getElementAutofillKey("element_override", slideNumber, element.order)];
  const suffix = fieldValues?.[getElementAutofillKey("element_suffix", slideNumber, element.order)];

  const content = {
    kind: "text",
    text: override || `${displayText}${suffix || ""}`,
  };
  if (slideNumber === 24 && element.order === 7 && element.kind === "table") {
    content.text = content.text.replace(/\[[^\]]+\]/g, "");
    content.visibleTableColumns = getSlide24VisibleTableColumns(elementFields, fieldValues);
    content.compactTableColumns = true;
    content.suppressTemplateFallback = true;
  }
  if (slideNumber === 26 && element.order === 5) {
    content.text = cleanSlide26MoneyPlaceholderText(content.text);
  }
  if (slideNumber === 26 && element.order === 7 && element.kind === "table") {
    content.text = cleanSlide26MoneyPlaceholderText(content.text).replace(/\[[^\]]+\]/g, "");
    content.visibleTableColumns = getSlide26VisibleTableColumns(elementFields, fieldValues);
    content.compactTableColumns = true;
    content.suppressTemplateFallback = true;
  }
  if (slideNumber === 30 && element.order === 28 && element.kind === "table") {
    const headerLine = String(content.text || "").split("\n")[0] || "";
    const columnCount = Math.max(1, headerLine.split("|").length);
    content.visibleTableColumns = Array.from({ length: columnCount }, (_, index) => index + 1);
    content.compactTableColumns = true;
    content.suppressTemplateFallback = true;
  }
  if (element.kind === "table" && Array.isArray(element.cells) && !content.tableMatrix) {
    content.tableMatrix = parseTableText(content.text ?? "", element.rows, element.cols);
  }
  return withElementLayout(slideNumber, element, content);
}

function hasFieldData(field, fieldValues, assetValues, chartValues) {
  if (field.hidden) return false;
  if (field.fieldKind === "ebitdaBridge") {
    return getSlide25BridgeFigures(fieldValues[field.id]).reported !== null;
  }
  if (field.fieldKind === "cashflowStatement") {
    return normalizeSlide27Cashflow(fieldValues[field.id]).rows.length > 0;
  }
  if (isAssetField(field)) return Boolean(assetValues?.[getAssetKey(field)]?.dataUrl);
  if (isChartField(field)) return Boolean(normalizeText(chartValues?.[field.id]?.dataText));
  if (field.repeatableConfig) {
    return parseRepeatableEntries(fieldValues[field.id], field.repeatableConfig).some(hasRepeatableEntryValue);
  }
  return Boolean(normalizeText(getStoredFieldValue(field, fieldValues)));
}

function getEditableTemplateFields(fields = [], globalDetails) {
  const includesSlide25 = fields.some((field) => field.slideNumber === 25);
  const includesSlide27 = fields.some((field) => field.slideNumber === 27);
  const editableFields = fields.filter(
    (field) => !(
      field.pptOnly ||
      (field.slideNumber === 25 && [8, 10].includes(field.order)) ||
      (field.slideNumber === 27 && field.order === 7)
    ),
  ).filter(
    (field) => !field.hidden && !isResolvedByGlobalDetails(field, globalDetails),
  );

  const insertStructuredField = (structuredField) => {
    const insertAt = editableFields.findIndex((field) =>
      field.slideNumber === structuredField.slideNumber && field.order > structuredField.order,
    );
    if (insertAt < 0) editableFields.push(structuredField);
    else editableFields.splice(insertAt, 0, structuredField);
  };
  if (includesSlide25) insertStructuredField(SLIDE_25_BRIDGE_FIELD);
  if (includesSlide27) insertStructuredField(SLIDE_27_CASHFLOW_FIELD);

  const slideOneAdvisorLogos = editableFields.filter((field) =>
    field.slideNumber === 1 && isAssetField(field) && getAssetKey(field) === "advisor-logo",
  );
  if (slideOneAdvisorLogos.length === 0) return editableFields;

  const advisorLogoField = slideOneAdvisorLogos[slideOneAdvisorLogos.length - 1];
  return [
    ...editableFields.filter((field) =>
      !(field.slideNumber === 1 && isAssetField(field) && getAssetKey(field) === "advisor-logo"),
    ),
    advisorLogoField,
  ];
}

function countFieldsWithData(fields = [], fieldValues, assetValues, chartValues) {
  return fields.filter((field) => hasFieldData(field, fieldValues, assetValues, chartValues)).length;
}

function createDefaultQuestion(field) {
  if (field.prompt) return field.prompt;
  if (isAssetField(field)) return `Please provide the ${field.label.toLowerCase()} or confirm what should be used.`;
  if (isChartField(field)) return `Please provide the source figures, labels, or notes needed to build ${field.label}.`;
  return `Please provide the information needed for ${field.label}.`;
}

function getFieldTokenIndex(field) {
  const match = String(field?.id || "").match(/:token:(\d+):/);
  return match ? Number(match[1]) : null;
}

function formatAutoFillNumber(value, digits = CIM_FINANCIAL_MAX_DECIMALS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const decimalPlaces = Number.isInteger(Number(digits))
    ? Math.max(0, Math.min(6, Number(digits)))
    : CIM_FINANCIAL_MAX_DECIMALS;
  const rounded = Math.abs(numeric) < 0.5 / (10 ** decimalPlaces) ? 0 : numeric;
  const fixed = rounded.toFixed(decimalPlaces);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function formatAutoFillMillions(value, digits = CIM_FINANCIAL_MAX_DECIMALS) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || Math.abs(numeric) < 0.0001) return "";
  return formatAutoFillNumber(numeric / 1_000_000, digits);
}

function formatAutoFillThousands(value, digits = CIM_FINANCIAL_MAX_DECIMALS) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || Math.abs(numeric) < 0.0001) return "";
  return formatAutoFillNumber(numeric / 1_000, digits);
}

function formatAutoFillPercent(value, digits = CIM_FINANCIAL_MAX_DECIMALS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) < 0.0001) return "";
  return formatAutoFillNumber(numeric, digits);
}

function getAutoFillMetric(snapshot, year, key) {
  if (!year || !key) return 0;
  return Number(snapshot?.metricsByYear?.[year]?.[key] || 0);
}

function getAutoFillYearMetrics(snapshot, year) {
  return snapshot?.metricsByYear?.[year] || {};
}

function getLongAutoFillDate(year) {
  return year ? `December 31, ${year}` : "";
}

function getShortAutoFillDate(year) {
  return year ? `Dec. 31, ${year}` : "";
}

function formatAutoFillDate(value, format = "long") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: format === "short" ? "short" : "long",
    day: "numeric",
    year: "numeric",
  });
}

function getCurrentAutoFillLongDate(snapshot, fallbackYear) {
  return formatAutoFillDate(snapshot?.currentPeriod?.endDate, "long") || getLongAutoFillDate(fallbackYear);
}

function getCurrentAutoFillShortDate(snapshot, fallbackYear) {
  return formatAutoFillDate(snapshot?.currentPeriod?.endDate, "short") || getShortAutoFillDate(fallbackYear);
}

function formatDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDefaultFinancialAutofillRange() {
  const year = new Date().getFullYear() - 1;
  return {
    companyStartDate: "",
    periodType: "calendar",
    startDate: formatDateInputValue(new Date(year - 4, 0, 1)),
    endDate: formatDateInputValue(new Date(year, 11, 31)),
  };
}

function getFinancialAutofillRangeError(range = {}) {
  const startDate = String(range.startDate || "");
  const endDate = String(range.endDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return "Select both financial period dates.";
  }
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (start > end) return "The from date must be before the to date.";
  const maximumEnd = new Date(start);
  maximumEnd.setFullYear(maximumEnd.getFullYear() + 5);
  maximumEnd.setDate(maximumEnd.getDate() - 1);
  if (end > maximumEnd) return "The selected financial period cannot exceed five years.";
  if (range.companyStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(range.companyStartDate))) {
    return "Choose a valid company operating start date.";
  }
  return "";
}

function isValidFinancialAutofillRange(range = {}) {
  return !getFinancialAutofillRangeError(range);
}

function getFinancialAutofillRangeLabel(range = {}) {
  const start = formatAutoFillDate(range.startDate, "short");
  const end = formatAutoFillDate(range.endDate, "short");
  return start && end ? `${start} - ${end}` : "selected FY range";
}

function getSlide24ActivePeriodCount(range = {}) {
  if (!range || !range.startDate || !range.endDate) return 6;
  const startYear = Number(String(range.startDate).slice(0, 4));
  const rawEndYear = Number(String(range.endDate).slice(0, 4));
  if (!startYear || !rawEndYear || rawEndYear < startYear) return 6;
  const currentCount = range.periodType === "fiscal"
    ? Math.max(1, rawEndYear - startYear)
    : Math.max(1, rawEndYear - startYear + 1);
  return Math.min(5, currentCount) + 1;
}

const SLIDE_24_ORDER_7_ROW_DEFS = [
  { start: 0, count: 6 },
  { start: 6, count: 6 },
  { start: 12, count: 5 },
  { start: 17, count: 6 },
  { start: 23, count: 6 },
  { start: 29, count: 6 },
  { start: 35, count: 6 },
  { start: 41, count: 6 },
  { start: 47, count: 6 },
  { start: 53, count: 6 },
  { start: 59, count: 6 },
  { start: 65, count: 6 },
];

const SLIDE_24_CARD_METRICS = [
  { label: "Revenue", start: 6, count: 6 },
  { label: "YoY Growth", start: 12, count: 5 },
  { label: "COGS", start: 17, count: 6 },
  { label: "Gross Profit", start: 23, count: 6 },
  { label: "Gross Margin", start: 29, count: 6 },
  { label: "Operating Expenses", start: 35, count: 6 },
  { label: "Adjusted EBITDA", start: 41, count: 6 },
  { label: "Adjusted EBITDA Margin", start: 47, count: 6 },
  { label: "D&A", start: 53, count: 6 },
  { label: "Adjusted EBIT", start: 59, count: 6 },
  { label: "Net Income", start: 65, count: 6 },
];

const SLIDE_26_ORDER_7_ROW_DEFS = [
  { start: 0, count: 6 },
  { start: 6, count: 6 },
  { start: 12, count: 6 },
  { start: 18, count: 6 },
  { start: 24, count: 6 },
  { start: 30, count: 6 },
  { start: 36, count: 6 },
  { start: 42, count: 6 },
  { start: 48, count: 6 },
  { start: 54, count: 6 },
  { start: 60, count: 6 },
  { start: 66, count: 6 },
  { start: 72, count: 6 },
  { start: 78, count: 6 },
  { start: 84, count: 6 },
  { start: 90, count: 6 },
  { start: 96, count: 6 },
];

const SLIDE_26_CARD_METRICS = [
  { label: "Cash & Equivalents", start: 6, count: 6 },
  { label: "Accounts Receivable", start: 12, count: 6 },
  { label: "Inventory", start: 18, count: 6 },
  { label: "Prepaid & Other Current", start: 24, count: 6 },
  { label: "Total Current Assets", start: 30, count: 6 },
  { label: "PP&E (net)", start: 36, count: 6 },
  { label: "Intangibles & Goodwill", start: 42, count: 6 },
  { label: "Total Assets", start: 48, count: 6 },
  { label: "Accounts Payable", start: 54, count: 6 },
  { label: "Accrued Liabilities", start: 60, count: 6 },
  { label: "Deferred Revenue", start: 66, count: 6 },
  { label: "Current Portion of Debt", start: 72, count: 6 },
  { label: "Total Current Liabilities", start: 78, count: 6 },
  { label: "Long-Term Debt", start: 84, count: 6 },
  { label: "Total Shareholders Equity", start: 90, count: 6 },
  { label: "Total Liabilities & Equity", start: 96, count: 6 },
];

function getSlide24ColumnIndex(field) {
  if (field.slideNumber !== 24 || field.order !== 7) return null;
  const ti = getFieldTokenIndex(field);
  if (ti === null || ti === undefined) return null;
  for (const { start, count } of SLIDE_24_ORDER_7_ROW_DEFS) {
    if (ti >= start && ti < start + count) return ti - start;
  }
  return null;
}

function isSlide24FieldActive(field, range = {}) {
  const column = getSlide24ColumnIndex(field);
  if (column === null) return true;
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);
  return column < annualCount || column === 5;
}

function getSlide24VisibleTableColumns(elementFields = [], fieldValues = {}) {
  const annualHeadingColumns = elementFields
    .map((field) => ({ field, tokenIndex: getFieldTokenIndex(field) }))
    .filter(({ field, tokenIndex }) =>
      tokenIndex >= 0 && tokenIndex < 5 && normalizeText(getStoredFieldValue(field, fieldValues)),
    )
    .map(({ tokenIndex }) => tokenIndex)
    .sort((a, b) => a - b);
  if (!annualHeadingColumns.length) return [1, 2, 3, 4, 5, 6, 7];
  return [1, ...annualHeadingColumns.map((column) => column + 2), 7];
}

function getSlide26ColumnIndex(field) {
  if (field.slideNumber !== 26 || field.order !== 7) return null;
  const ti = getFieldTokenIndex(field);
  if (ti === null || ti === undefined) return null;
  for (const { start, count } of SLIDE_26_ORDER_7_ROW_DEFS) {
    if (ti >= start && ti < start + count) return ti - start;
  }
  return null;
}

function isSlide26FieldActive(field, range = {}) {
  const column = getSlide26ColumnIndex(field);
  if (column === null) return true;
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);
  return column < annualCount || column === 5;
}

function getSlide26VisibleTableColumns(elementFields = [], fieldValues = {}) {
  const annualHeadingColumns = elementFields
    .map((field) => ({ field, tokenIndex: getFieldTokenIndex(field) }))
    .filter(({ tokenIndex, field }) =>
      tokenIndex >= 0 && tokenIndex < 5 && normalizeText(getStoredFieldValue(field, fieldValues)),
    )
    .map(({ tokenIndex }) => tokenIndex)
    .sort((a, b) => a - b);
  if (!annualHeadingColumns.length) return [1, 2, 3, 4, 5, 6, 7];
  return [1, ...annualHeadingColumns.map((column) => column + 2), 7];
}

function getTrailingTwelveMonthRange(range = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(range.endDate || ""))) return null;
  const end = new Date(`${range.endDate}T00:00:00`);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  start.setDate(start.getDate() + 1);
  return {
    startDate: formatDateInputValue(start),
    endDate: range.endDate,
  };
}

function convertFinancialRangePeriodType(range = {}, periodType = "calendar") {
  const startYear = Number(String(range.startDate || "").slice(0, 4)) || new Date().getFullYear() - 5;
  const rawEndYear = Number(String(range.endDate || "").slice(0, 4)) || startYear;
  const currentCount = range.periodType === "fiscal"
    ? Math.max(1, rawEndYear - startYear)
    : Math.max(1, rawEndYear - startYear + 1);
  const yearCount = Math.min(5, currentCount);
  return periodType === "fiscal"
    ? {
      ...range,
      periodType,
      startDate: `${startYear}-04-01`,
      endDate: `${startYear + yearCount}-03-31`,
    }
    : {
      ...range,
      periodType,
      startDate: `${startYear}-01-01`,
      endDate: `${startYear + yearCount - 1}-12-31`,
    };
}

function getLastFinancialYearLabel(range = {}) {
  const endYear = Number(String(range.endDate || "").slice(0, 4));
  if (!endYear) return "";
  return range.periodType === "fiscal"
    ? `Apr. 1, ${endYear - 1} - Mar. 31, ${endYear}`
    : `Jan. 1, ${endYear} - Dec. 31, ${endYear}`;
}

function getAutoFillYearRange(years = []) {
  const cleanYears = years.filter(Boolean);
  if (!cleanYears.length) return "";
  const first = cleanYears[0];
  const last = cleanYears[cleanYears.length - 1];
  return first === last ? `FY${last}` : `FY${first}-FY${last}`;
}

function alignAutoFillYears(years = [], count) {
  const selected = years.slice(-count);
  return Array.from({ length: count }, (_, index) => {
    const offset = count - selected.length;
    return index < offset ? null : selected[index - offset];
  });
}

function calculateAutoFillGrowth(snapshot, year) {
  const years = snapshot?.years || [];
  const index = years.indexOf(year);
  if (index <= 0) return 0;
  const current = getAutoFillMetric(snapshot, year, "totalRevenue");
  const previous = getAutoFillMetric(snapshot, years[index - 1], "totalRevenue");
  return previous ? ((current - previous) / Math.abs(previous)) * 100 : 0;
}

function formatSlide24Year(year, periodType = "calendar") {
  const numericYear = Number(year);
  if (!numericYear) return "";
  if (periodType === "fiscal") {
    return `FY${numericYear - 1}-${String(numericYear).slice(-2)}`;
  }
  return `FY${numericYear}`;
}

function formatSlide26Year(year) {
  const numericYear = Number(year);
  return numericYear ? String(numericYear) : "";
}

function formatSlide24Millions(value, { expense = false, missing = "-", zero = "0" } = {}) {
  if (value === null || value === undefined || value === "") return missing;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return missing;
  if (Math.abs(numeric) < 0.0001) return zero;
  const formatted = formatAutoFillNumber(Math.abs(numeric) / 1_000_000);
  if (expense) return `(${formatted}M)`;
  if (numeric < 0) return `($${formatted}M)`;
  return `$${formatted}M`;
}

function formatSlide24Percent(value, { missing = "-" } = {}) {
  if (value === null || value === undefined || value === "") return missing;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return missing;
  return `${formatAutoFillNumber(numeric)}%`;
}

function isDashValue(value) {
  return /^[-–—]$|^dash$/i.test(String(value ?? "").trim());
}

function formatSlide26Millions(value, { missing = "-", zero = "0" } = {}) {
  if (value === null || value === undefined || value === "") return missing;
  if (isDashValue(value)) return missing;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return missing;
  if (Math.abs(numeric) < 0.0001) return zero;
  return formatAutoFillNumber(numeric / 1_000_000);
}

function cleanSlide26MoneyPlaceholderText(text) {
  return String(text || "")
    .replace(/\$-M/g, "-")
    .replace(/\$0M/g, "0")
    .replace(/\$\[[^\]]+\]M/g, "-");
}

function calculateAutoFillCagr(snapshot, years = []) {
  const cleanYears = years.filter(Boolean);
  if (cleanYears.length < 2) return 0;
  const firstYear = cleanYears[0];
  const lastYear = cleanYears[cleanYears.length - 1];
  const firstRevenue = getAutoFillMetric(snapshot, firstYear, "totalRevenue");
  const lastRevenue = getAutoFillMetric(snapshot, lastYear, "totalRevenue");
  const periods = Number(lastYear) - Number(firstYear);
  if (firstRevenue <= 0 || lastRevenue <= 0 || periods <= 0) return 0;
  return (Math.pow(lastRevenue / firstRevenue, 1 / periods) - 1) * 100;
}

// Builds every year between startYear and endYear (inclusive, capped at
// maxYears), independent of which years the financial source actually
// returned data for -- so a selected 5-year range always yields 5 years.
function buildFullRangeYears(startYear, endYear, fallbackYears = [], maxYears = 5) {
  if (startYear && endYear && endYear >= startYear) {
    return Array.from(
      { length: Math.min(maxYears, endYear - startYear + 1) },
      (_, index) => startYear + index,
    );
  }
  return fallbackYears.filter(Boolean).slice(0, maxYears);
}

function getAutoFillCagrYears(snapshot, fallbackYears = []) {
  const availableYears = snapshot?.years || [];
  const startYear = Number(snapshot?.currentPeriod?.startFiscalYear || 0);
  const endYear = Number(snapshot?.currentPeriod?.fiscalYear || snapshot?.latestYear || 0);
  if (startYear && endYear && startYear < endYear) {
    const selected = availableYears.filter((year) => year >= startYear && year <= endYear);
    if (selected.includes(startYear) && selected.includes(endYear)) return selected;
  }
  return fallbackYears.filter(Boolean);
}

function calculateAutoFillFcfConversion(metrics = {}) {
  const fcf = Number(metrics.freeCashFlow || 0);
  const ebitda = Number(metrics.adjustedEbitda || metrics.ebitda || 0);
  return Math.abs(ebitda) > 0.0001 ? (fcf / ebitda) * 100 : 0;
}

function formatAutoFillChartValue(key, value) {
  return /margin|growth|percent|rate/i.test(String(key || ""))
    ? formatAutoFillPercent(value)
    : formatAutoFillMillions(value);
}

function getAutoFillChartData(snapshot, years = snapshot?.years || [], valueKeys = ["totalRevenue", "adjustedEbitda"]) {
  return years
    .filter(Boolean)
    .map((year) => {
      // Every requested year gets a row -- a year with no reported figure
      // shows as 0 on the chart rather than being silently skipped.
      const values = valueKeys.map((key) => (
        formatAutoFillChartValue(key, getAutoFillMetric(snapshot, year, key)) || "0"
      ));
      return `FY${year},${values.join(",")}`;
    })
    .join("\n");
}

function buildCimFinancialAutofillValues(fieldsBySlide, snapshot) {
  const fields = Object.values(fieldsBySlide || {}).flat();
  const fieldByToken = new Map();
  const chartFieldByOrder = new Map();

  fields.forEach((field) => {
    const tokenIndex = getFieldTokenIndex(field);
    if (tokenIndex !== null) {
      fieldByToken.set(`${field.slideNumber}:${field.order}:${tokenIndex}`, field);
    }
    if (isChartField(field)) {
      chartFieldByOrder.set(`${field.slideNumber}:${field.order}`, field);
    }
  });

  const fieldValues = {};
  const chartValues = {};
  const years = snapshot?.years || [];
  const latestYear = snapshot?.latestYear || years[years.length - 1];
  const latest = getAutoFillYearMetrics(snapshot, latestYear);
  const trailing = snapshot?.trailingMetrics || latest;
  const currentLongDate = getCurrentAutoFillLongDate(snapshot, latestYear);
  const currentShortDate = getCurrentAutoFillShortDate(snapshot, latestYear);
  const currentPeriodMonths = 12;
  const priorYears = years.filter((year) => Number(year) < Number(latestYear));
  const historyYears = alignAutoFillYears(priorYears, 4);
  const cagrYears = getAutoFillCagrYears(snapshot, historyYears);
  const selectedStartYear = Number(snapshot?.currentPeriod?.startFiscalYear || cagrYears[0] || 0);
  const selectedEndYear = Number(snapshot?.currentPeriod?.fiscalYear || latestYear || 0);
  // Chart years must span the whole selected range (like the Slide 24 table
  // does), not just whichever years the financial source actually returned
  // data for -- missing years still get a 0 bar rather than being dropped.
  const chartYears = buildFullRangeYears(selectedStartYear, selectedEndYear, years.slice(-5));
  const selectedRangeText = selectedStartYear && selectedEndYear
    ? selectedStartYear === selectedEndYear
      ? `FY${selectedEndYear}`
      : `FY${selectedStartYear} to FY${selectedEndYear}`
    : getAutoFillYearRange(cagrYears);
  const revenueCagr = calculateAutoFillCagr(snapshot, cagrYears);
  const firstHistoryYear = historyYears.find(Boolean);
  const firstCagrYear = cagrYears[0] || firstHistoryYear;
  const marginExpansion =
    Number(latest.ebitdaMargin || 0) -
    Number(getAutoFillYearMetrics(snapshot, firstHistoryYear)?.ebitdaMargin || 0);
  const previousYear = years[years.indexOf(latestYear) - 1] || null;
  const previous = getAutoFillYearMetrics(snapshot, previousYear);
  const grossMarginChange = Number(latest.grossMargin || 0) - Number(previous.grossMargin || 0);

  const add = (slide, order, tokenIndex, value) => {
    const cleanValue = typeof value === "string" ? value.trim() : value;
    if (cleanValue === "" || cleanValue === null || cleanValue === undefined) return;
    const field = fieldByToken.get(`${slide}:${order}:${tokenIndex}`);
    if (!field) return;
    fieldValues[field.valueFieldId || field.id] = String(cleanValue);
  };

  const addChart = (slide, order, type, dataText) => {
    if (!normalizeText(dataText)) return;
    const field = chartFieldByOrder.get(`${slide}:${order}`);
    if (!field) return;
    chartValues[field.id] = { type, dataText };
  };

  const addMergedOrder = (slide, order, value) => {
    if (!normalizeText(value)) return;
    const field = fields.find((candidate) =>
      candidate.slideNumber === slide &&
      candidate.order === order &&
      String(candidate.id || "").includes(":merged:"),
    );
    if (field) fieldValues[field.id] = value;
  };

  const addElementOverride = (slide, order, value) => {
    if (!normalizeText(value)) return;
    fieldValues[getElementAutofillKey("element_override", slide, order)] = value;
  };

  const addElementSuffix = (slide, order, value) => {
    if (!normalizeText(value)) return;
    fieldValues[getElementAutofillKey("element_suffix", slide, order)] = value;
  };

  const financialSource = snapshot?.validation?.sourceLedger?.sourceLabel || "Financial reports";
  const reportsSource = `${financialSource}; Reports; EBITDA Calculation`;
  const sourceAsOfDate = currentLongDate || (latestYear ? `December 31, ${latestYear}` : "");

  addElementOverride(5, 27, `Source: ${reportsSource}.`);
  addElementOverride(6, 32, `Source: ${reportsSource}; ${selectedRangeText}.`);
  addElementSuffix(24, 8, ` Source: ${reportsSource}.`);
  addElementOverride(23, 36, `Source: ${reportsSource}; ${selectedRangeText}.`);
  addElementOverride(26, 8, `Source: ${financialSource}; Reports; ${selectedRangeText}.`);
  addElementOverride(27, 8, `Source: ${financialSource}; Cash Flow report; ${selectedRangeText}.`);
  addElementOverride(29, 32, `Source: ${financialSource}; Quality of Earnings - Bank Reconciliation; as of ${sourceAsOfDate}.`);
  addElementOverride(30, 32, `Source: ${financialSource}; Quality of Earnings - Tax Reconciliation; ${selectedRangeText}; as of ${sourceAsOfDate}.`);

  add(5, 26, 1, formatAutoFillPercent(latest.ebitdaMargin));

  add(6, 6, 0, "Fiscal Year (FY)");
  add(6, 6, 1, currentLongDate);
  add(6, 9, 0, formatAutoFillMillions(latest.totalRevenue));
  add(6, 11, 0, formatAutoFillPercent(calculateAutoFillGrowth(snapshot, latestYear)));
  add(6, 14, 0, formatAutoFillPercent(latest.grossMargin));
  add(6, 16, 0, formatAutoFillPercent(grossMarginChange));
  add(6, 19, 0, formatAutoFillMillions(latest.adjustedEbitda));
  add(6, 21, 0, formatAutoFillPercent(latest.ebitdaMargin));
  add(6, 31, 0, formatAutoFillPercent(revenueCagr));
  add(6, 31, 1, selectedRangeText);
  add(6, 31, 2, formatAutoFillPercent(marginExpansion));
  addMergedOrder(6, 32, selectedRangeText);
  addChart(6, 28, "bar", getAutoFillChartData(snapshot, chartYears.filter(Boolean)));

  add(9, 34, 0, formatAutoFillMillions(latest.totalRevenue));
  add(9, 36, 0, formatAutoFillPercent(latest.ebitdaMargin));
  const companyStartDate = snapshot?.currentPeriod?.companyStartDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(companyStartDate || ""))) {
    const companyStart = new Date(`${companyStartDate}T00:00:00`);
    const periodEnd = new Date(`${snapshot.currentPeriod.endDate}T00:00:00`);
    let operatingYears = periodEnd.getFullYear() - companyStart.getFullYear();
    if (
      periodEnd.getMonth() < companyStart.getMonth() ||
      (periodEnd.getMonth() === companyStart.getMonth() && periodEnd.getDate() < companyStart.getDate())
    ) operatingYears -= 1;
    add(8, 6, 1, companyStart.getFullYear());
    add(9, 5, 2, String(Math.max(0, operatingYears)));
  }

  add(23, 5, 1, formatAutoFillPercent(revenueCagr));
  add(23, 5, 2, selectedRangeText);
  add(23, 5, 3, formatAutoFillPercent(getAutoFillYearMetrics(snapshot, firstCagrYear)?.ebitdaMargin));
  add(23, 5, 4, formatAutoFillPercent(latest.ebitdaMargin));
  add(23, 9, 0, formatAutoFillMillions(latest.totalRevenue));
  add(23, 10, 0, latestYear);
  add(23, 11, 0, formatAutoFillMillions(previous.totalRevenue));
  add(23, 11, 1, previousYear);
  add(23, 14, 0, formatAutoFillPercent(latest.grossMargin));
  add(23, 16, 0, formatAutoFillPercent(previous.grossMargin));
  add(23, 16, 1, previousYear);
  add(23, 19, 0, formatAutoFillMillions(latest.adjustedEbitda));
  add(23, 21, 0, formatAutoFillPercent(latest.ebitdaMargin));
  add(23, 24, 0, formatAutoFillMillions(latest.freeCashFlow));
  add(23, 26, 0, formatAutoFillPercent(calculateAutoFillFcfConversion(latest)));
  add(23, 29, 0, Number(latest.adjustedEbitda)
    ? formatAutoFillNumber(latest.longTermDebtAdjustedEbitdaRatio)
    : "");
  add(23, 31, 0, currentLongDate);
  add(23, 36, 2, financialSource);
  addMergedOrder(23, 36, selectedRangeText);
  addChart(23, 33, "bar", getAutoFillChartData(snapshot, chartYears.filter(Boolean), ["totalRevenue"]));
  addChart(23, 35, "bar", getAutoFillChartData(snapshot, chartYears.filter(Boolean), ["adjustedEbitda", "ebitdaMargin"]));

  const incomeYears = buildFullRangeYears(selectedStartYear, selectedEndYear, years.slice(0, 5));
  const incomeColumns = [
    ...incomeYears.map((year) => ({ year, metrics: getAutoFillYearMetrics(snapshot, year) })),
    { year: latestYear, metrics: trailing, trailing: true },
  ];
  const slide24PeriodType = snapshot?.currentPeriod?.periodType || "calendar";
  add(24, 5, 0, formatSlide24Year(selectedStartYear, slide24PeriodType));
  add(24, 5, 1, formatSlide24Year(selectedEndYear, slide24PeriodType));
  incomeColumns.forEach((column, columnIndex) => {
    const { year, metrics, trailing: isTrailing } = column;
    const tableColumnIndex = isTrailing ? 5 : columnIndex;
    if (isTrailing) add(24, 7, 5, currentShortDate);
    else add(24, 7, columnIndex, formatSlide24Year(year, slide24PeriodType));
    add(24, 7, 6 + tableColumnIndex, formatSlide24Millions(metrics.totalRevenue));
    if (!isTrailing) {
      const yearIndex = years.indexOf(year);
      const growth = yearIndex > 0 ? calculateAutoFillGrowth(snapshot, year) : null;
      add(24, 7, 12 + columnIndex, formatSlide24Percent(growth));
    }
    add(24, 7, 17 + tableColumnIndex, formatSlide24Millions(metrics.costOfGoodsSold, { expense: true }));
    add(24, 7, 23 + tableColumnIndex, formatSlide24Millions(
      metrics.hasGrossProfitData ? metrics.grossProfit : Number.NaN,
    ));
    add(24, 7, 29 + tableColumnIndex, formatSlide24Percent(
      metrics.hasGrossProfitData && Number(metrics.totalRevenue) ? metrics.grossMargin : Number.NaN,
    ));
    add(24, 7, 35 + tableColumnIndex, formatSlide24Millions(
      metrics.hasOperatingExpensesData ? metrics.operatingExpenses : Number.NaN,
      { expense: true },
    ));
    add(24, 7, 41 + tableColumnIndex, formatSlide24Millions(
      metrics.hasAdjustedEbitdaData ? metrics.adjustedEbitda : Number.NaN,
    ));
    add(24, 7, 47 + tableColumnIndex, formatSlide24Percent(
      metrics.hasAdjustedEbitdaData && Number(metrics.totalRevenue) ? metrics.ebitdaMargin : Number.NaN,
    ));
    add(24, 7, 53 + tableColumnIndex, formatSlide24Millions(
      metrics.hasDepreciationAmortizationData ? metrics.depreciationAmortization : Number.NaN,
      { expense: true },
    ));
    add(24, 7, 59 + tableColumnIndex, formatSlide24Millions(
      metrics.hasAdjustedEbitData ? metrics.ebit : Number.NaN,
    ));
    add(24, 7, 65 + tableColumnIndex, formatSlide24Millions(metrics.netProfit));
  });

  const slide25Adjustments = (
    snapshot?.adjustments?.itemsByYear?.[String(latestYear)] || []
  ).map((adjustment, index) => ({
    id: adjustment.id || `adjustment-${index + 1}`,
    label: adjustment.label || "",
    amount: formatAutoFillMillions(adjustment.amount),
    nature: adjustment.nature || "",
    commentary: adjustment.commentary || "",
  }));
  fieldValues[SLIDE_25_BRIDGE_FIELD_ID] = stringifySlide25Bridge({
    reportedEbitda: formatAutoFillMillions(latest.ebitda),
    adjustments: slide25Adjustments,
  });
  const slide25AdjustmentTotal = (
    snapshot?.adjustments?.itemsByYear?.[String(latestYear)] || []
  ).reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
  add(25, 5, 0, formatAutoFillMillions(Number(latest.ebitda || 0) + slide25AdjustmentTotal));
  add(25, 5, 1, String(slide25Adjustments.length));
  add(25, 5, 2, slide25AdjustmentTotal ? formatAutoFillMillions(slide25AdjustmentTotal) : "0");

  add(26, 5, 0, currentLongDate);
  add(26, 5, 1, formatSlide26Millions(latest.totalAssets));
  const balanceColumns = [
    ...incomeYears.map((year) => ({ year, metrics: getAutoFillYearMetrics(snapshot, year), trailing: false })),
    { year: latestYear, metrics: trailing, trailing: true },
  ];
  balanceColumns.forEach((column, columnIndex) => {
    const { year, metrics, trailing: isTrailing } = column;
    const tableColumnIndex = isTrailing ? 5 : columnIndex;
    if (isTrailing) add(26, 7, 5, currentShortDate);
    else add(26, 7, columnIndex, formatSlide26Year(year));
    add(26, 7, 6 + tableColumnIndex, formatSlide26Millions(metrics.cashAndBankBalance));
    add(26, 7, 12 + tableColumnIndex, formatSlide26Millions(metrics.accountReceivable));
    add(26, 7, 18 + tableColumnIndex, formatSlide26Millions(metrics.inventoryValue));
    add(26, 7, 24 + tableColumnIndex, formatSlide26Millions(metrics.prepaidOtherCurrent));
    add(26, 7, 30 + tableColumnIndex, formatSlide26Millions(metrics.currentAssetsApprox));
    add(26, 7, 36 + tableColumnIndex, formatSlide26Millions(metrics.ppeNet));
    add(26, 7, 42 + tableColumnIndex, formatSlide26Millions(metrics.intangiblesGoodwill));
    add(26, 7, 48 + tableColumnIndex, formatSlide26Millions(metrics.totalAssets));
    add(26, 7, 54 + tableColumnIndex, formatSlide26Millions(metrics.accountPayable));
    add(26, 7, 60 + tableColumnIndex, formatSlide26Millions(metrics.accruedLiabilities));
    add(26, 7, 66 + tableColumnIndex, formatSlide26Millions(metrics.deferredRevenue));
    add(26, 7, 72 + tableColumnIndex, formatSlide26Millions(metrics.currentDebt));
    add(26, 7, 78 + tableColumnIndex, formatSlide26Millions(metrics.currentLiabilitiesApprox));
    add(26, 7, 84 + tableColumnIndex, formatSlide26Millions(metrics.longTermDebt));
    add(26, 7, 90 + tableColumnIndex, formatSlide26Millions(metrics.totalEquity));
    add(26, 7, 96 + tableColumnIndex, formatSlide26Millions(
      metrics.totalLiabilitiesEquity || Number(metrics.totalLiabilities || 0) + Number(metrics.totalEquity || 0),
    ));
  });
  add(26, 8, 0, formatSlide26Year(selectedStartYear));
  add(26, 8, 1, formatSlide26Year(selectedEndYear));

  const cashflowPeriods = [
    ...incomeYears.map((year) => ({
      key: `fy-${year}`,
      label: formatSlide24Year(year, slide24PeriodType),
      metrics: getAutoFillYearMetrics(snapshot, year),
    })),
    {
      key: "ltm",
      label: currentShortDate ? `LTM ${currentShortDate}` : "LTM",
      metrics: trailing,
    },
  ];
  fieldValues[SLIDE_27_CASHFLOW_FIELD_ID] = stringifySlide27Cashflow({
    columns: cashflowPeriods.map(({ key, label }) => ({ key, label })),
    rows: buildSlide27CashflowRows(cashflowPeriods),
    placeholder: false,
  });
  const cumulativeFcf = incomeYears.reduce(
    (sum, year) => sum + Number(getAutoFillYearMetrics(snapshot, year).freeCashFlow || 0),
    0,
  );
  add(27, 5, 0, cumulativeFcf ? formatAutoFillMillions(cumulativeFcf) : "0");
  add(27, 5, 1, selectedRangeText);
  add(27, 6, 0, formatAutoFillPercent(calculateAutoFillFcfConversion(trailing)) || "0");

  add(28, 5, 0, formatAutoFillMillions(trailing.workingCapital));
  add(28, 5, 1, String(currentPeriodMonths));
  add(28, 9, 0, formatAutoFillMillions(trailing.workingCapital));
  add(28, 11, 0, formatAutoFillMillions(trailing.workingCapital));
  add(28, 30, 0, latestYear);
  [latest, trailing].forEach((metrics, offset) => {
    add(28, 30, 1 + offset, formatAutoFillMillions(metrics.accountReceivable));
    add(28, 30, 3 + offset, formatAutoFillMillions(metrics.inventoryValue));
    add(28, 30, 7 + offset, formatAutoFillMillions(metrics.currentAssetsApprox));
    add(28, 30, 9 + offset, formatAutoFillMillions(metrics.accountPayable));
    add(28, 30, 15 + offset, formatAutoFillMillions(metrics.currentLiabilitiesApprox));
    add(28, 30, 17 + offset, formatAutoFillMillions(metrics.workingCapital));
  });

  add(29, 6, 0, currentLongDate);
  add(29, 9, 0, formatAutoFillMillions(latest.cashAndBankBalance));
  add(29, 14, 0, formatAutoFillMillions(latest.cashAndBankBalance));
  add(29, 16, 1, currentLongDate);
  add(29, 28, 0, formatAutoFillMillions(latest.cashAndBankBalance));
  add(29, 32, 1, currentLongDate);
  add(29, 32, 2, currentLongDate);

  const bankReconciliation = snapshot?.bankReconciliation || {};
  if (bankReconciliation.hasData) {
    const reconciliationDate = formatAutoFillDate(bankReconciliation.date, "long") || currentLongDate;
    const bookBalance = Number(bankReconciliation.bookBalance || latest.cashAndBankBalance || 0);
    const bankBalance = Number(bankReconciliation.bankBalance || 0);
    const variance = Number(bankReconciliation.variance || bankBalance - bookBalance);
    add(29, 6, 0, reconciliationDate);
    add(29, 9, 0, formatAutoFillMillions(bookBalance));
    add(29, 14, 0, formatAutoFillMillions(bankBalance));
    add(29, 16, 0, bankReconciliation.bankName);
    add(29, 16, 1, reconciliationDate);
    add(29, 19, 0, formatAutoFillThousands(variance));
    add(29, 21, 0, String(bankReconciliation.itemCount || 0));
    addElementOverride(29, 24, bankReconciliation.frequency || "Monthly");
    const accountRows = (bankReconciliation.accounts || []).slice(0, 5).map((account) => {
      const accountVariance = Number(account.variance || account.bankBalance - account.bookBalance || 0);
      return `${account.name || account.bankName || "Bank account"} | ${formatAutoFillMillions(account.bankBalance)} | ${accountVariance >= 0 ? "Add" : "Deduct"} | ${account.status || (Math.abs(accountVariance) < 0.01 ? "Reconciled" : "Review")}`;
    });
    addElementOverride(29, 28, [
      "Account / item | Amount ($M) | Direction | Status",
      ...accountRows,
      `Total bank statement balance | ${formatAutoFillMillions(bankBalance)} | -- | ${Math.abs(variance) < 0.01 ? "Reconciled" : "Review"}`,
    ].join("\n"));
    addElementOverride(29, 31, Math.abs(variance) < 0.01
      ? `Bank statements and book cash reconcile as of ${reconciliationDate}. ${bankReconciliation.accounts?.length || 0} account(s) were reviewed.`
      : `A net reconciling difference of $${formatAutoFillThousands(Math.abs(variance))}k remains as of ${reconciliationDate}. Review the account-level items before circulation.`);
  }

  add(30, 5, 0, formatAutoFillPercent(latest.effectiveTaxRate));
  add(30, 9, 0, formatAutoFillPercent(latest.effectiveTaxRate));
  add(30, 14, 0, formatAutoFillMillions(latest.taxes));
  add(30, 16, 0, currentLongDate);
  add(30, 21, 0, currentLongDate);

  const taxReconciliation = snapshot?.taxReconciliation || {};
  const taxYears = getSlide30TaxFiscalYears(snapshot?.currentPeriod);
  const taxRowsByYearLower = {};
  taxYears.forEach((year) => {
    taxRowsByYearLower[year] = new Map(
      (taxReconciliation.rowsByYear?.[year] || []).map((row) => [
        normalizeText(row.label || row.name || row.account || "").toLowerCase(),
        row,
      ]),
    );
  });
  const taxLtmLabel = currentShortDate ? `LTM ${currentShortDate}` : "LTM";
  const taxHeaderCells = ["Item", ...taxYears.map((year) => `FY${year}`), taxLtmLabel];
  const taxDataRows = SLIDE_30_TAX_ROW_DEFS.map(({ label, matchKeys }) => {
    const values = taxYears.map((year) => {
      const row = matchKeys.map((key) => taxRowsByYearLower[year]?.get(key)).find(Boolean);
      const value = row ? Number(row.taxReturn ?? row.tax_return ?? row.amount ?? 0) : null;
      return value === null || !Number.isFinite(value) ? "-" : formatAutoFillMillions(value);
    });
    return [label, ...values, "-"].join(" | ");
  });
  addElementOverride(30, 27, "TAX RETURN / BOOK RECONCILIATION");
  addElementOverride(30, 28, [taxHeaderCells.join(" | "), ...taxDataRows].join("\n"));

  add(32, 7, 0, latestYear);
  add(32, 7, 1, latestYear ? latestYear + 1 : "");
  add(32, 7, 2, latestYear ? latestYear + 2 : "");
  add(32, 7, 3, latestYear ? latestYear + 3 : "");
  add(32, 7, 4, latestYear ? latestYear + 4 : "");
  add(32, 7, 5, formatAutoFillMillions(latest.totalRevenue));
  add(32, 7, 24, formatAutoFillMillions(latest.adjustedEbitda));
  add(32, 7, 29, formatAutoFillPercent(latest.ebitdaMargin));
  add(32, 7, 34, formatAutoFillMillions(latest.freeCashFlow));
  add(32, 7, 39, formatAutoFillMillions(latest.capitalExpenditures));

  return { fieldValues, chartValues };
}

function mergeOverwriteAutofillValues(existing = {}, additions = {}, isFilled = normalizeText) {
  let count = 0;
  const next = { ...existing };

  Object.entries(additions || {}).forEach(([key, value]) => {
    if (!isFilled(value)) return;
    const nextValue = String(value);
    if (next[key] !== nextValue) count += 1;
    next[key] = nextValue;
  });

  return { next, count };
}

function withoutFieldValues(existing = {}, fields = []) {
  const next = { ...existing };
  fields.forEach((field) => {
    delete next[field.valueFieldId || field.id];
  });
  return next;
}

function getSlide24PeriodHeadingValues(fields = [], range = {}) {
  const headings = {};
  const fieldByTokenIndex = new Map(
    fields
      .filter((field) => field.slideNumber === 24 && field.order === 7)
      .map((field) => [getFieldTokenIndex(field), field]),
  );
  const startYear = Number(String(range.startDate || "").slice(0, 4));
  const periodType = range.periodType === "fiscal" ? "fiscal" : "calendar";
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);

  Array.from({ length: annualCount }, (_, index) => index).forEach((columnIndex) => {
    const field = fieldByTokenIndex.get(columnIndex);
    if (!field || !startYear) return;
    const fiscalYear = periodType === "fiscal"
      ? startYear + columnIndex + 1
      : startYear + columnIndex;
    headings[field.valueFieldId || field.id] = formatSlide24Year(fiscalYear, periodType);
  });

  const ltmField = fieldByTokenIndex.get(5);
  const ltmDate = formatAutoFillDate(range.endDate, "short");
  if (ltmField && ltmDate) headings[ltmField.valueFieldId || ltmField.id] = ltmDate;
  return headings;
}

function getSlide26PeriodHeadingValues(fields = [], range = {}) {
  const headings = {};
  const fieldByTokenIndex = new Map(
    fields
      .filter((field) => field.slideNumber === 26 && field.order === 7)
      .map((field) => [getFieldTokenIndex(field), field]),
  );
  const startYear = Number(String(range.startDate || "").slice(0, 4));
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);

  Array.from({ length: annualCount }, (_, index) => index).forEach((columnIndex) => {
    const field = fieldByTokenIndex.get(columnIndex);
    if (!field || !startYear) return;
    headings[field.valueFieldId || field.id] = formatSlide26Year(startYear + columnIndex);
  });

  const ltmField = fieldByTokenIndex.get(5);
  const ltmDate = formatAutoFillDate(range.endDate, "short");
  if (ltmField && ltmDate) headings[ltmField.valueFieldId || ltmField.id] = ltmDate;
  return headings;
}

function getSectionForSlide(slideNumber) {
  return NAV_SECTIONS.find((section) => section.slides.includes(slideNumber)) || BASIC_DETAILS_SECTION;
}

function buildQuestionnaireItem(field, existingItem = null) {
  const section = field.sectionId
    ? NAV_SECTIONS.find((item) => item.id === field.sectionId) || getSectionForSlide(field.slideNumber)
    : getSectionForSlide(field.slideNumber);
  const now = new Date().toISOString();

  return {
    ...(existingItem || {}),
    id: field.id,
    fieldId: field.fieldId === undefined ? field.id : field.fieldId,
    slideNumber: field.slideNumber,
    sectionId: section.id,
    sectionTitle: section.title,
    label: field.label,
    fieldKind: getFieldKind(field),
    assetKey: isAssetField(field) ? getAssetKey(field) : existingItem?.assetKey || null,
    prompt: existingItem?.prompt || field.prompt || createDefaultQuestion(field),
    sourceText: field.sourceText || field.text,
    status: existingItem?.clientNote || existingItem?.clientAsset?.dataUrl ? "answered" : existingItem?.status || "open",
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
    currentBatchId: state?.currentBatchId || "",
    history: Array.isArray(state?.history) ? state.history : [],
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
    answered: items.filter((item) => item.status === "answered" || normalizeText(item.clientNote) || item.clientAsset?.dataUrl).length,
    resolved: items.filter((item) => item.status === "resolved").length,
  };
}

function normalizeCimReviewState(state) {
  const items = {};
  if (state?.items && typeof state.items === "object") {
    Object.entries(state.items).forEach(([fieldId, item]) => {
      items[fieldId] = {
        id: item?.id || fieldId,
        fieldId: item?.fieldId || fieldId,
        slideNumber: item?.slideNumber ?? null,
        sectionId: item?.sectionId || "",
        sectionTitle: item?.sectionTitle || "",
        label: item?.label || "",
        fieldKind: item?.fieldKind || "text",
        status: item?.status === "resolved" ? "resolved" : "open",
        notes: Array.isArray(item?.notes) ? item.notes : [],
        resolvedBy: item?.resolvedBy || null,
        resolvedAt: item?.resolvedAt || null,
        createdAt: item?.createdAt || new Date().toISOString(),
        updatedAt: item?.updatedAt || new Date().toISOString(),
      };
    });
  }

  return {
    version: 1,
    ownerUserId: state?.ownerUserId || null,
    sharedAt: state?.sharedAt || null,
    sharedBy: state?.sharedBy || null,
    sharedWith: Array.isArray(state?.sharedWith) ? state.sharedWith : [],
    items,
    history: Array.isArray(state?.history) ? state.history : [],
    updatedAt: state?.updatedAt || "",
    updatedBy: state?.updatedBy || null,
  };
}

function getCimReviewCounts(reviewState) {
  const items = Object.values(reviewState?.items || {});
  return {
    total: items.length,
    open: items.filter((item) => item.status === "open").length,
    resolved: items.filter((item) => item.status === "resolved").length,
  };
}

function makeQuestionnaireBatchId() {
  return `cimq:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function getQuestionnaireUserSummary(user) {
  return {
    id: user?.id || null,
    name: user?.name || user?.email || "Broker",
    email: user?.email || "",
    role: user?.role || "",
  };
}

function buildQuestionnaireHistoryEntry(activeItems, batchId, sentAt, user) {
  return {
    id: batchId,
    sentAt,
    sentBy: getQuestionnaireUserSummary(user),
    itemCount: activeItems.length,
    items: activeItems.map((item) => ({
      id: item.id,
      fieldId: item.fieldId || null,
      sectionId: item.sectionId,
      sectionTitle: item.sectionTitle,
      slideNumber: item.slideNumber,
      label: item.label,
      fieldKind: item.fieldKind,
      prompt: item.prompt,
    })),
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

function buildBasicQuestionnaireField(definition) {
  return {
    id: `basic:${definition.key}`,
    fieldId: `basic:${definition.key}`,
    slideNumber: definition.slides?.[0] || 1,
    sectionId: BASIC_DETAILS_SECTION.id,
    sectionTitle: BASIC_DETAILS_SECTION.title,
    label: definition.label,
    fieldKind: "text",
    text: `[${definition.label}]`,
    sourceText: definition.label,
    basicDetailKey: definition.key,
    maxLength: definition.maxLength,
  };
}

function buildFallbackQuestionField(section, questionId, prompt) {
  return {
    id: makeBankQuestionId(section.id, questionId),
    fieldId: null,
    questionId,
    slideNumber: section.slides[0],
    sectionId: section.id,
    sectionTitle: section.title,
    label: prompt.slice(0, 72),
    fieldKind: "question",
    text: prompt,
    sourceText: prompt,
    prompt,
  };
}

function getQuestionnaireTemplateFields(section, fieldsBySlide, globalDetails) {
  if (section.type === "basic") {
    return BASIC_DETAIL_FIELD_DEFINITIONS.map(buildBasicQuestionnaireField);
  }

  const seen = new Set();
  const fields = getEditableTemplateFields(
    section.slides.flatMap((slideNumber) => fieldsBySlide[slideNumber] || []),
    globalDetails,
  )
    .filter((field) => !field.excludeFromQuestionnaire)
    .filter((field) => {
      const key = `${field.fieldKind}:${normalizeText(field.label).toLowerCase()}:${normalizeText(field.sourceText || field.text).toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (fields.length) return fields;

  return getQuestionBankForSection(section.id).map(([questionId, prompt]) =>
    buildFallbackQuestionField(section, questionId, prompt),
  );
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
  if (!element?.text || !hasEditableTextBounds(element) || isTopRightSlideNumberElement(element)) return null;
  if (!containsTemplateToken(element.text) && !isPptTextEditableElement(element)) return null;
  return makeFieldId(slideNumber, element);
}

function getElementDisplayText(slideNumber, element, fieldsById, fieldValues, globalDetails, displaySlideNumber = slideNumber) {
  if (!element?.text) return "";
  if (isTopRightSlideNumberElement(element)) return String(displaySlideNumber);
  const elementOverride = fieldValues?.[getElementAutofillKey("element_override", slideNumber, element.order)];
  if (normalizeText(elementOverride)) return elementOverride;
  const elementFields = getElementFields(slideNumber, element, fieldsById);
  const pptTextField = elementFields.find(isPptTextField);
  if (pptTextField && hasStoredFieldValue(pptTextField, fieldValues)) {
    return String(getStoredFieldValue(pptTextField, fieldValues) ?? "");
  }

  if (containsTemplateToken(element.text)) {
    const value = applyFieldValues(element.text, elementFields, fieldValues, globalDetails);
    return `${value}${fieldValues?.[getElementAutofillKey("element_suffix", slideNumber, element.order)] || ""}`;
  }
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

export function SlideCanvas({
  slideNumber,
  displaySlideNumber = slideNumber,
  layout,
  fields,
  fieldValues,
  assetValues,
  chartValues,
  globalDetails,
  styleProfile = null,
  activeFieldId,
  onFieldFocus,
  onFieldChange,
  previewMode = false,
  styleSelectionMode = false,
  selectedStyleElementId = null,
  onSelectStyleElement,
}) {
  const stageRef = useRef(null);
  const stageWidth = useElementWidth(stageRef);
  const scale = stageWidth > 0 ? stageWidth / SLIDE_WIDTH : 1;
  const fieldsById = useMemo(
    () => Object.fromEntries(fields.map((field) => [field.id, field])),
    [fields],
  );
  const fieldsByElement = useMemo(() => groupFieldsByElement(fields), [fields]);
  const elements = layout?.elements || [];
  const slideBackgroundColor = cssColor(layout?.slide?.backgroundColor, "#FFFFFF");
  const resolvedAssetValues = assetValues || {};
  const resolvedChartValues = chartValues || {};

  return (
    <div
      ref={stageRef}
      className="relative mx-auto w-full overflow-hidden bg-white shadow-card"
      style={{ aspectRatio: "16 / 9", backgroundColor: slideBackgroundColor }}
      onClick={styleSelectionMode ? () => onSelectStyleElement?.(null) : undefined}
    >
      {elements.map((element, elementIndex) => {
        if (shouldHideUnusedRepeatableSlot(slideNumber, element, fieldValues)) {
          return null;
        }
        if (shouldHideLogoPlaceholderShape(elements, elementIndex, resolvedAssetValues)) {
          return null;
        }

        const content = getElementContent(
          slideNumber,
          element,
          fieldsById,
          fieldValues,
          resolvedAssetValues,
          resolvedChartValues,
          globalDetails,
          styleProfile,
        );
        if (content.kind === "hidden") return null;

        const [left = 0, top = 0, width = 0, height = 0] = content.bbox || element.bbox || [];
        const isRule = width === 0 || height === 0;
        const ruleWidth = Math.max(Number(element.lineWidth || 1) * scale, 1);
        const elementWidth = Math.max(width * scale, width === 0 ? ruleWidth : 1);
        const elementHeight = Math.max(height * scale, height === 0 ? ruleWidth : 1);
        const fieldId = getElementFieldId(slideNumber, element);
        const elementFields = fieldId ? fieldsByElement[fieldId] || [] : [];
        const mediaField = elementFields.find((candidate) => isAssetField(candidate) || isChartField(candidate));
        const editableElementFields = elementFields.filter((candidate) => !candidate.hidden && candidate.fieldKind === "text");
        const linkedElementFields = elementFields.filter((candidate) => (
          candidate.fieldKind === "text" && !isPptTextField(candidate)
        ));
        const editableLinkedElementFields = linkedElementFields.filter((candidate) => !candidate.hidden);
        const pptTextField = editableElementFields.find(isPptTextField);
        const inlineTokenField = editableLinkedElementFields.length === 1 && isWholeElementToken(element, editableLinkedElementFields[0])
          ? editableLinkedElementFields[0]
          : null;
        const inlineTextField = !mediaField
          ? inlineTokenField || (linkedElementFields.length === 0 ? pptTextField : null)
          : null;
        const field = mediaField || inlineTextField;
        const isEditable = inlineTextField && !previewMode && !isResolvedByGlobalDetails(inlineTextField, globalDetails);
        const displayText = getElementDisplayText(
          slideNumber,
          element,
          fieldsById,
          fieldValues,
          globalDetails,
          displaySlideNumber,
        );
        const style = elementFields[0]?.style || getElementStyle(element);
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
          const tableText = content.kind === "table"
            ? ""
            : content.text ?? getElementDisplayText(slideNumber, element, fieldsById, fieldValues, globalDetails);
          const matrix = content.tableMatrix || parseTableText(tableText, element.rows, element.cols);
          const visibleRows = content.visibleTableRows || Array.from(
            { length: Number(element.rows || 0) },
            (_, index) => index + 1,
          );
          const visibleColumns = content.visibleTableColumns || Array.from(
            { length: Number(element.cols || 0) },
            (_, index) => index + 1,
          );
          const sourceTableLeft = Number(element.bbox?.[0] || 0);
          const tableScaleX = Number(content.tableScaleX || 1);
          const sourceLabelWidth = Number(
            element.cells.find((cell) => Number(cell.column || 1) === 1)?.bbox?.[2] || 0,
          );
          const compactValueWidth = visibleColumns.length > 1
            ? (Number(element.bbox?.[2] || 0) - sourceLabelWidth) / (visibleColumns.length - 1)
            : 0;

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
              {element.cells.filter((cell) => (
                visibleRows.includes(Number(cell.row || 1)) &&
                visibleColumns.includes(Number(cell.column || 1))
              )).map((cell) => {
                const [cellLeft = 0, cellTop = 0, cellWidth = 0, cellHeight = 0] = cell.bbox || [];
                const cellStyle = getElementStyle(cell);
                const cellInsets = cellStyle.insets || {};
                const rowIndex = Number(cell.row || 1) - 1;
                const colIndex = Number(cell.column || 1) - 1;
                const compactRowIndex = visibleRows.indexOf(Number(cell.row || 1));
                const compactColumnIndex = visibleColumns.indexOf(Number(cell.column || 1));
                const effectiveCellLeft = content.compactTableColumns
                  ? left + (compactColumnIndex === 0
                    ? 0
                    : sourceLabelWidth + (compactColumnIndex - 1) * compactValueWidth)
                  : left + (cellLeft - sourceTableLeft) * tableScaleX;
                const effectiveCellTop = content.compactTableRows
                  ? top + compactRowIndex * cellHeight
                  : cellTop;
                const effectiveCellWidth = content.compactTableColumns
                  ? (compactColumnIndex === 0 ? sourceLabelWidth : compactValueWidth)
                  : cellWidth * tableScaleX;
                const matrixValue = matrix[rowIndex]?.[colIndex];
                const cellText = content.suppressTemplateFallback
                  ? (matrixValue ?? "")
                  : (matrixValue || applyGlobalDetails(cell.text, globalDetails));

                return (
                  <div
                    key={`${slideNumber}-${element.id}-cell-${cell.index}`}
                    className="absolute overflow-hidden"
                    style={{
                      left: effectiveCellLeft * scale - left * scale,
                      top: effectiveCellTop * scale - top * scale,
                      width: Math.max(effectiveCellWidth * scale, 1),
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
                      textDecoration: cellStyle.textDecoration,
                      color: cellStyle.color,
                      textAlign: cellStyle.textAlign,
                      lineHeight: cellStyle.lineHeight,
                      whiteSpace: cellStyle.wrap === false ? "nowrap" : "pre-wrap",
                      letterSpacing: cellStyle.letterSpacing,
                    }}
                  >
                    <span className="block w-full">{cellText}</span>
                  </div>
                );
              })}
            </div>
          );
        }

        if (!element.text && content.kind !== "image" && content.kind !== "chart") {
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
          textDecoration: style.textDecoration,
          color: style.color,
          textAlign: style.textAlign,
          lineHeight: style.lineHeight,
          whiteSpace: style.wrap === false ? "nowrap" : "pre-wrap",
          overflow: "hidden",
          letterSpacing: style.letterSpacing,
        };
        if ((content.kind === "image" || content.kind === "chart") && content.dataUrl) {
          return (
            <div
              key={`${slideNumber}-${element.order}-${element.id}`}
              className={`absolute overflow-hidden ${!previewMode && field ? "cursor-pointer" : ""
                }`}
              onClick={() => {
                if (!previewMode && field) onFieldFocus(field.id);
              }}
              style={{
                ...commonStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: content.kind === "image"
                  ? "transparent"
                  : fillColor === "transparent" ? "#FFFFFF" : fillColor,
                padding: content.kind === "image" ? 0 : Math.max(4 * scale, 2),
                opacity: Number(element.opacity ?? 1),
                borderRadius: element.imageCornerRadius ? Math.max(Number(element.imageCornerRadius || 0) * scale, 0) : undefined,
                border: element.imageBorderWidth
                  ? `${Math.max(Number(element.imageBorderWidth || 0) * scale, 0.5)}px solid ${cssColor(element.imageBorderColor, "#FFFFFF")}`
                  : commonStyle.border,
                boxShadow:
                  !previewMode && field && activeFieldId === field.id
                    ? "0 0 0 2px rgba(139, 197, 61, 0.5)"
                    : element.imageShadow
                      ? "0 10px 22px rgba(17,24,39,0.16)"
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
            onClick={() => onFieldFocus(getFieldValueKey(field) || field.id)}
            className={`absolute overflow-hidden rounded-[2px] border border-dashed outline-none transition ${[field.id, getFieldValueKey(field)].includes(activeFieldId)
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
          const isStyleSelected = styleSelectionMode && selectedStyleElementId === element.id;
          return (
            <div
              key={`${slideNumber}-${element.order}-${element.id}`}
              className={`absolute ${styleSelectionMode ? "cursor-pointer hover:shadow-[0_0_0_2px_rgba(139,197,61,0.35)]" : ""}`}
              onClick={
                styleSelectionMode
                  ? (event) => {
                    event.stopPropagation();
                    onSelectStyleElement?.({
                      elementId: element.id,
                      label: normalizeText(displayText).slice(0, 60) || "Text element",
                      currentFontSize: style.fontSize,
                      currentColor: style.color,
                    });
                  }
                  : undefined
              }
              style={{
                ...textStyle,
                boxShadow: isStyleSelected ? "0 0 0 2px #8BC53D" : textStyle.boxShadow,
              }}
            >
              <span className="block w-full">{displayText}</span>
            </div>
          );
        }

        const isPptTextEditor = isPptTextField(field);
        const fieldValueKey = getFieldValueKey(field) || field.id;
        const fieldIsActive = [field.id, fieldValueKey].includes(activeFieldId);
        const userValue = isPptTextEditor
          ? (hasStoredFieldValue(field, fieldValues) ? String(getStoredFieldValue(field, fieldValues) ?? "") : displayText)
          : getStoredFieldValue(field, fieldValues) || "";

        return (
          <textarea
            key={`${slideNumber}-${element.order}-${element.id}`}
            aria-label={field.label}
            value={userValue}
            onFocus={() => onFieldFocus(fieldValueKey)}
            onClick={() => onFieldFocus(fieldValueKey)}
            onChange={(event) => onFieldChange(fieldValueKey, event.target.value)}
            maxLength={field.maxLength || undefined}
            className={`absolute resize-none overflow-hidden rounded-[2px] border px-1 py-0.5 outline-none transition ${fieldIsActive
              ? "border-[#8BC53D] ring-2 ring-[#8BC53D]/30"
              : isPptTextEditor
                ? "border-transparent hover:border-[#8BC53D]/55 focus:border-[#8BC53D]/70"
                : "border-[#8BC53D]/45 hover:border-[#8BC53D]"
              }`}
            style={{
              ...textStyle,
              display: "block",
              backgroundColor: isPptTextEditor
                ? (fillColor === "transparent" ? "transparent" : fillColor)
                : (fillColor === "transparent" ? "rgba(255,255,255,0.76)" : fillColor),
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
  const getSectionProgress = (section) => {
    const isBasic = section.type === "basic";
    const sectionFields = section.slides.flatMap((slide) => fieldsBySlide[slide] || []);
    const editableFields = getEditableTemplateFields(sectionFields, globalDetails);
    const basicCompleted = BASIC_DETAIL_FIELDS.filter(([key]) => normalizeText(globalDetails[key])).length;
    const completed = isBasic
      ? basicCompleted + countFieldsWithData(editableFields, fieldValues, assetValues, chartValues)
      : countFieldsWithData(editableFields, fieldValues, assetValues, chartValues);
    const total = (isBasic ? BASIC_DETAIL_FIELDS.length : 0) + editableFields.length;
    return { completed, total };
  };

  return (
    <aside className="group sticky top-4 z-40 w-14 overflow-visible">
      <div className="rounded-lg border border-border bg-white p-1.5 shadow-card">
        <div className="mb-1 flex h-9 items-center justify-center rounded-md bg-[#F7F8FA] text-[#6D6E71]">
          <PanelLeft size={15} />
        </div>
        <nav className="space-y-1">
          {sections.map((section) => {
            const isActive = activeSectionId === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => onSelectSection(section.id)}
                title={section.title}
                className={`flex h-10 w-full items-center justify-center rounded-md text-[11px] font-bold transition ${isActive
                  ? "bg-[#476E2C] text-white"
                  : "text-[#6D6E71] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
                  }`}
              >
                {section.number}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="invisible pointer-events-none absolute left-0 top-0 z-50 w-72 opacity-0 shadow-2xl transition duration-150 group-hover:visible group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <div className="max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg border border-border bg-white p-3">
          <div className="mb-3 flex items-center gap-2 px-1 text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">
            <PanelLeft size={14} />
            CIM Sections
          </div>
          <nav className="space-y-1">
            {sections.map((section) => {
              const isActive = activeSectionId === section.id;
              const { completed, total } = getSectionProgress(section);
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => onSelectSection(section.id)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition ${isActive
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
        </div>
      </div>
    </aside>
  );
}

function GlobalDetailsPanel({ activeSlide, globalDetails, onChange, compact = false }) {
  const definitions = BASIC_DETAIL_FIELD_DEFINITIONS.filter((definition) =>
    !activeSlide || definition.slides.includes(activeSlide),
  );

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-card">
      <h3 className="text-sm font-bold text-[#050505]">Slide {activeSlide} Details</h3>
      <div className={`mt-4 grid gap-3 ${compact ? "" : "md:grid-cols-2"}`}>
        {definitions.length > 0 ? definitions.map(({ key, label, maxLength }) => (
          <label key={key} className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
              {label}
            </span>
            <input
              value={globalDetails[key] || ""}
              onChange={(event) => onChange(key, event.target.value)}
              maxLength={maxLength}
              className="theme-input h-9 text-[13px]"
            />
          </label>
        )) : (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-[#A5A5A5]">
            No setup fields required on this slide.
          </div>
        )}
      </div>
    </div>
  );
}

function fieldCardClass(active) {
  return `block rounded-md border p-3 transition ${active ? "border-[#8BC53D] bg-[#F7FBF1]" : "border-border bg-white"
    }`;
}

function AssetFieldControl({
  field,
  asset,
  active,
  onFieldFocus,
  onAssetUpload,
  onAssetRemove,
  onAssetScaleChange,
  questionnaireItem,
  onQuestionnaireToggle,
  onQuestionPromptChange,
  reviewItem,
  onReviewAddNote,
  onReviewResolve,
  onReviewReopen,
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
      {asset?.dataUrl && (
        <label className="mt-3 block" onClick={(event) => event.stopPropagation()}>
          <span className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase text-[#8A8F98]">
            <span>Logo Size</span>
            <span>{Math.round(normalizeAssetScale(asset.scale) * 100)}%</span>
          </span>
          <input
            type="range"
            min={ASSET_SCALE_MIN}
            max={ASSET_SCALE_MAX}
            step={0.05}
            value={normalizeAssetScale(asset.scale)}
            onChange={(event) => onAssetScaleChange(field, event.target.value)}
            className="w-full accent-[#476E2C]"
            aria-label={`${field.label} size`}
          />
          <span className="mt-0.5 block text-[10px] text-[#A5A5A5]">
            Resizes without stretching — the logo's aspect ratio is always preserved.
          </span>
        </label>
      )}
      <QuestionnaireFieldActions
        field={field}
        item={questionnaireItem}
        onToggle={onQuestionnaireToggle}
        onPromptChange={onQuestionPromptChange}
      />
      <CimReviewFieldBadge
        field={field}
        item={reviewItem}
        onAddNote={onReviewAddNote}
        onResolve={onReviewResolve}
        onReopen={onReviewReopen}
      />
    </div>
  );
}

function ChartFieldControl({
  field,
  active,
  chartValues,
  styleProfile,
  onFieldFocus,
  onChartChange,
  questionnaireItem,
  onQuestionnaireToggle,
  onQuestionPromptChange,
  reviewItem,
  onReviewAddNote,
  onReviewResolve,
  onReviewReopen,
}) {
  const config = getChartConfig(field, chartValues);
  const dataUrl = getChartDataUrl(field, chartValues, {}, styleProfile);

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
      {field.chartHelp && (
        <p className="mt-2 text-xs leading-snug text-[#6D6E71]">
          {field.chartHelp}
        </p>
      )}
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
      <CimReviewFieldBadge
        field={field}
        item={reviewItem}
        onAddNote={onReviewAddNote}
        onResolve={onReviewResolve}
        onReopen={onReviewReopen}
      />
    </div>
  );
}

function RepeatableFieldControl({
  field,
  value,
  active,
  onFieldFocus,
  onFieldChange,
  onRepeatablePageChange,
  questionnaireItem,
  onQuestionnaireToggle,
  onQuestionPromptChange,
  reviewItem,
  onReviewAddNote,
  onReviewResolve,
  onReviewReopen,
}) {
  const config = field.repeatableConfig || {};
  const entryFields = config.fields || [];
  const parsedEntries = parseRepeatableEntries(value, config);
  const entries = parsedEntries.length ? parsedEntries : [{}];
  const [expandedEntryIndex, setExpandedEntryIndex] = useState(0);

  const updateEntries = (nextEntries) => {
    const cleaned = nextEntries.length ? nextEntries : [{}];
    onFieldChange(field.id, stringifyRepeatableEntries(cleaned));
  };

  const updateEntry = (entryIndex, key, nextValue) => {
    updateEntries(entries.map((entry, index) =>
      index === entryIndex ? { ...entry, [key]: nextValue } : entry,
    ));
  };

  const addEntry = () => {
    const nextEntries = [...entries, {}];
    updateEntries(nextEntries);
    setExpandedEntryIndex(nextEntries.length - 1);
    if (config.pageSize) {
      onRepeatablePageChange?.(field.slideNumber, Math.floor((nextEntries.length - 1) / config.pageSize));
    }
  };

  const removeEntry = (entryIndex) => {
    const nextEntries = entries.filter((_, index) => index !== entryIndex);
    updateEntries(nextEntries);
    const nextExpandedIndex = Math.max(0, Math.min(entryIndex, nextEntries.length - 1));
    setExpandedEntryIndex(nextExpandedIndex);
    if (config.pageSize) {
      onRepeatablePageChange?.(field.slideNumber, Math.floor(nextExpandedIndex / config.pageSize));
    }
  };

  const updateEntryAsset = (entryIndex, key, file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateEntry(entryIndex, key, {
      dataUrl: String(reader.result || ""),
      name: file.name,
      type: file.type,
    });
    reader.readAsDataURL(file);
  };

  const renderEntryInput = (entry, entryIndex, entryField) => {
    if (entryField.inputType === "asset") {
      const asset = entry[entryField.key];
      return (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-white p-2.5">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#F2F4F5]">
            {asset?.dataUrl ? (
              <img src={asset.dataUrl} alt={asset.name || entryField.label} className="h-full w-full object-cover" />
            ) : (
              <ImagePlus size={22} className="text-[#A5A5A5]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold text-[#6D6E71]">
              {asset?.name || (entryField.key === "image" ? "PNG or JPG logo" : "PNG or JPG headshot")}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-[#EEF6E0] px-2 py-1.5 text-[11px] font-bold text-[#476E2C] transition hover:bg-[#DDEBCB]">
                <Upload size={12} />
                {asset?.dataUrl ? "Replace" : entryField.key === "image" ? "Upload logo" : "Upload photo"}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="sr-only"
                  onChange={(event) => {
                    updateEntryAsset(entryIndex, entryField.key, event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              {asset?.dataUrl ? (
                <button
                  type="button"
                  onClick={() => updateEntry(entryIndex, entryField.key, null)}
                  className="rounded-md px-2 py-1.5 text-[11px] font-bold text-red-600 transition hover:bg-red-50"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    if (entryField.inputType === "textarea" || entryField.key === "description") {
      return (
        <textarea
          value={entry[entryField.key] || ""}
          onChange={(event) => updateEntry(entryIndex, entryField.key, event.target.value)}
          placeholder={entryField.placeholder || ""}
          className="min-h-[84px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-[12px] leading-normal text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
          spellCheck={false}
        />
      );
    }

    return (
      <input
        value={entry[entryField.key] || ""}
        onChange={(event) => updateEntry(entryIndex, entryField.key, event.target.value)}
        placeholder={entryField.placeholder || ""}
        className="h-10 w-full rounded-md border border-border bg-white px-3 text-[12px] leading-normal text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
      />
    );
  };

  return (
    <div
      className={fieldCardClass(active)}
      onFocusCapture={() => onFieldFocus(field.id)}
      onClick={() => onFieldFocus(field.id)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="block truncate text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
            {field.label}
          </span>
          {config.pageSize ? (
            <span className="mt-0.5 block text-[11px] font-semibold text-[#8A8F98]">
              {entries.filter(hasRepeatableEntryValue).length} added · {Math.max(1, Math.ceil(entries.length / config.pageSize))} slide(s)
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            addEntry();
          }}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-[#476E2C] px-2.5 text-[11px] font-bold text-white transition hover:bg-[#365522]"
        >
          <Plus size={12} />
          {config.addLabel || "Add"}
        </button>
      </div>

      <div className="space-y-2">
        {entries.map((entry, entryIndex) => {
          const isPerson = field.fieldKind === "people";
          const isOffering = field.fieldKind === "offerings";
          const isMilestone = field.fieldKind === "milestones";
          const isShareholder = field.fieldKind === "shareholders";
          const isGroupedEntry = ["differentiators", "competitors", "initiatives", "revenueStreams"].includes(field.fieldKind);
          const expanded = expandedEntryIndex === entryIndex;
          const entryLabel = field.fieldKind === "shareholders"
            ? `Shareholder ${entryIndex + 1}`
            : isPerson
              ? `Person ${entryIndex + 1}`
              : field.fieldKind === "offerings"
                ? `Product / service ${entryIndex + 1}`
                : field.fieldKind === "differentiators"
                  ? `Differentiator ${entryIndex + 1}`
                  : field.fieldKind === "competitors"
                    ? `Company ${entryIndex + 1}`
                    : field.fieldKind === "initiatives"
                      ? `Initiative ${entryIndex + 1}`
                      : field.fieldKind === "revenueStreams"
                        ? `Revenue Stream ${entryIndex + 1}`
                        : `Milestone ${entryIndex + 1}`;

          return (
            <div
              key={entryIndex}
              className={`overflow-hidden rounded-lg border transition ${expanded ? "border-[#BFD99B] bg-[#F9FCF5]" : "border-border bg-white"}`}
            >
              <div className="flex min-h-11 items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpandedEntryIndex(entryIndex);
                    if (config.pageSize) {
                      onRepeatablePageChange?.(field.slideNumber, Math.floor(entryIndex / config.pageSize));
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E6F3D3] text-[11px] font-extrabold text-[#476E2C]">
                    {entryIndex + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-[#050505]">
                      {isMilestone
                        ? normalizeText(entry.year) || entryLabel
                        : isShareholder
                          ? normalizeText(entry.name) || entryLabel
                          : normalizeText(entry.name) || normalizeText(entry.title) || entryLabel}
                    </span>
                    {isPerson ? (
                      <span className="block truncate text-[10px] font-semibold text-[#8A8F98]">
                        {normalizeText(entry.title) || `Management slide ${Math.floor(entryIndex / (config.pageSize || 4)) + 1}`}
                      </span>
                    ) : isOffering ? (
                      <span className="block truncate text-[10px] font-semibold text-[#8A8F98]">
                        {normalizeText(entry.category) || `Product slide ${Math.floor(entryIndex / (config.pageSize || 3)) + 1}`}
                      </span>
                    ) : isShareholder && normalizeText(entry.role) ? (
                      <span className="block truncate text-[10px] font-semibold text-[#8A8F98]">
                        {entry.role}
                      </span>
                    ) : isMilestone && normalizeText(entry.description) ? (
                      <span className="block truncate text-[10px] font-semibold text-[#8A8F98]">
                        {entry.description}
                      </span>
                    ) : null}
                  </span>
                </button>
                {(entries.length > 1 || hasRepeatableEntryValue(entry)) ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeEntry(entryIndex);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#A5A5A5] transition hover:bg-red-50 hover:text-red-600"
                    aria-label={`Remove ${entryLabel}`}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>

              {expanded ? (
                <div className="space-y-3 border-t border-[#DDEBCB] p-3">
                  {isPerson ? (
                    <>
                      {entryFields.filter((entryField) => entryField.inputType === "asset").map((entryField) => (
                        <div key={entryField.key}>{renderEntryInput(entry, entryIndex, entryField)}</div>
                      ))}
                      <div className="grid gap-3">
                        {entryFields.filter((entryField) => !["asset", "textarea"].includes(entryField.inputType || "") && entryField.key !== "bio").map((entryField) => (
                          <label key={entryField.key} className="block">
                            <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                              {entryField.label}
                            </span>
                            {renderEntryInput(entry, entryIndex, entryField)}
                          </label>
                        ))}
                      </div>
                      {entryFields.filter((entryField) => entryField.key === "bio").map((entryField) => (
                        <label key={entryField.key} className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                            {entryField.label}
                          </span>
                          {renderEntryInput(entry, entryIndex, entryField)}
                        </label>
                      ))}
                    </>
                  ) : isOffering ? (
                    <>
                      {entryFields.filter((entryField) => entryField.inputType === "asset").map((entryField) => (
                        <div key={entryField.key}>{renderEntryInput(entry, entryIndex, entryField)}</div>
                      ))}
                      <div className="grid gap-3 md:grid-cols-2">
                        {entryFields.filter((entryField) => !["asset"].includes(entryField.inputType || "") && entryField.inputType !== "textarea" && entryField.key !== "description").map((entryField) => (
                          <label key={entryField.key} className="block">
                            <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                              {entryField.label}
                            </span>
                            {renderEntryInput(entry, entryIndex, entryField)}
                          </label>
                        ))}
                      </div>
                      {entryFields.filter((entryField) => entryField.key === "description" || entryField.inputType === "textarea").map((entryField) => (
                        <label key={entryField.key} className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                            {entryField.label}
                          </span>
                          {renderEntryInput(entry, entryIndex, entryField)}
                        </label>
                      ))}
                    </>
                  ) : isMilestone ? (
                    <div className="space-y-2">
                      {entryFields.map((entryField) => (
                        <label key={entryField.key} className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                            {entryField.label}
                          </span>
                          {renderEntryInput(entry, entryIndex, entryField)}
                        </label>
                      ))}
                    </div>
                  ) : isShareholder ? (
                    <div className="space-y-2">
                      {entryFields.map((entryField) => (
                        <label key={entryField.key} className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                            {entryField.label}
                          </span>
                          {renderEntryInput(entry, entryIndex, entryField)}
                        </label>
                      ))}
                    </div>
                  ) : isGroupedEntry ? (
                    <>
                      <div className="grid gap-3 md:grid-cols-2">
                        {entryFields.filter((entryField) => entryField.inputType !== "textarea" && entryField.key !== "description").map((entryField) => (
                          <label key={entryField.key} className="block">
                            <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                              {entryField.label}
                            </span>
                            {renderEntryInput(entry, entryIndex, entryField)}
                          </label>
                        ))}
                      </div>
                      {entryFields.filter((entryField) => entryField.inputType === "textarea" || entryField.key === "description").map((entryField) => (
                        <label key={entryField.key} className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                            {entryField.label}
                          </span>
                          {renderEntryInput(entry, entryIndex, entryField)}
                        </label>
                      ))}
                    </>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-[110px_minmax(0,1fr)]">
                      {entryFields.map((entryField) => (
                        <label key={entryField.key} className="block">
                          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                            {entryField.label}
                          </span>
                          {renderEntryInput(entry, entryIndex, entryField)}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <QuestionnaireFieldActions
        field={field}
        item={questionnaireItem}
        onToggle={onQuestionnaireToggle}
        onPromptChange={onQuestionPromptChange}
      />
      <CimReviewFieldBadge
        field={field}
        item={reviewItem}
        onAddNote={onReviewAddNote}
        onResolve={onReviewResolve}
        onReopen={onReviewReopen}
      />
    </div>
  );
}

function Slide24YearCards({ fields, fieldValues, range, activeFieldId, onFieldFocus, onFieldChange }) {
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);
  const columns = [...Array.from({ length: annualCount }, (_, index) => index), 5];
  const [expandedColumn, setExpandedColumn] = useState(columns[0] ?? 0);
  const fieldByTokenIndex = new Map(fields.map((field) => [getFieldTokenIndex(field), field]));
  const startYear = Number(String(range?.startDate || "").slice(0, 4));
  const periodType = range?.periodType || "calendar";
  const cardActive = fields.some((field) => (
    field.id === activeFieldId || getFieldValueKey(field) === activeFieldId
  ));
  const getCardValue = (field) => getStoredFieldValue(field, fieldValues) || "";
  const focusCardField = (field) => {
    const key = getFieldValueKey(field);
    if (key) onFieldFocus(key);
  };
  const changeCardField = (field, value) => {
    const key = getFieldValueKey(field);
    if (key) onFieldChange(key, value);
  };

  const getDefaultPeriodLabel = (column) => {
    if (column === 5) return "LTM";
    if (!startYear) return `Financial Year ${column + 1}`;
    const year = periodType === "fiscal" ? startYear + column + 1 : startYear + column;
    return formatSlide24Year(year, periodType);
  };

  return (
    <div className={fieldCardClass(cardActive)}>
      <div className="mb-3">
        <span className="block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
          Historical income statement by period
        </span>
        <span className="mt-0.5 block text-[11px] font-semibold text-[#8A8F98]">
          Auto-filled values remain editable. Empty fields stay blank on the slide.
        </span>
      </div>

      <div className="space-y-2">
        {columns.map((column, cardIndex) => {
          const periodField = fieldByTokenIndex.get(column);
          const storedPeriod = periodField ? normalizeText(getCardValue(periodField)) : "";
          const periodLabel = column === 5
            ? `LTM${storedPeriod ? ` · ${storedPeriod}` : ""}`
            : storedPeriod || getDefaultPeriodLabel(column);
          const metricFields = SLIDE_24_CARD_METRICS.flatMap((metric) => {
            if (column >= metric.count) return [];
            const metricField = fieldByTokenIndex.get(metric.start + column);
            return metricField ? [{ ...metric, field: metricField }] : [];
          });
          const populatedCount = metricFields.filter(({ field }) => normalizeText(getCardValue(field))).length;
          const expanded = expandedColumn === column;

          return (
            <div
              key={column}
              className={`overflow-hidden rounded-lg border transition ${expanded ? "border-[#BFD99B] bg-[#F9FCF5]" : "border-border bg-white"}`}
            >
              <button
                type="button"
                onClick={() => setExpandedColumn(expanded ? null : column)}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E6F3D3] text-[11px] font-extrabold text-[#476E2C]">
                    {cardIndex + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-[#050505]">{periodLabel}</span>
                    <span className="block text-[10px] font-semibold text-[#8A8F98]">
                      {populatedCount}/{metricFields.length} values entered
                    </span>
                  </span>
                </span>
                <ChevronRight
                  size={15}
                  className={`shrink-0 text-[#6D6E71] transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              </button>

              {expanded ? (
                <div className="space-y-3 border-t border-[#DDEBCB] p-3">
                  {periodField ? (
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                        {column === 5 ? "LTM end date" : "Financial year heading"}
                      </span>
                      <input
                        value={getCardValue(periodField)}
                        onFocus={() => focusCardField(periodField)}
                        onChange={(event) => changeCardField(periodField, event.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-white px-3 text-[12px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                      />
                    </label>
                  ) : null}

                  <div className="grid gap-3 md:grid-cols-2">
                    {metricFields.map(({ label, field }) => (
                      <label key={field.id} className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                          {label}
                        </span>
                        <input
                          value={getCardValue(field)}
                          onFocus={() => focusCardField(field)}
                          onChange={(event) => changeCardField(field, event.target.value)}
                          className="h-10 w-full rounded-md border border-border bg-white px-3 text-[12px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Slide26YearCards({ fields, fieldValues, range, activeFieldId, onFieldFocus, onFieldChange }) {
  const annualCount = Math.max(1, getSlide24ActivePeriodCount(range) - 1);
  const columns = [...Array.from({ length: annualCount }, (_, index) => index), 5];
  const [expandedColumn, setExpandedColumn] = useState(columns[0] ?? 0);
  const fieldByTokenIndex = new Map(fields.map((field) => [getFieldTokenIndex(field), field]));
  const startYear = Number(String(range?.startDate || "").slice(0, 4));
  const cardActive = fields.some((field) => (
    field.id === activeFieldId || getFieldValueKey(field) === activeFieldId
  ));
  const getCardValue = (field) => getStoredFieldValue(field, fieldValues) || "";
  const focusCardField = (field) => {
    const key = getFieldValueKey(field);
    if (key) onFieldFocus(key);
  };
  const changeCardField = (field, value) => {
    const key = getFieldValueKey(field);
    if (key) onFieldChange(key, value);
  };

  const getDefaultPeriodLabel = (column) => {
    if (column === 5) return "LTM";
    if (!startYear) return `Year ${column + 1}`;
    return formatSlide26Year(startYear + column);
  };

  return (
    <div className={fieldCardClass(cardActive)}>
      <div className="mb-3">
        <span className="block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
          Balance sheet by period
        </span>
        <span className="mt-0.5 block text-[11px] font-semibold text-[#8A8F98]">
          Auto-filled values remain editable. Empty fields stay blank on the slide.
        </span>
      </div>

      <div className="space-y-2">
        {columns.map((column, cardIndex) => {
          const periodField = fieldByTokenIndex.get(column);
          const storedPeriod = periodField ? normalizeText(getCardValue(periodField)) : "";
          const periodLabel = column === 5
            ? `LTM${storedPeriod ? ` · ${storedPeriod}` : ""}`
            : storedPeriod || getDefaultPeriodLabel(column);
          const metricFields = SLIDE_26_CARD_METRICS.flatMap((metric) => {
            if (column >= metric.count) return [];
            const metricField = fieldByTokenIndex.get(metric.start + column);
            return metricField ? [{ ...metric, field: metricField }] : [];
          });
          const populatedCount = metricFields.filter(({ field }) => normalizeText(getCardValue(field))).length;
          const expanded = expandedColumn === column;

          return (
            <div
              key={column}
              className={`overflow-hidden rounded-lg border transition ${expanded ? "border-[#BFD99B] bg-[#F9FCF5]" : "border-border bg-white"}`}
            >
              <button
                type="button"
                onClick={() => setExpandedColumn(expanded ? null : column)}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E6F3D3] text-[11px] font-extrabold text-[#476E2C]">
                    {cardIndex + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-[#050505]">{periodLabel}</span>
                    <span className="block text-[10px] font-semibold text-[#8A8F98]">
                      {populatedCount}/{metricFields.length} values entered
                    </span>
                  </span>
                </span>
                <ChevronRight
                  size={15}
                  className={`shrink-0 text-[#6D6E71] transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              </button>

              {expanded ? (
                <div className="space-y-3 border-t border-[#DDEBCB] p-3">
                  {periodField ? (
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                        {column === 5 ? "LTM end date" : "Year heading"}
                      </span>
                      <input
                        value={getCardValue(periodField)}
                        onFocus={() => focusCardField(periodField)}
                        onChange={(event) => changeCardField(periodField, event.target.value)}
                        className="h-10 w-full rounded-md border border-border bg-white px-3 text-[12px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                      />
                    </label>
                  ) : null}

                  <div className="grid gap-3 md:grid-cols-2">
                    {metricFields.map(({ label, field }) => (
                      <label key={field.id} className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                          {label}
                        </span>
                        <input
                          value={getCardValue(field)}
                          onFocus={() => focusCardField(field)}
                          onChange={(event) => changeCardField(field, event.target.value)}
                          className="h-10 w-full rounded-md border border-border bg-white px-3 text-[12px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Slide25EbitdaBridgeCard({ field, value, active, onFieldFocus, onFieldChange }) {
  const bridge = normalizeSlide25Bridge(value);
  const figures = getSlide25BridgeFigures(value);

  const updateBridge = (nextBridge) => {
    onFieldChange(field.id, stringifySlide25Bridge(nextBridge));
  };
  const updateAdjustment = (index, key, nextValue) => {
    const adjustments = bridge.adjustments.map((adjustment, adjustmentIndex) =>
      adjustmentIndex === index ? { ...adjustment, [key]: nextValue } : adjustment,
    );
    updateBridge({ ...bridge, adjustments });
  };
  const addAdjustment = () => {
    let nextIndex = 1;
    while (bridge.adjustments.some((adjustment) => adjustment.id === `manual-adjustment-${nextIndex}`)) {
      nextIndex += 1;
    }
    updateBridge({
      ...bridge,
      adjustments: [
        ...bridge.adjustments,
        { id: `manual-adjustment-${nextIndex}`, label: "", amount: "", nature: "", commentary: "" },
      ],
    });
  };
  const removeAdjustment = (index) => {
    updateBridge({
      ...bridge,
      adjustments: bridge.adjustments.filter((_, adjustmentIndex) => adjustmentIndex !== index),
    });
  };

  return (
    <div className={fieldCardClass(active)} onFocus={() => onFieldFocus(field.id)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
          EBITDA bridge
        </span>
        <button
          type="button"
          onClick={addAdjustment}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#BFD99B] bg-white px-2.5 text-[11px] font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
        >
          <Plus size={13} />
          Add adjustment
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
            Reported EBITDA ($M)
          </span>
          <input
            value={bridge.reportedEbitda}
            onChange={(event) => updateBridge({ ...bridge, reportedEbitda: event.target.value })}
            className="h-10 w-full rounded-md border border-border bg-white px-3 text-[12px] font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            inputMode="decimal"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
            Adjusted EBITDA ($M)
          </span>
          <input
            value={figures.adjusted === null ? "" : formatAutoFillNumber(figures.adjusted)}
            readOnly
            className="h-10 w-full rounded-md border border-[#DDEBCB] bg-[#F4F9EC] px-3 text-[12px] font-bold text-[#243F18] outline-none"
          />
        </label>
      </div>

      {bridge.adjustments.length > 0 ? (
        <div className="mt-4 border-t border-[#DDEBCB]">
          {bridge.adjustments.map((adjustment, index) => (
            <div key={adjustment.id} className="border-b border-[#E8EDEF] py-3 last:border-b-0">
              <div className="grid grid-cols-[minmax(0,1fr)_92px_32px] gap-2">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                    Adjustment {index + 1}
                  </span>
                  <input
                    value={adjustment.label}
                    onChange={(event) => updateAdjustment(index, "label", event.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-white px-2.5 text-[12px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
                    Amount ($M)
                  </span>
                  <input
                    value={adjustment.amount}
                    onChange={(event) => updateAdjustment(index, "amount", event.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-white px-2.5 text-[12px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                    inputMode="decimal"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeAdjustment(index)}
                  className="mt-5 flex h-9 w-8 items-center justify-center rounded-md text-[#8A8F98] transition hover:bg-red-50 hover:text-red-600"
                  title={`Remove adjustment ${index + 1}`}
                  aria-label={`Remove adjustment ${index + 1}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Slide27CashflowCard({ field, value, active, onFieldFocus, onFieldChange }) {
  const cashflow = normalizeSlide27Cashflow(value);
  const [expandedPeriod, setExpandedPeriod] = useState(cashflow.columns[0]?.key || "");

  const updateValue = (rowKey, periodKey, nextValue) => {
    const rows = cashflow.rows.map((row) =>
      row.key === rowKey
        ? { ...row, values: { ...row.values, [periodKey]: nextValue || "-" } }
        : row,
    );
    onFieldChange(field.id, stringifySlide27Cashflow({ ...cashflow, rows }));
  };
  const updateRowLabel = (rowKey, label) => {
    const rows = cashflow.rows.map((row) => row.key === rowKey ? { ...row, label } : row);
    onFieldChange(field.id, stringifySlide27Cashflow({ ...cashflow, rows }));
  };
  const addRow = () => {
    let nextIndex = 1;
    while (cashflow.rows.some((row) => row.key === `manual-cashflow-row-${nextIndex}`)) nextIndex += 1;
    const rows = [
      ...cashflow.rows,
      {
        key: `manual-cashflow-row-${nextIndex}`,
        label: "Manual cash flow item",
        type: "data",
        depth: 1,
        manual: true,
        values: Object.fromEntries(cashflow.columns.map((column) => [column.key, "-"])),
      },
    ];
    onFieldChange(field.id, stringifySlide27Cashflow({ ...cashflow, rows }));
  };
  const removeRow = (rowKey) => {
    onFieldChange(field.id, stringifySlide27Cashflow({
      ...cashflow,
      rows: cashflow.rows.filter((row) => row.key !== rowKey),
    }));
  };

  return (
    <div className={fieldCardClass(active)} onFocus={() => onFieldFocus(field.id)}>
      <div className="flex items-center justify-between gap-3">
        <span className="block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
          Cash flow statement by period
        </span>
        <button
          type="button"
          onClick={addRow}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#BFD99B] bg-white px-2.5 text-[11px] font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
        >
          <Plus size={13} />
          Add row
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {cashflow.columns.map((column, columnIndex) => {
          const expanded = expandedPeriod === column.key;
          const editableRows = cashflow.rows.filter((row) => row.type !== "header");
          const populatedCount = editableRows.filter((row) => row.values[column.key] !== "-").length;
          return (
            <div key={column.key} className="overflow-hidden rounded-lg border border-border bg-white">
              <button
                type="button"
                onClick={() => setExpandedPeriod(expanded ? "" : column.key)}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E6F3D3] text-[11px] font-extrabold text-[#476E2C]">
                    {columnIndex + 1}
                  </span>
                  <span>
                    <span className="block text-[12px] font-bold text-[#050505]">{column.label}</span>
                    <span className="block text-[10px] font-semibold text-[#8A8F98]">
                      {populatedCount}/{editableRows.length} values entered
                    </span>
                  </span>
                </span>
                <ChevronRight
                  size={15}
                  className={`shrink-0 text-[#6D6E71] transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              </button>
              {expanded ? (
                <div className="border-t border-[#DDEBCB] px-3 py-2">
                  {cashflow.rows.map((row) => row.type === "header" ? (
                    <div key={row.key} className="mt-2 bg-[#EEF6E0] px-2 py-1.5 text-[10px] font-bold uppercase text-[#476E2C] first:mt-0">
                      {row.label}
                    </div>
                  ) : (
                    <div key={row.key} className={`grid items-center gap-2 border-b border-[#EEF0F2] py-2 last:border-b-0 ${row.manual ? "grid-cols-[minmax(0,1fr)_108px_28px]" : "grid-cols-[minmax(0,1fr)_108px]"}`}>
                      {row.manual ? (
                        <input
                          value={row.label}
                          onChange={(event) => updateRowLabel(row.key, event.target.value)}
                          className="h-8 min-w-0 rounded-md border border-border bg-white px-2 text-[11px] font-semibold text-[#55585D] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                        />
                      ) : (
                        <span className="truncate text-[11px] font-semibold text-[#55585D]" title={row.label}>
                          {row.label}
                        </span>
                      )}
                      <input
                        value={row.values[column.key] || "-"}
                        onChange={(event) => updateValue(row.key, column.key, event.target.value)}
                        className="h-8 w-full rounded-md border border-border bg-white px-2 text-right text-[11px] text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                      />
                      {row.manual ? (
                        <button
                          type="button"
                          onClick={() => removeRow(row.key)}
                          className="flex h-8 w-7 items-center justify-center rounded-md text-[#8A8F98] transition hover:bg-red-50 hover:text-red-600"
                          title="Remove manual row"
                          aria-label="Remove manual row"
                        >
                          <Trash2 size={14} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CimSharePickerModal({ onClose, teamMembers, sharedWith, onShare }) {
  const [selectedIds, setSelectedIds] = useState(() => sharedWith.map((member) => member.id));

  const toggleMember = (id) => {
    setSelectedIds((previous) =>
      previous.includes(id) ? previous.filter((candidate) => candidate !== id) : [...previous, id],
    );
  };

  return (
    <Modal isOpen onClose={onClose} title="Share CIM for review" size="md">
      <p className="mb-3 text-sm text-[#6D6E71]">
        Select which client team members can view this CIM and raise notes for review.
      </p>
      {teamMembers.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-[#FAFBFC] p-4 text-sm text-[#6D6E71]">
          No client team members found for this company yet.
        </p>
      ) : (
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {teamMembers.map((member) => (
            <label
              key={member.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm transition hover:bg-[#FAFBFC]"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(member.id)}
                onChange={() => toggleMember(member.id)}
                className="h-4 w-4 rounded border-border text-[#8BC53D] focus:ring-[#8BC53D]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-[#050505]">{member.name || member.email}</span>
                <span className="block truncate text-xs text-[#6D6E71]">{member.email}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="theme-btn-secondary">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onShare(selectedIds)}
          disabled={selectedIds.length === 0}
          className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Share2 size={16} />
          Share
        </button>
      </div>
    </Modal>
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
    <div className="mt-2 rounded-md border border-border bg-[#FAFBFC] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.05em] text-[#6D6E71]">
          <MessageSquareText size={12} className="text-[#8BC53D]" />
          Client
        </div>
        {requested ? <QuestionnaireStatusPill status={item.status} /> : null}
      </div>

      {requested ? (
        <div className="mt-1.5 space-y-1.5">
          <textarea
            value={item.prompt || ""}
            onChange={(event) => onPromptChange(field, event.target.value)}
            className="min-h-[44px] w-full resize-y rounded-md border border-border bg-white px-2 py-1.5 text-[11px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            spellCheck={false}
          />
          {normalizeText(item.clientNote) && (
            <div className="rounded-md bg-white p-2 text-[11px] leading-snug text-[#050505]">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                Client note
              </p>
              <p className="line-clamp-3 whitespace-pre-wrap">{item.clientNote}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => onToggle(field)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-[11px] font-bold text-[#6D6E71] transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 size={12} />
            Remove request
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(field)}
          className="mt-1.5 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-[11px] font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
        >
          <Send size={12} />
          Ask client
        </button>
      )}
    </div>
  );
}

function CimReviewFieldBadge({ field, item, onAddNote, onResolve, onReopen }) {
  const [open, setOpen] = useState(false);
  if (!item) return null;
  const isOpen = item.status !== "resolved";

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        className={`mt-2 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-bold transition ${isOpen
          ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
          : "border-border bg-white text-[#6D6E71] hover:bg-[#FAFBFC]"
          }`}
      >
        <Flag size={12} />
        {isOpen ? "Client flagged" : "Resolved"}
        {item.notes?.length > 0 && (
          <span className="ml-0.5 rounded-full bg-white/70 px-1.5 text-[10px]">{item.notes.length}</span>
        )}
      </button>
      {open && (
        <Modal isOpen={open} onClose={() => setOpen(false)} title={field.label} size="sm">
          <CimFieldNoteThread
            notes={item.notes || []}
            status={item.status}
            resolvedBy={item.resolvedBy}
            resolvedAt={item.resolvedAt}
            canResolve
            canReopen
            onAddNote={(body) => onAddNote(field.id, body)}
            onResolve={(body) => onResolve(field.id, body)}
            onReopen={() => onReopen(field.id)}
          />
        </Modal>
      )}
    </>
  );
}

function FieldPanel({
  activeSlide,
  activeSlideInstance = 0,
  fields,
  fieldValues,
  assetValues,
  chartValues,
  styleProfile,
  questionnaireState,
  reviewState,
  globalDetails,
  financialAutofillRange,
  activeFieldId,
  onFieldFocus,
  onFieldChange,
  onRepeatablePageChange,
  onAssetUpload,
  onAssetRemove,
  onAssetScaleChange,
  onChartChange,
  onQuestionnaireToggle,
  onQuestionPromptChange,
  onReviewAddNote,
  onReviewResolve,
  onReviewReopen,
}) {
  const allEditableFields = getEditableTemplateFields(fields, globalDetails);
  const activeEditableFields = activeSlide === 24
    ? allEditableFields.filter((field) => isSlide24FieldActive(field, financialAutofillRange))
    : activeSlide === 26
      ? allEditableFields.filter((field) => isSlide26FieldActive(field, financialAutofillRange))
      : allEditableFields;
  const slide24TableFields = activeSlide === 24
    ? activeEditableFields.filter((field) => field.order === 7)
    : [];
  const slide26TableFields = activeSlide === 26
    ? activeEditableFields.filter((field) => field.order === 7)
    : [];
  const editableFields = activeSlide === 24 || activeSlide === 26
    ? activeEditableFields.filter((field) => field.order !== 7)
    : activeEditableFields;
  const filledFieldCount = countFieldsWithData(activeEditableFields, fieldValues, assetValues, chartValues);

  return (
    <div className="rounded-lg border border-border bg-white p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-[#050505]">
          Slide {activeSlide}{activeSlideInstance > 0 ? `.${activeSlideInstance + 1}` : ""} Fields
        </h3>
        <span
          className="rounded-md bg-[#EEF6E0] px-2 py-1 text-[11px] font-bold text-[#476E2C]"
          title={`${filledFieldCount} fields with data out of ${activeEditableFields.length}`}
        >
          {filledFieldCount}/{activeEditableFields.length}
        </span>
      </div>

      <div className="mt-3 max-h-[520px] space-y-3 overflow-y-auto pr-1">
        {slide24TableFields.length ? (
          <Slide24YearCards
            fields={slide24TableFields}
            fieldValues={fieldValues}
            range={financialAutofillRange}
            activeFieldId={activeFieldId}
            onFieldFocus={onFieldFocus}
            onFieldChange={onFieldChange}
          />
        ) : null}
        {slide26TableFields.length ? (
          <Slide26YearCards
            fields={slide26TableFields}
            fieldValues={fieldValues}
            range={financialAutofillRange}
            activeFieldId={activeFieldId}
            onFieldFocus={onFieldFocus}
            onFieldChange={onFieldChange}
          />
        ) : null}
        {editableFields.length > 0 ? (
          editableFields.map((field) => {
            const fieldValueKey = getFieldValueKey(field) || field.id;
            const fieldValue = getStoredFieldValue(field, fieldValues) || "";
            const fieldActive = activeFieldId === field.id || activeFieldId === fieldValueKey;
            const questionnaireItem = questionnaireState?.items?.[field.id];
            const reviewItem = reviewState?.items?.[field.id];
            if (field.fieldKind === "ebitdaBridge") {
              return (
                <Slide25EbitdaBridgeCard
                  key={field.id}
                  field={field}
                  value={fieldValues[field.id] || ""}
                  active={activeFieldId === field.id}
                  onFieldFocus={onFieldFocus}
                  onFieldChange={onFieldChange}
                />
              );
            }
            if (field.fieldKind === "cashflowStatement") {
              return (
                <Slide27CashflowCard
                  key={field.id}
                  field={field}
                  value={fieldValues[field.id] || ""}
                  active={activeFieldId === field.id}
                  onFieldFocus={onFieldFocus}
                  onFieldChange={onFieldChange}
                />
              );
            }
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
                  onAssetScaleChange={onAssetScaleChange}
                  questionnaireItem={questionnaireItem}
                  onQuestionnaireToggle={onQuestionnaireToggle}
                  onQuestionPromptChange={onQuestionPromptChange}
                  reviewItem={reviewItem}
                  onReviewAddNote={onReviewAddNote}
                  onReviewResolve={onReviewResolve}
                  onReviewReopen={onReviewReopen}
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
                  styleProfile={styleProfile}
                  onFieldFocus={onFieldFocus}
                  onChartChange={onChartChange}
                  questionnaireItem={questionnaireItem}
                  onQuestionnaireToggle={onQuestionnaireToggle}
                  onQuestionPromptChange={onQuestionPromptChange}
                  reviewItem={reviewItem}
                  onReviewAddNote={onReviewAddNote}
                  onReviewResolve={onReviewResolve}
                  onReviewReopen={onReviewReopen}
                />
              );
            }

            if (field.repeatableConfig) {
              return (
                <RepeatableFieldControl
                  key={field.id}
                  field={field}
                  value={fieldValues[field.id] || ""}
                  active={activeFieldId === field.id}
                  onFieldFocus={onFieldFocus}
                  onFieldChange={onFieldChange}
                  onRepeatablePageChange={onRepeatablePageChange}
                  questionnaireItem={questionnaireItem}
                  onQuestionnaireToggle={onQuestionnaireToggle}
                  onQuestionPromptChange={onQuestionPromptChange}
                  reviewItem={reviewItem}
                  onReviewAddNote={onReviewAddNote}
                  onReviewResolve={onReviewResolve}
                  onReviewReopen={onReviewReopen}
                />
              );
            }

            return (
              <label
                key={field.id}
                className={fieldCardClass(fieldActive)}
                onFocus={() => onFieldFocus(fieldValueKey)}
              >
                <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                  {field.label}
                </span>
                {field.inputType === "select" ? (
                  <select
                    value={fieldValue}
                    onChange={(event) => onFieldChange(fieldValueKey, event.target.value)}
                    className="h-10 w-full rounded-md border border-border bg-white px-3 text-[13px] font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                  >
                    <option value="">Select one</option>
                    {(field.options || []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    value={fieldValue}
                    onChange={(event) => onFieldChange(fieldValueKey, event.target.value)}
                    placeholder={getFieldValue(field, fieldValues, globalDetails) || field.label}
                    maxLength={field.maxLength || undefined}
                    className="min-h-[86px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-[13px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                    spellCheck={false}
                  />
                )}
                <QuestionnaireFieldActions
                  field={field}
                  item={questionnaireItem}
                  onToggle={onQuestionnaireToggle}
                  onPromptChange={onQuestionPromptChange}
                />
                <CimReviewFieldBadge
                  field={field}
                  item={reviewItem}
                  onAddNote={onReviewAddNote}
                  onResolve={onReviewResolve}
                  onReopen={onReviewReopen}
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

function FinancialAutofillModal({
  initialRange,
  initialReportVersionId,
  initialDatasetVersion,
  sourceLabel,
  versionMode,
  reportVersions,
  reportVersionsLoading,
  reportVersionsError,
  datasetVersions,
  datasetVersionsLoading,
  datasetVersionsError,
  loading,
  onClose,
  onConfirm,
}) {
  const [range, setRange] = useState(initialRange || getDefaultFinancialAutofillRange());
  const [reportVersionId, setReportVersionId] = useState(initialReportVersionId || "");
  const [datasetVersion, setDatasetVersion] = useState(initialDatasetVersion || "");

  const needsReportVersion = versionMode === "key_reports";
  const needsDatasetVersion = versionMode === "manual_gl";
  const hasReportVersions = needsReportVersion && reportVersions.length > 0;
  const hasDatasetVersions = needsDatasetVersion && datasetVersions.length > 0;
  const fallbackReportVersion = reportVersions.find((version) => version.id === initialReportVersionId)
    || reportVersions.find((version) => version.isActive)
    || reportVersions[0]
    || null;
  const effectiveReportVersionId = reportVersions.some((version) => version.id === reportVersionId)
    ? reportVersionId
    : fallbackReportVersion?.id || "";
  const fallbackDatasetVersion = datasetVersions.find((version) => String(version.value ?? version.id) === String(initialDatasetVersion))
    || datasetVersions.find((version) => version.isActive || version.is_active)
    || datasetVersions[0]
    || null;
  const effectiveDatasetVersion = datasetVersions.some((version) => String(version.value ?? version.id) === String(datasetVersion))
    ? datasetVersion
    : fallbackDatasetVersion ? String(fallbackDatasetVersion.value ?? fallbackDatasetVersion.id) : "";
  const reportVersionValid = !needsReportVersion || reportVersions.some((version) => version.id === effectiveReportVersionId);
  const datasetVersionValid = !needsDatasetVersion || datasetVersions.some((version) => String(version.value ?? version.id) === String(effectiveDatasetVersion));
  const valid = isValidFinancialAutofillRange(range)
    && reportVersionValid
    && datasetVersionValid
    && (!needsReportVersion || (!reportVersionsLoading && !reportVersionsError))
    && (!needsDatasetVersion || (!datasetVersionsLoading && !datasetVersionsError));
  const rangeError = getFinancialAutofillRangeError(range);
  const formError = rangeError
    || (needsReportVersion && !hasReportVersions && !reportVersionsLoading ? "No Key Reports version is available for this company." : "")
    || (needsReportVersion && !reportVersionValid ? "Select a valid reports version." : "")
    || (needsDatasetVersion && !hasDatasetVersions && !datasetVersionsLoading ? "No Manual GL version is available for this company." : "")
    || (needsDatasetVersion && !datasetVersionValid ? "Select a valid Manual GL version." : "");
  const trailingRange = getTrailingTwelveMonthRange(range);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!valid || loading) return;
    onConfirm({
      dateRange: range,
      reportVersionId: needsReportVersion ? effectiveReportVersionId : "",
      datasetVersion: needsDatasetVersion ? effectiveDatasetVersion : "",
    });
  };

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-[#111827]/70 p-4 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-[#EEF6E0] text-[#476E2C]">
              <CalendarDays size={20} />
            </span>
            <div>
              <h2 className="text-base font-bold text-[#050505]">
                {needsReportVersion || needsDatasetVersion ? "Select Financial Period and Version" : "Select Financial Period"}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-[#6D6E71]">
                Auto-fill will read from {sourceLabel || "the active financial source"} and replicate the same connected-source data used in Reports.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-[#6D6E71] transition hover:bg-bg-page hover:text-[#050505]"
            disabled={loading}
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
              Company operating since
            </span>
            <input
              type="date"
              value={range.companyStartDate || ""}
              onChange={(event) => setRange((previous) => ({ ...previous, companyStartDate: event.target.value }))}
              className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
              disabled={loading}
            />
            <span className="mt-1 block text-xs text-[#6D6E71]">
              Used for company history and all-time operating information, not to limit the financial tables.
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
              Reporting year
            </span>
            <select
              value={range.periodType || "calendar"}
              onChange={(event) => setRange((previous) => convertFinancialRangePeriodType(previous, event.target.value))}
              className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
              disabled={loading}
            >
              <option value="calendar">Calendar year (Jan 1 - Dec 31)</option>
              <option value="fiscal">Fiscal year (Apr 1 - Mar 31)</option>
            </select>
          </label>

          {needsReportVersion ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                Reports version
              </span>
              <select
                value={effectiveReportVersionId}
                onChange={(event) => setReportVersionId(event.target.value)}
                className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20 disabled:bg-[#F7F8FA] disabled:text-[#A5A5A5]"
                disabled={loading || reportVersionsLoading || !hasReportVersions}
                required
              >
                {reportVersionsLoading ? <option value="">Loading report versions...</option> : null}
                {!reportVersionsLoading && !hasReportVersions ? (
                  <option value="">No Key Reports versions available</option>
                ) : null}
                {reportVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.versionName || `Version ${version.versionNumber || ""}`.trim()}
                    {version.isActive ? " (Official)" : ""}
                    {version.status ? ` - ${version.status}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {needsDatasetVersion ? (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                Manual GL version
              </span>
              <select
                value={effectiveDatasetVersion}
                onChange={(event) => setDatasetVersion(event.target.value)}
                className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20 disabled:bg-[#F7F8FA] disabled:text-[#A5A5A5]"
                disabled={loading || datasetVersionsLoading || !hasDatasetVersions}
                required
              >
                {datasetVersionsLoading ? <option value="">Loading Manual GL versions...</option> : null}
                {!datasetVersionsLoading && !hasDatasetVersions ? (
                  <option value="">No Manual GL versions available</option>
                ) : null}
                {datasetVersions.map((version) => (
                  <option key={version.id || version.value} value={String(version.value ?? version.id)}>
                    {version.label || `Version ${version.value ?? version.versionNumber ?? ""}`.trim()}
                    {version.isActive || version.is_active ? " (Active)" : ""}
                    {version.status ? ` - ${version.status}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {needsReportVersion && reportVersionsError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {reportVersionsError}
            </p>
          ) : null}

          {needsDatasetVersion && datasetVersionsError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {datasetVersionsError}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                From
              </span>
              <input
                type="date"
                value={range.startDate || ""}
                onChange={(event) => setRange((previous) => ({ ...previous, startDate: event.target.value }))}
                className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                disabled={loading}
                required
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                To
              </span>
              <input
                type="date"
                value={range.endDate || ""}
                onChange={(event) => setRange((previous) => ({ ...previous, endDate: event.target.value }))}
                className="h-11 w-full rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                disabled={loading}
                required
              />
            </label>
          </div>

          {formError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {formError}
            </p>
          )}

          <div className="rounded-md border border-[#DDEBCB] bg-[#F8FCF3] px-3 py-2 text-sm text-[#476E2C]">
            Financial tables will use {getFinancialAutofillRangeLabel(range)} (maximum five years).
            {valid ? ` Last financial year: ${getLastFinancialYearLabel(range)}.` : ""}
            {trailingRange ? ` T12M will run from ${formatAutoFillDate(trailingRange.startDate, "short")} through ${formatAutoFillDate(trailingRange.endDate, "short")}.` : ""}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-[#FAFBFC] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="theme-btn-secondary"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-70"
            disabled={!valid || loading}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Apply Auto-Fill
          </button>
        </div>
      </form>
    </div>
  );
}

function FinancialAutofillProgressOverlay({ state }) {
  if (!state?.loading) return null;
  const progress = Math.max(1, Math.min(100, Number(state.progress || 1)));

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-[#111827]/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Auto-filling CIM financials"
    >
      <div className="w-full max-w-md rounded-lg border border-white/20 bg-white px-6 py-7 shadow-2xl sm:px-8">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#EEF6E0] text-[#476E2C]">
            <Loader2 size={24} className="animate-spin" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-[#050505]">Auto-filling financials</h2>
              <span className="tabular-nums text-sm font-bold text-[#476E2C]">{Math.round(progress)}%</span>
            </div>
            <p className="mt-1 min-h-10 text-sm leading-relaxed text-[#6D6E71]" aria-live="polite">
              {state.progressMessage || "Preparing financial reports"}
            </p>
          </div>
        </div>

        <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#E8EDEF]" aria-hidden="true">
          <div
            className="h-full rounded-full bg-[#8BC53D] transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-3 text-center text-xs font-medium text-[#8A8F98]">
          Keep this page open while the CIM is updated.
        </p>
      </div>
    </div>
  );
}

function FinancialValidationBanner({ validation }) {
  if (!validation || validation.status !== "verified") return null;
  const summary = validation.summary || {};
  const source = validation.sourceLedger || {};

  return (
    <section className="mb-4 flex items-center gap-3 rounded-lg border border-[#CFE2B8] bg-[#F8FCF3] px-4 py-3">
      <ShieldCheck size={18} className="shrink-0 text-[#476E2C]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-[#476E2C]">All financial checks passed — ready to export</p>
        <p className="mt-0.5 text-xs text-[#6D6E71]">
          {summary.verifiedChecks || 0} checks verified · {summary.calculatedMetrics || 0} metrics calculated
          {source.sourceLabel ? ` · ${source.sourceLabel}` : ""}
          {source.lastSyncedAt ? ` · synced ${new Date(source.lastSyncedAt).toLocaleString("en-IN")}` : ""}
        </p>
      </div>
    </section>
  );
}

const CIM_BUILDER_EXTRA_PREVIEW_KIND = "cim-builder-added-page";

function getCimBuilderSlideKey(slideNumber, instanceIndex = 0) {
  return `${Number(slideNumber || 1)}:${Number(instanceIndex || 0)}`;
}

function sanitizeCimBuilderElement(element = {}) {
  if (!element || typeof element !== "object" || !element.type) return null;
  const type = element.type === "rect" || element.type === "ellipse" ? "shape" : element.type;
  const sanitized = {
    id: String(element.id || `element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    type,
    subType: element.subType || (element.type === "ellipse" ? "ellipse" : "rect"),
    cimKind: element.cimKind || type,
    cimFieldId: element.cimFieldId || null,
    cimLinkedFieldIds: Array.from(new Set(element.cimLinkedFieldIds || [])).filter(Boolean).map(String),
    cimAssetKey: element.cimAssetKey || null,
    x: Number(element.x || 0),
    y: Number(element.y || 0),
    width: Math.max(Number(element.width || 1), 1),
    height: Number(element.height ?? (type === "line" ? 0 : 1)),
    rotation: Number(element.rotation || 0),
    opacity: Number(element.opacity ?? 1),
    zIndex: Number(element.zIndex || 1),
  };

  if (type === "text") {
    return {
      ...sanitized,
      text: String(element.text ?? ""),
      fontFamily: element.fontFamily || "Calibri, Aptos, Arial, sans-serif",
      fontSize: Number(element.fontSize || 12),
      fill: element.fill || "#111827",
      align: element.align || "left",
      verticalAlign: element.verticalAlign || "top",
      lineHeight: Number(element.lineHeight || 1.08),
      letterSpacing: Number(element.letterSpacing || 0),
      fontWeight: element.fontWeight || 400,
      fontStyle: element.fontStyle || "normal",
      textDecoration: element.textDecoration || "none",
      backgroundFill: element.backgroundFill || "transparent",
      stroke: element.stroke || "transparent",
      strokeWidth: Number(element.strokeWidth || 0),
      padding: Number(element.padding || 0),
    };
  }

  if (type === "image") {
    return {
      ...sanitized,
      src: normalizeBuilderImageSource(element),
      name: element.name || "Image",
      fit: element.fit || "contain",
      objectPosition: element.objectPosition || "center center",
      stroke: element.stroke || "transparent",
      strokeWidth: Number(element.strokeWidth || 0),
    };
  }

  return {
    ...sanitized,
    fill: element.fill || (type === "line" ? "transparent" : "#FFFFFF"),
    stroke: element.stroke || element.fill || "#111827",
    strokeWidth: Number(element.strokeWidth || (type === "line" ? 2 : 0)),
    cornerRadius: Number(element.cornerRadius || 0),
  };
}

function sanitizeCimBuilderPage(page = {}) {
  return {
    id: String(page.id || `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    name: page.name || "Added page",
    backgroundColor: page.backgroundColor || page.background || "#FFFFFF",
    backgroundImage: page.backgroundImage || "",
    backgroundImageOpacity: Number(page.backgroundImageOpacity ?? 1),
    deleted: Boolean(page.deleted),
    elements: (page.elements || page.children || []).map(sanitizeCimBuilderElement).filter(Boolean),
  };
}

function normalizeCimBuilderPageState(pageState = {}) {
  if (!pageState || typeof pageState !== "object") {
    return {
      hiddenElementIds: [],
      elementOverrides: {},
      addedElements: [],
      backgroundColor: "",
      backgroundImage: "",
      backgroundImageOpacity: 1,
      deleted: false,
    };
  }

  const elementOverrides = Object.fromEntries(
    Object.entries(pageState.elementOverrides || {})
      .map(([id, element]) => [id, sanitizeCimBuilderElement({ ...element, id })])
      .filter(([, element]) => Boolean(element)),
  );

  return {
    hiddenElementIds: Array.from(new Set(pageState.hiddenElementIds || [])).map(String),
    elementOverrides,
    addedElements: (pageState.addedElements || []).map(sanitizeCimBuilderElement).filter(Boolean),
    backgroundColor: pageState.backgroundColor || "",
    backgroundImage: pageState.backgroundImage || "",
    backgroundImageOpacity: Number(pageState.backgroundImageOpacity ?? 1),
    deleted: Boolean(pageState.deleted),
  };
}

function convertLegacyPolotnoElementToBuilderElement(element = {}) {
  if (!element || typeof element !== "object") return null;
  if (element.type === "figure") {
    return sanitizeCimBuilderElement({
      ...element,
      type: "shape",
      subType: element.subType === "circle" ? "ellipse" : "rect",
      fill: element.fill,
      stroke: element.stroke,
    });
  }
  if (element.type === "text") {
    return sanitizeCimBuilderElement({
      ...element,
      cimFieldId: element.custom?.cimFieldId || element.cimFieldId || null,
    });
  }
  if (element.type === "image" || element.type === "svg") {
    return sanitizeCimBuilderElement({
      ...element,
      type: "image",
      cimAssetKey: element.custom?.cimAssetKey || element.cimAssetKey || null,
    });
  }
  if (element.type === "line") return sanitizeCimBuilderElement(element);
  return null;
}

function migrateLegacyPolotnoPagesToBuilderState(input = {}) {
  if (!input || typeof input !== "object") return {};
  const extraPagesByKey = Object.fromEntries(
    Object.entries(input)
      .map(([key, pages]) => [
        key,
        (Array.isArray(pages) ? pages : []).map((page) => sanitizeCimBuilderPage({
          id: page.id,
          name: page.name || "Added page",
          backgroundColor: page.background || "#FFFFFF",
          elements: (page.children || []).map(convertLegacyPolotnoElementToBuilderElement).filter(Boolean),
        })).filter(Boolean),
      ])
      .filter(([, pages]) => pages.length > 0),
  );
  return { version: 1, pagesByKey: {}, extraPagesByKey };
}

function normalizeCimBuilderState(input = {}) {
  if (!input || typeof input !== "object") {
    return { version: 1, pagesByKey: {}, extraPagesByKey: {} };
  }

  const pagesByKey = Object.fromEntries(
    Object.entries(input.pagesByKey || {})
      .map(([key, pageState]) => [key, normalizeCimBuilderPageState(pageState)])
      .filter(([key]) => Boolean(key)),
  );
  const extraPagesByKey = Object.fromEntries(
    Object.entries(input.extraPagesByKey || {})
      .map(([key, pages]) => [
        key,
        (Array.isArray(pages) ? pages : []).map(sanitizeCimBuilderPage).filter(Boolean),
      ])
      .filter(([, pages]) => pages.length > 0),
  );

  return { version: 1, pagesByKey, extraPagesByKey };
}

function getCimBuilderTemplateBackground() {
  return "#FFFFFF";
}

function getComparableCimBuilderElement(element = {}) {
  const comparable = sanitizeCimBuilderElement(element);
  if (!comparable) return null;
  if (isCimBuilderTextLinked(comparable)) delete comparable.text;
  return comparable;
}

function isCimBuilderTextLinked(element = {}) {
  return Boolean(element.cimFieldId || (Array.isArray(element.cimLinkedFieldIds) && element.cimLinkedFieldIds.length));
}

function buildCimBuilderPage(baseElements = [], pageState = {}, fallbackBackground = "#FFFFFF") {
  const normalizedState = normalizeCimBuilderPageState(pageState);
  const hiddenIds = new Set(normalizedState.hiddenElementIds || []);
  const elements = [
    ...baseElements
      .map(sanitizeCimBuilderElement)
      .filter(Boolean)
      .filter((element) => element.cimKind !== "background" && !hiddenIds.has(element.id))
      .map((element) => {
        const override = normalizedState.elementOverrides[element.id] || null;
        if (!override) return element;
        const safeOverride = { ...override };
        if (isCimBuilderTextLinked(element)) delete safeOverride.text;
        return sanitizeCimBuilderElement({ ...element, ...safeOverride, id: element.id, type: element.type });
      }),
    ...normalizedState.addedElements,
  ].filter(Boolean);

  return sanitizeCimBuilderPage({
    id: "template-page",
    name: "Template page",
    backgroundColor: normalizedState.backgroundColor || fallbackBackground || "#FFFFFF",
    backgroundImage: normalizedState.backgroundImage || "",
    backgroundImageOpacity: normalizedState.backgroundImageOpacity,
    deleted: normalizedState.deleted,
    elements,
  });
}

function extractCimBuilderPageState(baseElements = [], page = {}) {
  const baseMap = new Map(
    baseElements
      .map(sanitizeCimBuilderElement)
      .filter(Boolean)
      .filter((element) => element.cimKind !== "background")
      .map((element) => [element.id, element]),
  );
  const nextElements = (page.elements || []).map(sanitizeCimBuilderElement).filter(Boolean);
  const nextById = new Map(nextElements.map((element) => [element.id, element]));
  const hiddenElementIds = Array.from(baseMap.keys()).filter((id) => !nextById.has(id));
  const elementOverrides = {};
  const addedElements = [];

  nextElements.forEach((element) => {
    const base = baseMap.get(element.id);
    if (!base) {
      addedElements.push(element);
      return;
    }

    const comparableBase = getComparableCimBuilderElement(base);
    const comparableNext = getComparableCimBuilderElement(element);
    if (JSON.stringify(comparableBase) !== JSON.stringify(comparableNext)) {
      const override = sanitizeCimBuilderElement(element);
      if (isCimBuilderTextLinked(override)) delete override.text;
      elementOverrides[element.id] = override;
    }
  });

  return normalizeCimBuilderPageState({
    hiddenElementIds,
    elementOverrides,
    addedElements,
    backgroundColor: page.backgroundColor || "",
    backgroundImage: page.backgroundImage || "",
    backgroundImageOpacity: Number(page.backgroundImageOpacity ?? 1),
    deleted: Boolean(page.deleted),
  });
}

function buildPreviewSlidesWithBuilderPages(fieldValues = {}, builderState = {}) {
  const normalizedState = normalizeCimBuilderState(builderState);
  return buildCimExportSlides(fieldValues).flatMap((slideRef) => {
    const key = getCimBuilderSlideKey(slideRef.sourceSlideNumber, slideRef.instanceIndex);
    const pageState = normalizedState.pagesByKey[key] || {};
    const extraPages = normalizedState.extraPagesByKey[key] || [];
    return [
      ...(pageState.deleted ? [] : [slideRef]),
      ...extraPages.map((page, index) => ({
        kind: CIM_BUILDER_EXTRA_PREVIEW_KIND,
        sourceSlideNumber: slideRef.sourceSlideNumber,
        instanceIndex: slideRef.instanceIndex || 0,
        builderPageIndex: index,
        page,
      })),
    ];
  });
}

function isCimBuilderExtraPreviewSlide(slideRef) {
  return slideRef?.kind === CIM_BUILDER_EXTRA_PREVIEW_KIND;
}

function getCimBuilderFirstFontFamily(fontFamily = "Calibri") {
  return String(fontFamily || "Calibri").split(",")[0].replace(/["']/g, "").trim() || "Calibri";
}

function buildCimBuilderExportTextElement(element, index) {
  const text = String(element.text || "");
  const typeface = getCimBuilderFirstFontFamily(element.fontFamily);
  const color = element.fill || "#111827";
  const padding = Number(element.padding || 0);
  return {
    id: element.id,
    name: element.name || `Builder Text ${index + 1}`,
    kind: "shape",
    builderKind: "text",
    order: index + 1,
    bbox: [element.x, element.y, element.width, element.height],
    rotation: element.rotation || 0,
    text,
    fillColor: element.backgroundFill === "transparent" ? null : element.backgroundFill,
    lineColor: element.stroke === "transparent" ? null : element.stroke,
    lineWidth: element.strokeWidth || 0,
    resolvedFontSize: element.fontSize || 12,
    resolvedTextStyle: {
      typeface,
      alignment: element.align || "left",
      verticalAlignment: element.verticalAlign || "top",
      lineSpacing: element.lineHeight || 1.08,
      insets: { top: padding, right: padding, bottom: padding, left: padding },
      wrap: true,
    },
    paragraphs: [{
      resolvedTextStyle: { alignment: element.align || "left", lineSpacing: element.lineHeight || 1.08 },
      runs: [{
        text,
        fontSize: element.fontSize || 12,
        typeface,
        bold: Number(element.fontWeight || 400) >= 600,
        italic: element.fontStyle === "italic",
        underline: element.textDecoration === "underline",
        color,
        letterSpacing: element.letterSpacing || 0,
      }],
    }],
  };
}

function buildCimBuilderExportLayoutElement(element, index) {
  if (element.type === "text") return buildCimBuilderExportTextElement(element, index);
  if (element.type === "image") {
    return {
      id: element.id,
      name: element.name || `Builder Image ${index + 1}`,
      kind: "shape",
      builderKind: "image",
      order: index + 1,
      bbox: [element.x, element.y, element.width, element.height],
      rotation: element.rotation || 0,
      dataUrl: normalizeBuilderImageSource(element),
      opacity: element.opacity,
      imageFit: element.fit || "contain",
      imageBorderColor: element.stroke,
      imageBorderWidth: element.strokeWidth || 0,
    };
  }
  return {
    id: element.id,
    name: `Builder Shape ${index + 1}`,
    kind: "shape",
    builderKind: element.type,
    order: index + 1,
    bbox: [element.x, element.y, element.width, element.height],
    rotation: element.rotation || 0,
    text: "",
    fillColor: element.type === "line" ? element.stroke : element.fill,
    lineColor: element.stroke,
    lineWidth: element.strokeWidth || 0,
    geometry: element.subType === "ellipse" ? "ellipse" : "rect",
    opacity: element.opacity,
  };
}

function buildCimBuilderExportLayout(page = {}) {
  const safePage = sanitizeCimBuilderPage(page);
  return {
    slide: {
      backgroundColor: safePage.backgroundColor || "#FFFFFF",
      backgroundImage: safePage.backgroundImage ? { dataUrl: safePage.backgroundImage } : null,
      backgroundImageOpacity: safePage.backgroundImageOpacity,
    },
    elements: safePage.elements.map(buildCimBuilderExportLayoutElement),
  };
}

function getCimBuilderExportElementContent(_slideRef, element = {}) {
  if (element.builderKind === "image") return { kind: "image", dataUrl: element.dataUrl, name: element.name };
  return { kind: "text", text: element.text || "" };
}

function resolveCimBuilderPreviewPage(slideRef, {
  layouts,
  fieldsBySlide,
  fieldValues,
  assetValues,
  chartValues,
  globalDetails,
  styleProfile,
  builderState,
}) {
  if (isCimBuilderExtraPreviewSlide(slideRef)) return sanitizeCimBuilderPage(slideRef.page);

  const slideNumber = slideRef?.sourceSlideNumber || slideRef;
  const scopedFieldValues = getFieldValuesForExportSlide(fieldValues, slideRef);
  const baseElements = buildCimBuilderElementSpecs(
    slideNumber,
    layouts[slideNumber],
    fieldsBySlide[slideNumber] || [],
    scopedFieldValues,
    assetValues,
    chartValues,
    globalDetails,
    styleProfile,
  );
  const key = getCimBuilderSlideKey(slideNumber, slideRef?.instanceIndex || 0);
  return buildCimBuilderPage(
    baseElements,
    normalizeCimBuilderState(builderState).pagesByKey[key],
    getCimBuilderTemplateBackground(layouts[slideNumber]),
  );
}

function PreviewModal({
  open,
  previewSlideIndex,
  onClose,
  onSlideIndexChange,
  builderState,
  layouts,
  fieldsBySlide,
  fieldValues,
  assetValues,
  chartValues,
  globalDetails,
  styleProfile,
}) {
  if (!open) return null;

  const previewSlides = buildPreviewSlidesWithBuilderPages(fieldValues, builderState);
  const activeSlideRef = previewSlides[previewSlideIndex] || previewSlides[0];
  const activePage = activeSlideRef ? resolveCimBuilderPreviewPage(activeSlideRef, {
    layouts,
    fieldsBySlide,
    fieldValues,
    assetValues,
    chartValues,
    globalDetails,
    styleProfile,
    builderState,
  }) : null;
  const prevDisabled = previewSlideIndex <= 0;
  const nextDisabled = previewSlideIndex >= previewSlides.length - 1;

  return (
    <div className="fixed inset-0 z-[99999] bg-[#111827]/70 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-7xl flex-col overflow-hidden rounded-lg bg-[#F7F8FA] shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <FileText size={17} className="text-[#476E2C]" />
            <div>
              <h2 className="text-sm font-bold text-[#050505]">PPT Preview</h2>
              <p className="text-xs text-[#6D6E71]">
                Slide {previewSlideIndex + 1} of {previewSlides.length}
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
              {previewSlides.map((slideRef, index) => {
                const slideNumber = slideRef.sourceSlideNumber;
                const isAddedPage = isCimBuilderExtraPreviewSlide(slideRef);
                const previewPage = resolveCimBuilderPreviewPage(slideRef, {
                  layouts,
                  fieldsBySlide,
                  fieldValues,
                  assetValues,
                  chartValues,
                  globalDetails,
                  styleProfile,
                  builderState,
                });
                return (
                  <button
                    key={isAddedPage
                      ? `${slideNumber}-${slideRef.instanceIndex}-builder-${slideRef.builderPageIndex}`
                      : `${slideNumber}-${slideRef.instanceIndex}`}
                    onClick={() => onSlideIndexChange(index)}
                    className={`block w-full overflow-hidden rounded-md border text-left transition ${index === previewSlideIndex
                      ? "border-[#8BC53D] ring-2 ring-[#8BC53D]/25"
                      : "border-border hover:border-[#8BC53D]/60"
                      }`}
                  >
                    <div className="pointer-events-none">
                      <CimBuilderPagePreview page={previewPage} />
                    </div>
                    {isAddedPage ? (
                      <div className="border-t border-border bg-[#F8FCF3] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.06em] text-[#476E2C]">
                        Added page
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
              {activePage ? <CimBuilderPagePreview page={activePage} /> : null}
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
                  onSlideIndexChange(Math.min(previewSlides.length - 1, previewSlideIndex + 1))
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
  fieldsBySlide,
  globalDetails,
  questionnaireState,
  onSendQuestionnaire,
  onUseClientNote,
  onUseClientAsset,
  onCopyNote,
}) {
  const [builderSectionId, setBuilderSectionId] = useState(BASIC_DETAILS_SECTION.id);
  const [draftItems, setDraftItems] = useState(() => normalizeQuestionnaireState(questionnaireState).items);
  const [customQuestion, setCustomQuestion] = useState("");
  const activeSection =
    sections.find((section) => section.id === builderSectionId) || BASIC_DETAILS_SECTION;
  const sectionFields = getQuestionnaireTemplateFields(activeSection, fieldsBySlide, globalDetails);
  const activeDraftState = normalizeQuestionnaireState({
    ...questionnaireState,
    items: draftItems,
  });
  const items = getQuestionnaireItems(activeDraftState);
  const sectionItems = items.filter((item) => item.sectionId === activeSection.id);
  const counts = getQuestionnaireCounts(activeDraftState);
  const selectedForSection = sectionItems.length;
  const history = activeDraftState.history || [];

  const isFieldSelected = (field) => {
    return Boolean(draftItems[field.id] && !draftItems[field.id].archived);
  };

  const toggleFieldQuestion = (field) => {
    setDraftItems((previous) => {
      const current = previous[field.id];
      if (current && !current.archived) {
        return {
          ...previous,
          [field.id]: {
            ...current,
            archived: true,
            status: "resolved",
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return {
        ...previous,
        [field.id]: buildQuestionnaireItem(field, current),
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
      const hasAnswer = normalizeText(current.clientNote) || current.clientAsset?.dataUrl;
      const nextStatus = status === "open" && hasAnswer ? "answered" : status;
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
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left transition ${active
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
            {history.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <p className="mb-2 px-1 text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">
                  History
                </p>
                <div className="space-y-2">
                  {history.slice(0, 5).map((entry) => (
                    <div key={entry.id || entry.sentAt} className="rounded-md border border-border bg-[#FAFBFC] p-2">
                      <p className="text-xs font-bold text-[#050505]">
                        {entry.itemCount || entry.items?.length || 0} questions
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#6D6E71]">
                        {entry.sentAt ? new Date(entry.sentAt).toLocaleString("en-IN") : "Draft send"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <section className="min-h-0 overflow-y-auto rounded-lg border border-border bg-white p-4 shadow-card">
            <div className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#8BC53D]">
                  {activeSection.number === "BD" ? "Basic Details" : `Section ${activeSection.number}`}
                </p>
                <h3 className="mt-1 text-lg font-bold text-[#050505]">{activeSection.title}</h3>
                <p className="mt-1 text-sm text-[#6D6E71]">
                  Select the datafields to request from the client for this section.
                </p>
              </div>
              <span className="rounded-md bg-[#EEF6E0] px-3 py-2 text-xs font-bold text-[#476E2C]">
                {selectedForSection} selected
              </span>
            </div>

            <div className="mt-4 space-y-2">
              {sectionFields.map((field) => {
                const selected = isFieldSelected(field);
                const item = draftItems[field.id];

                return (
                  <div
                    key={field.id}
                    className={`rounded-lg border p-3 transition ${selected ? "border-[#8BC53D] bg-[#F7FBF1]" : "border-border bg-white"
                      }`}
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleFieldQuestion(field)}
                        className="mt-1 h-4 w-4 accent-[#8BC53D]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold leading-snug text-[#050505]">
                          {field.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-[#6D6E71]">
                          Slide {field.slideNumber} · {getFieldKind(field) === "asset" ? "Image upload" : getFieldKind(field) === "chart" ? "Chart data" : "Text"}
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
                  const clientAsset = item.clientAsset?.dataUrl ? item.clientAsset : null;
                  const canUseAsset = clientAsset && item.fieldKind === "asset";

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
                          {canUseAsset && (
                            <button
                              type="button"
                              onClick={() => onUseClientAsset(item)}
                              className="theme-btn-secondary h-9 px-3 text-xs"
                            >
                              <ImagePlus size={14} />
                              Use Image
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
                        {clientAsset && (
                          <div className="mb-3 overflow-hidden rounded-md border border-border bg-[#F7F8FA] p-2">
                            <img
                              src={clientAsset.dataUrl}
                              alt={clientAsset.name || item.label}
                              className="max-h-40 w-full object-contain"
                            />
                            <p className="mt-2 truncate text-xs text-[#6D6E71]">{clientAsset.name || "Uploaded image"}</p>
                          </div>
                        )}
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
                          <p className="text-sm text-[#A5A5A5]">
                            {clientAsset ? "No text note included." : "No client response yet."}
                          </p>
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

function CimReviewModal({ onClose, reviewState, onAddNote, onResolve, onReopen }) {
  const [filter, setFilter] = useState("open");
  const items = Object.values(reviewState?.items || {})
    .filter((item) => (filter === "all" ? true : filter === "resolved" ? item.status === "resolved" : item.status !== "resolved"))
    .sort((a, b) => Number(a.slideNumber || 0) - Number(b.slideNumber || 0) || String(a.label || "").localeCompare(String(b.label || "")));
  const counts = getCimReviewCounts(reviewState);

  return (
    <div className="fixed inset-0 z-[99999] bg-[#111827]/70 p-4 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-lg bg-[#F7F8FA] shadow-2xl">
        <div className="flex items-center justify-between border-b border-border bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <Flag size={17} className="text-[#476E2C]" />
            <div>
              <h2 className="text-sm font-bold text-[#050505]">CIM Review Notes</h2>
              <p className="text-xs text-[#6D6E71]">
                {counts.open} open · {counts.resolved} resolved
                {reviewState?.sharedAt ? ` · Shared ${new Date(reviewState.sharedAt).toLocaleString("en-IN")}` : ""}
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

        <div className="flex gap-2 border-b border-border bg-white px-4 py-2.5">
          {[["open", "Open"], ["resolved", "Resolved"], ["all", "All"]].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`rounded-md border px-3 py-1.5 text-xs font-bold transition ${filter === value
                ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
                }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed border-border bg-white text-center text-sm text-[#6D6E71]">
              {reviewState?.sharedAt ? "No notes here yet." : "Share this CIM with the client team to start collecting review notes."}
            </div>
          ) : (
            items.map((item) => (
              <div key={item.id} className="rounded-lg border border-border bg-white p-3.5 shadow-card">
                <p className="text-xs font-semibold text-[#6D6E71]">
                  Slide {item.slideNumber} · {item.sectionTitle}
                </p>
                <h3 className="mt-1 text-sm font-bold text-[#050505]">{item.label}</h3>
                <div className="mt-2.5">
                  <CimFieldNoteThread
                    notes={item.notes || []}
                    status={item.status}
                    resolvedBy={item.resolvedBy}
                    resolvedAt={item.resolvedAt}
                    canResolve
                    canReopen
                    onAddNote={(body) => onAddNote(item.id, body)}
                    onResolve={(body) => onResolve(item.id, body)}
                    onReopen={() => onReopen(item.id)}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceCimPrep() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeSource } = useDataSource();
  const { showToast } = useToast();
  const selectedDatasetVersion = useDatasetVersionStore((state) => state.selectedVersion);
  const manualGlDatasetVersions = useDatasetVersionStore((state) => state.versions);
  const activeManualGlDatasetVersion = useDatasetVersionStore((state) => state.activeVersion);
  const manualGlDatasetVersionsLoading = useDatasetVersionStore((state) => state.isLoading);
  const manualGlDatasetVersionsError = useDatasetVersionStore((state) => state.error);
  const fetchManualGlDatasetVersions = useDatasetVersionStore((state) => state.fetchVersions);
  const setSelectedDatasetVersion = useDatasetVersionStore((state) => state.setSelectedVersion);
  const reportVersions = useKeyReportContextStore((state) => state.versions);
  const selectedReportVersionId = useKeyReportContextStore((state) => state.selectedVersionId);
  const reportVersionsLoading = useKeyReportContextStore((state) => state.loading);
  const reportVersionsError = useKeyReportContextStore((state) => state.error);
  const fetchReportVersions = useKeyReportContextStore((state) => state.fetchVersions);
  const selectReportVersion = useKeyReportContextStore((state) => state.selectVersion);
  const [company, setCompany] = useState(null);
  const [layouts, setLayouts] = useState({});
  const [globalDetails, setGlobalDetails] = useState(() => createDefaultGlobalDetails());
  const [fieldValues, setFieldValues] = useState({});
  const [assetValues, setAssetValues] = useState({});
  const [chartValues, setChartValues] = useState({});
  const [cimBuilderState, setCimBuilderState] = useState(() => normalizeCimBuilderState());
  const [questionnaireState, setQuestionnaireState] = useState(() => normalizeQuestionnaireState());
  const [reviewState, setReviewState] = useState(() => normalizeCimReviewState());
  const [styleProfilesState, setStyleProfilesState] = useState(() => normalizeCimStyleProfilesState());
  const [activeStyleProfileId, setActiveStyleProfileId] = useState(DEFAULT_CIM_STYLE_PROFILE_ID);
  const [companyUsers, setCompanyUsers] = useState([]);
  const [financialAutofillState, setFinancialAutofillState] = useState({
    loading: false,
    filledCount: 0,
    error: "",
    validation: null,
    progress: 0,
    progressMessage: "",
  });
  const [activeSectionId, setActiveSectionId] = useState(BASIC_DETAILS_SECTION.id);
  const [activeSlide, setActiveSlide] = useState(BASIC_DETAILS_SECTION.slides[0]);
  const [activeSlideInstance, setActiveSlideInstance] = useState(0);
  const [activeFieldId, setActiveFieldId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSlideIndex, setPreviewSlideIndex] = useState(0);
  const [questionnaireOpen, setQuestionnaireOpen] = useState(false);
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  const [styleProfilesSaving, setStyleProfilesSaving] = useState(false);
  const [activeBuilderPageIndex, setActiveBuilderPageIndex] = useState(0);
  const [financialAutofillModalOpen, setFinancialAutofillModalOpen] = useState(false);
  const [financialAutofillRange, setFinancialAutofillRange] = useState(() => getDefaultFinancialAutofillRange());
  const [financialAutofillReportVersionId, setFinancialAutofillReportVersionId] = useState("");
  const [financialAutofillDatasetVersion, setFinancialAutofillDatasetVersion] = useState("");
  const reportSource = useMemo(
    () => normalizeReportSourceKey(activeSource) || REPORT_SOURCE_KEYS.QUICKBOOKS,
    [activeSource],
  );
  const reportSourceLabel = useMemo(() => getReportSourceLabel(reportSource), [reportSource]);
  const isKeyReportsSource = reportSource === REPORT_SOURCE_KEYS.KEY_REPORTS;
  const isManualGlSource = reportSource === REPORT_SOURCE_KEYS.MANUAL_GL;
  const manualGlAutofillDatasetVersion = String(
    financialAutofillDatasetVersion ||
    selectedDatasetVersion ||
    activeManualGlDatasetVersion?.value ||
    activeManualGlDatasetVersion?.dataset_version ||
    "",
  );
  const financialAutofillVersionMode = isKeyReportsSource
    ? "key_reports"
    : isManualGlSource && (manualGlDatasetVersionsLoading || manualGlDatasetVersions.length > 1)
      ? "manual_gl"
      : "none";
  const financialAutofillReportVersions = isKeyReportsSource ? reportVersions : [];

  const fieldsBySlide = useMemo(() => {
    const result = {};
    for (let slideNumber = 1; slideNumber <= TEMPLATE_SLIDE_COUNT; slideNumber += 1) {
      result[slideNumber] = extractTemplateFields(slideNumber, layouts[slideNumber]);
    }
    return result;
  }, [layouts]);
  const activeStyleProfile = useMemo(() => (
    styleProfilesState.profiles.find((profile) => profile.id === activeStyleProfileId) ||
    getActiveCimStyleProfile(styleProfilesState)
  ), [activeStyleProfileId, styleProfilesState]);
  const styledLayouts = useMemo(
    () => applyCimTemplateStyleProfilesToLayouts(layouts, activeStyleProfile),
    [activeStyleProfile, layouts],
  );
  const templateFieldCount = useMemo(
    () => Object.values(fieldsBySlide).reduce((sum, fields) => sum + fields.length, 0),
    [fieldsBySlide],
  );

  const activeSection = useMemo(
    () => NAV_SECTIONS.find((section) => section.id === activeSectionId) || BASIC_DETAILS_SECTION,
    [activeSectionId],
  );
  const activeSectionSlideRefs = useMemo(
    () => getEditorSlideRefs(activeSection.slides, fieldValues),
    [activeSection.slides, fieldValues],
  );
  const activeSlideRef = useMemo(() => ({
    sourceSlideNumber: activeSlide,
    instanceIndex: activeSlideInstance,
  }), [activeSlide, activeSlideInstance]);
  const activeCanvasFieldValues = useMemo(
    () => getFieldValuesForEditorSlide(fieldValues, activeSlideRef),
    [activeSlideRef, fieldValues],
  );
  const advisorDefaults = useMemo(() => getBrokerAdvisorDefaults(user), [user]);
  const effectiveGlobalDetails = useMemo(() => ({
    ...globalDetails,
    companyLegalName: globalDetails.companyName,
    advisorFirm: globalDetails.advisorFirm || advisorDefaults.advisorFirm,
    advisorAddress: globalDetails.advisorAddress || advisorDefaults.advisorAddress,
    advisorCityPhone: globalDetails.advisorCityPhone || advisorDefaults.advisorCityPhone,
    leadAdvisor: globalDetails.leadAdvisor || advisorDefaults.leadAdvisor,
    leadAdvisorTitle: globalDetails.leadAdvisorTitle || advisorDefaults.leadAdvisorTitle,
    leadAdvisorEmail: globalDetails.leadAdvisorEmail || advisorDefaults.leadAdvisorEmail,
    leadAdvisorPhone: globalDetails.leadAdvisorPhone || advisorDefaults.leadAdvisorPhone,
  }), [advisorDefaults, globalDetails]);

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
          companyLegalName: previous.companyName || payload?.name || "",
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
    if (clientId && isKeyReportsSource) void fetchReportVersions(clientId);
  }, [clientId, fetchReportVersions, isKeyReportsSource]);

  useEffect(() => {
    if (clientId && isManualGlSource) void fetchManualGlDatasetVersions(clientId);
  }, [clientId, fetchManualGlDatasetVersions, isManualGlSource]);

  useEffect(() => {
    if (!isKeyReportsSource) {
      window.queueMicrotask(() => setFinancialAutofillReportVersionId(""));
      return;
    }
    if (loading || reportVersionsLoading || !reportVersions.length) return;
    window.queueMicrotask(() => setFinancialAutofillReportVersionId((previous) => {
      if (previous && reportVersions.some((version) => version.id === previous)) return previous;
      return selectedReportVersionId || reportVersions.find((version) => version.isActive)?.id || reportVersions[0].id;
    }));
  }, [isKeyReportsSource, loading, reportVersions, reportVersionsLoading, selectedReportVersionId]);

  useEffect(() => {
    if (!isManualGlSource) {
      window.queueMicrotask(() => setFinancialAutofillDatasetVersion(""));
      return;
    }
    window.queueMicrotask(() => setFinancialAutofillDatasetVersion((previous) => (
      selectedDatasetVersion || previous || activeManualGlDatasetVersion?.value || activeManualGlDatasetVersion?.dataset_version || ""
    )));
  }, [activeManualGlDatasetVersion, isManualGlSource, selectedDatasetVersion]);

  useEffect(() => {
    if (loading || !isValidFinancialAutofillRange(financialAutofillRange)) return;

    const slide24HeadingFields = (fieldsBySlide[24] || []).filter((field) => {
      const tokenIndex = getFieldTokenIndex(field);
      return field.order === 7 && tokenIndex >= 0 && tokenIndex <= 5;
    });
    const slide26HeadingFields = (fieldsBySlide[26] || []).filter((field) => {
      const tokenIndex = getFieldTokenIndex(field);
      return field.order === 7 && tokenIndex >= 0 && tokenIndex <= 5;
    });
    const headingFields = [...slide24HeadingFields, ...slide26HeadingFields];
    if (!headingFields.length) return;

    const headingValues = {
      ...getSlide24PeriodHeadingValues(slide24HeadingFields, financialAutofillRange),
      ...getSlide26PeriodHeadingValues(slide26HeadingFields, financialAutofillRange),
    };
    setFieldValues((previous) => {
      const next = {
        ...withoutFieldValues(previous, headingFields),
        ...headingValues,
      };
      const changed = headingFields.some((field) => {
        const fieldId = field.valueFieldId || field.id;
        return normalizeText(previous[fieldId]) !== normalizeText(next[fieldId]);
      });
      return changed ? next : previous;
    });
  }, [fieldsBySlide, financialAutofillRange, loading]);

  useEffect(() => {
    if (loading || !isValidFinancialAutofillRange(financialAutofillRange)) return;
    if (!(fieldsBySlide[27] || []).length) return;

    setFieldValues((previous) => {
      const existing = normalizeSlide27Cashflow(previous[SLIDE_27_CASHFLOW_FIELD_ID]);
      const placeholder = buildSlide27PlaceholderCashflow(financialAutofillRange);
      if (existing.rows.length && !existing.placeholder) {
        const hasLtmColumn = existing.columns.some((column) => (
          column.key === "ltm" || /^ltm\b/i.test(column.label)
        ));
        if (hasLtmColumn) return previous;

        const ltmColumn = placeholder.columns.at(-1);
        const nextValue = stringifySlide27Cashflow({
          ...existing,
          columns: [...existing.columns, ltmColumn],
          rows: existing.rows.map((row) => ({
            ...row,
            values: { ...row.values, [ltmColumn.key]: "-" },
          })),
          placeholder: false,
        });
        return { ...previous, [SLIDE_27_CASHFLOW_FIELD_ID]: nextValue };
      }

      const nextValue = mergeSlide27ManualRows(
        existing,
        placeholder,
      );
      if (previous[SLIDE_27_CASHFLOW_FIELD_ID] === nextValue) return previous;
      return { ...previous, [SLIDE_27_CASHFLOW_FIELD_ID]: nextValue };
    });
  }, [fieldsBySlide, financialAutofillRange, loading]);

  useEffect(() => {
    let cancelled = false;

    async function loadLayouts() {
      try {
        const entries = await Promise.all(
          Array.from({ length: TEMPLATE_SLIDE_COUNT }, async (_, index) => {
            const slideNumber = index + 1;
            const response = await fetch(getSlideLayoutPath(slideNumber), { cache: "no-store" });
            if (!response.ok) return [slideNumber, null];
            return [slideNumber, prepareCimLayout(slideNumber, await response.json())];
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

    function applyLoadedCimPrepState(data) {
      setGlobalDetails((previous) => ({ ...previous, ...(data.globalDetails || {}) }));
      setFieldValues(data.fieldValues || {});
      setAssetValues(data.assetValues || {});
      setChartValues(data.chartValues || {});
      setCimBuilderState(normalizeCimBuilderState(
        data.cimBuilderState || migrateLegacyPolotnoPagesToBuilderState(data.polotnoPagesBySlideKey),
      ));
      setFinancialAutofillState((previous) => ({
        ...previous,
        validation: data.financialValidation || null,
      }));
      if (isValidFinancialAutofillRange(data.financialAutofillRange)) {
        setFinancialAutofillRange(data.financialAutofillRange);
      }
      if (data.financialAutofillReportVersionId) {
        setFinancialAutofillReportVersionId(String(data.financialAutofillReportVersionId));
      }
      if (data.financialAutofillDatasetVersion) {
        setFinancialAutofillDatasetVersion(String(data.financialAutofillDatasetVersion));
      }
    }

    function readLocalCimPrepDraft(localKey) {
      try {
        const local = window.localStorage.getItem(localKey);
        return local ? JSON.parse(local) : null;
      } catch {
        return null;
      }
    }

    async function loadSavedState() {
      setLoading(true);
      const localKey = getLocalStorageKey(clientId);

      try {
        const payload = await getWorkspacePageStateRequest(PAGE_KEY, { clientId });
        if (cancelled) return;
        const state = payload?.state || null;
        const backendUpdatedAt = payload?.updatedAt || state?.updatedAt || "";
        const localDraft = readLocalCimPrepDraft(localKey);
        // A prior save that failed leaves its only copy of the user's edits marked
        // "unsynced" in localStorage. If that draft is newer than whatever the backend
        // just returned, it represents work the server has never seen — trusting the
        // backend response here would silently erase it, which is exactly the "saved,
        // then a refresh wiped everything" failure mode this is fixing.
        const draftHasUnsyncedNewerWork = localDraft?.unsynced &&
          (!backendUpdatedAt || new Date(localDraft.updatedAt || 0) > new Date(backendUpdatedAt));

        if (draftHasUnsyncedNewerWork) {
          applyLoadedCimPrepState(localDraft);
          setUpdatedAt(backendUpdatedAt || "");
          showToast({
            type: "error",
            title: "Unsaved changes recovered",
            message: "Your last save didn't reach the server. We've restored those changes from this browser — click Save to sync them now.",
            duration: 10000,
          });
        } else if (state) {
          applyLoadedCimPrepState(state);
          setUpdatedAt(backendUpdatedAt);
          window.localStorage.setItem(localKey, JSON.stringify({ ...state, updatedAt: backendUpdatedAt, unsynced: false }));
        } else if (localDraft) {
          applyLoadedCimPrepState(localDraft);
          setUpdatedAt(localDraft.updatedAt || "");
        }
      } catch {
        if (!cancelled) {
          const localDraft = readLocalCimPrepDraft(localKey);
          if (localDraft) {
            applyLoadedCimPrepState(localDraft);
            setUpdatedAt(localDraft.updatedAt || "");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSavedState();
    return () => {
      cancelled = true;
    };
  }, [clientId, showToast]);

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

  useEffect(() => {
    let cancelled = false;

    async function loadReviewState() {
      try {
        const payload = await getCimReviewRequest({ clientId });
        if (cancelled) return;
        setReviewState(normalizeCimReviewState(payload?.state || {}));
      } catch {
        // Review state is optional until the CIM has been shared; ignore load failures.
      }
    }

    async function loadCompanyUsers() {
      try {
        const users = await listUsersRequest();
        if (cancelled) return;
        setCompanyUsers(Array.isArray(users) ? users : []);
      } catch {
        // Team-member list is only needed to populate the share picker.
      }
    }

    loadReviewState();
    loadCompanyUsers();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;

    // Style profiles are a per-broker preference (not scoped to this company), so this
    // only needs to load once on mount.
    async function loadStyleProfiles() {
      try {
        const payload = await getCimStyleProfilesRequest();
        if (cancelled) return;
        const state = normalizeCimStyleProfilesState(payload?.state || {});
        setStyleProfilesState(state);
        setActiveStyleProfileId(state.activeProfileId || DEFAULT_CIM_STYLE_PROFILE_ID);
      } catch {
        // Keep the default template style if saved profiles can't be loaded.
      }
    }

    loadStyleProfiles();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveStyleProfiles = useCallback(async (nextState) => {
    setStyleProfilesSaving(true);
    try {
      const payload = await saveCimStyleProfilesRequest(nextState);
      const savedState = normalizeCimStyleProfilesState(payload?.state || nextState);
      setStyleProfilesState(savedState);
      setActiveStyleProfileId(savedState.activeProfileId || DEFAULT_CIM_STYLE_PROFILE_ID);
      showToast({
        type: "success",
        title: "Template Style Saved",
        message: "Your CIM template style was saved.",
      });
    } finally {
      setStyleProfilesSaving(false);
    }
  }, [showToast]);

  const persistCimReviewState = useCallback(async (nextState, toastOptions = null) => {
    const state = normalizeCimReviewState(nextState);
    try {
      const payload = await saveCimReviewRequest(state, { clientId });
      setReviewState(normalizeCimReviewState(payload?.state || state));
      if (toastOptions?.success) {
        showToast({ type: "success", title: toastOptions.success, message: toastOptions.message || "" });
      }
    } catch (error) {
      showToast({
        type: "error",
        title: toastOptions?.errorTitle || "Failed to update CIM review",
        message: error?.message || "Please try again.",
      });
    }
  }, [clientId, showToast]);

  const clientTeamMembers = useMemo(() => {
    return companyUsers.filter((candidate) => {
      const inCompany =
        String(candidate.company_id) === String(clientId) ||
        (candidate.assigned_companies || []).some((company) => String(company.id) === String(clientId));
      if (!inCompany) return false;
      return CLIENT_SUB_ROLES.includes(candidate.sub_role);
    });
  }, [companyUsers, clientId]);

  const reviewCounts = useMemo(() => getCimReviewCounts(reviewState), [reviewState]);

  const handleShareCimForReview = useCallback((selectedMemberIds) => {
    const selectedMembers = clientTeamMembers
      .filter((member) => selectedMemberIds.includes(member.id))
      .map((member) => ({ id: member.id, name: member.name, email: member.email, sharedAt: new Date().toISOString() }));
    const now = new Date().toISOString();
    const historyEntry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: reviewState.sharedAt ? "reshared" : "shared",
      at: now,
      by: getQuestionnaireUserSummary(user),
      fieldId: null,
      summary: `Shared CIM for review with ${selectedMembers.length} team member${selectedMembers.length === 1 ? "" : "s"}`,
    };
    const nextState = normalizeCimReviewState({
      ...reviewState,
      ownerUserId: user?.id || reviewState.ownerUserId,
      sharedAt: now,
      sharedBy: getQuestionnaireUserSummary(user),
      sharedWith: selectedMembers,
      history: [historyEntry, ...(reviewState.history || [])].slice(0, 25),
    });
    setReviewState(nextState);
    setReviewPickerOpen(false);
    void persistCimReviewState(nextState, {
      success: "CIM shared for review",
      message: `${selectedMembers.length} team member${selectedMembers.length === 1 ? "" : "s"} can now review this CIM.`,
    });
  }, [clientTeamMembers, persistCimReviewState, reviewState, user]);

  const handleResolveCimReviewItem = useCallback((fieldId, resolutionBody = "") => {
    const item = reviewState.items[fieldId];
    if (!item) return;
    const now = new Date().toISOString();
    const resolver = getQuestionnaireUserSummary(user);
    const notes = resolutionBody.trim()
      ? [...item.notes, { id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, author: resolver, body: resolutionBody.trim(), createdAt: now, kind: "resolution" }]
      : item.notes;
    const nextItem = { ...item, status: "resolved", resolvedBy: resolver, resolvedAt: now, notes, updatedAt: now };
    const historyEntry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "resolved",
      at: now,
      by: resolver,
      fieldId,
      summary: `${resolver.name} resolved ${item.label || fieldId}`,
    };
    const nextState = normalizeCimReviewState({
      ...reviewState,
      items: { ...reviewState.items, [fieldId]: nextItem },
      history: [historyEntry, ...(reviewState.history || [])].slice(0, 25),
    });
    setReviewState(nextState);
    void persistCimReviewState(nextState);
  }, [persistCimReviewState, reviewState, user]);

  const handleReopenCimReviewItem = useCallback((fieldId) => {
    const item = reviewState.items[fieldId];
    if (!item) return;
    const now = new Date().toISOString();
    const actor = getQuestionnaireUserSummary(user);
    const nextItem = { ...item, status: "open", resolvedBy: null, resolvedAt: null, updatedAt: now };
    const historyEntry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "reopened",
      at: now,
      by: actor,
      fieldId,
      summary: `${actor.name} reopened ${item.label || fieldId}`,
    };
    const nextState = normalizeCimReviewState({
      ...reviewState,
      items: { ...reviewState.items, [fieldId]: nextItem },
      history: [historyEntry, ...(reviewState.history || [])].slice(0, 25),
    });
    setReviewState(nextState);
    void persistCimReviewState(nextState);
  }, [persistCimReviewState, reviewState, user]);

  const handleAddCimReviewNote = useCallback((fieldId, body) => {
    const item = reviewState.items[fieldId];
    if (!item || !body.trim()) return;
    const now = new Date().toISOString();
    const author = getQuestionnaireUserSummary(user);
    const note = { id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, author, body: body.trim(), createdAt: now, kind: "note" };
    const nextItem = { ...item, notes: [...item.notes, note], updatedAt: now };
    const historyEntry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "note_added",
      at: now,
      by: author,
      fieldId,
      summary: `${author.name} raised a note on ${item.label || fieldId}`,
    };
    const nextState = normalizeCimReviewState({
      ...reviewState,
      items: { ...reviewState.items, [fieldId]: nextItem },
      history: [historyEntry, ...(reviewState.history || [])].slice(0, 25),
    });
    setReviewState(nextState);
    void persistCimReviewState(nextState);
  }, [persistCimReviewState, reviewState, user]);

  const handleFinancialAutofill = useCallback(async ({ dateRange, reportVersionId = "", datasetVersion = "" } = {}) => {
    if (!clientId || templateFieldCount === 0) {
      showToast({
        type: "info",
        title: "CIM Still Loading",
        message: "Please wait for the CIM template to finish loading before auto-filling financials.",
      });
      return false;
    }
    if (!isValidFinancialAutofillRange(dateRange)) {
      showToast({
        type: "error",
        title: "Select FY Range",
        message: "Choose valid from and to dates before auto-filling CIM financials.",
      });
      return false;
    }

    const effectiveReportVersionId = isKeyReportsSource ? reportVersionId : "";
    if (isKeyReportsSource && !effectiveReportVersionId) {
      showToast({
        type: "error",
        title: "Select Reports Version",
        message: "Choose a Key Reports version before auto-filling CIM financials.",
      });
      return false;
    }
    const reportVersion = isKeyReportsSource
      ? reportVersions.find((version) => version.id === effectiveReportVersionId) || null
      : null;
    if (isKeyReportsSource && !reportVersion) {
      showToast({
        type: "error",
        title: "Reports Version Unavailable",
        message: "The selected Key Reports version is no longer available. Please choose another version.",
      });
      return false;
    }
    const selectedReportSource = reportVersion
      ? (reportVersion.resolvedBatchId ? REPORT_SOURCE_KEYS.MANUAL_GL : REPORT_SOURCE_KEYS.MANUAL_UPLOAD)
      : reportSource;
    const reportDatasetVersion = selectedReportSource === REPORT_SOURCE_KEYS.MANUAL_GL
      ? String(
        reportVersion?.resolvedDatasetVersion ||
        datasetVersion ||
        financialAutofillDatasetVersion ||
        selectedDatasetVersion ||
        activeManualGlDatasetVersion?.value ||
        activeManualGlDatasetVersion?.dataset_version ||
        "",
      )
      : "";

    setFinancialAutofillState((previous) => ({
      ...previous,
      loading: true,
      error: "",
      progress: 4,
      progressMessage: reportVersion
        ? `Preparing ${reportVersion.versionName || `Version ${reportVersion.versionNumber || ""}`.trim()}`
        : `Preparing ${getReportSourceLabel(selectedReportSource)}`,
    }));

    try {
      const snapshot = await loadCimFinancialAutofillSnapshot({
        clientId,
        sourceKey: selectedReportSource,
        selectedDatasetVersion: reportDatasetVersion,
        selectedReportVersionId: effectiveReportVersionId,
        dateRange,
        onProgress: ({ progress, message }) => {
          setFinancialAutofillState((previous) => ({
            ...previous,
            loading: true,
            progress,
            progressMessage: message,
          }));
        },
      });
      setFinancialAutofillState((previous) => ({
        ...previous,
        progress: 97,
        progressMessage: "Updating CIM fields, tables, and charts",
      }));
      const additions = buildCimFinancialAutofillValues(fieldsBySlide, snapshot);
      additions.fieldValues[SLIDE_27_CASHFLOW_FIELD_ID] = mergeSlide27ManualRows(
        fieldValues[SLIDE_27_CASHFLOW_FIELD_ID],
        additions.fieldValues[SLIDE_27_CASHFLOW_FIELD_ID],
      );
      const slide24TableFields = (fieldsBySlide[24] || []).filter((field) => field.order === 7);
      const slide26TableFields = (fieldsBySlide[26] || []).filter((field) => field.order === 7);
      const replacedTemplateFields = [
        ...slide24TableFields,
        ...slide26TableFields,
        ...(fieldsBySlide[25] || []).filter((field) => [8, 10].includes(field.order)),
        ...(fieldsBySlide[27] || []).filter((field) => field.order === 7),
      ];
      const fieldMerge = mergeOverwriteAutofillValues(
        withoutFieldValues(fieldValues, replacedTemplateFields),
        additions.fieldValues,
      );

      let chartCount = 0;
      const nextChartValues = { ...chartValues };
      Object.entries(additions.chartValues || {}).forEach(([fieldId, config]) => {
        if (!normalizeText(config?.dataText)) return;
        const previous = chartValues[fieldId] || {};
        if (previous.type !== config.type || previous.dataText !== config.dataText) chartCount += 1;
        nextChartValues[fieldId] = {
          ...previous,
          ...config,
        };
      });

      setFieldValues(fieldMerge.next);
      if (chartCount > 0) setChartValues(nextChartValues);

      const filledCount = fieldMerge.count + chartCount;
      setFinancialAutofillState((previous) => ({
        ...previous,
        progress: 100,
        progressMessage: "Financial auto-fill complete",
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      setFinancialAutofillState({
        loading: false,
        filledCount,
        error: "",
        validation: snapshot.validation || null,
        progress: 100,
        progressMessage: "Financial auto-fill complete",
      });
      setFinancialAutofillRange(dateRange);
      setFinancialAutofillReportVersionId(effectiveReportVersionId);
      setFinancialAutofillDatasetVersion(reportDatasetVersion);

      const discrepancyCount = snapshot.validation?.summary?.discrepancies || 0;
      const sourceWarningCount = snapshot.validation?.summary?.sourceWarnings || 0;
      showToast({
        type: filledCount > 0 && discrepancyCount === 0 && sourceWarningCount === 0 ? "success" : "info",
        title: discrepancyCount || sourceWarningCount
          ? "CIM Auto-filled with Review Items"
          : filledCount > 0 ? "CIM Auto-filled" : "No Matching Financial Changes",
        message: filledCount > 0
          ? `${filledCount} financial field${filledCount === 1 ? "" : "s"} refreshed; ${discrepancyCount + sourceWarningCount} review item${discrepancyCount + sourceWarningCount === 1 ? "" : "s"} flagged.`
          : "Financial source data matched the values already in the CIM.",
      });
      return true;
    } catch (error) {
      const message = error?.message || "Financial auto-fill failed.";
      setFinancialAutofillState((previous) => ({
        ...previous,
        loading: false,
        filledCount: 0,
        error: message,
        progress: 0,
        progressMessage: "",
      }));
      showToast({
        type: "error",
        title: "Auto-fill Failed",
        message,
      });
      return false;
    }
  }, [
    chartValues,
    clientId,
    fieldValues,
    fieldsBySlide,
    financialAutofillDatasetVersion,
    activeManualGlDatasetVersion,
    isKeyReportsSource,
    reportSource,
    reportVersions,
    selectedDatasetVersion,
    showToast,
    templateFieldCount,
  ]);

  const handleConfirmFinancialAutofill = useCallback(({ dateRange, reportVersionId, datasetVersion }) => {
    const effectiveReportVersionId = isKeyReportsSource ? reportVersionId || "" : "";
    const effectiveDatasetVersion = isManualGlSource ? datasetVersion || manualGlAutofillDatasetVersion || "" : "";
    setFinancialAutofillModalOpen(false);
    setFinancialAutofillRange(dateRange);
    setFinancialAutofillReportVersionId(effectiveReportVersionId);
    setFinancialAutofillDatasetVersion(effectiveDatasetVersion);
    if (effectiveReportVersionId) void selectReportVersion(effectiveReportVersionId);
    if (effectiveDatasetVersion) setSelectedDatasetVersion(effectiveDatasetVersion);
    const slide24HeadingFields = (fieldsBySlide[24] || []).filter((field) => {
      const tokenIndex = getFieldTokenIndex(field);
      return field.order === 7 && tokenIndex >= 0 && tokenIndex <= 5;
    });
    const slide26HeadingFields = (fieldsBySlide[26] || []).filter((field) => {
      const tokenIndex = getFieldTokenIndex(field);
      return field.order === 7 && tokenIndex >= 0 && tokenIndex <= 5;
    });
    const headingFields = [...slide24HeadingFields, ...slide26HeadingFields];
    const headingValues = {
      ...getSlide24PeriodHeadingValues(slide24HeadingFields, dateRange),
      ...getSlide26PeriodHeadingValues(slide26HeadingFields, dateRange),
    };
    setFieldValues((previous) => ({
      ...withoutFieldValues(previous, headingFields),
      ...headingValues,
    }));
    void handleFinancialAutofill({
      dateRange,
      reportVersionId: effectiveReportVersionId,
      datasetVersion: effectiveDatasetVersion,
    });
  }, [
    fieldsBySlide,
    handleFinancialAutofill,
    isKeyReportsSource,
    isManualGlSource,
    manualGlAutofillDatasetVersion,
    selectReportVersion,
    setSelectedDatasetVersion,
  ]);

  const handleSectionSelect = useCallback((sectionId) => {
    const nextSection = NAV_SECTIONS.find((section) => section.id === sectionId) || BASIC_DETAILS_SECTION;
    setActiveSectionId(sectionId);
    setActiveSlide(nextSection.slides[0] || null);
    setActiveSlideInstance(0);
    setActiveFieldId("");
  }, []);

  const handleRepeatablePageChange = useCallback((slideNumber, instanceIndex) => {
    const config = getRepeatableSlideConfig(slideNumber);
    setActiveSlide(slideNumber);
    setActiveSlideInstance(Math.max(0, Number(instanceIndex || 0)));
    if (config) setActiveFieldId(makeRepeatableFieldId(slideNumber, config.key));
  }, []);

  const handleGlobalChange = useCallback((key, value) => {
    setGlobalDetails((previous) => ({
      ...previous,
      [key]: value,
      ...(key === "companyName" ? { companyLegalName: value } : {}),
    }));
  }, []);

  const handleFieldChange = useCallback((fieldId, value) => {
    setFieldValues((previous) => ({ ...previous, [fieldId]: value }));
  }, []);

  const syncBuilderFieldValues = useCallback((elements = []) => {
    const updates = applyCimBuilderElementsToFieldValues(elements);
    Object.entries(updates).forEach(([fieldId, value]) => {
      setFieldValues((previous) => (
        previous[fieldId] === value ? previous : { ...previous, [fieldId]: value }
      ));
    });
  }, []);

  const buildActiveBuilderBaseElements = useCallback(() => buildCimBuilderElementSpecs(
    activeSlide,
    styledLayouts[activeSlide],
    fieldsBySlide[activeSlide] || [],
    activeCanvasFieldValues,
    assetValues,
    chartValues,
    effectiveGlobalDetails,
    activeStyleProfile,
  ), [
    activeCanvasFieldValues,
    activeSlide,
    activeStyleProfile,
    assetValues,
    chartValues,
    effectiveGlobalDetails,
    fieldsBySlide,
    styledLayouts,
  ]);

  const handleBuilderPageChange = useCallback((nextPage) => {
    const key = getCimBuilderSlideKey(activeSlide, activeSlideInstance);
    const safePage = sanitizeCimBuilderPage(nextPage);
    syncBuilderFieldValues(safePage.elements);

    setCimBuilderState((previous) => {
      const normalized = normalizeCimBuilderState(previous);
      if (activeBuilderPageIndex === 0) {
        const baseElements = buildActiveBuilderBaseElements();
        const pageState = extractCimBuilderPageState(baseElements, safePage);
        return {
          ...normalized,
          pagesByKey: {
            ...normalized.pagesByKey,
            [key]: pageState,
          },
        };
      }

      const currentPages = normalized.extraPagesByKey[key] || [];
      const nextPages = [...currentPages];
      nextPages[activeBuilderPageIndex - 1] = safePage;
      return {
        ...normalized,
        extraPagesByKey: {
          ...normalized.extraPagesByKey,
          [key]: nextPages.filter(Boolean),
        },
      };
    });
  }, [
    activeBuilderPageIndex,
    activeSlide,
    activeSlideInstance,
    buildActiveBuilderBaseElements,
    syncBuilderFieldValues,
  ]);

  const handleAddBuilderPage = useCallback(() => {
    const key = getCimBuilderSlideKey(activeSlide, activeSlideInstance);
    const normalized = normalizeCimBuilderState(cimBuilderState);
    const currentPages = normalized.extraPagesByKey[key] || [];
    const nextPage = createBlankBuilderPage({ name: `Added page ${currentPages.length + 1}` });
    setCimBuilderState({
      ...normalized,
      extraPagesByKey: {
        ...normalized.extraPagesByKey,
        [key]: [...currentPages, nextPage],
      },
    });
    setActiveBuilderPageIndex(currentPages.length + 1);
  }, [activeSlide, activeSlideInstance, cimBuilderState]);

  const handleDeleteBuilderPage = useCallback(() => {
    const key = getCimBuilderSlideKey(activeSlide, activeSlideInstance);
    const normalized = normalizeCimBuilderState(cimBuilderState);
    if (activeBuilderPageIndex === 0) {
      const pageState = normalizeCimBuilderPageState(normalized.pagesByKey[key]);
      setCimBuilderState({
        ...normalized,
        pagesByKey: {
          ...normalized.pagesByKey,
          [key]: { ...pageState, deleted: true },
        },
      });
      return;
    }

    const currentPages = normalized.extraPagesByKey[key] || [];
    const nextPages = currentPages.filter((_, index) => index !== activeBuilderPageIndex - 1);
    setActiveBuilderPageIndex(Math.max(0, activeBuilderPageIndex - 1));
    if (!nextPages.length) {
      const nextExtraPagesByKey = { ...normalized.extraPagesByKey };
      delete nextExtraPagesByKey[key];
      setCimBuilderState({ ...normalized, extraPagesByKey: nextExtraPagesByKey });
      return;
    }
    setCimBuilderState({
      ...normalized,
      extraPagesByKey: {
        ...normalized.extraPagesByKey,
        [key]: nextPages,
      },
    });
  }, [activeBuilderPageIndex, activeSlide, activeSlideInstance, cimBuilderState]);

  const handleRestoreBuilderPage = useCallback(() => {
    const key = getCimBuilderSlideKey(activeSlide, activeSlideInstance);
    setCimBuilderState((previous) => {
      const normalized = normalizeCimBuilderState(previous);
      const pageState = normalizeCimBuilderPageState(normalized.pagesByKey[key]);
      return {
        ...normalized,
        pagesByKey: {
          ...normalized.pagesByKey,
          [key]: { ...pageState, deleted: false },
        },
      };
    });
  }, [activeSlide, activeSlideInstance]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setActiveBuilderPageIndex(0));
    return () => window.cancelAnimationFrame(frame);
  }, [activeSlide, activeSlideInstance]);

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

  const handleAssetScaleChange = useCallback((field, scale) => {
    setAssetValues((previous) => {
      const key = getAssetKey(field);
      const existing = previous[key];
      if (!existing?.dataUrl) return previous;
      return {
        ...previous,
        [key]: { ...existing, scale: normalizeAssetScale(scale) },
      };
    });
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
    const batchId = makeQuestionnaireBatchId();
    const activeItems = Object.values(nextState.items || {}).filter((item) => !item.archived);
    const itemsWithBatch = Object.fromEntries(
      Object.entries(nextState.items || {}).map(([itemId, item]) => [
        itemId,
        item.archived
          ? item
          : {
            ...item,
            batchId,
            sentAt: now,
            updatedAt: now,
          },
      ]),
    );
    const historyEntry = buildQuestionnaireHistoryEntry(activeItems, batchId, now, user);

    updateQuestionnaireState((previous) => ({
      ...previous,
      ...nextState,
      items: itemsWithBatch,
      currentBatchId: batchId,
      history: [historyEntry, ...(previous.history || [])].slice(0, 25),
      sentAt: now,
      sentBy: getQuestionnaireUserSummary(user),
      updatedAt: now,
    }), {
      success: "Questionnaire Sent",
      local: "Questionnaire Saved Locally",
      message: `${activeItems.length} question${activeItems.length === 1 ? "" : "s"} are now available to the client.`,
    });
  }, [updateQuestionnaireState, user]);

  const handleUseClientNote = useCallback((item) => {
    if (!normalizeText(item.clientNote)) return;
    if (String(item.fieldId || "").startsWith("basic:")) {
      const key = String(item.fieldId).slice("basic:".length);
      handleGlobalChange(key, item.clientNote);
      setActiveSectionId(BASIC_DETAILS_SECTION.id);
      setActiveSlide(item.slideNumber || 1);
      setActiveSlideInstance(0);
      showToast({
        type: "success",
        title: "Client Note Added",
        message: "The note was placed into the CIM setup field. Review and save your CIM changes.",
      });
      return;
    }
    setFieldValues((previous) => ({ ...previous, [item.fieldId]: item.clientNote }));
    setActiveSectionId(item.sectionId || BASIC_DETAILS_SECTION.id);
    setActiveSlide(item.slideNumber);
    setActiveSlideInstance(0);
    setActiveFieldId(item.fieldId);
    showToast({
      type: "success",
      title: "Client Note Added",
      message: "The note was placed into the CIM field. Review and save your CIM changes.",
    });
  }, [
    handleGlobalChange,
    showToast,
  ]);

  const handleUseClientAsset = useCallback((item) => {
    const asset = item.clientAsset;
    if (!asset?.dataUrl) return;
    setAssetValues((previous) => ({
      ...previous,
      [item.assetKey || item.fieldId]: {
        dataUrl: asset.dataUrl,
        name: asset.name || item.label || "Client image",
        mimeType: asset.mimeType || "image/png",
        updatedAt: new Date().toISOString(),
      },
    }));
    setActiveSectionId(item.sectionId || BASIC_DETAILS_SECTION.id);
    setActiveSlide(item.slideNumber);
    setActiveSlideInstance(0);
    setActiveFieldId(item.fieldId || "");
    showToast({
      type: "success",
      title: "Client Image Added",
      message: "The uploaded image was placed into the CIM asset field. Review and save your CIM changes.",
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

  const buildNativeBuilderExportDeck = useCallback(() => {
    const previewSlides = buildPreviewSlidesWithBuilderPages(fieldValues, cimBuilderState);
    const exportLayouts = {};
    const exportSlideRefs = previewSlides.map((slideRef, index) => {
      const exportKey = `builder-${index + 1}`;
      const page = resolveCimBuilderPreviewPage(slideRef, {
        layouts: styledLayouts,
        fieldsBySlide,
        fieldValues,
        assetValues,
        chartValues,
        globalDetails: effectiveGlobalDetails,
        styleProfile: activeStyleProfile,
        builderState: cimBuilderState,
      });
      exportLayouts[exportKey] = buildCimBuilderExportLayout(page);
      return { sourceSlideNumber: exportKey, instanceIndex: 0 };
    });

    return { exportLayouts, exportSlideRefs };
  }, [
    activeStyleProfile,
    assetValues,
    chartValues,
    cimBuilderState,
    effectiveGlobalDetails,
    fieldValues,
    fieldsBySlide,
    styledLayouts,
  ]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const state = {
      version: 2,
      globalDetails: effectiveGlobalDetails,
      fieldValues,
      assetValues,
      chartValues,
      cimBuilderState: normalizeCimBuilderState(cimBuilderState),
      financialValidation: financialAutofillState.validation,
      financialAutofillRange,
      financialAutofillReportVersionId,
      financialAutofillDatasetVersion,
      updatedAt: new Date().toISOString(),
    };
    const localKey = getLocalStorageKey(clientId);

    try {
      const payload = await saveWorkspacePageStateRequest(PAGE_KEY, state, { clientId });
      const savedAt = payload?.updatedAt || state.updatedAt;
      setUpdatedAt(savedAt);
      window.localStorage.setItem(localKey, JSON.stringify({ ...state, updatedAt: savedAt, unsynced: false }));
      showToast({
        type: "success",
        title: "CIM Prep Saved",
        message: "Your CIM changes were saved for this company.",
      });
    } catch {
      // The backend write did not succeed — keep the browser-local copy as an explicit
      // "unsynced" draft (never silently presented as if it reached the server), and do
      // NOT advance the displayed "Saved" timestamp: it must always reflect the last
      // change we actually confirmed the backend has, otherwise a refresh later reads the
      // real (older) backend state back and looks like data vanished, at the exact
      // timestamp the UI had just claimed was current.
      window.localStorage.setItem(localKey, JSON.stringify({ ...state, unsynced: true }));
      showToast({
        type: "error",
        title: "CIM Prep NOT Saved",
        message: "Your changes could not be saved to the server and only exist in this browser. Do not close this tab or refresh — click Save again to retry.",
        duration: 10000,
      });
    } finally {
      setSaving(false);
    }
  }, [
    assetValues,
    chartValues,
    clientId,
    activeStyleProfileId,
    effectiveGlobalDetails,
    fieldValues,
    financialAutofillRange,
    financialAutofillDatasetVersion,
    financialAutofillReportVersionId,
    financialAutofillState.validation,
    cimBuilderState,
    showToast,
    styleProfilesState,
  ]);

  const handleExport = useCallback(async () => {
    const missingSlides = PREVIEW_SLIDES.filter((slideNumber) => !styledLayouts[slideNumber]);
    if (missingSlides.length > 0) {
      showToast({
        type: "error",
        title: "Export Not Ready",
        message: "The CIM template is still loading. Please try again in a moment.",
      });
      return;
    }

    const baseName = sanitizeFileName(
      effectiveGlobalDetails.projectName || effectiveGlobalDetails.companyLegalName || company?.name || "cim-prep",
    );
    const { exportLayouts, exportSlideRefs } = buildNativeBuilderExportDeck();
    if (!exportSlideRefs.length) {
      showToast({
        type: "error",
        title: "Export Not Ready",
        message: "All pages are removed. Restore or add at least one page before exporting.",
      });
      return;
    }
    exportCimPptx({
      layouts: exportLayouts,
      slideNumbers: exportSlideRefs,
      getElementContent: getCimBuilderExportElementContent,
      filename: `${baseName}-CIM.pptx`,
      styleProfile: isDefaultCimStyleProfile(activeStyleProfile) ? null : activeStyleProfile,
    });
    showToast({
      type: "success",
      title: "PPT Export Started",
      message: "Your editable CIM PowerPoint is downloading.",
    });
  }, [
    company?.name,
    buildNativeBuilderExportDeck,
    effectiveGlobalDetails,
    activeStyleProfile,
    styledLayouts,
    showToast,
  ]);

  const isBasicSection = activeSection.type === "basic";
  const activeFields = activeSlide ? fieldsBySlide[activeSlide] || [] : [];
  const activeBuilderSlideKey = getCimBuilderSlideKey(activeSlide, activeSlideInstance);
  const normalizedBuilderState = useMemo(() => normalizeCimBuilderState(cimBuilderState), [cimBuilderState]);
  const activeBuilderBaseElements = useMemo(() => buildCimBuilderElementSpecs(
    activeSlide, styledLayouts[activeSlide], activeFields, activeCanvasFieldValues,
    assetValues, chartValues, effectiveGlobalDetails, activeStyleProfile,
  ), [
    activeCanvasFieldValues,
    activeFields,
    activeSlide,
    activeStyleProfile,
    assetValues,
    chartValues,
    effectiveGlobalDetails,
    styledLayouts,
  ]);
  const activeBuilderExtraPages = normalizedBuilderState.extraPagesByKey[activeBuilderSlideKey] || [];
  const activeBuilderPageState = normalizedBuilderState.pagesByKey[activeBuilderSlideKey] || {};
  const activeBuilderPage = activeBuilderPageIndex === 0
    ? buildCimBuilderPage(
        activeBuilderBaseElements,
        activeBuilderPageState,
        getCimBuilderTemplateBackground(styledLayouts[activeSlide]),
      )
    : sanitizeCimBuilderPage(activeBuilderExtraPages[activeBuilderPageIndex - 1] || createBlankBuilderPage());
  const activeBuilderPageTabs = [
    { index: 0, label: activeBuilderPageState.deleted ? "Removed" : "Template" },
    ...activeBuilderExtraPages.map((page, index) => ({ index: index + 1, label: page.name || `Page ${index + 2}` })),
  ];
  const sectionEditableFields = getEditableTemplateFields(
    activeSection.slides.flatMap((slideNumber) => fieldsBySlide[slideNumber] || []),
    effectiveGlobalDetails,
  ).filter((field) => isSlide24FieldActive(field, financialAutofillRange));
  const basicCompleted = BASIC_DETAIL_FIELDS.filter(([key]) => normalizeText(effectiveGlobalDetails[key])).length;
  const sectionCompleted = isBasicSection
    ? basicCompleted + countFieldsWithData(sectionEditableFields, fieldValues, assetValues, chartValues)
    : countFieldsWithData(sectionEditableFields, fieldValues, assetValues, chartValues);
  const sectionFieldTotal = (isBasicSection ? BASIC_DETAIL_FIELDS.length : 0) + sectionEditableFields.length;
  const questionnaireCounts = getQuestionnaireCounts(questionnaireState);
  const questionnaireSections = NAV_SECTIONS;

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
            onClick={() => setFinancialAutofillModalOpen(true)}
            disabled={financialAutofillState.loading}
            className="theme-btn-secondary disabled:cursor-not-allowed disabled:opacity-70"
          >
            {financialAutofillState.loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Auto-fill Financials
          </button>
          <button
            onClick={() => setQuestionnaireOpen(true)}
            className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
            aria-label={`Questionnaire${questionnaireCounts.total > 0 ? ` (${questionnaireCounts.total})` : ""}`}
          >
            <ClipboardList size={16} />
            {questionnaireCounts.total > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-[#8BC53D] px-1 text-[10px] font-bold leading-none text-white">
                {questionnaireCounts.total}
              </span>
            )}
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-md bg-[#050505] px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Questionnaire
            </span>
          </button>
          <button
            onClick={() => setReviewPickerOpen(true)}
            className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
            aria-label="Share for Review"
          >
            <Share2 size={16} />
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-md bg-[#050505] px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Share for Review
            </span>
          </button>
          <button
            onClick={() => setReviewModalOpen(true)}
            className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
            aria-label="Review notes"
          >
            <Flag size={16} />
            {reviewCounts.open > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                {reviewCounts.open}
              </span>
            )}
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-md bg-[#050505] px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Review notes
            </span>
          </button>
          <button
            onClick={() => setStyleEditorOpen(true)}
            className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
            aria-label="Customize template"
          >
            <Palette size={16} />
            {!isDefaultCimStyleProfile(activeStyleProfile) ? (
              <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-white bg-[#8BC53D]" />
            ) : null}
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-md bg-[#050505] px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {isDefaultCimStyleProfile(activeStyleProfile) ? "Customize template" : `Template: ${activeStyleProfile.name}`}
            </span>
          </button>
          <button
            onClick={() => {
              const previewSlides = buildPreviewSlidesWithBuilderPages(fieldValues, cimBuilderState);
              const index = previewSlides.findIndex((slideRef) => {
                const sameSlide = Number(slideRef.sourceSlideNumber) === Number(activeSlide) &&
                  Number(slideRef.instanceIndex || 0) === Number(activeSlideInstance || 0);
                if (!sameSlide) return false;
                if (activeBuilderPageIndex === 0) return !isCimBuilderExtraPreviewSlide(slideRef);
                return isCimBuilderExtraPreviewSlide(slideRef) &&
                  Number(slideRef.builderPageIndex || 0) === activeBuilderPageIndex - 1;
              });
              setPreviewSlideIndex(index >= 0 ? index : 0);
              setPreviewOpen(true);
            }}
            className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
            aria-label="Preview PPT"
          >
            <Eye size={16} />
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-md bg-[#050505] px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Preview PPT
            </span>
          </button>
          <button
            onClick={handleExport}
            className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-white text-[#6D6E71] transition hover:border-[#8BC53D] hover:bg-[#EEF6E0] hover:text-[#476E2C]"
            aria-label="Export PPT"
          >
            <Download size={16} />
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 whitespace-nowrap rounded-md bg-[#050505] px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Export PPT
            </span>
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-70"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save
          </button>
        </div>
      </div>

      <FinancialValidationBanner validation={financialAutofillState.validation} />

      <div className="grid gap-3 xl:grid-cols-[58px_minmax(0,1fr)_288px]">
        <SectionDrawer
          sections={questionnaireSections}
          activeSectionId={activeSectionId}
          fieldValues={fieldValues}
          assetValues={assetValues}
          chartValues={chartValues}
          fieldsBySlide={fieldsBySlide}
          globalDetails={effectiveGlobalDetails}
          onSelectSection={handleSectionSelect}
        />

        <section className="min-w-0 space-y-2">
          <div className="rounded-lg border border-border bg-white px-3 py-2 shadow-card">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#EEF6E0] text-xs font-bold text-[#476E2C]">
                  {isBasicSection ? "BD" : activeSection.number}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-bold text-[#050505]">
                    {activeSection.title}
                  </h2>
                  <p className="text-xs text-[#6D6E71]">
                    {sectionCompleted}/{sectionFieldTotal} fields completed
                  </p>
                </div>
              </div>

              {activeSectionSlideRefs.length > 0 && (
                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                  {activeSectionSlideRefs.map((slideRef) => {
                    const slideNumber = slideRef.sourceSlideNumber;
                    const instanceIndex = slideRef.instanceIndex || 0;
                    const selected = activeSlide === slideNumber && activeSlideInstance === instanceIndex;
                    return (
                      <button
                        key={`${slideNumber}-${instanceIndex}`}
                        onClick={() => {
                          setActiveSlide(slideNumber);
                          setActiveSlideInstance(instanceIndex);
                          setActiveFieldId("");
                        }}
                        className={`h-8 shrink-0 rounded-md border px-2.5 text-xs font-bold transition ${selected
                          ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                          : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
                          }`}
                      >
                        Slide {slideNumber}{instanceIndex > 0 ? `.${instanceIndex + 1}` : ""}
                        {instanceIndex > 0 ? (
                          <span className="ml-1 rounded bg-[#476E2C] px-1 py-0.5 text-[9px] text-white">CONT.</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-white p-1.5 shadow-card">
            {loading ? (
              <div className="flex aspect-video items-center justify-center text-sm font-semibold text-[#6D6E71]">
                <Loader2 size={18} className="mr-2 animate-spin text-[#8BC53D]" />
                Loading CIM template
              </div>
            ) : (
              <CimNativeBuilderCanvas
                slideKey={`${activeSlide}-${activeSlideInstance}`}
                page={activeBuilderPage}
                pageTabs={activeBuilderPageTabs}
                activePageIndex={activeBuilderPageIndex}
                onSelectPage={setActiveBuilderPageIndex}
                onAddPage={handleAddBuilderPage}
                onDeletePage={handleDeleteBuilderPage}
                onRestorePage={handleRestoreBuilderPage}
                onChange={handleBuilderPageChange}
              />
            )}
          </div>
        </section>

        <aside className="sticky top-6 max-h-[calc(100vh-3rem)] space-y-4 overflow-y-auto">
          {isBasicSection && (
            <GlobalDetailsPanel
              activeSlide={activeSlide}
              globalDetails={effectiveGlobalDetails}
              onChange={handleGlobalChange}
              compact
            />
          )}
          <FieldPanel
            activeSlide={activeSlide}
            activeSlideInstance={activeSlideInstance}
            fields={activeFields}
            fieldValues={fieldValues}
            assetValues={assetValues}
            chartValues={chartValues}
            styleProfile={activeStyleProfile}
            questionnaireState={questionnaireState}
            reviewState={reviewState}
            globalDetails={effectiveGlobalDetails}
            financialAutofillRange={financialAutofillRange}
            activeFieldId={activeFieldId}
            onFieldFocus={setActiveFieldId}
            onFieldChange={handleFieldChange}
            onRepeatablePageChange={handleRepeatablePageChange}
            onAssetUpload={handleAssetUpload}
            onAssetRemove={handleAssetRemove}
            onChartChange={handleChartChange}
            onQuestionnaireToggle={handleQuestionnaireToggle}
            onQuestionPromptChange={handleQuestionPromptChange}
            onReviewAddNote={handleAddCimReviewNote}
            onReviewResolve={handleResolveCimReviewItem}
            onReviewReopen={handleReopenCimReviewItem}
          />
        </aside>
      </div>

      {questionnaireOpen && (
        <QuestionnaireReviewModal
          onClose={() => setQuestionnaireOpen(false)}
          sections={questionnaireSections}
          fieldsBySlide={fieldsBySlide}
          globalDetails={effectiveGlobalDetails}
          questionnaireState={questionnaireState}
          onSendQuestionnaire={handleSendQuestionnaire}
          onUseClientNote={handleUseClientNote}
          onUseClientAsset={handleUseClientAsset}
          onCopyNote={handleCopyQuestionNote}
        />
      )}

      {reviewModalOpen && (
        <CimReviewModal
          onClose={() => setReviewModalOpen(false)}
          reviewState={reviewState}
          onAddNote={handleAddCimReviewNote}
          onResolve={handleResolveCimReviewItem}
          onReopen={handleReopenCimReviewItem}
        />
      )}

      {reviewPickerOpen && (
        <CimSharePickerModal
          onClose={() => setReviewPickerOpen(false)}
          teamMembers={clientTeamMembers}
          sharedWith={reviewState.sharedWith}
          onShare={handleShareCimForReview}
        />
      )}

      {financialAutofillModalOpen ? (
        <FinancialAutofillModal
          initialRange={financialAutofillRange}
          initialReportVersionId={financialAutofillReportVersionId}
          initialDatasetVersion={manualGlAutofillDatasetVersion}
          sourceLabel={reportSourceLabel}
          versionMode={financialAutofillVersionMode}
          reportVersions={financialAutofillReportVersions}
          reportVersionsLoading={isKeyReportsSource && reportVersionsLoading}
          reportVersionsError={isKeyReportsSource ? reportVersionsError : null}
          datasetVersions={manualGlDatasetVersions}
          datasetVersionsLoading={isManualGlSource && manualGlDatasetVersionsLoading}
          datasetVersionsError={isManualGlSource ? manualGlDatasetVersionsError : null}
          loading={financialAutofillState.loading}
          onClose={() => setFinancialAutofillModalOpen(false)}
          onConfirm={handleConfirmFinancialAutofill}
        />
      ) : null}

      {styleEditorOpen ? (
        <CimTemplateStyleEditor
          open
          profilesState={{
            ...styleProfilesState,
            activeProfileId: activeStyleProfileId,
          }}
          previewSlides={TEMPLATE_SLIDES}
          sections={NAV_SECTIONS}
          saving={styleProfilesSaving}
          onClose={() => setStyleEditorOpen(false)}
          onSave={handleSaveStyleProfiles}
          renderPreview={({ profile, slideNumber, selection }) => (
            <SlideCanvas
              slideNumber={slideNumber}
              displaySlideNumber={slideNumber}
              layout={applyCimTemplateStyleProfile(slideNumber, layouts[slideNumber], profile)}
              fields={fieldsBySlide[slideNumber] || []}
              fieldValues={fieldValues}
              assetValues={assetValues}
              chartValues={chartValues}
              globalDetails={effectiveGlobalDetails}
              styleProfile={profile}
              previewMode
              styleSelectionMode={Boolean(selection)}
              selectedStyleElementId={selection?.selectedElementId}
              onSelectStyleElement={selection?.onSelectElement}
            />
          )}
        />
      ) : null}

      <FinancialAutofillProgressOverlay state={financialAutofillState} />

      <PreviewModal
        open={previewOpen}
        previewSlideIndex={previewSlideIndex}
        onClose={() => setPreviewOpen(false)}
        onSlideIndexChange={setPreviewSlideIndex}
        builderState={cimBuilderState}
        layouts={styledLayouts}
        fieldsBySlide={fieldsBySlide}
        fieldValues={fieldValues}
        assetValues={assetValues}
        chartValues={chartValues}
        globalDetails={effectiveGlobalDetails}
        styleProfile={activeStyleProfile}
      />
    </div>
  );
}
