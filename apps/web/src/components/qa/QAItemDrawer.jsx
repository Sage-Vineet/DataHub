import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink, History, Loader2, Lock, Paperclip, Send, Sparkles, X } from 'lucide-react';
import { getQaAuditRequest } from '../../lib/api';
import { useQaStore } from '../../store/qaStore';
import { useFeature } from '../../context/useFeature';

/**
 * One Q&A item: the thread, the answer's version history, and — for the deal
 * team — the presentable version beside the words the company actually wrote.
 *
 * The side-by-side is the point. A rewording that replaced the original would be
 * indistinguishable from an edit, and the whole reason it lives in its own record
 * is that the seller's answer is immutable.
 */

const TAP = 'min-h-[44px] px-4';

/**
 * A document attached as evidence for an answer.
 *
 * Links into the data room and opens the file, because the claim the chip makes —
 * "here is the lease that says that" — is only worth anything if the reader can
 * check it. Both ids come with the item detail, so the link needs no lookup.
 *
 * Falls back to a plain chip where the data room is switched off or there is no
 * company in the route (the seller's view). A link to a "coming soon" page is
 * worse than no link.
 */
function AttachmentChip({ attachment, clientId, linkable }) {
  const label = attachment.name ?? 'Attachment';
  const base =
    'inline-flex items-center gap-1.5 rounded-full bg-[#EFF6FF] px-2.5 py-1 text-xs text-[#1D4ED8]';

  if (!linkable || !clientId || !attachment.document_id) {
    return (
      <span className={base}>
        <Paperclip size={11} />
        {label}
      </span>
    );
  }

  const params = new URLSearchParams({ doc: attachment.document_id });
  if (attachment.folder_id) params.set('folder', attachment.folder_id);

  return (
    <Link
      to={`/broker/client/${clientId}/dataroom/documents?${params}`}
      className={`${base} hover:bg-[#DBEAFE] hover:underline`}
      title={`Open ${label} in the data room`}
    >
      <Paperclip size={11} />
      {label}
      <ExternalLink size={10} />
    </Link>
  );
}

function timestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function QAItemDrawer({ detail, onClose, currentUser }) {
  const { answer, reword, setStatus } = useQaStore();
  const canReword = useFeature('qaPresentation');
  const canLink = useFeature('dataroom');
  const { clientId } = useParams();
  const [reply, setReply] = useState('');
  const [rewording, setRewording] = useState(null);
  const [rewordText, setRewordText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(false);
  // Fetched only when the section is opened — an audit is a deliberate look.
  const [audit, setAudit] = useState(null);

  const { item, responses, presentations } = detail;
  const isDealTeam = currentUser?.role === 'broker' || currentUser?.role === 'admin';

  // Superseded answers are hidden by default — the current text is what matters
  // at a glance — but never dropped, because the earlier version is still cited.
  const visibleResponses = useMemo(
    () => responses.filter((r) => showSuperseded || r.is_current || !r.answer_root_id),
    [responses, showSuperseded],
  );
  const supersededCount = responses.length - visibleResponses.length;

  const presentationFor = (responseId) =>
    presentations.find((p) => p.source_response_id === responseId);

  async function submitReply(event) {
    event.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await answer(item.id, reply.trim(), { kind: isDealTeam ? 'comment' : 'answer' });
      setReply('');
    } finally {
      setBusy(false);
    }
  }

  async function submitReword(responseId) {
    if (!rewordText.trim()) return;
    setBusy(true);
    try {
      await reword(item.id, responseId, rewordText.trim());
      setRewording(null);
      setRewordText('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
      {/* Full-width below lg: a side panel on a tablet is unusable. */}
      <div className="flex h-[100dvh] w-full flex-col bg-white lg:w-[640px]">
        <header className="flex items-start justify-between gap-3 border-b border-[#F3F4F6] p-5">
          <div>
            <p className="font-mono text-xs text-[#9CA3AF]">{item.reference}</p>
            <h2 className="mt-1 text-lg font-semibold text-[#111827]">{item.title}</h2>
            <p className="mt-1 text-xs text-[#6B7280]">
              Asked by {item.requestor_name ?? 'someone'} · {timestamp(item.asked_at)}
              {item.category_label ? ` · ${item.category_label}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-[#6B7280] hover:bg-[#F3F4F6]"
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <p className="whitespace-pre-wrap rounded-xl bg-[#F9FAFB] p-4 text-sm text-[#374151]">
            {item.body}
          </p>

          {supersededCount > 0 && (
            <button
              type="button"
              onClick={() => setShowSuperseded((v) => !v)}
              className="inline-flex items-center gap-2 text-xs font-medium text-[#2563EB]"
            >
              <History size={14} />
              {showSuperseded
                ? 'Hide earlier versions'
                : `Show ${supersededCount} earlier version${supersededCount === 1 ? '' : 's'}`}
            </button>
          )}

          {visibleResponses.map((response) => {
            const presentation = presentationFor(response.id);
            const superseded = response.answer_root_id && !response.is_current;
            return (
              <article
                key={response.id}
                className={`rounded-xl border p-4 ${
                  superseded ? 'border-dashed border-[#E5E7EB] opacity-70' : 'border-[#E5E7EB]'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#6B7280]">
                  <span className="font-medium text-[#374151]">
                    {response.author_name ?? 'Unknown'}
                  </span>
                  <span>{timestamp(response.posted_at)}</span>
                  <span className="font-mono text-[#9CA3AF]">{response.citation_ref}</span>
                  {response.answer_root_id && (
                    <span className="rounded-full bg-[#F3F4F6] px-2 py-0.5">
                      v{response.answer_version}
                      {superseded ? ' · superseded' : ' · current'}
                    </span>
                  )}
                  {/* The answer cannot be edited, and saying so is kinder than
                      letting someone hunt for the button. */}
                  <span className="inline-flex items-center gap-1 text-[#9CA3AF]">
                    <Lock size={11} /> on the record
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-[#111827]">{response.body}</p>

                {response.attachments.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {response.attachments.map((a) => (
                      <li key={a.document_id}>
                        <AttachmentChip attachment={a} clientId={clientId} linkable={canLink} />
                      </li>
                    ))}
                  </ul>
                )}

                {presentation && (
                  <div className="mt-3 rounded-lg border border-[#C7D2FE] bg-[#EEF2FF] p-3">
                    <p className="flex items-center gap-1 text-xs font-medium text-[#4338CA]">
                      <Sparkles size={12} />
                      Presentable version
                      {presentation.status === 'draft' ? ' (draft — not shared)' : ''}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[#312E81]">
                      {presentation.body}
                    </p>
                    <p className="mt-1 text-xs text-[#6366F1]">
                      Written by {presentation.author_name ?? 'the deal team'} · the answer above is
                      unchanged
                    </p>
                  </div>
                )}

                {isDealTeam && canReword && response.kind === 'answer' && !presentation && (
                  <div className="mt-3">
                    {rewording === response.id ? (
                      <>
                        <textarea
                          value={rewordText}
                          onChange={(e) => setRewordText(e.target.value)}
                          rows={3}
                          placeholder="How should this read to a buyer?"
                          className="w-full rounded-xl border border-[#E5E7EB] p-3 text-sm"
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setRewording(null)}
                            className={`${TAP} rounded-xl text-sm text-[#6B7280]`}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => submitReword(response.id)}
                            className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#4338CA] text-sm font-medium text-white disabled:opacity-60`}
                          >
                            {busy && <Loader2 className="animate-spin" size={14} />}
                            Save &amp; publish
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setRewording(response.id);
                          setRewordText(response.body);
                        }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#4338CA]"
                      >
                        <Sparkles size={12} />
                        Write a presentable version
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {/* The whole exchange in order, assembled server-side from the
              assignment log, the responses and the published rewordings. */}
          <details
            className="rounded-xl border border-[#E5E7EB] p-4"
            onToggle={(e) => {
              if (e.currentTarget.open && audit === null) {
                getQaAuditRequest(item.id)
                  .then((trail) => setAudit(trail.entries))
                  .catch(() => setAudit([]));
              }
            }}
          >
            <summary className="cursor-pointer text-xs font-medium text-[#6B7280]">
              Audit trail
            </summary>
            {audit === null ? (
              <p className="mt-2 text-xs text-[#9CA3AF]">Loading…</p>
            ) : (
              <ol className="mt-2 space-y-1 text-xs text-[#6B7280]">
                {audit.map((entry, i) => (
                  <li key={`${entry.at}-${i}`}>
                    <span className="text-[#9CA3AF]">{timestamp(entry.at)}</span> —{' '}
                    <span className="font-medium text-[#374151]">
                      {entry.actor_name ?? 'someone'}
                    </span>{' '}
                    {entry.kind}
                    {entry.citation_ref ? ` (${entry.citation_ref})` : ''}
                  </li>
                ))}
              </ol>
            )}
          </details>
        </div>

        <form onSubmit={submitReply} className="border-t border-[#F3F4F6] p-4">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            placeholder={isDealTeam ? 'Add a follow-up…' : 'Answer this question…'}
            className="w-full rounded-xl border border-[#E5E7EB] p-3 text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {isDealTeam && (
              <select
                value={item.status}
                onChange={(e) => setStatus(item.id, e.target.value)}
                className={`${TAP} rounded-xl border border-[#E5E7EB] text-sm`}
              >
                <option value="open">Open</option>
                <option value="answered">Answered</option>
                <option value="follow_up">Follow-up</option>
                <option value="closed">Closed</option>
              </select>
            )}
            <button
              type="submit"
              disabled={busy || !reply.trim()}
              className={`${TAP} ml-auto inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-50`}
            >
              {busy ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
              Post
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
