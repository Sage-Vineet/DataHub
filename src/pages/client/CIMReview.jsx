import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, MessageSquare, CheckCircle, RefreshCw, Send, X, AlertCircle } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import {
  getCimByCompanyRequest,
  getCimCommentsRequest,
  addCimCommentRequest,
  updateCimCommentRequest,
} from "../../services/cimService";

// ---------------------------------------------------------------------------
// Section labels — kept in sync with broker form
// ---------------------------------------------------------------------------
const SECTION_LABELS = {
  company_info:            "Company Information",
  company_history:         "Company History",
  ownership:               "Ownership",
  executive_summary:       "Executive Summary",
  products_services:       "Products & Services",
  competitive_diff:        "Competitive Differentiation",
  management_team:         "Management Team",
  market_information:      "Market Information",
  operations:              "Operations",
  historical_financials:   "Historical Financials",
  adjusted_ebitda:         "Adjusted EBITDA",
  balance_sheet:           "Balance Sheet",
  cash_flow:               "Cash Flow",
  net_working_capital:     "Net Working Capital",
  bank_reconciliation:     "Bank Reconciliation",
  tax_information:         "Tax Information",
  financial_projections:   "Financial Projections",
  projection_assumptions:  "Projection Assumptions",
  growth_strategy:         "Growth Strategy",
  transaction_overview:    "Transaction Overview",
  advisor_information:     "Advisor Information",
};

const SECTION_ORDER = Object.keys(SECTION_LABELS);

// ---------------------------------------------------------------------------
// Pretty-print a section's data as readable key-value, with per-field comments
// ---------------------------------------------------------------------------
function SectionDataView({ data, sectionKey, fieldComments = {}, onAddFieldComment }) {
  const [activeField, setActiveField] = useState(null);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const { showToast } = useToast();

  const renderValue = (val) => {
    if (val === null || val === undefined || val === "") return <span className="text-text-muted">—</span>;
    if (typeof val === "boolean") return <span>{val ? "Yes" : "No"}</span>;
    if (Array.isArray(val)) {
      if (!val.length) return <span className="text-text-muted">—</span>;
      if (typeof val[0] === "object") {
        return (
          <div className="space-y-2 mt-1">
            {val.map((item, i) => (
              <div key={i} className="rounded-lg border border-border bg-bg-page p-2.5">
                {Object.entries(item)
                  .filter(([, v]) => v !== "" && v !== null && v !== undefined)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-[12px]">
                      <span className="font-medium text-secondary capitalize">{k.replace(/_/g, " ")}:</span>
                      <span className="text-text-primary">{String(v)}</span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        );
      }
      return (
        <ul className="mt-1 list-inside list-disc space-y-1 text-[13px] text-text-primary">
          {val.map((v, i) => <li key={i}>{String(v)}</li>)}
        </ul>
      );
    }
    if (typeof val === "object") {
      if (val.data && Array.isArray(val.data)) {
        return (
          <div className="overflow-x-auto mt-1">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="bg-[#1B2A4A] text-white">
                  {Object.keys(val.data[0] || {}).map((k) => (
                    <th key={k} className="px-2 py-1.5 text-center font-medium capitalize">{k.replace(/_/g, " ")}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {val.data.map((row, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="px-2 py-1 text-center text-text-primary">{v || "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
    return <span className="text-[13px] text-text-primary whitespace-pre-wrap">{String(val)}</span>;
  };

  const entries = Object.entries(data || {}).filter(([, v]) => {
    if (v === "" || v === null || v === undefined) return false;
    if (Array.isArray(v) && !v.length) return false;
    return true;
  });

  if (!entries.length) return <p className="text-[13px] text-secondary">No data entered for this section.</p>;

  const handlePost = async (fieldKey) => {
    const trimmed = commentText.trim();
    if (!trimmed || !onAddFieldComment) return;
    setPosting(true);
    try {
      await onAddFieldComment(sectionKey, fieldKey, trimmed);
      setCommentText("");
      setActiveField(null);
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="space-y-4">
      {entries.map(([key, value]) => {
        const notes = fieldComments[key] || [];
        const openCount = notes.filter((n) => n.status === "open").length;
        const isActive = activeField === key;

        return (
          <div key={key}>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-secondary">
                {key.replace(/_/g, " ")}
              </p>
              <button
                onClick={() => {
                  setActiveField(isActive ? null : key);
                  setCommentText("");
                }}
                className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold transition-colors ${
                  openCount > 0
                    ? "bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
                    : "bg-gray-100 text-gray-400 hover:bg-yellow-50 hover:text-yellow-600"
                }`}
                title={openCount > 0 ? `${openCount} open note${openCount !== 1 ? "s" : ""}` : "Add a note on this field"}
              >
                <MessageSquare size={9} />
                <span className="ml-0.5">{openCount > 0 ? openCount : "+"}</span>
              </button>
            </div>

            {renderValue(value)}

            {isActive && (
              <div className="mt-2 rounded-xl border border-yellow-200 bg-yellow-50 p-3 space-y-2.5">
                {notes.length > 0 && (
                  <div className="space-y-2">
                    {notes.map((n) => (
                      <div key={n.id} className={`flex gap-2 rounded-lg p-2 ${n.status === "resolved" ? "opacity-50 bg-green-50" : "bg-white"}`}>
                        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#1B2A4A] text-[10px] font-bold text-white">
                          {(n.reviewer_name || "C").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-semibold text-text-primary">{n.reviewer_name || "You"}</span>
                            <span className="text-[10px] text-text-muted">{new Date(n.created_at).toLocaleDateString()}</span>
                            {n.status === "resolved" && <span className="text-[10px] text-green-600">· Resolved</span>}
                          </div>
                          <p className="text-[12px] text-text-primary">{n.comment_text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handlePost(key)}
                    placeholder="Add a note on this field…"
                    className="flex-1 rounded-lg border border-yellow-300 bg-white px-2.5 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                  />
                  <button
                    onClick={() => handlePost(key)}
                    disabled={posting || !commentText.trim()}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {posting ? <RefreshCw size={11} className="animate-spin" /> : <Send size={11} />}
                  </button>
                  <button
                    onClick={() => setActiveField(null)}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-white text-text-muted hover:text-text-primary"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comment thread for a section
// ---------------------------------------------------------------------------
function CommentThread({ cimId, sectionKey, comments, onAdd, onResolve, userId }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const { showToast } = useToast();

  const sectionComments = comments.filter((c) => c.section_key === sectionKey);

  const handlePost = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPosting(true);
    try {
      await onAdd(sectionKey, trimmed);
      setText("");
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border/50 pt-3 space-y-3">
      {sectionComments.length > 0 && (
        <div className="space-y-2">
          {sectionComments.map((c) => (
            <div key={c.id} className={`flex gap-2.5 rounded-lg p-2.5 ${c.status === "resolved" ? "bg-green-50 opacity-60" : "bg-yellow-50"}`}>
              <MessageSquare size={14} className={`mt-0.5 flex-shrink-0 ${c.status === "resolved" ? "text-green-500" : "text-yellow-600"}`} />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-text-primary">{c.comment_text}</p>
                <p className="mt-0.5 text-[10px] text-text-muted">{new Date(c.created_at).toLocaleString()}</p>
              </div>
              {c.status === "open" && (
                <button
                  onClick={() => onResolve(c.id)}
                  className="flex-shrink-0 text-[10px] font-medium text-green-600 hover:underline"
                >
                  Resolve
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handlePost()}
          placeholder="Add a comment or request a correction…"
          className="flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
        />
        <button
          onClick={handlePost}
          disabled={posting || !text.trim()}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-40"
        >
          {posting ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function CIMReview() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const companyId = user?.company_ids?.[0] || user?.company_id || user?.companyId;

  const [cim, setCim] = useState(null);
  const [comments, setComments] = useState([]);
  const [expanded, setExpanded] = useState({ company_info: true });
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!companyId) { setLoading(false); return; }
    try {
      const [cimData, commentsData] = await Promise.all([
        getCimByCompanyRequest(companyId),
        Promise.resolve([]),
      ]);
      setCim(cimData);
      if (cimData?.id) {
        const c = await getCimCommentsRequest(cimData.id);
        setComments(c || []);
      }
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [companyId, showToast]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleAddComment = async (sectionKey, text) => {
    if (!cim?.id) return;
    const newComment = await addCimCommentRequest(cim.id, { section_key: sectionKey, comment_text: text });
    setComments((prev) => [...prev, newComment]);
  };

  const handleAddFieldComment = async (sectionKey, fieldKey, text) => {
    if (!cim?.id) return;
    const newComment = await addCimCommentRequest(cim.id, { section_key: sectionKey, field_key: fieldKey, comment_text: text });
    setComments((prev) => [...prev, newComment]);
  };

  const handleResolve = async (commentId) => {
    const updated = await updateCimCommentRequest(commentId, { status: "resolved" });
    setComments((prev) => prev.map((c) => c.id === commentId ? updated : c));
  };

  const toggleSection = (key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const REVIEW_STATUSES = ["client_review", "revision_requested", "approved", "generated"];
  const isReviewable = cim && REVIEW_STATUSES.includes(cim.status);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw size={20} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-secondary">Loading CIM…</span>
      </div>
    );
  }

  if (!cim || !isReviewable) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <CheckCircle size={48} className="mx-auto mb-4 text-text-muted opacity-30" />
        <h2 className="text-lg font-semibold text-text-primary">CIM Not Available for Review</h2>
        <p className="mt-2 text-[13px] text-secondary">
          The CIM for your company is not yet ready for review. Your advisor will notify you when it is ready.
        </p>
      </div>
    );
  }

  const sectionData = cim.section_data || {};
  const openComments = comments.filter((c) => c.status === "open").length;

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">CIM Review</h1>
          <p className="mt-0.5 text-[13px] text-secondary">
            Review the Confidential Information Memorandum prepared by your advisor. Use comments to request corrections.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            cim.status === "approved" ? "bg-green-100 text-green-700" :
            cim.status === "revision_requested" ? "bg-red-100 text-red-600" :
            "bg-orange-100 text-orange-700"
          }`}>
            {cim.status === "approved" ? "Approved" :
             cim.status === "revision_requested" ? "Revision Requested" :
             cim.status === "generated" ? "Generated" : "Under Review"}
          </span>
          {openComments > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700">
              <MessageSquare size={10} />
              {openComments} open {openComments === 1 ? "comment" : "comments"}
            </span>
          )}
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-3">
        {SECTION_ORDER.map((key) => {
          const hasData = !!sectionData[key] && Object.keys(sectionData[key]).length > 0;
          const sectionComments = comments.filter((c) => c.section_key === key);
          const openSectionComments = sectionComments.filter((c) => c.status === "open").length;
          const isOpen = !!expanded[key];

          return (
            <div key={key} className="overflow-hidden rounded-xl border border-border bg-bg-card shadow-sm">
              <button
                onClick={() => toggleSection(key)}
                className="flex w-full items-center gap-3 p-4 text-left"
              >
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <p className="text-[14px] font-semibold text-text-primary">{SECTION_LABELS[key]}</p>
                  {!hasData && <span className="text-[11px] text-text-muted">(no data)</span>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {openSectionComments > 0 && (
                    <span className="flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-medium text-yellow-700">
                      <MessageSquare size={9} />
                      {openSectionComments}
                    </span>
                  )}
                  {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-border px-4 pb-4 pt-3">
                  <SectionDataView
                    data={sectionData[key]}
                    sectionKey={key}
                    fieldComments={Object.fromEntries(
                      comments
                        .filter((c) => c.section_key === key && c.field_key)
                        .reduce((map, c) => {
                          if (!map.has(c.field_key)) map.set(c.field_key, []);
                          map.get(c.field_key).push(c);
                          return map;
                        }, new Map())
                    )}
                    onAddFieldComment={handleAddFieldComment}
                  />
                  <CommentThread
                    cimId={cim.id}
                    sectionKey={key}
                    comments={comments}
                    onAdd={handleAddComment}
                    onResolve={handleResolve}
                    userId={user?.id}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Global comments */}
      <div className="rounded-xl border border-border bg-bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">General Comments</h3>
        <CommentThread
          cimId={cim.id}
          sectionKey="__global__"
          comments={comments}
          onAdd={handleAddComment}
          onResolve={handleResolve}
          userId={user?.id}
        />
      </div>
    </div>
  );
}
