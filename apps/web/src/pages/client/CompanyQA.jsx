import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Loader2, Send } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useQaStore } from '../../store/qaStore';

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
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (companyId) load(companyId);
  }, [companyId, load]);

  async function submit(event) {
    event.preventDefault();
    if (!reply.trim() || !detail) return;
    setBusy(true);
    try {
      await answer(detail.item.id, reply.trim(), { kind: 'answer' });
      setReply('');
      closeItem();
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
            <p className="mt-2 text-xs text-[#9CA3AF]">
              Once posted, an answer stays on the record. If you need to correct it, post again and
              both versions are kept.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={closeItem} className={`${TAP} rounded-xl text-sm text-[#6B7280]`}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !reply.trim()}
                className={`${TAP} inline-flex items-center gap-2 rounded-xl bg-[#05164D] text-sm font-medium text-white disabled:opacity-50`}
              >
                {busy ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
                Send
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
