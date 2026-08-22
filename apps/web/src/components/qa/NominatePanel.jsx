import { useState } from 'react';
import { Loader2, UserCheck, X } from 'lucide-react';
import { useQaStore } from '../../store/qaStore';
import { useFeature } from '../../context/useFeature';

/**
 * Who answers what, per category.
 *
 * This is the seller's screen even though the deal team can reach it: the point
 * of nomination is that the company decides who fields Finance rather than the
 * broker guessing. A nominated person is assigned automatically when a question
 * is raised in their category — and can still be reassigned afterwards, because
 * nomination is a default, not a lock.
 */
export default function NominatePanel({ categories, onClose }) {
  const { nominate, items } = useQaStore();
  const enabled = useFeature('qaNominations');
  const [busy, setBusy] = useState(null);

  // Everyone who has been a requestee or requestor is on this deal, which is a
  // good enough roster without a separate members endpoint.
  const people = new Map();
  for (const item of items) {
    if (item.requestor_id) people.set(item.requestor_id, item.requestor_name ?? 'Unknown');
    for (const a of item.assignees) people.set(a.user_id, a.name ?? 'Unknown');
  }

  async function toggle(category, userId) {
    const current = category.nominees.map((n) => n.user_id);
    const next = current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId];
    setBusy(category.id);
    try {
      await nominate(category.id, next);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
      <div className="flex h-[100dvh] w-full flex-col bg-white lg:w-[520px]">
        <header className="flex items-start justify-between border-b border-[#F3F4F6] p-5">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[#111827]">
              <UserCheck size={18} />
              Who answers what
            </h2>
            <p className="mt-1 text-xs text-[#6B7280]">
              Nominate someone per category and new questions go straight to them. They can still
              be handed on afterwards.
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

        <div className="flex-1 overflow-y-auto p-5">
          {!enabled ? (
            <p className="text-sm text-[#6B7280]">Nomination is not enabled on this deployment.</p>
          ) : people.size === 0 ? (
            <p className="text-sm text-[#6B7280]">
              Nobody on this deal has raised or been assigned a question yet.
            </p>
          ) : (
            <>
            {categories.some((c) => c.nominees.length === 0) && (
              <p className="mb-4 rounded-xl border border-[#F0DFB8] bg-[#FCF7EC] px-4 py-3 text-sm text-[#8A5E10]">
                {categories.filter((c) => c.nominees.length === 0).length} of {categories.length}{' '}
                categories have nobody assigned. Questions raised in those still reach the deal —
                they just arrive without a named owner.
              </p>
            )}
            <ul className="space-y-4">
              {categories.map((category) => (
                <li key={category.id} className="rounded-xl border border-[#E5E7EB] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-[#111827]">{category.label}</p>
                    <div className="flex items-center gap-2">
                      {/*
                        An unassigned category is worth saying out loud. Finance
                        and Legal were nominated and the other five were not, with
                        nothing on screen indicating where a question raised in
                        them would go — so the gap read as a deliberate state
                        rather than an omission.
                      */}
                      {category.nominees.length === 0 && (
                        <span className="rounded-full bg-[#FAF0DC] px-2 py-0.5 text-[11px] font-semibold text-[#8A5E10]">
                          Nobody assigned
                        </span>
                      )}
                      {busy === category.id && (
                        <Loader2 className="animate-spin text-[#9CA3AF]" size={14} />
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[...people.entries()].map(([userId, name]) => {
                      const on = category.nominees.some((n) => n.user_id === userId);
                      return (
                        <button
                          key={userId}
                          type="button"
                          onClick={() => toggle(category, userId)}
                          className={`min-h-[44px] rounded-full border px-4 text-sm ${
                            on
                              ? 'border-[#05164D] bg-[#05164D] text-white'
                              : 'border-[#E5E7EB] bg-white text-[#374151]'
                          }`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
