import { useCallback, useEffect, useState } from 'react';
import {
  History,
  Loader2,
  Lock,
  MessageSquare,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import {
  createDocumentCommentRequest,
  documentVersionContentUrl,
  listDocumentCommentsRequest,
  listDocumentVersionsRequest,
  restoreDocumentVersionRequest,
} from '../../lib/api';
import { useFeature } from '../../context/useFeature';

/**
 * Version history and commentary for one document.
 *
 * A drawer beside the existing preview rather than a rewrite of it: the file
 * explorer already renders PDFs, spreadsheets and Word documents, and replacing
 * that would be a lot of risk for no story.
 *
 * Each panel returns nothing when its own flag is off — an empty tab is worse
 * than an absent one, because it reads as broken rather than as not-here.
 */

const TAP = 'min-h-[44px] px-4';

function when(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function bytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentDetailDrawer({ document: doc, isDealTeam, onClose, onChanged }) {
  const versionsEnabled = useFeature('dataroomVersions');
  const commentsEnabled = useFeature('dataroomComments');
  const [tab, setTab] = useState(versionsEnabled ? 'versions' : 'comments');
  const [versions, setVersions] = useState(null);
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState('');
  const [visibility, setVisibility] = useState(isDealTeam ? 'internal' : 'shared');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /** Fetch both panels. Resolves to what they should show; sets nothing itself. */
  const fetchAll = useCallback(
    () =>
      Promise.all([
        versionsEnabled ? listDocumentVersionsRequest(doc.id) : null,
        commentsEnabled ? listDocumentCommentsRequest(doc.id) : null,
      ]),
    [doc.id, versionsEnabled, commentsEnabled],
  );

  const apply = useCallback(
    ([nextVersions, nextComments]) => {
      if (versionsEnabled) setVersions(nextVersions);
      if (commentsEnabled) setComments(nextComments);
      setError(null);
    },
    [versionsEnabled, commentsEnabled],
  );

  // State is set from the promise callbacks rather than in the effect body, so
  // opening the drawer costs one render rather than cascading.
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((result) => {
        if (!cancelled) apply(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAll, apply]);

  const reload = useCallback(
    () => fetchAll().then(apply).catch((err) => setError(err.message)),
    [fetchAll, apply],
  );

  async function restore(versionId) {
    setBusy(true);
    try {
      await restoreDocumentVersionRequest(doc.id, versionId);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function comment(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await createDocumentCommentRequest(doc.id, draft.trim(), visibility);
      setDraft('');
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!versionsEnabled && !commentsEnabled) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
      <div className="flex h-[100dvh] w-full flex-col bg-white lg:w-[520px]">
        <header className="flex items-start justify-between gap-3 border-b border-gray-100 p-5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[#111827]">{doc.name}</h2>
            <p className="mt-1 text-xs text-[#6B7280]">
              {versions ? `${versions.version_count} version${versions.version_count === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[#6B7280] hover:bg-gray-50"
          >
            <X size={20} />
          </button>
        </header>

        <nav className="flex gap-1 border-b border-gray-100 px-3">
          {versionsEnabled && (
            <button
              type="button"
              onClick={() => setTab('versions')}
              className={`${TAP} inline-flex items-center gap-2 border-b-2 text-sm ${
                tab === 'versions'
                  ? 'border-[#05164D] font-medium text-[#05164D]'
                  : 'border-transparent text-[#6B7280]'
              }`}
            >
              <History size={14} /> Versions
            </button>
          )}
          {commentsEnabled && (
            <button
              type="button"
              onClick={() => setTab('comments')}
              className={`${TAP} inline-flex items-center gap-2 border-b-2 text-sm ${
                tab === 'comments'
                  ? 'border-[#05164D] font-medium text-[#05164D]'
                  : 'border-transparent text-[#6B7280]'
              }`}
            >
              <MessageSquare size={14} /> Comments
            </button>
          )}
        </nav>

        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <p className="mb-4 rounded-xl bg-[#FEF2F2] p-3 text-sm text-[#B91C1C]">{error}</p>
          )}

          {tab === 'versions' && versionsEnabled && (
            versions === null ? (
              <p className="flex items-center gap-2 text-sm text-[#6B7280]">
                <Loader2 className="animate-spin" size={14} /> Loading…
              </p>
            ) : (
              <ul className="space-y-3">
                {versions.versions.map((v) => (
                  <li
                    key={v.id}
                    className={`rounded-xl border p-4 ${
                      v.is_current ? 'border-[#05164D] bg-[#F8FAFF]' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[#111827]">v{v.version_no}</span>
                      {v.is_current && (
                        <span className="rounded-full bg-[#05164D] px-2 py-0.5 text-xs text-white">
                          current
                        </span>
                      )}
                      <span className="text-xs text-[#9CA3AF]">{bytes(v.size_bytes)}</span>
                    </div>
                    <p className="mt-1 text-xs text-[#6B7280]">{when(v.created_at)}</p>
                    {v.note && <p className="mt-1 text-xs italic text-[#6B7280]">{v.note}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <a
                        href={documentVersionContentUrl(v.id)}
                        target="_blank"
                        rel="noreferrer"
                        className={`${TAP} inline-flex items-center rounded-xl border border-gray-200 text-sm text-[#374151]`}
                      >
                        Open this version
                      </a>
                      {!v.is_current && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => restore(v.id)}
                          className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-60`}
                        >
                          <RotateCcw size={14} />
                          Make current
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === 'comments' && commentsEnabled && (
            comments === null ? (
              <p className="flex items-center gap-2 text-sm text-[#6B7280]">
                <Loader2 className="animate-spin" size={14} /> Loading…
              </p>
            ) : comments.length === 0 ? (
              <p className="text-sm text-[#6B7280]">No comments on this document yet.</p>
            ) : (
              <ul className="space-y-3">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-xl border border-gray-200 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#6B7280]">
                      <span className="font-medium text-[#374151]">{c.author_name ?? 'Unknown'}</span>
                      <span>{when(c.created_at)}</span>
                      {c.visibility === 'internal' && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#FEF3C7] px-2 py-0.5 text-[#A86F0B]">
                          <Lock size={10} /> internal
                        </span>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-[#111827]">{c.body}</p>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>

        {tab === 'comments' && commentsEnabled && (
          <form onSubmit={comment} className="border-t border-gray-100 p-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="Add a comment…"
              className="w-full rounded-xl border border-gray-200 p-3 text-sm"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              {isDealTeam && (
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  className={`${TAP} rounded-xl border border-gray-200 text-sm`}
                >
                  <option value="internal">Internal — our side only</option>
                  <option value="shared">Shared with the company</option>
                </select>
              )}
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className={`${TAP} ml-auto inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-50`}
              >
                {busy ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
                Post
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
