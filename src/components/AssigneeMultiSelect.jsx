import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Users } from 'lucide-react';

const ALL_VALUE = 'all';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeAssigneeSelection(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
    ? value.split(',')
    : [];
  const cleaned = raw.map((item) => normalizeEmail(item)).filter(Boolean);
  if (!cleaned.length || cleaned.includes(ALL_VALUE)) return [ALL_VALUE];
  return Array.from(new Set(cleaned));
}

export function assigneeSelectionToPayload(value) {
  const selected = normalizeAssigneeSelection(value);
  return selected.includes(ALL_VALUE) ? ALL_VALUE : selected;
}

export default function AssigneeMultiSelect({
  users = [],
  value,
  onChange,
  disabled = false,
  compact = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = normalizeAssigneeSelection(value);

  const options = useMemo(() => (
    (users || [])
      .map((user) => ({
        ...user,
        email: normalizeEmail(user.email),
        label: user.name || user.email || 'Unnamed user',
      }))
      .filter((user) => user.email)
  ), [users]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const selectedLabels = useMemo(() => {
    if (selected.includes(ALL_VALUE)) return ['All client team'];
    const byEmail = new Map(options.map((user) => [user.email, user]));
    return selected.map((email) => byEmail.get(email)?.label || email);
  }, [options, selected]);

  const displayLabel = selected.includes(ALL_VALUE)
    ? 'All client team'
    : selectedLabels.length > 1
    ? `${selectedLabels[0]} +${selectedLabels.length - 1}`
    : selectedLabels[0] || 'All client team';

  const toggleAll = () => {
    onChange?.([ALL_VALUE]);
    setOpen(false);
  };

  const toggleUser = (email) => {
    const current = selected.includes(ALL_VALUE) ? [] : selected;
    const next = current.includes(email)
      ? current.filter((item) => item !== email)
      : [...current, email];
    onChange?.(next.length ? next : [ALL_VALUE]);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white text-left text-sm font-semibold text-[#050505] transition-colors hover:border-[#8BC53D] disabled:cursor-not-allowed disabled:opacity-60 ${
          compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2.5'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Users size={compact ? 13 : 15} className="flex-shrink-0 text-[#8BC53D]" />
          <span className="truncate">{displayLabel}</span>
        </span>
        <ChevronDown size={compact ? 13 : 15} className={`flex-shrink-0 text-[#A5A5A5] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
          <button
            type="button"
            onClick={toggleAll}
            className="flex w-full items-center gap-2 border-b border-gray-100 px-3 py-2 text-left text-xs font-semibold text-[#050505] hover:bg-[#F8FAFC]"
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded border ${selected.includes(ALL_VALUE) ? 'border-[#8BC53D] bg-[#8BC53D] text-white' : 'border-gray-300 bg-white text-transparent'}`}>
              <Check size={11} />
            </span>
            <span>All client team</span>
          </button>

          <div className="max-h-56 overflow-y-auto py-1">
            {options.length === 0 ? (
              <p className="px-3 py-3 text-xs text-[#A5A5A5]">No client users with email found.</p>
            ) : options.map((user) => {
              const checked = !selected.includes(ALL_VALUE) && selected.includes(user.email);
              return (
                <button
                  key={user.id || user.email}
                  type="button"
                  onClick={() => toggleUser(user.email)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#F8FAFC]"
                >
                  <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${checked ? 'border-[#8BC53D] bg-[#8BC53D] text-white' : 'border-gray-300 bg-white text-transparent'}`}>
                    <Check size={11} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-[#050505]">{user.label}</span>
                    <span className="block truncate text-[10px] text-[#A5A5A5]">{user.email}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
