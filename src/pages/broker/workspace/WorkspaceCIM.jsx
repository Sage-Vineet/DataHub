import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import {
  FileText, ChevronRight, ChevronDown, Plus, Trash2, Send,
  Save, Download, CheckCircle, Clock, AlertCircle, RefreshCw,
  X, Edit2, MessageSquare,
} from "lucide-react";
import { useToast } from "../../../context/ToastContext";
import {
  getCimByCompanyRequest,
  updateCimRequest,
  updateCimStatusRequest,
  listQuestionnairesRequest,
  createQuestionnaireRequest,
  sendQuestionnaireRequest,
  deleteQuestionnaireRequest,
  getQuestionnaireRequest,
  addQuestionsRequest,
  deleteQuestionRequest,
  generateCimRequest,
  getCimCommentsRequest,
  updateCimCommentRequest,
} from "../../../services/cimService";

// ---------------------------------------------------------------------------
// CIM section definitions
// ---------------------------------------------------------------------------
const CIM_TOPICS = [
  {
    key: "executive_summary",
    label: "Executive Summary",
    fields: [
      { key: "investment_thesis", label: "Investment Thesis", type: "textarea", prompt: "What are the 3-5 reasons a buyer should be excited about this opportunity?" },
      { key: "company_descriptor", label: "One-Line Company Descriptor", prompt: "Example: Founder-led B2B services platform serving healthcare providers across the Southeast." },
      { key: "key_highlights", label: "Investment Highlights", type: "repeatableText", addLabel: "Add Highlight" },
      { key: "revenue", label: "Current Revenue", prompt: "Enter LTM or most recent fiscal-year revenue." },
      { key: "gross_margin", label: "Gross Margin", prompt: "Enter percentage and period, if available." },
      { key: "ebitda", label: "Current EBITDA", prompt: "Enter adjusted or reported EBITDA and period." },
      { key: "primary_growth_driver", label: "Primary Growth Driver", type: "textarea", prompt: "What is the strongest driver of recent and future growth?" },
    ],
  },
  {
    key: "company_overview",
    label: "Company Overview",
    fields: [
      { key: "legal_name", label: "Legal Company Name", prompt: "What is the legal entity name to show in the CIM?" },
      { key: "dba", label: "DBA / Trade Name" },
      { key: "founded_year", label: "Year Founded", type: "number" },
      { key: "headquarters", label: "Headquarters", prompt: "City, state/province, country." },
      { key: "employee_count", label: "Employees", type: "number" },
      { key: "customer_count", label: "Customers / Clients", type: "number" },
      { key: "legal_structure", label: "Legal Structure", prompt: "Example: LLC, C-Corp, S-Corp, partnership." },
      { key: "overview", label: "Company Description", type: "textarea", prompt: "Cover what the company does, who it serves, how it makes money, and why it is distinctive." },
      { key: "history", label: "Company History", type: "textarea", prompt: "Summarize founding context and the journey to current scale." },
      { key: "milestones", label: "Key Milestones", type: "repeatable", addLabel: "Add Milestone", itemFields: [
        { key: "year", label: "Year", type: "number" },
        { key: "description", label: "Milestone", type: "text" },
      ] },
      { key: "owners", label: "Ownership Summary", type: "repeatable", addLabel: "Add Owner", itemFields: [
        { key: "name", label: "Shareholder", type: "text" },
        { key: "ownership_pct", label: "Ownership %", type: "number" },
        { key: "role", label: "Role", type: "text" },
      ] },
    ],
  },
  {
    key: "products_services",
    label: "Products & Services",
    fields: [
      { key: "portfolio_overview", label: "Portfolio Overview", type: "textarea", prompt: "Describe core products/services, categories, customers, and benefits." },
      { key: "products", label: "Product / Service Lines", type: "repeatable", addLabel: "Add Product / Service", itemFields: [
        { key: "name", label: "Name", type: "text" },
        { key: "category", label: "Category", type: "text" },
        { key: "description", label: "Description", type: "textarea" },
        { key: "revenue_pct", label: "% of Revenue", type: "number" },
      ] },
      { key: "differentiators", label: "Competitive Differentiators", type: "repeatable", addLabel: "Add Differentiator", itemFields: [
        { key: "title", label: "Differentiator", type: "text" },
        { key: "description", label: "Why It Matters", type: "textarea" },
      ] },
    ],
  },
  {
    key: "management_team",
    label: "Management Team",
    fields: [
      { key: "team_overview", label: "Team Overview", type: "textarea", prompt: "What makes the leadership team credible and valuable to a buyer?" },
      { key: "retention_plan", label: "Retention / Transition Plan", type: "textarea", prompt: "Who is expected to remain with the company after close and for how long?" },
      { key: "members", label: "Management Members", type: "repeatable", addLabel: "Add Team Member", itemFields: [
        { key: "name", label: "Full Name", type: "text" },
        { key: "title", label: "Title", type: "text" },
        { key: "experience_years", label: "Years Experience", type: "number" },
        { key: "bio", label: "Brief Bio", type: "textarea" },
      ] },
    ],
  },
  {
    key: "market_overview",
    label: "Market Overview",
    fields: [
      { key: "market_name", label: "Market Name", prompt: "Which market should be framed for buyers?" },
      { key: "tam", label: "Total Addressable Market", prompt: "Enter amount, year, and source if known." },
      { key: "sam", label: "Serviceable Addressable Market", prompt: "Enter geography/segment and estimate." },
      { key: "cagr", label: "Market CAGR", prompt: "Enter percentage and period." },
      { key: "tailwinds", label: "Market Tailwinds", type: "repeatableText", addLabel: "Add Tailwind" },
      { key: "competitive_landscape", label: "Competitive Landscape", type: "textarea", prompt: "Describe market fragmentation and where the company is positioned." },
      { key: "competitors", label: "Key Competitors", type: "repeatable", addLabel: "Add Competitor", itemFields: [
        { key: "name", label: "Competitor", type: "text" },
        { key: "size", label: "Size", type: "text" },
        { key: "differentiator", label: "Key Differentiator", type: "text" },
      ] },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    fields: [
      { key: "business_model", label: "Business Model", type: "textarea", prompt: "How does the company generate revenue and deliver value?" },
      { key: "revenue_streams", label: "Revenue Streams", type: "repeatable", addLabel: "Add Revenue Stream", itemFields: [
        { key: "name", label: "Stream", type: "text" },
        { key: "revenue_pct", label: "% of Revenue", type: "number" },
        { key: "type", label: "Type", type: "text" },
        { key: "description", label: "Description", type: "textarea" },
      ] },
      { key: "delivery_process", label: "Delivery Process", type: "textarea", prompt: "Describe the end-to-end operational flow." },
      { key: "facilities", label: "Facilities / Footprint", type: "textarea" },
      { key: "technology_stack", label: "Technology Stack", type: "textarea" },
      { key: "suppliers", label: "Key Suppliers / Vendors", type: "repeatable", addLabel: "Add Supplier", itemFields: [
        { key: "name", label: "Supplier", type: "text" },
        { key: "relationship", label: "Relationship / Purpose", type: "text" },
      ] },
    ],
  },
  {
    key: "financial_performance",
    label: "Financial Performance",
    fields: [
      { key: "performance_summary", label: "Performance Summary", type: "textarea", prompt: "Summarize revenue growth, margin trajectory, and earnings quality." },
      { key: "historical_financials", label: "Historical Income Statement", type: "financial", metricsKey: "historical_financials" },
      { key: "ebitda_adjustments", label: "EBITDA Add-Backs", type: "repeatable", addLabel: "Add Adjustment", itemFields: [
        { key: "description", label: "Item", type: "text" },
        { key: "amount", label: "Amount", type: "number" },
        { key: "nature", label: "Nature", type: "text" },
        { key: "commentary", label: "Commentary", type: "textarea" },
      ] },
      { key: "balance_sheet", label: "Balance Sheet", type: "financial", metricsKey: "balance_sheet" },
      { key: "cash_flow", label: "Cash Flow", type: "financial", metricsKey: "cash_flow" },
      { key: "net_working_capital", label: "Net Working Capital", type: "financial", metricsKey: "net_working_capital" },
      { key: "bank_reconciliation_notes", label: "Bank Reconciliation Notes", type: "textarea" },
      { key: "tax_notes", label: "Tax Notes", type: "textarea" },
    ],
  },
  {
    key: "financial_projection",
    label: "Financial Projection",
    fields: [
      { key: "projection_summary", label: "Projection Summary", type: "textarea", prompt: "Summarize projected revenue, EBITDA, and key drivers." },
      { key: "projected_financials", label: "Projected Financials", type: "financial", metricsKey: "financial_projections" },
      { key: "assumptions", label: "Key Assumptions", type: "repeatable", addLabel: "Add Assumption", itemFields: [
        { key: "category", label: "Category", type: "text" },
        { key: "assumption", label: "Assumption", type: "textarea" },
      ] },
      { key: "risks", label: "Key Risks", type: "textarea" },
    ],
  },
  {
    key: "growth_strategy",
    label: "Growth Strategy",
    fields: [
      { key: "strategy_summary", label: "Strategy Summary", type: "textarea", prompt: "What are the most credible growth levers after close?" },
      { key: "initiatives", label: "Growth Initiatives", type: "repeatable", addLabel: "Add Initiative", itemFields: [
        { key: "title", label: "Initiative", type: "text" },
        { key: "timeframe", label: "Timeframe", type: "text" },
        { key: "description", label: "Action / Rationale", type: "textarea" },
        { key: "expected_impact", label: "Expected Impact", type: "text" },
      ] },
      { key: "ma_opportunities", label: "M&A Opportunities", type: "textarea" },
    ],
  },
  {
    key: "transaction_overview",
    label: "Transaction Overview",
    fields: [
      { key: "transaction_type", label: "Transaction Type", prompt: "Sale of 100% equity, majority recapitalization, asset sale, etc." },
      { key: "ownership_offered", label: "Ownership Offered" },
      { key: "consideration", label: "Consideration", prompt: "All-cash, cash + rollover, earnout, etc." },
      { key: "asking_price", label: "Asking Price", type: "number" },
      { key: "seller_financing", label: "Seller Financing", type: "textarea" },
      { key: "transition_support", label: "Transition Support", type: "textarea" },
      { key: "expected_timeline", label: "Expected Timeline", type: "textarea" },
      { key: "advisor_firm", label: "Advisor Firm" },
      { key: "lead_advisor", label: "Lead Advisor" },
      { key: "advisor_email", label: "Advisor Email", type: "email" },
      { key: "advisor_phone", label: "Advisor Phone" },
    ],
  },
];

const QUESTIONNAIRE_TOPICS = [
  ...CIM_TOPICS.map(({ key, label }) => ({ key, label })),
  { key: "other", label: "Other" },
];

const QUESTION_PRESETS = {
  executive_summary: [
    "What are the top 3-5 investment highlights a buyer should understand first?",
    "What is the clearest one-line descriptor for the company?",
    "What were revenue, gross margin, and EBITDA for the most recent period?",
    "What is the primary reason the company is attractive to an acquirer?",
  ],
  company_overview: [
    "What is the company's legal name, DBA, headquarters, and legal structure?",
    "When was the company founded and what are the major milestones since founding?",
    "How many employees, customers, and locations does the company currently have?",
    "Who owns the company today and what percentage does each owner hold?",
  ],
  products_services: [
    "What are the company's core products or services?",
    "What percentage of revenue does each product or service line represent?",
    "What customer problem does each offering solve?",
    "What differentiates the portfolio from competitors?",
  ],
  management_team: [
    "Who are the key management team members and what are their titles?",
    "What relevant experience and accomplishments should be included for each leader?",
    "Which team members are expected to remain after a transaction?",
    "Are there any key-person dependencies a buyer should understand?",
  ],
  market_overview: [
    "What market does the company operate in and how large is it?",
    "What are the main market tailwinds and expected growth rates?",
    "Who are the primary competitors and how is the company positioned against them?",
    "What sources support market size, CAGR, and competitive positioning?",
  ],
  operations: [
    "How does the business model work and how does the company generate revenue?",
    "What are the major revenue streams and how much does each contribute?",
    "What are the key steps in the operating or service delivery process?",
    "Which systems, facilities, suppliers, or partners are critical to operations?",
  ],
  financial_performance: [
    "Please provide historical income statement data by year.",
    "What EBITDA adjustments or add-backs should be included and why?",
    "Please provide balance sheet, cash flow, and net working capital summaries.",
    "Are bank reconciliations and tax filings current? Note any issues or exposures.",
  ],
  financial_projection: [
    "Please provide management's projected financials by year.",
    "What assumptions drive revenue growth, margin expansion, CapEx, and working capital?",
    "What risks or sensitivities should be disclosed with the forecast?",
    "Does the forecast include only organic growth or also M&A upside?",
  ],
  growth_strategy: [
    "What are the most important organic growth initiatives?",
    "What is the timeline, investment need, and expected impact for each initiative?",
    "Are there geographic, product, channel, or pricing opportunities?",
    "Are there M&A opportunities or acquisition targets that support the strategy?",
  ],
  transaction_overview: [
    "What transaction type is being contemplated?",
    "What ownership percentage is offered and what consideration structure is preferred?",
    "Is seller financing, rollover equity, earnout, or transition support contemplated?",
    "What is the expected process timeline from first-round bids to close?",
  ],
  other: [
    "Please provide any additional information that should be considered for the CIM.",
    "Are there any open issues, risks, or buyer questions that should be addressed?",
  ],
};

const SECTION_GROUPS = [
  {
    label: "CIM Prep",
    sections: CIM_TOPICS.map(({ key, label }) => ({ key, label })),
  },
];

const ALL_SECTIONS = SECTION_GROUPS.flatMap((g) => g.sections);

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
const STATUS_META = {
  draft:                   { label: "Draft",                  color: "bg-gray-100 text-gray-600" },
  questionnaire_pending:   { label: "Questionnaire Pending",  color: "bg-yellow-100 text-yellow-700" },
  questionnaire_answered:  { label: "Questionnaire Answered", color: "bg-blue-100 text-blue-700" },
  broker_editing:          { label: "Broker Editing",         color: "bg-purple-100 text-purple-700" },
  client_review:           { label: "Client Review",          color: "bg-orange-100 text-orange-700" },
  revision_requested:      { label: "Revision Requested",     color: "bg-red-100 text-red-600" },
  approved:                { label: "Approved",               color: "bg-green-100 text-green-700" },
  generated:               { label: "Generated",              color: "bg-emerald-100 text-emerald-700" },
};

const Q_STATUS_META = {
  draft:    { label: "Draft",    color: "bg-gray-100 text-gray-600",    icon: Edit2 },
  sent:     { label: "Sent",     color: "bg-blue-100 text-blue-700",    icon: Send },
  answered: { label: "Answered", color: "bg-green-100 text-green-700",  icon: CheckCircle },
};

function StatusBadge({ status, map = STATUS_META }) {
  const meta = map[status] || { label: status, color: "bg-gray-100 text-gray-600" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.color}`}>
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Repeatable field component
// ---------------------------------------------------------------------------
function RepeatableField({ itemFields, value = [], onChange, addLabel = "Add Item" }) {
  const add = () => {
    const blank = Object.fromEntries(itemFields.map((f) => [f.key, ""]));
    onChange([...value, blank]);
  };
  const remove = (i) => onChange(value.filter((_, idx) => idx !== i));
  const update = (i, key, val) => {
    const updated = value.map((item, idx) => idx === i ? { ...item, [key]: val } : item);
    onChange(updated);
  };

  return (
    <div className="space-y-3">
      {value.map((item, i) => (
        <div key={i} className="relative rounded-lg border border-border bg-bg-page p-3">
          <button
            onClick={() => remove(i)}
            className="absolute right-2 top-2 rounded p-0.5 text-text-muted hover:text-negative hover:bg-red-50"
          >
            <X size={14} />
          </button>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {itemFields.map((f) => (
              <div key={f.key}>
                <label className="mb-0.5 block text-[11px] font-medium text-secondary">{f.label}</label>
                {f.type === "textarea" ? (
                  <textarea
                    value={item[f.key] || ""}
                    onChange={(e) => update(i, f.key, e.target.value)}
                    rows={2}
                    className="w-full rounded border border-border bg-white px-2 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none resize-none"
                  />
                ) : (
                  <input
                    type={f.type === "number" ? "number" : "text"}
                    value={item[f.key] || ""}
                    onChange={(e) => update(i, f.key, e.target.value)}
                    className="w-full rounded border border-border bg-white px-2 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <button
        onClick={add}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-primary/40 px-3 py-1.5 text-[12px] font-medium text-primary hover:bg-[#EEF6E0] transition-colors"
      >
        <Plus size={13} />
        {addLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Financial table editor (years as columns, metrics as rows)
// ---------------------------------------------------------------------------
const FIN_METRICS = {
  historical_financials: [
    { key: "revenue",      label: "Revenue" },
    { key: "cogs",         label: "COGS" },
    { key: "gross_profit", label: "Gross Profit" },
    { key: "op_expenses",  label: "Op. Expenses" },
    { key: "ebitda",       label: "EBITDA" },
    { key: "net_income",   label: "Net Income" },
  ],
  financial_projections: [
    { key: "revenue",      label: "Revenue" },
    { key: "cogs",         label: "COGS" },
    { key: "gross_profit", label: "Gross Profit" },
    { key: "op_expenses",  label: "Op. Expenses" },
    { key: "ebitda",       label: "EBITDA" },
    { key: "net_income",   label: "Net Income" },
  ],
  balance_sheet: [
    { key: "current_assets",       label: "Current Assets" },
    { key: "total_assets",         label: "Total Assets" },
    { key: "current_liabilities",  label: "Current Liabilities" },
    { key: "total_liabilities",    label: "Total Liabilities" },
    { key: "equity",               label: "Equity" },
  ],
  cash_flow: [
    { key: "operating",   label: "Operating" },
    { key: "investing",   label: "Investing" },
    { key: "financing",   label: "Financing" },
    { key: "net_change",  label: "Net Change" },
  ],
  net_working_capital: [
    { key: "current_assets",       label: "Current Assets" },
    { key: "current_liabilities",  label: "Current Liabilities" },
    { key: "nwc",                  label: "Net Working Capital" },
  ],
};

function FinancialTableEditor({ sectionKey, value = {}, onChange }) {
  const metrics = FIN_METRICS[sectionKey] || [];
  const years = value.data || [];

  const addYear = () => {
    const lastYear = years.length ? Number(years[years.length - 1].year) : new Date().getFullYear() - 1;
    const newYear = { year: lastYear + 1, ...Object.fromEntries(metrics.map((m) => [m.key, ""])) };
    onChange({ ...value, data: [...years, newYear] });
  };

  const removeYear = (i) => onChange({ ...value, data: years.filter((_, idx) => idx !== i) });

  const updateCell = (yearIdx, metricKey, val) => {
    const updated = years.map((y, i) => i === yearIdx ? { ...y, [metricKey]: val } : y);
    onChange({ ...value, data: updated });
  };

  return (
    <div className="space-y-3">
      {years.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-[#1B2A4A] text-white">
                <th className="px-3 py-2 text-left font-semibold w-32">Metric</th>
                {years.map((y, i) => (
                  <th key={i} className="px-2 py-2 text-center font-semibold min-w-[90px]">
                    <div className="flex items-center justify-center gap-1">
                      <input
                        type="number"
                        value={y.year}
                        onChange={(e) => updateCell(i, "year", e.target.value)}
                        className="w-16 rounded border-0 bg-white/20 px-1 py-0.5 text-center text-[11px] font-semibold text-white focus:bg-white/30 focus:outline-none"
                      />
                      <button onClick={() => removeYear(i)} className="text-white/60 hover:text-red-300">
                        <X size={11} />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, mi) => (
                <tr key={m.key} className={mi % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="px-3 py-1.5 font-medium text-text-primary">{m.label}</td>
                  {years.map((y, yi) => (
                    <td key={yi} className="px-2 py-1">
                      <input
                        type="text"
                        value={y[m.key] || ""}
                        onChange={(e) => updateCell(yi, m.key, e.target.value)}
                        placeholder="0"
                        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-right text-[11px] text-text-primary hover:border-border focus:border-primary focus:bg-white focus:outline-none"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[12px] text-secondary">No data yet. Add a year to get started.</p>
      )}
      <button
        onClick={addYear}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-primary/40 px-3 py-1.5 text-[12px] font-medium text-primary hover:bg-[#EEF6E0] transition-colors"
      >
        <Plus size={13} />
        Add Year
      </button>
      <div>
        <label className="mb-0.5 block text-[11px] font-medium text-secondary">Notes</label>
        <textarea
          value={value.notes || ""}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          rows={2}
          placeholder="Additional notes..."
          className="w-full rounded border border-border bg-white px-2.5 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none resize-none"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section form renderer
// ---------------------------------------------------------------------------
function SectionForm({ sectionKey, data, onChange, fieldComments = {}, onFieldNoteClick }) {
  const update = (key, val) => onChange({ ...data, [key]: val });

  const field = (key, label, type = "text", placeholder = "") => {
    const notes = fieldComments[key] || [];
    const openCount = notes.filter((n) => n.status === "open").length;
    return (
      <div key={key}>
        <div className="mb-1 flex items-center gap-1.5">
          <label className="text-[12px] font-medium text-secondary">{label}</label>
          {notes.length > 0 && (
            <button
              type="button"
              onClick={() => onFieldNoteClick && onFieldNoteClick(key, label, notes)}
              className="flex items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-600 hover:bg-orange-200 transition-colors"
              title={`${openCount} open client note${openCount !== 1 ? "s" : ""}`}
            >
              <AlertCircle size={9} />
              {openCount > 0 ? openCount : notes.length}
            </button>
          )}
        </div>
        {type === "textarea" ? (
          <textarea
            value={data[key] || ""}
            onChange={(e) => update(key, e.target.value)}
            rows={4}
            placeholder={placeholder}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none resize-none"
          />
        ) : type === "boolean" ? (
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={!!data[key]}
              onChange={(e) => update(key, e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-[13px] text-text-primary">Yes</span>
          </label>
        ) : (
          <input
            type={type}
            value={data[key] || ""}
            onChange={(e) => update(key, e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none"
          />
        )}
      </div>
    );
  };

  const twoCol = (...fields) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{fields}</div>
  );

  const topic = CIM_TOPICS.find((t) => t.key === sectionKey);
  if (topic) {
    const renderTopicField = (f) => {
      const notes = fieldComments[f.key] || [];
      const openCount = notes.filter((n) => n.status === "open").length;
      const label = (
        <div className="mb-1 flex items-center gap-1.5">
          <label className="text-[12px] font-medium text-secondary">{f.label}</label>
          {notes.length > 0 && (
            <button
              type="button"
              onClick={() => onFieldNoteClick && onFieldNoteClick(f.key, f.label, notes)}
              className="flex items-center gap-0.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-600 hover:bg-orange-200 transition-colors"
              title={`${openCount} open client note${openCount !== 1 ? "s" : ""}`}
            >
              <AlertCircle size={9} />
              {openCount > 0 ? openCount : notes.length}
            </button>
          )}
        </div>
      );

      if (f.type === "repeatable") {
        return (
          <div key={f.key}>
            {label}
            {f.prompt && <p className="mb-2 text-[11px] text-text-muted">{f.prompt}</p>}
            <RepeatableField
              value={data[f.key] || []}
              onChange={(v) => update(f.key, v)}
              addLabel={f.addLabel || "Add Item"}
              itemFields={f.itemFields || []}
            />
          </div>
        );
      }

      if (f.type === "repeatableText") {
        return (
          <div key={f.key}>
            {label}
            {f.prompt && <p className="mb-2 text-[11px] text-text-muted">{f.prompt}</p>}
            <RepeatableField
              value={(data[f.key] || []).map((text) => ({ text }))}
              onChange={(v) => update(f.key, v.map((i) => i.text || "").filter(Boolean))}
              addLabel={f.addLabel || "Add Item"}
              itemFields={[{ key: "text", label: f.label, type: "text" }]}
            />
          </div>
        );
      }

      if (f.type === "financial") {
        return (
          <div key={f.key}>
            {label}
            {f.prompt && <p className="mb-2 text-[11px] text-text-muted">{f.prompt}</p>}
            <FinancialTableEditor
              sectionKey={f.metricsKey}
              value={data[f.key] || {}}
              onChange={(v) => update(f.key, v)}
            />
          </div>
        );
      }

      return (
        <div key={f.key}>
          {label}
          {f.prompt && <p className="mb-1.5 text-[11px] text-text-muted">{f.prompt}</p>}
          {f.type === "textarea" ? (
            <textarea
              value={data[f.key] || ""}
              onChange={(e) => update(f.key, e.target.value)}
              rows={4}
              placeholder={f.prompt || ""}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none resize-none"
            />
          ) : (
            <input
              type={f.type === "number" ? "number" : f.type === "email" ? "email" : "text"}
              value={data[f.key] || ""}
              onChange={(e) => update(f.key, e.target.value)}
              placeholder={f.prompt || ""}
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[13px] text-text-primary focus:border-primary focus:outline-none"
            />
          )}
        </div>
      );
    };

    return (
      <div className="space-y-5">
        {topic.fields.map(renderTopicField)}
      </div>
    );
  }

  if (FIN_METRICS[sectionKey]) {
    return (
      <FinancialTableEditor sectionKey={sectionKey} value={data} onChange={onChange} />
    );
  }

  switch (sectionKey) {
    case "company_info":
      return (
        <div className="space-y-4">
          {twoCol(field("legal_name", "Legal Company Name", "text", "e.g. Acme Corp LLC"), field("dba", "DBA / Trade Name", "text", "Doing Business As"))}
          {twoCol(field("industry", "Industry"), field("sub_industry", "Sub-Industry"))}
          {field("address", "Street Address")}
          {twoCol(field("city", "City"), field("state", "State"), field("zip", "ZIP Code"))}
          {twoCol(field("phone", "Phone"), field("website", "Website"))}
          {twoCol(field("founded_year", "Year Founded", "number"), field("employee_count", "Number of Employees", "number"))}
          {twoCol(field("location_count", "Number of Locations", "number"), field("ein", "EIN (Tax ID)", "text"))}
        </div>
      );

    case "company_history":
      return (
        <div className="space-y-4">
          {field("narrative", "History & Background", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Key Milestones</label>
            <RepeatableField
              value={data.milestones || []}
              onChange={(v) => update("milestones", v)}
              addLabel="Add Milestone"
              itemFields={[
                { key: "year", label: "Year", type: "number" },
                { key: "description", label: "Description", type: "text" },
              ]}
            />
          </div>
        </div>
      );

    case "ownership":
      return (
        <div className="space-y-4">
          {field("structure", "Ownership Structure Description", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Owners / Shareholders</label>
            <RepeatableField
              value={data.owners || []}
              onChange={(v) => update("owners", v)}
              addLabel="Add Owner"
              itemFields={[
                { key: "name", label: "Name", type: "text" },
                { key: "title", label: "Title", type: "text" },
                { key: "ownership_pct", label: "Ownership %", type: "number" },
                { key: "years_with_company", label: "Years with Company", type: "number" },
              ]}
            />
          </div>
        </div>
      );

    case "executive_summary":
      return (
        <div className="space-y-4">
          {field("overview", "Business Overview", "textarea")}
          {field("key_strengths", "Key Strengths", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Investment Highlights</label>
            <RepeatableField
              value={(data.investment_highlights || []).map((h) => ({ text: h }))}
              onChange={(v) => update("investment_highlights", v.map((i) => i.text || ""))}
              addLabel="Add Highlight"
              itemFields={[{ key: "text", label: "Highlight", type: "text" }]}
            />
          </div>
        </div>
      );

    case "products_services":
      return (
        <div className="space-y-4">
          {field("description", "Products & Services Overview", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Product / Service Lines</label>
            <RepeatableField
              value={data.items || []}
              onChange={(v) => update("items", v)}
              addLabel="Add Product/Service"
              itemFields={[
                { key: "name", label: "Name", type: "text" },
                { key: "description", label: "Description", type: "textarea" },
                { key: "revenue_pct", label: "% of Revenue", type: "number" },
              ]}
            />
          </div>
        </div>
      );

    case "competitive_diff":
      return (
        <div className="space-y-4">
          {field("advantages", "Competitive Advantages", "textarea")}
          {field("barriers_to_entry", "Barriers to Entry", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Key Competitors</label>
            <RepeatableField
              value={data.competitors || []}
              onChange={(v) => update("competitors", v)}
              addLabel="Add Competitor"
              itemFields={[
                { key: "name", label: "Name", type: "text" },
                { key: "description", label: "Description / Market Position", type: "text" },
              ]}
            />
          </div>
        </div>
      );

    case "management_team":
      return (
        <div className="space-y-4">
          {field("overview", "Team Overview", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Team Members</label>
            <RepeatableField
              value={data.members || []}
              onChange={(v) => update("members", v)}
              addLabel="Add Team Member"
              itemFields={[
                { key: "name", label: "Name", type: "text" },
                { key: "title", label: "Title", type: "text" },
                { key: "years_with_company", label: "Years with Company", type: "number" },
                { key: "background", label: "Background / Bio", type: "textarea" },
              ]}
            />
          </div>
        </div>
      );

    case "market_information":
      return (
        <div className="space-y-4">
          {twoCol(field("total_addressable_market", "Total Addressable Market"), field("market_size", "Market Size (USD)"))}
          {field("target_market", "Target Market Description", "textarea")}
          {field("growth_trends", "Market Growth Trends", "textarea")}
          {field("competitive_landscape", "Competitive Landscape", "textarea")}
        </div>
      );

    case "operations":
      return (
        <div className="space-y-4">
          {field("overview", "Operations Overview", "textarea")}
          {field("facilities", "Facilities", "textarea")}
          {field("technology_systems", "Technology & Systems", "textarea")}
          {field("key_processes", "Key Processes", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Key Suppliers / Vendors</label>
            <RepeatableField
              value={data.suppliers || []}
              onChange={(v) => update("suppliers", v)}
              addLabel="Add Supplier"
              itemFields={[
                { key: "name", label: "Name", type: "text" },
                { key: "relationship", label: "Relationship / Purpose", type: "text" },
              ]}
            />
          </div>
        </div>
      );

    case "adjusted_ebitda":
      return (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">EBITDA Adjustments</label>
            <RepeatableField
              value={data.adjustments || []}
              onChange={(v) => update("adjustments", v)}
              addLabel="Add Adjustment"
              itemFields={[
                { key: "description", label: "Description", type: "text" },
                { key: "type", label: "Type (add-back / deduction)", type: "text" },
                { key: "year", label: "Year", type: "number" },
                { key: "amount", label: "Amount (USD)", type: "number" },
              ]}
            />
          </div>
          {field("notes", "Notes", "textarea")}
        </div>
      );

    case "bank_reconciliation":
      return (
        <div className="space-y-4">
          {field("notes", "Notes", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Reconciliation Items</label>
            <RepeatableField
              value={data.items || []}
              onChange={(v) => update("items", v)}
              addLabel="Add Item"
              itemFields={[
                { key: "period", label: "Period", type: "text" },
                { key: "bank_balance", label: "Bank Balance", type: "number" },
                { key: "book_balance", label: "Book Balance", type: "number" },
                { key: "difference", label: "Difference", type: "number" },
                { key: "explanation", label: "Explanation", type: "text" },
              ]}
            />
          </div>
        </div>
      );

    case "tax_information":
      return (
        <div className="space-y-4">
          {twoCol(field("entity_type", "Entity Type (LLC, Corp, S-Corp…)"), field("filing_status", "Filing Status"))}
          {field("notes", "Notes / Tax Matters", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Tax Line Items</label>
            <RepeatableField
              value={data.items || []}
              onChange={(v) => update("items", v)}
              addLabel="Add Item"
              itemFields={[
                { key: "year", label: "Year", type: "number" },
                { key: "type", label: "Tax Type", type: "text" },
                { key: "amount", label: "Amount", type: "number" },
                { key: "notes", label: "Notes", type: "text" },
              ]}
            />
          </div>
        </div>
      );

    case "projection_assumptions":
      return (
        <div className="space-y-4">
          {field("revenue_assumptions", "Revenue Assumptions", "textarea")}
          {field("expense_assumptions", "Expense Assumptions", "textarea")}
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Growth Drivers</label>
            <RepeatableField
              value={data.drivers || []}
              onChange={(v) => update("drivers", v)}
              addLabel="Add Driver"
              itemFields={[
                { key: "category", label: "Category", type: "text" },
                { key: "assumption", label: "Assumption", type: "text" },
                { key: "impact", label: "Expected Impact", type: "text" },
              ]}
            />
          </div>
          {field("notes", "Additional Notes", "textarea")}
        </div>
      );

    case "growth_strategy":
      return (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-[12px] font-medium text-secondary">Organic Growth Initiatives</label>
            <RepeatableField
              value={data.organic_initiatives || []}
              onChange={(v) => update("organic_initiatives", v)}
              addLabel="Add Initiative"
              itemFields={[
                { key: "title", label: "Initiative", type: "text" },
                { key: "description", label: "Description", type: "textarea" },
                { key: "timeline", label: "Timeline", type: "text" },
                { key: "expected_impact", label: "Expected Impact", type: "text" },
              ]}
            />
          </div>
          {field("ma_strategy", "M&A Strategy", "textarea")}
          {field("new_markets", "New Markets / Products", "textarea")}
        </div>
      );

    case "transaction_overview":
      return (
        <div className="space-y-4">
          {twoCol(field("asking_price", "Asking Price (USD)", "number"), field("transaction_structure", "Transaction Structure"))}
          <div className="flex items-center gap-3">
            {field("seller_financing", "Seller Financing Available", "boolean")}
          </div>
          {data.seller_financing && field("seller_financing_terms", "Seller Financing Terms", "textarea")}
          {twoCol(field("transition_period", "Transition Period"), field("reason_for_selling", "Reason for Selling"))}
          {field("use_of_proceeds", "Use of Proceeds", "textarea")}
          {field("notes", "Additional Notes", "textarea")}
        </div>
      );

    case "advisor_information":
      return (
        <div className="space-y-4">
          {twoCol(field("name", "Advisor Name"), field("firm", "Firm Name"))}
          {twoCol(field("title", "Title"), field("email", "Email", "email"))}
          {field("phone", "Phone")}
          {field("confidentiality_statement", "Confidentiality Statement", "textarea")}
        </div>
      );

    default:
      return <p className="text-[13px] text-secondary">No form defined for this section.</p>;
  }
}

// ---------------------------------------------------------------------------
// Questionnaire panel
// ---------------------------------------------------------------------------
function QuestionnairePanel({ cimId }) {
  const { showToast } = useToast();
  const [questionnaires, setQuestionnaires] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [questionnaireDetails, setQuestionnaireDetails] = useState({});
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [selectedTopic, setSelectedTopic] = useState("");
  const [selectedPresetQuestions, setSelectedPresetQuestions] = useState([]);
  const [manualQuestions, setManualQuestions] = useState("");
  const [newQuestionText, setNewQuestionText] = useState({});
  const [addingQ, setAddingQ] = useState({});

  const load = useCallback(async () => {
    try {
      const data = await listQuestionnairesRequest(cimId);
      setQuestionnaires(data || []);
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [cimId, showToast]);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = async (qId) => {
    const isOpen = expanded[qId];
    setExpanded((prev) => ({ ...prev, [qId]: !isOpen }));
    if (!isOpen && !questionnaireDetails[qId]) {
      try {
        const detail = await getQuestionnaireRequest(qId);
        setQuestionnaireDetails((prev) => ({ ...prev, [qId]: detail }));
      } catch (err) {
        showToast({ type: "error", title: "Error", message: err.message });
      }
    }
  };

  const handleCreate = async () => {
    if (!selectedTopic) return;
    const topicMeta = QUESTIONNAIRE_TOPICS.find((t) => t.key === selectedTopic);
    const title = newTitle.trim() || `${topicMeta?.label || "CIM"} Questionnaire`;
    const customQuestions = manualQuestions
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
    const questions = [...selectedPresetQuestions, ...customQuestions]
      .filter((q, idx, arr) => q && arr.indexOf(q) === idx)
      .map((question_text) => ({ question_text, is_required: true }));
    if (!questions.length) {
      showToast({ type: "error", title: "Select or add at least one question" });
      return;
    }
    try {
      const created = await createQuestionnaireRequest(cimId, { title, category: topicMeta?.label || "Other" });
      await addQuestionsRequest(created.id, questions);
      setNewTitle("");
      setSelectedTopic("");
      setSelectedPresetQuestions([]);
      setManualQuestions("");
      setCreating(false);
      await load();
      showToast({ type: "success", title: "Questionnaire created" });
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    }
  };

  const handleSend = async (qId) => {
    try {
      await sendQuestionnaireRequest(qId);
      await load();
      showToast({ type: "success", title: "Questionnaire sent to client" });
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    }
  };

  const handleDelete = async (qId) => {
    try {
      await deleteQuestionnaireRequest(qId);
      await load();
      showToast({ type: "success", title: "Questionnaire deleted" });
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    }
  };

  const handleAddQuestion = async (qId) => {
    const text = (newQuestionText[qId] || "").trim();
    if (!text) return;
    try {
      await addQuestionsRequest(qId, [{ question_text: text }]);
      setNewQuestionText((prev) => ({ ...prev, [qId]: "" }));
      setAddingQ((prev) => ({ ...prev, [qId]: false }));
      const detail = await getQuestionnaireRequest(qId);
      setQuestionnaireDetails((prev) => ({ ...prev, [qId]: detail }));
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    }
  };

  const handleDeleteQuestion = async (questionId, qId) => {
    try {
      await deleteQuestionRequest(questionId);
      const detail = await getQuestionnaireRequest(qId);
      setQuestionnaireDetails((prev) => ({ ...prev, [qId]: detail }));
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    }
  };

  const togglePresetQuestion = (question) => {
    setSelectedPresetQuestions((prev) =>
      prev.includes(question) ? prev.filter((q) => q !== question) : [...prev, question]
    );
  };

  if (loading) return <div className="py-12 text-center text-sm text-secondary">Loading questionnaires…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Questionnaire Requests</h3>
          <p className="mt-0.5 text-[12px] text-secondary">Send targeted questions to your client to fill gaps in the CIM.</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90 transition-opacity"
        >
          <Plus size={13} />
          New Questionnaire
        </button>
      </div>

      {creating && (
        <div className="rounded-xl border border-primary/30 bg-[#EEF6E0] p-4 space-y-4">
          <p className="text-[13px] font-semibold text-primary">New Questionnaire</p>
          <div>
            <label className="mb-2 block text-[11px] font-medium text-secondary">Topic *</label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {QUESTIONNAIRE_TOPICS.map((topic) => (
                <button
                  key={topic.key}
                  type="button"
                  onClick={() => {
                    setSelectedTopic(topic.key);
                    setSelectedPresetQuestions([]);
                    setNewTitle(`${topic.label} Questionnaire`);
                  }}
                  className={`rounded-lg border px-3 py-2 text-left text-[12px] font-semibold transition-colors ${
                    selectedTopic === topic.key
                      ? "border-primary bg-white text-primary shadow-sm"
                      : "border-border bg-white/70 text-secondary hover:border-primary/50 hover:text-text-primary"
                  }`}
                >
                  {topic.label}
                </button>
              ))}
            </div>
          </div>

          {selectedTopic && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-secondary">Title</label>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Questionnaire title"
                className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[13px] focus:border-primary focus:outline-none"
              />
            </div>
          )}

          {selectedTopic && (
            <div>
              <label className="mb-2 block text-[11px] font-medium text-secondary">Select Questions *</label>
              <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border bg-white p-2">
                {(QUESTION_PRESETS[selectedTopic] || []).map((question) => (
                  <label key={question} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-bg-page">
                    <input
                      type="checkbox"
                      checked={selectedPresetQuestions.includes(question)}
                      onChange={() => togglePresetQuestion(question)}
                      className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <span className="text-[12px] text-text-primary">{question}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {selectedTopic && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-secondary">Additional Manual Questions</label>
              <textarea
                value={manualQuestions}
                onChange={(e) => setManualQuestions(e.target.value)}
                rows={3}
                placeholder="Add one custom question per line..."
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[13px] focus:border-primary focus:outline-none resize-none"
              />
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={handleCreate} className="rounded-lg bg-primary px-4 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">
              Create
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setSelectedTopic("");
                setSelectedPresetQuestions([]);
                setManualQuestions("");
              }}
              className="rounded-lg border border-border px-4 py-1.5 text-[12px] font-semibold text-secondary hover:bg-bg-page"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {questionnaires.length === 0 && !creating && (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <MessageSquare size={32} className="mx-auto mb-2 text-text-muted opacity-30" />
          <p className="text-[13px] text-secondary">No questionnaires yet. Create one to request information from the client.</p>
        </div>
      )}

      {questionnaires.map((q) => {
        const meta = Q_STATUS_META[q.status] || Q_STATUS_META.draft;
        const Icon = meta.icon;
        const detail = questionnaireDetails[q.id];
        const isOpen = !!expanded[q.id];

        return (
          <div key={q.id} className="rounded-xl border border-border bg-bg-card overflow-hidden">
            <div className="flex items-center gap-3 p-4">
              <button
                onClick={() => toggleExpand(q.id)}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${meta.color}`}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-text-primary">{q.title}</p>
                  <div className="mt-0.5 flex items-center gap-2">
                    {q.category && <span className="text-[11px] text-secondary">{q.category}</span>}
                    <span className="text-[11px] text-text-muted">{q.question_count || 0} question{q.question_count !== 1 ? "s" : ""}</span>
                    {q.sent_at && <span className="text-[11px] text-text-muted">Sent {new Date(q.sent_at).toLocaleDateString()}</span>}
                  </div>
                </div>
                <StatusBadge status={q.status} map={Q_STATUS_META} />
                {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
              </button>
              <div className="flex items-center gap-1.5">
                {q.status === "draft" && (
                  <button
                    onClick={() => handleSend(q.id)}
                    className="flex items-center gap-1 rounded-md border border-primary/30 px-2.5 py-1.5 text-[11px] font-semibold text-primary hover:bg-[#EEF6E0] transition-colors"
                  >
                    <Send size={11} />
                    Send
                  </button>
                )}
                {q.status === "draft" && (
                  <button
                    onClick={() => handleDelete(q.id)}
                    className="rounded-md p-1.5 text-text-muted hover:bg-red-50 hover:text-negative transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <div className="border-t border-border px-4 pb-4 pt-3">
                {!detail ? (
                  <p className="text-[12px] text-secondary">Loading…</p>
                ) : (
                  <div className="space-y-2">
                    {(detail.questions || []).length === 0 && (
                      <p className="text-[12px] text-secondary">No questions yet.</p>
                    )}
                    {(detail.questions || []).map((question, idx) => (
                      <div key={question.id} className="flex items-start gap-2 rounded-lg bg-bg-page p-2.5">
                        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#1B2A4A] text-[10px] font-bold text-white">
                          {idx + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] text-text-primary">{question.question_text}</p>
                          {question.response && (
                            <p className="mt-1 text-[11px] italic text-secondary">
                              Response: {question.response.response_text}
                              {question.response.is_draft && " (draft)"}
                            </p>
                          )}
                        </div>
                        {q.status === "draft" && (
                          <button
                            onClick={() => handleDeleteQuestion(question.id, q.id)}
                            className="flex-shrink-0 rounded p-0.5 text-text-muted hover:text-negative"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    ))}

                    {q.status === "draft" && (
                      addingQ[q.id] ? (
                        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-[#EEF6E0] p-2.5">
                          <input
                            autoFocus
                            value={newQuestionText[q.id] || ""}
                            onChange={(e) => setNewQuestionText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && handleAddQuestion(q.id)}
                            placeholder="Type a question and press Enter…"
                            className="flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder-text-muted"
                          />
                          <button onClick={() => handleAddQuestion(q.id)} className="text-primary hover:opacity-70">
                            <CheckCircle size={14} />
                          </button>
                          <button onClick={() => setAddingQ((p) => ({ ...p, [q.id]: false }))} className="text-text-muted hover:text-negative">
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setAddingQ((p) => ({ ...p, [q.id]: true }))}
                          className="flex items-center gap-1.5 text-[12px] font-medium text-primary hover:underline"
                        >
                          <Plus size={12} />
                          Add Question
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function WorkspaceCIM() {
  const { clientId } = useParams();
  const { showToast } = useToast();

  const [cim, setCim] = useState(null);
  const [sectionData, setSectionData] = useState({});
  const [activeTab, setActiveTab] = useState("form");
  const [activeSection, setActiveSection] = useState("executive_summary");
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [generating, setGenerating] = useState(false);
  const [comments, setComments] = useState([]);
  const [commentPopup, setCommentPopup] = useState(null); // { fieldKey, fieldLabel, sectionKey, notes }
  const [resolvingComment, setResolvingComment] = useState({});

  const saveTimer = useRef(null);
  const lastSavedData = useRef({});

  // Load CIM on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getCimByCompanyRequest(clientId);
        if (!cancelled) {
          setCim(data);
          setSectionData(data.section_data || {});
          lastSavedData.current = data.section_data || {};
          try {
            const commentsList = await getCimCommentsRequest(data.id);
            if (!cancelled) setComments(commentsList || []);
          } catch { /* non-critical */ }
        }
      } catch (err) {
        if (!cancelled) showToast({ type: "error", title: "Could not load CIM", message: err.message });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientId, showToast]);

  // Debounced auto-save
  const triggerSave = useCallback((data) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      if (!cim?.id) return;
      try {
        await updateCimRequest(cim.id, data);
        lastSavedData.current = data;
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2000);
      } catch {
        setSaveState("error");
      }
    }, 1500);
  }, [cim?.id]);

  const handleSectionChange = useCallback((key, newData) => {
    const updated = { ...sectionData, [key]: newData };
    setSectionData(updated);
    triggerSave(updated);
  }, [sectionData, triggerSave]);

  const handleManualSave = async () => {
    if (!cim?.id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    try {
      await updateCimRequest(cim.id, sectionData);
      lastSavedData.current = sectionData;
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
      showToast({ type: "success", title: "CIM saved" });
    } catch (err) {
      setSaveState("error");
      showToast({ type: "error", title: "Save failed", message: err.message });
    }
  };

  const handleStatusChange = async (status) => {
    if (!cim?.id) return;
    try {
      const updated = await updateCimStatusRequest(cim.id, status);
      setCim(updated);
      showToast({ type: "success", title: "Status updated" });
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    }
  };

  const handleGenerate = async () => {
    if (!cim?.id) return;
    setGenerating(true);
    try {
      const { blob, fileName } = await generateCimRequest(cim.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast({ type: "success", title: "CIM generated", message: "PowerPoint downloaded." });
      // Refresh CIM to update status
      const refreshed = await getCimByCompanyRequest(clientId);
      setCim(refreshed);
    } catch (err) {
      showToast({ type: "error", title: "Generation failed", message: err.message });
    } finally {
      setGenerating(false);
    }
  };

  const handleResolveComment = async (commentId) => {
    setResolvingComment((p) => ({ ...p, [commentId]: true }));
    try {
      await updateCimCommentRequest(commentId, { status: "resolved" });
      setComments((prev) => prev.map((c) => c.id === commentId ? { ...c, status: "resolved" } : c));
      setCommentPopup((prev) =>
        prev ? { ...prev, notes: prev.notes.map((n) => n.id === commentId ? { ...n, status: "resolved" } : n) } : null
      );
    } catch (err) {
      showToast({ type: "error", title: "Could not resolve", message: err.message });
    } finally {
      setResolvingComment((p) => ({ ...p, [commentId]: false }));
    }
  };

  const handleFieldNoteClick = (fieldKey, fieldLabel, notes) => {
    setCommentPopup({ fieldKey, fieldLabel, sectionKey: activeSection, notes });
  };

  // Build fieldComments map for the active section: { fieldKey: comments[] }
  const activeFieldComments = {};
  comments
    .filter((c) => c.section_key === activeSection && c.field_key)
    .forEach((c) => {
      if (!activeFieldComments[c.field_key]) activeFieldComments[c.field_key] = [];
      activeFieldComments[c.field_key].push(c);
    });

  const openCommentCount = comments.filter((c) => c.status === "open" && c.field_key).length;

  const isSectionFilled = (key) => {
    const d = sectionData[key];
    if (!d) return false;
    const vals = Object.values(d);
    return vals.some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      return v !== "" && v !== null && v !== undefined;
    });
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw size={20} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-secondary">Loading CIM…</span>
      </div>
    );
  }

  const currentSectionMeta = ALL_SECTIONS.find((s) => s.key === activeSection);

  return (
    <div className="mx-auto max-w-[1400px]">
      {/* Header */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">CIM Prep</h1>
          <p className="mt-0.5 text-[13px] text-secondary">Confidential Information Memorandum</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cim && (
            <div className="flex items-center gap-2">
              <StatusBadge status={cim.status} />
              <select
                value={cim.status}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="rounded-lg border border-border bg-bg-card px-2 py-1 text-[12px] text-text-primary focus:border-primary focus:outline-none"
              >
                {Object.entries(STATUS_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[12px]">
            {saveState === "saving" && <><RefreshCw size={12} className="animate-spin text-primary" /><span className="text-secondary">Saving…</span></>}
            {saveState === "saved"  && <><CheckCircle size={12} className="text-green-600" /><span className="text-green-600">Saved</span></>}
            {saveState === "error"  && <><AlertCircle size={12} className="text-negative" /><span className="text-negative">Save failed</span></>}
          </div>
          <button
            onClick={handleManualSave}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-card px-3 py-2 text-[12px] font-semibold text-secondary hover:bg-bg-page transition-colors"
          >
            <Save size={13} />
            Save Draft
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {generating ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
            Generate CIM
          </button>
        </div>
      </div>

      {/* Main layout: left sidebar + content */}
      <div className="flex gap-4 items-start">

        {/* Left sidebar */}
        <aside className="w-52 flex-shrink-0 sticky top-4">
          <div className="rounded-xl border border-border bg-bg-card overflow-hidden">

            {/* Tab switcher */}
            <div className="border-b border-border p-2 space-y-0.5">
              {[
                { key: "form",          label: "CIM Form",              icon: FileText,      badge: openCommentCount },
                { key: "questionnaire", label: "Questionnaire",          icon: MessageSquare, badge: 0 },
              ].map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition-all ${
                      activeTab === tab.key
                        ? "bg-primary text-white"
                        : "text-secondary hover:bg-bg-page hover:text-text-primary"
                    }`}
                  >
                    {activeTab === tab.key && (
                      <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-white/60" />
                    )}
                    <Icon size={14} className="flex-shrink-0" />
                    <span className="flex-1 text-left">{tab.label}</span>
                    {tab.badge > 0 && (
                      <span className={`inline-flex min-w-4 items-center justify-center rounded-full px-1 py-0.5 text-[10px] font-bold ${
                        activeTab === tab.key ? "bg-white/30 text-white" : "bg-orange-500 text-white"
                      }`}>
                        {tab.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Section navigator — only shown on CIM Form tab */}
            {activeTab === "form" && (
              <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
                {SECTION_GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="border-b border-border bg-bg-page px-3 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{group.label}</p>
                    </div>
                    {group.sections.map((section) => {
                      const filled = isSectionFilled(section.key);
                      const isActive = activeSection === section.key;
                      const sectionOpenNotes = comments.filter(
                        (c) => c.section_key === section.key && c.field_key && c.status === "open"
                      ).length;
                      return (
                        <button
                          key={section.key}
                          onClick={() => setActiveSection(section.key)}
                          className={`relative flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors ${
                            isActive
                              ? "bg-[#EEF6E0] text-primary font-semibold"
                              : "text-secondary hover:bg-bg-page hover:text-text-primary"
                          }`}
                        >
                          {isActive && (
                            <div className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                          )}
                          <span className="flex-1 truncate">{section.label}</span>
                          <div className="flex flex-shrink-0 items-center gap-1">
                            {sectionOpenNotes > 0 && (
                              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-orange-100 text-[9px] font-bold text-orange-600">
                                {sectionOpenNotes}
                              </span>
                            )}
                            {filled && (
                              <span className={`h-1.5 w-1.5 rounded-full ${isActive ? "bg-primary" : "bg-green-500"}`} />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Right content */}
        <div className="min-w-0 flex-1">
          {activeTab === "form" && (
            <div className="max-h-[calc(100vh-160px)] overflow-y-auto rounded-xl border border-border bg-bg-card p-5">
              <div className="sticky -top-5 z-10 mb-4 border-b border-border bg-bg-card pb-3 pt-0">
                <h2 className="text-base font-bold text-text-primary">
                  {currentSectionMeta?.label || ""}
                </h2>
                <p className="mt-0.5 text-[12px] text-secondary">
                  Complete the fields needed to populate this section. Changes auto-save as you work.
                </p>
              </div>
              <SectionForm
                key={activeSection}
                sectionKey={activeSection}
                data={sectionData[activeSection] || {}}
                onChange={(newData) => handleSectionChange(activeSection, newData)}
                fieldComments={activeFieldComments}
                onFieldNoteClick={handleFieldNoteClick}
              />
            </div>
          )}
          {activeTab === "questionnaire" && (
            <div className="rounded-xl border border-border bg-bg-card p-5">
              {cim && <QuestionnairePanel cimId={cim.id} />}
            </div>
          )}
        </div>

      </div>

      {/* Field comment popup */}
      {commentPopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setCommentPopup(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-sm font-bold text-text-primary capitalize">
                  {commentPopup.fieldLabel}
                </h3>
                <p className="mt-0.5 text-[11px] text-secondary">
                  {ALL_SECTIONS.find((s) => s.key === commentPopup.sectionKey)?.label || commentPopup.sectionKey}
                  {" · "}
                  {commentPopup.notes.filter((n) => n.status === "open").length} open
                </p>
              </div>
              <button
                onClick={() => setCommentPopup(null)}
                className="rounded-md p-1 text-text-muted hover:bg-bg-page hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto px-5 py-4">
              {commentPopup.notes.length === 0 && (
                <p className="text-center text-[13px] text-secondary">No notes for this field.</p>
              )}
              {commentPopup.notes.map((n) => (
                <div
                  key={n.id}
                  className={`flex gap-3 rounded-xl p-3 ${
                    n.status === "resolved" ? "bg-green-50 opacity-60" : "bg-orange-50"
                  }`}
                >
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#1B2A4A] text-[11px] font-bold text-white">
                    {(n.reviewer_name || "C").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-text-primary">
                        {n.reviewer_name || "Client"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        n.status === "resolved" ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-600"
                      }`}>
                        {n.status === "resolved" ? "Resolved" : "Open"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[13px] text-text-primary">{n.comment_text}</p>
                    <p className="mt-0.5 text-[10px] text-text-muted">
                      {new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                    {n.status === "open" && (
                      <button
                        onClick={() => handleResolveComment(n.id)}
                        disabled={resolvingComment[n.id]}
                        className="mt-1.5 flex items-center gap-1 rounded-md border border-green-300 px-2 py-0.5 text-[11px] font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50 transition-colors"
                      >
                        {resolvingComment[n.id] ? <RefreshCw size={9} className="animate-spin" /> : <CheckCircle size={9} />}
                        Mark Resolved
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-border px-5 py-3">
              <button
                onClick={() => setCommentPopup(null)}
                className="w-full rounded-xl border border-border py-2 text-[13px] font-semibold text-secondary hover:bg-bg-page transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
