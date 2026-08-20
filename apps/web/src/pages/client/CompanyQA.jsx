import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Loader2, Paperclip, Send, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useFeature } from '../../context/useFeature';
import { useQaStore } from '../../store/qaStore';
import {
  attachQaDocumentRequest,
  listFolderTree,
  uploadFileChunked,
} from '../../lib/api';
import { defaultFolderFor, fileSize, flattenFolders } from './qaFolders';

/**
 * The company's side of Q&A: only what has been asked of them.
 *
 * Deliberately plain. This is answered on a phone or a tablet, often by someone
 * who has never used the platform before, so it is a list of questions and a box
 * to type in — no filters, no tabs, no deck.
 */

const TAP = 'min-h-[44px] px-4';

function resolveCompanyId(user) {
  return (
    user?.company_id ||
    user?.companyId ||
    user?.company_ids?.[0] ||
    user?.assigned_companies?.[0]?.id ||
    null
  );
}

export default function CompanyQA() {
  const { user } = useAuth();
  const companyId = resolveCompanyId(user);
  const { items, loading, error, load, openItem, detail, answer, closeItem } = useQaStore();
  const canAttach = useFeature('dataroomChunkedUpload');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState('');
  const [progress, setProgress] = useState(null);
  const [sent, setSent] = useState(null);
  const [attachError, setAttachError] = useState(null);
  /** Held so a failed link can be retried without re-uploading. */
  const [uploadedDocId, setUploadedDocId] = useState(null);

  useEffect(() => {
    if (companyId) load(companyId);
  }, [companyId, load]);

  /** Folders, fetched once the sheet is actually opened rather than on page load. */
  const loadFolders = useCallback(
    (state) => {
      if (!companyId || folders.length > 0 || !canAttach) return;
      const label = detail?.item?.category_label;
      listFolderTree(companyId)
        .then((tree) => {
          if (state.cancelled) return;
          const flat = flattenFolders(tree);
          setFolders(flat);
          setFolderId(defaultFolderFor(label, flat));
        })
        .catch(() => {
          // A picker we cannot populate means no attaching; answering still works.
          if (!state.cancelled) setFolders([]);
        });
    },
    [companyId, folders.length, canAttach, detail],
  );

  // Fetched from the promise callback rather than in the effect body, so opening
  // the sheet costs one render rather than cascading.
  useEffect(() => {
    if (!detail) return undefined;
    // A holder, not a bare boolean: the promise callbacks close over the object,
    // so the cleanup's write is one the in-flight request can actually see.
    const state = { cancelled: false };
    loadFolders(state);
    return () => {
      state.cancelled = true;
    };
  }, [detail, loadFolders]);

  function dismiss() {
    setReply('');
    setFile(null);
    setProgress(null);
    setSent(null);
    setAttachError(null);
    setUploadedDocId(null);
    closeItem();
  }

  /** Link an already-uploaded document. Separate so a failure can be retried alone. */
  async function link(documentId, responseId) {
    await attachQaDocumentRequest(detail.item.id, documentId, folderId, responseId);
  }

  /**
   * Answer, then upload, then link.
   *
   * The order matters. If the upload fails the answer is already on the record —
   * the thing that must not be lost — and the message can say so honestly.
   * Uploading first would risk a document filed against nothing.
   */
  async function submit(event) {
    event.preventDefault();
    if (!reply.trim() || !detail) return;
    setBusy(true);
    setAttachError(null);
    try {
      const response = await answer(detail.item.id, reply.trim(), { kind: 'answer' });
      const folderName = folders.find((f) => f.id === folderId)?.name ?? 'the data room';

      if (!file || !canAttach || !folderId) {
        setSent({ folderName: null });
        return;
      }

      setProgress({ bytes: 0, bytesTotal: file.size });
      const uploaded = await uploadFileChunked(file, {
        fileName: file.name,
        folderId,
        onProgress: setProgress,
      });
      setUploadedDocId(uploaded.document_id);

      let linked = true;
      try {
        await link(uploaded.document_id, response?.id);
      } catch {
        // The document is filed correctly and only the backlink is missing. Never
        // delete it to repair that — a seller's uploaded file is worth more than a
        // tidy join table, and attach is idempotent so a retry is free.
        await link(uploaded.document_id, response?.id).catch(() => {
          linked = false;
          setAttachError(
            `Your file is in the data room under ${folderName}, but we could not link it to this answer.`,
          );
        });
      }
      // Only on a real link. Showing "Filed into Legal" beside an error saying it
      // was not linked is the one message worse than either alone.
      if (linked) setSent({ folderName, fileName: file.name });
    } catch (err) {
      setAttachError(
        file
          ? `Your answer is posted. The file did not upload — ${err.message}`
          : err.message,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** Retry only the link, using the document already uploaded. */
  async function retryLink() {
    setBusy(true);
    try {
      await link(uploadedDocId, null);
      setAttachError(null);
      setSent({ folderName: folders.find((f) => f.id === folderId)?.name, fileName: file?.name });
    } catch (err) {
      setAttachError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const outstanding = items.filter((i) => i.status === 'open' || i.status === 'follow_up');
  const done = items.filter((i) => i.status === 'answered' || i.status === 'closed');

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-[#050505]">Questions for you</h1>
        <p className="mt-1 text-sm text-[#6B7280]">
          {outstanding.length === 0
            ? 'Nothing outstanding — thank you.'
            : `${outstanding.length} still to answer.`}
        </p>
      </header>

      {error && (
        <p className="rounded-xl bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-[#6B7280]">
          <Loader2 className="animate-spin" size={16} /> Loading…
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {outstanding.map((item) => (
              <li key={item.id} className="rounded-2xl bg-white p-4 shadow-card">
                <div className="flex items-center gap-2 text-xs text-[#A86F0B]">
                  <Clock size={12} />
                  {item.category_label ?? 'General'}
                </div>
                <p className="mt-2 text-base font-medium text-[#111827]">{item.title}</p>
                <p className="mt-1 text-sm text-[#4B5563]">{item.body}</p>
                <button
                  type="button"
                  onClick={() => openItem(item.id)}
                  className={`${TAP} mt-3 inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white`}
                >
                  <Send size={14} />
                  Answer
                </button>
              </li>
            ))}
          </ul>

          {done.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-[#6B7280]">Already answered</h2>
              <ul className="space-y-2">
                {done.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-xl bg-white p-3 text-sm text-[#4B5563] shadow-card"
                  >
                    <CheckCircle2 size={14} className="text-[#166534]" />
                    {item.title}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/30 sm:items-center sm:justify-center">
          {/* A bottom sheet on a phone, a dialog on a laptop. */}
          <form
            onSubmit={submit}
            className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-lg sm:rounded-2xl"
          >
            <p className="text-base font-medium text-[#111827]">{detail.item.title}</p>
            <p className="mt-1 text-sm text-[#4B5563]">{detail.item.body}</p>
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={5}
              autoFocus
              placeholder="Your answer…"
              className="mt-4 w-full rounded-xl border border-[#E5E7EB] p-3 text-base"
            />
            {/* Attaching. The row is one line until a file is chosen — a folder
                picker with nothing to file in it is noise. */}
            {canAttach && folders.length > 0 && !sent && (
              <div className="mt-3">
                {!file ? (
                  <label
                    className={`${TAP} inline-flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-[#D1D5DB] text-sm text-[#4B5563]`}
                  >
                    <Paperclip size={15} />
                    Attach a file
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const chosen = e.target.files?.[0];
                        // A zero-byte file 400s with a message nobody can act on.
                        if (chosen && chosen.size > 0) setFile(chosen);
                        e.target.value = '';
                      }}
                    />
                  </label>
                ) : (
                  <div className="rounded-xl border border-[#E5E7EB] p-3">
                    <div className="flex items-center gap-2">
                      <Paperclip size={14} className="shrink-0 text-[#6B7280]" />
                      <span className="flex-1 truncate text-sm text-[#111827]">{file.name}</span>
                      <span className="text-xs text-[#9CA3AF]">{fileSize(file.size)}</span>
                      <button
                        type="button"
                        onClick={() => setFile(null)}
                        aria-label="Remove file"
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-[#6B7280]"
                      >
                        <X size={16} />
                      </button>
                    </div>

                    <label className="mt-3 block text-xs font-medium text-[#6B7280]">
                      File it under
                    </label>
                    <select
                      value={folderId}
                      onChange={(e) => setFolderId(e.target.value)}
                      className={`${TAP} mt-1 w-full rounded-xl border border-[#E5E7EB] text-sm`}
                    >
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {`${'\u00A0'.repeat(f.depth * 2)}${f.name}`}
                        </option>
                      ))}
                    </select>
                    {/* Said in plain text too, so a distracted person sees where it
                        is going without opening the picker. */}
                    <p className="mt-1 text-xs text-[#6B7280]">
                      Goes into {folders.find((f) => f.id === folderId)?.name ?? '—'}
                    </p>

                    {progress && (
                      <div className="mt-3">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#E5E7EB]">
                          <div
                            className="h-full rounded-full bg-[#05164D] transition-all"
                            style={{
                              width: `${Math.round((progress.bytes / progress.bytesTotal) * 100)}%`,
                            }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-[#6B7280]">
                          Uploading {fileSize(progress.bytes)} of {fileSize(progress.bytesTotal)}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {attachError && (
              <div className="mt-3 rounded-xl bg-[#FEF2F2] p-3 text-sm text-[#B91C1C]">
                {attachError}
                {uploadedDocId && (
                  <button
                    type="button"
                    onClick={retryLink}
                    className="mt-2 block font-medium underline"
                  >
                    Try linking it again
                  </button>
                )}
              </div>
            )}

            {/* Kept open on success. The seller needs to see their own file land —
                the route returns no body, so nothing else would tell them. */}
            {sent ? (
              <div className="mt-4">
                <div className="flex items-start gap-2 rounded-xl bg-[#ECFDF5] p-3 text-sm text-[#065F46]">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                  <span>
                    Answer posted.
                    {sent.fileName ? ` ${sent.fileName} is filed under ${sent.folderName}.` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={dismiss}
                  className={`${TAP} mt-3 w-full rounded-xl bg-[#05164D] text-sm font-medium text-white`}
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <p className="mt-2 text-xs text-[#9CA3AF]">
                  Once posted, an answer stays on the record. If you need to correct it, post again
                  and both versions are kept.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={dismiss} className={`${TAP} rounded-xl text-sm text-[#6B7280]`}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !reply.trim()}
                    className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-50`}
                  >
                    {busy ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
                    {file ? 'Send with file' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
