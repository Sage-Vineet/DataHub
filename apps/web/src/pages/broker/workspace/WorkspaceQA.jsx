import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { formatCalendarDate, parseCalendarDate } from '../../../lib/calendarDate';
import {
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  UserCheck,
  X,
} from 'lucide-react';
import { useQaStore } from '../../../store/qaStore';
import { useAuth } from '../../../context/AuthContext';
import QAItemDrawer from '../../../components/qa/QAItemDrawer';
import NominatePanel from '../../../components/qa/NominatePanel';

const STATUS_META = {
  open: { label: 'Open', color: '#A86F0B', bg: '#FEF3C7', icon: Clock },
  answered: { label: 'Answered', color: '#2563EB', bg: '#DBEAFE', icon: MessageSquareText },
  follow_up: { label: 'Follow-up', color: '#7C3AED', bg: '#EDE9FE', icon: RefreshCw },
  closed: { label: 'Closed', color: '#166534', bg: '#DCFCE7', icon: CheckCircle2 },
};

const RELATIONSHIP_FILTERS = [
  [null, 'All questions'],
  ['requestor', 'Raised by me'],
  ['requestee', 'Assigned to me'],
];

function StatusChip({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.open;
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color: meta.color, backgroundColor: meta.bg }}
    >
      <Icon size={12} />
      {meta.label}
    </span>
  );
}

/** Minimum 44px targets throughout: this is used on a tablet, by a thumb. */
const TAP = 'min-h-[44px] px-4';

/** Items still owed an answer. Used for ordering and for the age treatment. */
const OUTSTANDING = new Set(['open', 'follow_up']);

/**
 * How long this has been outstanding, in the words a broker chasing it would
 * use. Answered items report when they were answered instead — the age of a
 * closed question is not what anyone is looking for.
 */
function describeAge(item) {
  const asked = parseCalendarDate(item.asked_at);
  if (!asked) return '—';
  if (!OUTSTANDING.has(item.status)) {
    const answered = parseCalendarDate(item.answered_at || item.closed_at);
    return answered ? formatCalendarDate(answered, { month: 'short', day: 'numeric' }) : '—';
  }
  const days = Math.floor((Date.now() - asked.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

export default function WorkspaceQA() {
  const { clientId } = useParams();
  const { user } = useAuth();
  const {
    categories,
    items,
    filters,
    loading,
    error,
    detail,
    load,
    setFilters,
    openItem,
    closeItem,
    ask,
  } = useQaStore();
  /**
   * Outstanding first, oldest first within that — the order a broker triages in.
   *
   * The list previously rendered in whatever order the API returned, which came
   * out as QA-005, 001, 003, 002, 004: no ordering a reader could name, and no
   * control to change it. The one open question sat last.
   */
  const sortedItems = useMemo(() => {
    const rank = (i) => (OUTSTANDING.has(i.status) ? 0 : i.status === 'answered' ? 1 : 2);
    return [...items].sort((a, b) => {
      const byState = rank(a) - rank(b);
      if (byState !== 0) return byState;
      const aAsked = a.asked_at || '';
      const bAsked = b.asked_at || '';
      // Oldest outstanding first; most recently resolved first.
      return rank(a) === 0 ? aAsked.localeCompare(bAsked) : bAsked.localeCompare(aAsked);
    });
  }, [items]);

  const [asking, setAsking] = useState(false);
  const [nominating, setNominating] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', category_id: '' });

  useEffect(() => {
    if (clientId) load(clientId);
  }, [clientId, load]);

  const counts = useMemo(() => {
    const out = { open: 0, answered: 0, follow_up: 0, closed: 0 };
    for (const item of items) out[item.status] = (out[item.status] ?? 0) + 1;
    return out;
  }, [items]);

  async function submitAsk(event) {
    event.preventDefault();
    if (!draft.title.trim() || !draft.body.trim()) return;
    await ask({
      title: draft.title.trim(),
      body: draft.body.trim(),
      ...(draft.category_id ? { category_id: draft.category_id } : {}),
    });
    setDraft({ title: '', body: '', category_id: '' });
    setAsking(false);
  }

  const selectedCategory = categories.find((c) => c.id === filters.categoryId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Q&amp;A</h1>
          <p className="mt-1 text-sm text-[#6B7280]">
            Questions to the company, and the answers on the record.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setNominating(true)}
            className={`${TAP} inline-flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-white text-sm font-medium text-[#374151]`}
          >
            <UserCheck size={16} />
            Who answers what
          </button>
          <button
            type="button"
            onClick={() => setAsking((v) => !v)}
            className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white`}
          >
            <Plus size={16} />
            Ask a question
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(STATUS_META).map(([key, meta]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilters({ status: filters.status === key ? null : key })}
            className={`rounded-2xl bg-white p-5 text-left shadow-card ${
              filters.status === key ? 'ring-2 ring-[#05164D]' : ''
            }`}
          >
            <p className="text-xs text-[#A5A5A5]">{meta.label}</p>
            <p className="mt-2 text-3xl font-bold" style={{ color: meta.color }}>
              {counts[key] ?? 0}
            </p>
          </button>
        ))}
      </div>

      {asking && (
        <form onSubmit={submitAsk} className="rounded-2xl bg-white p-5 shadow-card">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="Short title, e.g. Q3 revenue variance"
              className={`${TAP} rounded-xl border border-[#E5E7EB] text-sm`}
            />
            <select
              value={draft.category_id}
              onChange={(e) => setDraft((d) => ({ ...d, category_id: e.target.value }))}
              className={`${TAP} rounded-xl border border-[#E5E7EB] text-sm`}
            >
              <option value="">Choose a category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.nominees.length > 0 ? ` — goes to ${c.nominees[0].name ?? 'nominee'}` : ''}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            placeholder="What do you need to know, and why?"
            rows={3}
            className="mt-3 w-full rounded-xl border border-[#E5E7EB] p-3 text-sm"
          />
          {selectedCategory?.nominees?.length > 0 && (
            <p className="mt-2 text-xs text-[#6B7280]">
              This will go to {selectedCategory.nominees.map((n) => n.name).join(', ')} — the
              company nominated them for {selectedCategory.label}.
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAsking(false)} className={`${TAP} rounded-xl text-sm text-[#6B7280]`}>
              Cancel
            </button>
            <button type="submit" className={`${TAP} rounded-xl bg-[#05164D] text-sm font-medium text-white`}>
              Send
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-2">
        {RELATIONSHIP_FILTERS.map(([value, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => setFilters({ mine: value })}
            className={`${TAP} rounded-full border text-sm ${
              filters.mine === value
                ? 'border-[#05164D] bg-[#05164D] text-white'
                : 'border-[#E5E7EB] bg-white text-[#374151]'
            }`}
          >
            {label}
          </button>
        ))}
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setFilters({ categoryId: filters.categoryId === c.id ? null : c.id })}
            className={`${TAP} rounded-full border text-sm ${
              filters.categoryId === c.id
                ? 'border-[#05164D] bg-[#05164D] text-white'
                : 'border-[#E5E7EB] bg-white text-[#374151]'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-[#FEF2F2] p-4 text-sm text-[#B91C1C]">
          <X size={16} />
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl bg-white shadow-card">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-[#6B7280]">
            <Loader2 className="animate-spin" size={16} />
            Loading questions…
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#6B7280]">
            No questions yet. Ask the company something and it lands here.
          </div>
        ) : (
          <>
            {/*
              A header row, because the columns needed naming. The right-hand
              column showed a bare name — "Dana Client" — on a thread the detail
              view says was asked by someone else, so a reader could not tell
              whether they were looking at the asker or the answerer.
            */}
            <div className="flex items-center gap-3 border-b border-[#F3F4F6] px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[#9CA3AF]">
              <span className="w-14">Ref</span>
              <span className="flex-1">Question</span>
              <span className="w-24 text-right">Asked</span>
              <span className="w-20 text-center">Status</span>
              <span className="w-36 text-right">Answering</span>
            </div>
            <ul className="divide-y divide-[#F3F4F6]">
              {sortedItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => openItem(item.id)}
                    className="flex w-full min-h-[44px] flex-wrap items-center gap-3 p-4 text-left hover:bg-[#FAFAFA]"
                  >
                    <span className="w-14 font-mono text-xs text-[#9CA3AF]">{item.reference}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm font-medium text-[#111827]">{item.title}</span>
                      {item.category_label && (
                        <span className="mt-0.5 inline-block rounded-full bg-[#F3F4F6] px-2 py-0.5 text-[11px] text-[#4B5563]">
                          {item.category_label}
                        </span>
                      )}
                    </span>
                    {/*
                      How long this has been outstanding — the question a Q&A
                      list exists to answer, and the one it could not. The dates
                      were in the payload all along; only the list ignored them.
                    */}
                    <span className="w-24 text-right text-xs text-[#6B7280]" title={item.asked_at ? formatCalendarDate(item.asked_at) : ''}>
                      {describeAge(item)}
                    </span>
                    <span className="w-20 text-center"><StatusChip status={item.status} /></span>
                    <span className="w-36 truncate text-right text-xs text-[#6B7280]">
                      {item.assignees.map((a) => a.name).filter(Boolean).join(', ') || 'Unassigned'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {detail && <QAItemDrawer detail={detail} onClose={closeItem} currentUser={user} />}
      {nominating && (
        <NominatePanel categories={categories} onClose={() => setNominating(false)} />
      )}
    </div>
  );
}
