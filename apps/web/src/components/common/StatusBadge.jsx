/**
 * A status, rendered honestly.
 *
 * This component used to fall back to `statusConfig.pending` for any value it
 * did not recognise — and it did not recognise the statuses the requests API
 * actually returns. `in-review`, `completed`, `blocked` and `overdue` were all
 * absent, so every one of them rendered as "Pending".
 *
 * The effect was that the broker's own Deal Tracker showed six requests, all
 * badged Pending, while one was overdue, one blocked, one in review and one
 * completed. The requests table — which formats its own badges — showed the
 * truth, so the two screens disagreed about the same six rows.
 *
 * A fallback that dresses an unknown value as a known one is worse than no
 * fallback: it produces a confident wrong answer. Unknown values now render in a
 * neutral style with the raw value visible, which is ugly on purpose — it looks
 * like something to fix rather than like a real status.
 */

const statusConfig = {
  // Request workflow — the vocabulary the requests API and the client portal use.
  pending: { label: 'Pending', bg: 'bg-orange-light/40', text: 'text-orange-dark', dot: 'bg-orange-DEFAULT' },
  'in-review': { label: 'In Review', bg: 'bg-blue-light/30', text: 'text-blue-dark', dot: 'bg-blue-dark' },
  in_review: { label: 'In Review', bg: 'bg-blue-light/30', text: 'text-blue-dark', dot: 'bg-blue-dark' },
  completed: { label: 'Completed', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  blocked: { label: 'Blocked', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },
  overdue: { label: 'Overdue', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },

  // Document / upload lifecycle.
  received: { label: 'Received', bg: 'bg-blue-light/30', text: 'text-blue-dark', dot: 'bg-blue-dark' },
  'under-review': { label: 'Under Review', bg: 'bg-orange-light/40', text: 'text-orange-dark', dot: 'bg-orange-DEFAULT' },
  approved: { label: 'Approved', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  rejected: { label: 'Rejected', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },
  verified: { label: 'Verified', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  dismissed: { label: 'Dismissed', bg: 'bg-gray-100', text: 'text-secondary', dot: 'bg-secondary-light' },

  // Account / company state.
  active: { label: 'Active', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  inactive: { label: 'Inactive', bg: 'bg-gray-100', text: 'text-secondary', dot: 'bg-secondary-light' },
};

const priorityConfig = {
  critical: { label: 'Critical', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },
  high: { label: 'High', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },
  medium: { label: 'Medium', bg: 'bg-orange-light/40', text: 'text-orange-dark', dot: 'bg-orange-DEFAULT' },
  low: { label: 'Low', bg: 'bg-blue-light/30', text: 'text-blue-dark', dot: 'bg-blue-dark' },
};

/** Neutral treatment for a value no config covers. Never impersonates a status. */
const UNKNOWN = { bg: 'bg-gray-100', text: 'text-secondary', dot: 'bg-secondary-light' };

/** "in-review" → "In Review"; used only when a value has no configured label. */
function humanize(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a value to its badge presentation.
 *
 * Exported and pure so the mapping can be tested directly — the bug was in this
 * lookup, not in the markup, and a test that renders JSX would need a DOM this
 * package does not currently carry.
 *
 * `known` is the signal callers care about: false means nothing in the config
 * matched, and the badge is showing the raw value rather than a real status.
 */
export function resolveBadge(value, variant = 'status') {
  const table = variant === 'priority' ? priorityConfig : statusConfig;
  const hit = value === null || value === undefined ? undefined : table[value];
  if (hit) return { ...hit, known: true };
  return { ...UNKNOWN, label: value ? humanize(value) : '—', known: false };
}

export default function StatusBadge({ value, variant = 'status', size = 'sm' }) {
  const config = resolveBadge(value, variant);
  const padding = size === 'xs' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md font-semibold ${padding} ${config.bg} ${config.text}`}
      title={config.known ? undefined : `Unrecognised ${variant}: ${value}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}
