import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CheckCircle2,
  CircleSlash,
  FileText,
  Loader2,
  Lock,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import {
  acceptCimAnswerRequest,
  createCimDeckRequest,
  discardCimAnswerRequest,
  generateCimQuestionsRequest,
  getCimHealthRequest,
  getCimVersionRequest,
  listCimDecksRequest,
  listCimGapsRequest,
  listCimReviewQueueRequest,
  listCimVersionsRequest,
  saveCimBlocksRequest,
} from '../../../lib/api';

/**
 * The CIM builder.
 *
 * Scoped to the half that makes the pitch: which slides are still empty, one
 * action that asks the company about exactly those, a queue where the broker
 * decides what reaches the deck, and the published PDF in the data room.
 *
 * The visual deck editor is the existing CIM Prep screen, which renders 38
 * extracted layouts and is unchanged. See the change's design notes for why the
 * two are not yet one surface.
 */

const TAP = 'min-h-[44px] px-4';

function when(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function WorkspaceCimBuilder() {
  const { clientId } = useParams();
  const [decks, setDecks] = useState(null);
  const [deck, setDeck] = useState(null);
  const [versions, setVersions] = useState([]);
  const [detail, setDetail] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [queue, setQueue] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState({});
  const [editing, setEditing] = useState({});

  const loadDeck = useCallback(async (versionId, deckId) => {
    const [nextDetail, nextGaps, nextQueue, nextHealth, nextVersions] = await Promise.all([
      getCimVersionRequest(versionId),
      listCimGapsRequest(versionId),
      listCimReviewQueueRequest(versionId),
      getCimHealthRequest(versionId),
      listCimVersionsRequest(deckId),
    ]);
    return { nextDetail, nextGaps, nextQueue, nextHealth, nextVersions };
  }, []);

  const apply = useCallback((r) => {
    setDetail(r.nextDetail);
    setGaps(r.nextGaps);
    setQueue(r.nextQueue);
    setHealth(r.nextHealth);
    setVersions(r.nextVersions);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listCimDecksRequest(clientId)
      .then(async (list) => {
        if (cancelled) return;
        setDecks(list);
        const first = list[0];
        if (!first?.current_version_id) return;
        setDeck(first);
        apply(await loadDeck(first.current_version_id, first.id));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, loadDeck, apply]);

  const refresh = useCallback(async () => {
    if (!deck?.current_version_id) return;
    apply(await loadDeck(deck.current_version_id, deck.id));
  }, [deck, loadDeck, apply]);

  const published = useMemo(
    () => versions.find((v) => v.status === 'published' && v.document_id),
    [versions],
  );

  async function createDeck() {
    setBusy(true);
    try {
      const created = await createCimDeckRequest(clientId, 'Confidential Information Memorandum');
      setDeck(created);
      setDecks([created]);
      apply(await loadDeck(created.current_version_id, created.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  /** Ask the company about exactly the blocks that are still empty. */
  async function sendRequest() {
    const questions = gaps
      .filter((gap) => selected[gap.block_id] !== false && gap.question_text)
      .map((gap) => ({
        block_id: gap.block_id,
        text: editing[gap.block_id] ?? gap.question_text,
      }));
    if (questions.length === 0) return;
    setBusy(true);
    try {
      await generateCimQuestionsRequest(deck.current_version_id, questions);
      setComposing(false);
      setSelected({});
      setEditing({});
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function accept(item, mode) {
    setBusy(true);
    try {
      await acceptCimAnswerRequest(item.block_id, {
        qa_item_id: item.qa_item_id,
        qa_response_id: item.qa_response_id,
        mode,
        ...(editing[item.qa_response_id] ? { text: editing[item.qa_response_id] } : {}),
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function discard(item) {
    setBusy(true);
    try {
      await discardCimAnswerRequest(item.block_id, {
        qa_item_id: item.qa_item_id,
        qa_response_id: item.qa_response_id,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveBlock(block, value) {
    setBusy(true);
    try {
      await saveCimBlocksRequest(deck.current_version_id, {
        blocks: [{ block_key: block.block_key, content: value }],
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (decks === null) {
    return (
      <div className="flex items-center gap-2 p-10 text-sm text-[#6B7280]">
        <Loader2 className="animate-spin" size={16} /> Loading…
      </div>
    );
  }

  if (!deck) {
    return (
      <div className="mx-auto max-w-lg p-10 text-center">
        <h1 className="text-lg font-semibold text-[#111827]">No CIM yet</h1>
        <p className="mt-2 text-sm text-[#6B7280]">
          Start one and the section outline is created for you.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={createDeck}
          className={`${TAP} mt-4 inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-60`}
        >
          {busy && <Loader2 className="animate-spin" size={14} />}
          Start a CIM
        </button>
      </div>
    );
  }

  const filled = detail
    ? detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks)).filter((b) => b.populated_by)
        .length
    : 0;
  const total = detail
    ? detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks)).length
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">{deck.name}</h1>
          <p className="mt-1 text-sm text-[#6B7280]">
            {filled} of {total} sections written
            {health?.outstanding_questions
              ? ` · ${health.outstanding_questions} question${health.outstanding_questions === 1 ? '' : 's'} outstanding`
              : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {published && (
            <a
              href={`/#/broker/client/${clientId}/dataroom/documents`}
              className={`${TAP} inline-flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-white text-sm font-medium text-[#374151]`}
            >
              <FileText size={16} />
              Published v{published.version_no} in the data room
            </a>
          )}
          <button
            type="button"
            disabled={gaps.length === 0}
            onClick={() => setComposing((v) => !v)}
            className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-50`}
          >
            <Send size={16} />
            Request missing info ({gaps.length})
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
          <X size={16} />
          {error}
        </div>
      )}

      {composing && (
        <section className="rounded-2xl bg-white p-5 shadow-card">
          <h2 className="text-sm font-semibold text-[#111827]">
            Ask the company about what is still missing
          </h2>
          <p className="mt-1 text-xs text-[#6B7280]">
            These questions go to the company through Q&amp;A. Reword anything — the library
            entry is not changed.
          </p>
          <ul className="mt-4 space-y-3">
            {gaps.map((gap) => (
              <li key={gap.block_id} className="rounded-xl border border-[#E5E7EB] p-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected[gap.block_id] !== false}
                    disabled={!gap.question_text}
                    onChange={(e) =>
                      setSelected((v) => ({ ...v, [gap.block_id]: e.target.checked }))
                    }
                    className="mt-3 h-5 w-5 shrink-0"
                  />
                  <span className="flex-1">
                    <span className="text-xs uppercase tracking-wide text-[#9CA3AF]">
                      {gap.section_key.replace(/-/g, ' ')}
                    </span>
                    {gap.question_text ? (
                      <textarea
                        value={editing[gap.block_id] ?? gap.question_text}
                        onChange={(e) =>
                          setEditing((v) => ({ ...v, [gap.block_id]: e.target.value }))
                        }
                        rows={2}
                        className="mt-1 w-full rounded-lg border border-[#E5E7EB] p-2 text-sm"
                      />
                    ) : (
                      <span className="mt-1 flex items-center gap-1 text-sm text-[#B45309]">
                        <CircleSlash size={13} />
                        No question mapped to this block — write one on the slide instead.
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setComposing(false)} className={`${TAP} rounded-xl text-sm text-[#6B7280]`}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={sendRequest}
              className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-60`}
            >
              {busy ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
              Send
            </button>
          </div>
        </section>
      )}

      {queue.length > 0 && (
        <section className="rounded-2xl bg-white p-5 shadow-card">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111827]">
            <Sparkles size={15} className="text-[#4338CA]" />
            Answers waiting for you ({queue.length})
          </h2>
          <p className="mt-1 text-xs text-[#6B7280]">
            Nothing reaches a slide until you accept it. Edit first if the wording is not right
            for a buyer — the company&apos;s original stays on the record either way.
          </p>
          <ul className="mt-4 space-y-4">
            {queue.map((item) => (
              <li key={item.qa_response_id} className="rounded-xl border border-[#C7D2FE] bg-[#F5F7FF] p-4">
                <p className="text-xs uppercase tracking-wide text-[#6366F1]">
                  {item.section_key.replace(/-/g, ' ')}
                </p>
                <p className="mt-1 text-sm font-medium text-[#312E81]">{item.question_text}</p>
                <p className="mt-2 text-xs text-[#6B7280]">
                  {item.respondent_name ?? 'The company'} · {when(item.submitted_at)}
                </p>
                <textarea
                  value={editing[item.qa_response_id] ?? item.answer_text}
                  onChange={(e) =>
                    setEditing((v) => ({ ...v, [item.qa_response_id]: e.target.value }))
                  }
                  rows={3}
                  className="mt-2 w-full rounded-lg border border-[#C7D2FE] bg-white p-3 text-sm"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => accept(item, item.block_has_content ? 'replace' : 'skip')}
                    className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#4338CA] text-sm font-medium text-white disabled:opacity-60`}
                  >
                    <CheckCircle2 size={14} />
                    {item.block_has_content ? 'Replace what is there' : 'Put this on the slide'}
                  </button>
                  {item.block_has_content && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => accept(item, 'append')}
                      className={`${TAP} rounded-xl border border-[#C7D2FE] bg-white text-sm text-[#4338CA]`}
                    >
                      Add underneath
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => discard(item)}
                    className={`${TAP} rounded-xl text-sm text-[#6B7280]`}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail && (
        <section className="space-y-4">
          {detail.sections.map((section) => (
            <div key={section.id} className="rounded-2xl bg-white p-5 shadow-card">
              <h3 className="text-sm font-semibold text-[#111827]">{section.title}</h3>
              <ul className="mt-3 space-y-3">
                {section.slides.flatMap((slide) =>
                  slide.blocks.map((block) => (
                    <li key={block.id}>
                      <label className="text-xs text-[#6B7280]">{block.label}</label>
                      <textarea
                        defaultValue={typeof block.content === 'string' ? block.content : ''}
                        onBlur={(e) => {
                          const next = e.target.value;
                          const current = typeof block.content === 'string' ? block.content : '';
                          if (next !== current) saveBlock(block, next);
                        }}
                        rows={2}
                        disabled={detail.version.status !== 'draft'}
                        placeholder="Not written yet"
                        className="mt-1 w-full rounded-xl border border-[#E5E7EB] p-3 text-sm disabled:bg-[#F9FAFB]"
                      />
                      {block.content_class_locked && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-[#9CA3AF]">
                          <Lock size={11} />
                          Came from the company&apos;s answer — stays with this deal.
                        </p>
                      )}
                    </li>
                  )),
                )}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
