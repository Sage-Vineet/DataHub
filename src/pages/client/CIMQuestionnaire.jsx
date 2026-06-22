import { useState, useEffect, useCallback } from "react";
import { MessageSquare, CheckCircle, Clock, ChevronDown, ChevronRight, Send, Save, RefreshCw } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import {
  getClientQuestionnairesRequest,
  getQuestionnaireRequest,
  saveResponseRequest,
  submitQuestionnaireResponseRequest,
} from "../../services/cimService";

const STATUS_META = {
  sent:     { label: "Pending",   color: "bg-yellow-100 text-yellow-700" },
  answered: { label: "Submitted", color: "bg-green-100 text-green-700" },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: "bg-gray-100 text-gray-600" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.color}`}>
      {meta.label}
    </span>
  );
}

export default function CIMQuestionnaire() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const companyId = user?.company_ids?.[0] || user?.company_id || user?.companyId;

  const [questionnaires, setQuestionnaires] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [details, setDetails] = useState({});
  const [responses, setResponses] = useState({});
  const [saving, setSaving] = useState({});
  const [submitting, setSubmitting] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return; }
    try {
      const data = await getClientQuestionnairesRequest(companyId);
      setQuestionnaires(data || []);
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [companyId, showToast]);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = async (qId) => {
    const isOpen = expanded[qId];
    setExpanded((prev) => ({ ...prev, [qId]: !isOpen }));
    if (!isOpen && !details[qId]) {
      try {
        const detail = await getQuestionnaireRequest(qId);
        setDetails((prev) => ({ ...prev, [qId]: detail }));
        // Pre-populate responses with existing answers
        const existing = {};
        for (const q of detail.questions || []) {
          if (q.response) existing[q.id] = q.response.response_text || "";
        }
        setResponses((prev) => ({ ...prev, ...existing }));
      } catch (err) {
        showToast({ type: "error", title: "Error", message: err.message });
      }
    }
  };

  const handleChange = (questionId, value) => {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
  };

  const handleSaveDraft = async (qId) => {
    const detail = details[qId];
    if (!detail) return;
    setSaving((prev) => ({ ...prev, [qId]: true }));
    try {
      await Promise.all(
        (detail.questions || []).map((q) =>
          saveResponseRequest(q.id, {
            response_text: responses[q.id] || "",
            is_draft: true,
          })
        )
      );
      showToast({ type: "success", title: "Draft saved" });
    } catch (err) {
      showToast({ type: "error", title: "Error", message: err.message });
    } finally {
      setSaving((prev) => ({ ...prev, [qId]: false }));
    }
  };

  const handleSubmit = async (qId) => {
    const detail = details[qId];
    if (!detail) return;

    // Check required questions
    const missing = (detail.questions || []).filter(
      (q) => q.is_required && !(responses[q.id] || "").trim()
    );
    if (missing.length) {
      showToast({ type: "error", title: "Please answer all required questions before submitting." });
      return;
    }

    setSubmitting((prev) => ({ ...prev, [qId]: true }));
    try {
      // Save all responses first
      await Promise.all(
        (detail.questions || []).map((q) =>
          saveResponseRequest(q.id, {
            response_text: responses[q.id] || "",
            is_draft: false,
          })
        )
      );
      // Then submit the questionnaire
      await submitQuestionnaireResponseRequest(qId);
      await load();
      showToast({ type: "success", title: "Questionnaire submitted", message: "Your answers have been sent to the broker." });
    } catch (err) {
      showToast({ type: "error", title: "Submission failed", message: err.message });
    } finally {
      setSubmitting((prev) => ({ ...prev, [qId]: false }));
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw size={20} className="animate-spin text-primary" />
        <span className="ml-2 text-sm text-secondary">Loading…</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">CIM Questionnaires</h1>
        <p className="mt-0.5 text-[13px] text-secondary">
          Your advisor has sent questions to help prepare the Confidential Information Memorandum. Please answer them as completely as possible.
        </p>
      </div>

      {questionnaires.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <MessageSquare size={40} className="mx-auto mb-3 text-text-muted opacity-30" />
          <p className="text-sm font-medium text-secondary">No questionnaires yet</p>
          <p className="mt-1 text-[12px] text-text-muted">Your advisor will send questions when they are ready.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {questionnaires.map((q) => {
            const isOpen = !!expanded[q.id];
            const detail = details[q.id];
            const isAnswered = q.status === "answered";

            return (
              <div key={q.id} className="overflow-hidden rounded-xl border border-border bg-bg-card shadow-sm">
                {/* Header */}
                <button
                  onClick={() => toggleExpand(q.id)}
                  className="flex w-full items-center gap-3 p-4 text-left"
                >
                  <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${isAnswered ? "bg-green-100" : "bg-yellow-100"}`}>
                    {isAnswered ? (
                      <CheckCircle size={16} className="text-green-600" />
                    ) : (
                      <Clock size={16} className="text-yellow-600" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-text-primary">{q.title}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      {q.category && <span className="text-[11px] text-secondary">{q.category}</span>}
                      {q.sent_at && (
                        <span className="text-[11px] text-text-muted">
                          Received {new Date(q.sent_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={q.status} />
                  {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                </button>

                {/* Expanded content */}
                {isOpen && (
                  <div className="border-t border-border px-4 pb-4 pt-3">
                    {!detail ? (
                      <div className="flex items-center gap-2 py-4 text-[13px] text-secondary">
                        <RefreshCw size={13} className="animate-spin" /> Loading questions…
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {(detail.questions || []).length === 0 ? (
                          <p className="text-[13px] text-secondary">No questions in this questionnaire.</p>
                        ) : (
                          (detail.questions || []).map((question, idx) => (
                            <div key={question.id}>
                              <label className="mb-1.5 block text-[13px] font-medium text-text-primary">
                                {idx + 1}. {question.question_text}
                                {question.is_required && <span className="ml-1 text-negative">*</span>}
                              </label>
                              <textarea
                                value={responses[question.id] || ""}
                                onChange={(e) => handleChange(question.id, e.target.value)}
                                disabled={isAnswered}
                                rows={3}
                                placeholder={isAnswered ? "" : "Your answer…"}
                                className={`w-full rounded-lg border px-3 py-2 text-[13px] focus:border-primary focus:outline-none resize-none transition-colors ${
                                  isAnswered
                                    ? "border-border bg-bg-page text-secondary cursor-not-allowed"
                                    : "border-border bg-white text-text-primary"
                                }`}
                              />
                            </div>
                          ))
                        )}

                        {!isAnswered && (detail.questions || []).length > 0 && (
                          <div className="flex items-center gap-3 pt-2">
                            <button
                              onClick={() => handleSaveDraft(q.id)}
                              disabled={saving[q.id]}
                              className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[12px] font-semibold text-secondary hover:bg-bg-page disabled:opacity-60 transition-colors"
                            >
                              {saving[q.id] ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
                              Save Draft
                            </button>
                            <button
                              onClick={() => handleSubmit(q.id)}
                              disabled={submitting[q.id]}
                              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60 transition-opacity"
                            >
                              {submitting[q.id] ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
                              Submit Answers
                            </button>
                          </div>
                        )}

                        {isAnswered && (
                          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2.5">
                            <CheckCircle size={14} className="text-green-600" />
                            <p className="text-[12px] font-medium text-green-700">
                              Submitted {q.answered_at ? new Date(q.answered_at).toLocaleDateString() : ""}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
