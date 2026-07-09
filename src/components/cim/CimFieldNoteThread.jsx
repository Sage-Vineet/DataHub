import { useState } from "react";
import { CheckCircle2, Clock, Send } from "lucide-react";

function formatTimestamp(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("en-IN");
  } catch {
    return "";
  }
}

export default function CimFieldNoteThread({
  notes = [],
  status = "open",
  resolvedBy = null,
  resolvedAt = null,
  canResolve = false,
  canReopen = false,
  onAddNote,
  onResolve,
  onReopen,
  disabled = false,
}) {
  const [draft, setDraft] = useState("");
  const [resolutionDraft, setResolutionDraft] = useState("");
  const [showResolveForm, setShowResolveForm] = useState(false);

  const submitNote = () => {
    const body = draft.trim();
    if (!body || disabled) return;
    onAddNote?.(body);
    setDraft("");
  };

  const submitResolve = () => {
    onResolve?.(resolutionDraft.trim());
    setResolutionDraft("");
    setShowResolveForm(false);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] ${
            status === "resolved" ? "bg-[#DCFCE7] text-[#166534]" : "bg-[#FEF3C7] text-[#A86F0B]"
          }`}
        >
          {status === "resolved" ? <CheckCircle2 size={12} /> : <Clock size={12} />}
          {status === "resolved" ? "Resolved" : "Open"}
        </span>
        {status === "resolved" && resolvedBy ? (
          <span className="text-[11px] text-[#6D6E71]">
            by {resolvedBy.name} · {formatTimestamp(resolvedAt)}
          </span>
        ) : null}
      </div>

      {notes.length > 0 ? (
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-[#FAFBFC] p-2.5">
          {notes.map((note) => (
            <div
              key={note.id}
              className={`rounded-md p-2 text-[11px] leading-snug ${
                note.kind === "resolution" ? "border border-[#8BC53D]/30 bg-[#EEF6E0]" : "bg-white"
              }`}
            >
              <div className="mb-0.5 flex items-center justify-between gap-2">
                <span className="font-bold text-[#050505]">{note.author?.name || "User"}</span>
                <span className="text-[10px] text-[#8A8F98]">{formatTimestamp(note.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap text-[#050505]">{note.body}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-[#FAFBFC] p-2.5 text-[11px] text-[#6D6E71]">
          No notes yet.
        </p>
      )}

      {!disabled && (
        <div className="flex items-start gap-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a note..."
            className="min-h-[44px] flex-1 resize-y rounded-md border border-border bg-white px-2 py-1.5 text-[11px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={submitNote}
            disabled={!draft.trim()}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border bg-white text-[#476E2C] transition hover:bg-[#EEF6E0] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Add note"
          >
            <Send size={14} />
          </button>
        </div>
      )}

      {canResolve && status === "open" && (
        <div>
          {showResolveForm ? (
            <div className="space-y-1.5 rounded-md border border-border bg-white p-2">
              <textarea
                value={resolutionDraft}
                onChange={(event) => setResolutionDraft(event.target.value)}
                placeholder="Optional note about the fix (visible to the client)..."
                className="min-h-[44px] w-full resize-y rounded-md border border-border bg-white px-2 py-1.5 text-[11px] leading-snug text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
                spellCheck={false}
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowResolveForm(false)}
                  className="theme-btn-secondary h-7 px-2 text-[11px]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitResolve}
                  className="theme-btn-primary h-7 px-2 text-[11px]"
                >
                  <CheckCircle2 size={12} />
                  Mark resolved
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowResolveForm(true)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-[11px] font-bold text-[#476E2C] transition hover:bg-[#EEF6E0]"
            >
              <CheckCircle2 size={12} />
              Mark resolved
            </button>
          )}
        </div>
      )}

      {canReopen && status === "resolved" && (
        <button
          type="button"
          onClick={() => onReopen?.()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-[11px] font-bold text-[#6D6E71] transition hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700"
        >
          <Clock size={12} />
          Reopen
        </button>
      )}
    </div>
  );
}
