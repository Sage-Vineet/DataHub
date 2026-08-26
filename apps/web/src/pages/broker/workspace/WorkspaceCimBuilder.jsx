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
  createCimDraftRequest,
  discardCimAnswerRequest,
  generateCimQuestionsRequest,
  getCimHealthRequest,
  getCimVersionRequest,
  listCimDecksRequest,
  listCimGapsRequest,
  listCimReviewQueueRequest,
  listCimVersionsRequest,
  publishCimVersionRequest,
  saveCimBlocksRequest,
} from '../../../lib/api';
import { buildCimPdf } from '../../../features/cim/cimPdfExport';

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
  /** block_key → 'saving' | 'saved' | 'failed'. Cleared a moment after success. */
  const [blockState, setBlockState] = useState({});
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

  /**
   * Publishing freezes the version, and the deck's current version is derived as
   * the LATEST one — so once the newest version is published there is nothing
   * editable left and every control refuses. Without a way to start the next
   * draft the builder is a one-way door: the first person to publish leaves it
   * read-only for everyone after them.
   */
  const frozen = detail?.version?.status && detail.version.status !== 'draft';

  async function startNextDraft() {
    if (!deck) return;
    setBusy(true);
    try {
      const draft = await createCimDraftRequest(deck.id);
      apply(await loadDeck(draft.id, deck.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

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

  /**
   * Render the deck and freeze the version around it.
   *
   * Rendering is text-primitive jsPDF, so it finishes in well under a second
   * even on a tablet — but a watchdog still bounds it, because a publish button
   * that spins forever in front of a stranger is worse than one that says it
   * failed.
   */
  async function publish() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const { blob, pageCount } = await Promise.race([
        Promise.resolve().then(() =>
          buildCimPdf({
            deckName: deck.name,
            cover: detail.cover,
            versionNo: detail.version.version_no,
            status: detail.version.status,
            sections: detail.sections,
          }),
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Rendering took too long — try again.')), 25_000),
        ),
      ]);
      await publishCimVersionRequest(deck.current_version_id, blob, { pageCount });
      const decks = await listCimDecksRequest(clientId);
      const next = decks.find((d) => d.id === deck.id) ?? decks[0];
      setDecks(decks);
      setDeck(next);
      apply(await loadDeck(next.current_version_id, next.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  /** Preview without freezing anything — the same renderer, opened in a tab. */
  function preview() {
    if (!detail) return;
    const { blob } = buildCimPdf({
      deckName: deck.name,
      cover: detail.cover,
      versionNo: detail.version.version_no,
      status: detail.version.status,
      sections: detail.sections,
    });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  }

  /**
   * Save one answer, and say so.
   *
   * A CIM is filled in over days, often by the business owner. There was no save
   * button, no dirty state and no confirmation — the answer went on blur and the
   * writer had nothing telling them it had been kept. For a long document that
   * is not a polish issue: it is the reason people retype things, or copy them
   * into a Word file first.
   */
  async function saveBlock(block, value) {
    setBusy(true);
    setBlockState((prev) => ({ ...prev, [block.block_key]: 'saving' }));
    try {
      await saveCimBlocksRequest(deck.current_version_id, {
        blocks: [{ block_key: block.block_key, content: value }],
      });
      await refresh();
      setBlockState((prev) => ({ ...prev, [block.block_key]: 'saved' }));
      // The tick is reassurance, not a permanent badge — it clears once read.
      window.setTimeout(
        () => setBlockState((prev) => (prev[block.block_key] === 'saved'
          ? { ...prev, [block.block_key]: undefined }
          : prev)),
        2500,
      );
    } catch (err) {
      setError(err.message);
      setBlockState((prev) => ({ ...prev, [block.block_key]: 'failed' }));
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

  /**
   * Answered means answered — the same rule the server applies.
   *
   * The counts here tested `populated_by` alone, which is set the moment a field
   * is saved for the first time. Saving a field and then clearing it left it
   * marked as written, so "12 of 29 sections written" could include blanks and
   * the gap count would miss them. The service's own `hasContent` requires both
   * a writer AND actual content; this mirrors it so the two agree.
   */
  const isAnswered = (block) => {
    if (!block.populated_by) return false;
    const c = block.content;
    if (c === null || c === undefined) return false;
    if (typeof c === 'string') return c.trim().length > 0;
    if (Array.isArray(c)) return c.length > 0;
    if (typeof c === 'object') return Object.keys(c).length > 0;
    return true;
  };

  const filled = detail
    ? detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks)).filter(isAnswered).length
    : 0;
  const total = detail
    ? detail.sections.flatMap((s) => s.slides.flatMap((sl) => sl.blocks)).length
    : 0;

  /** Per-section written/total, for the outline. */
  const sectionProgress = detail
    ? detail.sections.map((section) => {
        const blocks = section.slides.flatMap((sl) => sl.blocks);
        return {
          id: section.id,
          title: section.title,
          total: blocks.length,
          written: blocks.filter(isAnswered).length,
        };
      })
    : [];

  /** Every question still unanswered, in document order. */
  const unansweredKeys = detail
    ? detail.sections
        .flatMap((s) => s.slides.flatMap((sl) => sl.blocks))
        .filter((b) => !isAnswered(b))
        .map((b) => b.block_key)
    : [];

  /**
   * Move to the next gap, cycling from wherever the reader is.
   *
   * Focus rather than just scroll: the point of jumping to a blank field is to
   * answer it, and landing next to it with the cursor somewhere else would make
   * the reader click again.
   */
  function goToNextGap() {
    if (unansweredKeys.length === 0) return;
    const active = document.activeElement?.closest('[id^="cim-block-"]')?.id;
    const activeKey = active ? active.replace('cim-block-', '') : null;
    const from = activeKey ? unansweredKeys.indexOf(activeKey) : -1;
    const nextKey = unansweredKeys[(from + 1) % unansweredKeys.length];
    const el = document.getElementById(`cim-block-${nextKey}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.querySelector('textarea')?.focus({ preventScroll: true });
  }

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
            className={`${TAP} inline-flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-white text-sm font-medium text-[#374151] disabled:opacity-50`}
          >
            <Send size={16} />
            Request missing info ({gaps.length})
          </button>
          <button
            type="button"
            onClick={preview}
            className={`${TAP} inline-flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-white text-sm font-medium text-[#374151]`}
          >
            <FileText size={16} />
            Preview
          </button>
          {frozen && (
            <button
              type="button"
              disabled={busy}
              onClick={startNextDraft}
              className={`${TAP} inline-flex items-center gap-2 rounded-xl border border-[#05164D] bg-white text-sm font-medium text-[#05164D] disabled:opacity-60`}
            >
              {busy ? <Loader2 className="animate-spin" size={16} /> : <FileText size={16} />}
              Start v{(detail?.version?.version_no ?? 0) + 1}
            </button>
          )}
          {!frozen && health?.publishable && (
            <button
              type="button"
              disabled={busy}
              onClick={publish}
              className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-60`}
            >
              {busy ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
              Publish to the data room
            </button>
          )}
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
        /*
          Two columns: an outline that stays put, and the questions.

          29 questions across ten sections used to be one unbroken scroll with no
          way to see the shape of the document, jump to a section, or find the
          gaps the header was counting. Reaching the last section meant scrolling
          past everything — and the wide empty right-hand side was doing nothing.
        */
        <section className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
          <nav className="rounded-2xl bg-white p-4 shadow-card lg:sticky lg:top-5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
              Sections
            </p>
            <ul className="mt-3 space-y-1">
              {sectionProgress.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#cim-section-${s.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(`cim-section-${s.id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-[#374151] hover:bg-[#F3F4F6]"
                  >
                    <span className="truncate">{s.title}</span>
                    <span
                      className={`shrink-0 text-[11px] font-semibold ${
                        s.written === s.total ? 'text-[#1B6152]' : 'text-[#9CA3AF]'
                      }`}
                    >
                      {s.written}/{s.total}
                    </span>
                  </a>
                </li>
              ))}
            </ul>

            {/*
              The header counts the gaps; this is how you get to one. Without it
              "17 unanswered" was a number with nothing behind it, and the blank
              fields are only distinguishable from filled ones by the grey of
              their placeholder.
            */}
            {unansweredKeys.length > 0 && (
              <button
                type="button"
                onClick={goToNextGap}
                className="mt-4 w-full rounded-xl border border-[#F0DFB8] bg-[#FCF7EC] px-3 py-2 text-xs font-semibold text-[#8A5E10] hover:bg-[#FAF0DC]"
              >
                Next unanswered ({unansweredKeys.length})
              </button>
            )}
          </nav>

          <div className="space-y-4">
            {detail.sections.map((section) => (
              <div
                key={section.id}
                id={`cim-section-${section.id}`}
                className="scroll-mt-5 rounded-2xl bg-white p-5 shadow-card"
              >
                <h3 className="text-sm font-semibold text-[#111827]">{section.title}</h3>
                <ul className="mt-3 space-y-3">
                  {section.slides.flatMap((slide) =>
                    slide.blocks.map((block) => {
                      const written = isAnswered(block);
                      const state = blockState[block.block_key];
                      return (
                        <li key={block.id} id={`cim-block-${block.block_key}`} className="scroll-mt-24">
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-xs text-[#6B7280]">{block.label}</label>
                            <span className="text-[11px]">
                              {state === 'saving' && <span className="text-[#9CA3AF]">Saving…</span>}
                              {state === 'saved' && <span className="text-[#1B6152]">Saved</span>}
                              {state === 'failed' && <span className="text-[#B91C1C]">Not saved</span>}
                              {!state && !written && <span className="text-[#B08415]">Unanswered</span>}
                            </span>
                          </div>
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
                            className={`mt-1 w-full rounded-xl border p-3 text-sm disabled:bg-[#F9FAFB] ${
                              written ? 'border-[#E5E7EB]' : 'border-[#F0DFB8] bg-[#FFFDF8]'
                            }`}
                          />
                          {block.content_class_locked && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-[#9CA3AF]">
                              <Lock size={11} />
                              Came from the company&apos;s answer — stays with this deal.
                            </p>
                          )}
                        </li>
                      );
                    }),
                  )}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
