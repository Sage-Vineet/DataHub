import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Clock, Flag, List, Loader2, Presentation } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { getCimReviewContentRequest, saveCimReviewRequest } from "../../lib/api";
import { loadCimTemplateData } from "../../lib/cimTemplateFields";
import {
  SlideCanvas,
  TEMPLATE_SLIDES,
  buildCimExportSlides,
  formatFieldDisplayValue,
  getFieldValuesForExportSlide,
} from "../broker/workspace/WorkspaceCimPrep";
import CimFieldNoteThread from "../../components/cim/CimFieldNoteThread";

const FILTERS = [
  ["open", "Open"],
  ["resolved", "Resolved"],
  ["all", "All"],
];

function CimPptView({ cimContent, layouts, fieldsBySlide }) {
  const [slideIndex, setSlideIndex] = useState(0);
  const previewSlides = useMemo(
    () => buildCimExportSlides(cimContent?.fieldValues || {}),
    [cimContent],
  );
  const activeSlideRef = previewSlides[slideIndex] || previewSlides[0];
  const activeSlide = activeSlideRef?.sourceSlideNumber || TEMPLATE_SLIDES[0];
  const activeFieldValues = getFieldValuesForExportSlide(cimContent?.fieldValues || {}, activeSlideRef);

  return (
    <div className="grid gap-4 lg:grid-cols-[160px_minmax(0,1fr)]">
      <div className="hidden max-h-[560px] overflow-y-auto rounded-lg border border-border bg-white p-2 lg:block">
        <div className="space-y-2">
          {previewSlides.map((slideRef, index) => {
            const slideNumber = slideRef.sourceSlideNumber;
            const scopedFieldValues = getFieldValuesForExportSlide(cimContent?.fieldValues || {}, slideRef);
            return (
              <button
                key={`${slideNumber}-${slideRef.instanceIndex}`}
                type="button"
                onClick={() => setSlideIndex(index)}
                className={`block w-full overflow-hidden rounded-md border text-left transition ${
                  index === slideIndex
                    ? "border-[#8BC53D] ring-2 ring-[#8BC53D]/25"
                    : "border-border hover:border-[#8BC53D]/60"
                }`}
              >
                <div className="pointer-events-none">
                  <SlideCanvas
                    slideNumber={slideNumber}
                    displaySlideNumber={index + 1}
                    layout={layouts[slideNumber]}
                    fields={fieldsBySlide[slideNumber] || []}
                    fieldValues={scopedFieldValues}
                    assetValues={cimContent?.assetValues}
                    chartValues={cimContent?.chartValues}
                    globalDetails={cimContent?.globalDetails || {}}
                    previewMode
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col">
        <div className="overflow-auto rounded-lg border border-border bg-white p-2">
          <SlideCanvas
            slideNumber={activeSlide}
            displaySlideNumber={slideIndex + 1}
            layout={layouts[activeSlide]}
            fields={fieldsBySlide[activeSlide] || []}
            fieldValues={activeFieldValues}
            assetValues={cimContent?.assetValues}
            chartValues={cimContent?.chartValues}
            globalDetails={cimContent?.globalDetails || {}}
            previewMode
          />
        </div>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setSlideIndex((index) => Math.max(0, index - 1))}
            disabled={slideIndex <= 0}
            className="theme-btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft size={16} />
            Previous
          </button>
          <span className="text-xs font-semibold text-[#6D6E71]">
            Slide {slideIndex + 1} of {previewSlides.length}
          </span>
          <button
            type="button"
            onClick={() => setSlideIndex((index) => Math.min(previewSlides.length - 1, index + 1))}
            disabled={slideIndex >= previewSlides.length - 1}
            className="theme-btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function resolveCompanies(user) {
  const assigned = user?.assigned_companies?.length
    ? user.assigned_companies
    : user?.assignedCompanies?.length
      ? user.assignedCompanies
      : [];
  const fallbackId = user?.company_id || user?.companyId || user?.company_ids?.[0] || user?.companyIds?.[0];

  if (assigned.length) {
    return assigned.map((company) => ({
      id: company.id,
      name: company.name || company.company_name || "Company",
    })).filter((company) => company.id);
  }

  if (!fallbackId) return [];
  return [{
    id: fallbackId,
    name: user?.company || user?.company_name || "Company",
  }];
}

function normalizeReviewState(state) {
  return {
    version: 1,
    ownerUserId: state?.ownerUserId || null,
    sharedAt: state?.sharedAt || null,
    sharedBy: state?.sharedBy || null,
    sharedWith: Array.isArray(state?.sharedWith) ? state.sharedWith : [],
    items: state?.items && typeof state.items === "object" ? state.items : {},
    history: Array.isArray(state?.history) ? state.history : [],
    updatedAt: state?.updatedAt || "",
    updatedBy: state?.updatedBy || null,
  };
}

function renderValuePreview(field, cimContent) {
  if (!cimContent) return "";

  if (field.fieldKind === "asset") {
    const asset = cimContent.assetValues?.[field.id];
    return asset?.dataUrl ? (
      <img src={asset.dataUrl} alt={field.label} className="h-20 w-32 rounded-md border border-border object-contain" />
    ) : (
      <span className="italic text-[#A5A5A5]">No image uploaded</span>
    );
  }

  if (field.fieldKind === "chart") {
    const chart = cimContent.chartValues?.[field.id];
    return chart ? (
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-[#6D6E71]">
        {typeof chart === "string" ? chart : JSON.stringify(chart, null, 2)}
      </pre>
    ) : (
      <span className="italic text-[#A5A5A5]">No chart data</span>
    );
  }

  const raw = cimContent.fieldValues?.[field.id];
  if (raw == null || raw === "") return <span className="italic text-[#A5A5A5]">No value entered</span>;
  if (typeof raw === "string") return formatFieldDisplayValue(field, raw);
  return (
    <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-[#6D6E71]">
      {JSON.stringify(raw, null, 2)}
    </pre>
  );
}

export default function ClientCimReview() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const companies = useMemo(() => resolveCompanies(user), [user]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(companies[0]?.id || "");
  const activeCompanyId = selectedCompanyId || companies[0]?.id || "";

  const [templateFields, setTemplateFields] = useState([]);
  const [layouts, setLayouts] = useState({});
  const [fieldsBySlide, setFieldsBySlide] = useState({});
  const [reviewState, setReviewState] = useState(() => normalizeReviewState());
  const [cimContent, setCimContent] = useState(null);
  const [notShared, setNotShared] = useState(false);
  const [filter, setFilter] = useState("open");
  const [viewMode, setViewMode] = useState("list");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadCimTemplateData()
      .then(({ fields, layouts: nextLayouts, fieldsBySlide: nextFieldsBySlide }) => {
        setTemplateFields(fields);
        setLayouts(nextLayouts);
        setFieldsBySlide(nextFieldsBySlide);
      })
      .catch(() => setTemplateFields([]));
  }, []);

  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setNotShared(false);
      try {
        const payload = await getCimReviewContentRequest({ clientId: activeCompanyId });
        if (cancelled) return;
        const nextReviewState = normalizeReviewState(payload?.reviewState || {});
        setReviewState(nextReviewState);
        setCimContent(payload?.cimContent || null);
        if (!nextReviewState.ownerUserId) setNotShared(true);
      } catch (error) {
        if (cancelled) return;
        if (error?.status === 403) {
          setNotShared(true);
        } else {
          showToast({ type: "error", title: "Failed to load CIM review", message: error?.message || "Please try again." });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, showToast]);

  const fieldsById = useMemo(
    () => Object.fromEntries(templateFields.map((field) => [field.id, field])),
    [templateFields],
  );

  const reviewableFields = useMemo(() => {
    return templateFields.filter((field) => {
      if (reviewState.items[field.id]) return true;
      const raw = cimContent?.fieldValues?.[field.id];
      const asset = cimContent?.assetValues?.[field.id];
      const chart = cimContent?.chartValues?.[field.id];
      return Boolean((typeof raw === "string" ? raw.trim() : raw) || asset?.dataUrl || chart);
    });
  }, [templateFields, cimContent, reviewState.items]);

  const filteredFields = useMemo(() => {
    return reviewableFields
      .filter((field) => {
        const item = reviewState.items[field.id];
        if (filter === "all") return true;
        if (filter === "resolved") return item?.status === "resolved";
        return !item || item.status !== "resolved";
      })
      .sort((a, b) => Number(a.slideNumber || 0) - Number(b.slideNumber || 0) || a.label.localeCompare(b.label));
  }, [reviewableFields, reviewState.items, filter]);

  const counts = useMemo(() => {
    const items = reviewableFields.map((field) => reviewState.items[field.id]).filter(Boolean);
    return {
      total: reviewableFields.length,
      open: reviewableFields.length - items.filter((item) => item.status === "resolved").length,
      resolved: items.filter((item) => item.status === "resolved").length,
    };
  }, [reviewableFields, reviewState.items]);

  const persist = useCallback(async (nextState) => {
    try {
      const payload = await saveCimReviewRequest(nextState, { clientId: activeCompanyId });
      setReviewState(normalizeReviewState(payload?.state || nextState));
    } catch (error) {
      showToast({ type: "error", title: "Failed to save note", message: error?.message || "Please try again." });
    }
  }, [activeCompanyId, showToast]);

  const handleAddNote = useCallback((field, body) => {
    const now = new Date().toISOString();
    const author = { id: user?.id || null, name: user?.name || user?.email || "Client", email: user?.email || "", role: "client" };
    const existingItem = reviewState.items[field.id];
    const note = { id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, author, body, createdAt: now, kind: "note" };
    const nextItem = {
      id: field.id,
      fieldId: field.id,
      slideNumber: field.slideNumber,
      sectionId: field.sectionId,
      sectionTitle: field.sectionTitle,
      label: field.label,
      fieldKind: field.fieldKind,
      status: "open",
      notes: [...(existingItem?.notes || []), note],
      resolvedBy: null,
      resolvedAt: null,
      createdAt: existingItem?.createdAt || now,
      updatedAt: now,
    };
    const nextState = normalizeReviewState({
      ...reviewState,
      items: { ...reviewState.items, [field.id]: nextItem },
    });
    setReviewState(nextState);
    void persist(nextState);
  }, [persist, reviewState, user]);

  if (!activeCompanyId) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-white text-center shadow-card">
        <p className="text-sm text-[#6D6E71]">No company is assigned to your account yet.</p>
      </div>
    );
  }

  if (!loading && notShared) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-white text-center shadow-card">
        <div>
          <Flag size={34} className="mx-auto mb-3 text-[#8BC53D]" />
          <h2 className="text-sm font-bold text-[#050505]">This CIM hasn't been shared with you yet</h2>
          <p className="mt-1 text-sm text-[#6D6E71]">
            Your broker will share the CIM here once it's ready for your review.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 shadow-card md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Flag size={20} className="text-[#476E2C]" />
            <h1 className="text-2xl font-bold text-[#050505]">CIM Review</h1>
          </div>
          <p className="mt-1 text-sm text-[#6D6E71]">
            Raise a note on any field that needs a change before the CIM is finalized.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-white p-1">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-bold transition ${
                viewMode === "list" ? "bg-[#EEF6E0] text-[#476E2C]" : "text-[#6D6E71] hover:text-[#050505]"
              }`}
            >
              <List size={14} />
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode("ppt")}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-bold transition ${
                viewMode === "ppt" ? "bg-[#EEF6E0] text-[#476E2C]" : "text-[#6D6E71] hover:text-[#050505]"
              }`}
            >
              <Presentation size={14} />
              PPT
            </button>
          </div>
          {companies.length > 1 && (
            <select
              value={activeCompanyId}
              onChange={(event) => setSelectedCompanyId(event.target.value)}
              className="h-10 rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-border bg-white text-sm font-semibold text-[#6D6E71] shadow-card">
          <Loader2 size={18} className="mr-2 animate-spin text-[#8BC53D]" />
          Loading CIM
        </div>
      ) : viewMode === "ppt" ? (
        <CimPptView cimContent={cimContent} layouts={layouts} fieldsBySlide={fieldsBySlide} />
      ) : (
        <>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-white p-4 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">Fields in review</p>
          <p className="mt-2 text-2xl font-bold text-[#050505]">{counts.total}</p>
        </div>
        <div className="rounded-lg border border-border bg-white p-4 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">Open</p>
          <p className="mt-2 text-2xl font-bold text-[#A86F0B]">{counts.open}</p>
        </div>
        <div className="rounded-lg border border-border bg-white p-4 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">Resolved</p>
          <p className="mt-2 text-2xl font-bold text-[#166534]">{counts.resolved}</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`shrink-0 rounded-md border px-3 py-2 text-sm font-bold transition ${
              filter === value
                ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {filteredFields.length > 0 ? (
        <div className="space-y-3">
          {filteredFields.map((field) => {
            const item = reviewState.items[field.id];
            return (
              <article key={field.id} className="rounded-lg border border-border bg-white p-4 shadow-card">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[#6D6E71]">
                    Slide {field.slideNumber} · {field.sectionTitle}
                  </span>
                  {item?.status === "resolved" ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#166534]">
                      <CheckCircle2 size={12} /> Resolved
                    </span>
                  ) : item ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#A86F0B]">
                      <Clock size={12} /> Open
                    </span>
                  ) : null}
                </div>
                <h2 className="mt-2 text-sm font-bold text-[#050505]">{field.label}</h2>
                <div className="mt-1.5 rounded-md border border-border bg-[#FAFBFC] p-2.5 text-sm text-[#050505]">
                  {renderValuePreview(field, cimContent)}
                </div>
                <div className="mt-3">
                  <CimFieldNoteThread
                    notes={item?.notes || []}
                    status={item?.status || "open"}
                    resolvedBy={item?.resolvedBy}
                    resolvedAt={item?.resolvedAt}
                    canResolve={false}
                    canReopen={false}
                    disabled={item?.status === "resolved"}
                    onAddNote={(body) => handleAddNote(fieldsById[field.id] || field, body)}
                  />
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-white text-center shadow-card">
          <div>
            <Flag size={34} className="mx-auto mb-3 text-[#8BC53D]" />
            <h2 className="text-sm font-bold text-[#050505]">Nothing to show here</h2>
            <p className="mt-1 text-sm text-[#6D6E71]">
              {filter === "resolved" ? "No fields have been resolved yet." : "No open items — you're all caught up."}
            </p>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
