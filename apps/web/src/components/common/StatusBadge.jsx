const statusConfig = {
  pending: { label: 'Pending', bg: 'bg-orange-light/40', text: 'text-orange-dark', dot: 'bg-orange-DEFAULT' },
  received: { label: 'Received', bg: 'bg-blue-light/30', text: 'text-blue-dark', dot: 'bg-blue-dark' },
  'under-review': { label: 'Under Review', bg: 'bg-orange-light/40', text: 'text-orange-dark', dot: 'bg-orange-DEFAULT' },
  approved: { label: 'Approved', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  rejected: { label: 'Rejected', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },
  active: { label: 'Active', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  inactive: { label: 'Inactive', bg: 'bg-gray-100', text: 'text-secondary', dot: 'bg-secondary-light' },
  verified: { label: 'Verified', bg: 'bg-green-light/40', text: 'text-green-dark', dot: 'bg-green-dark' },
  dismissed: { label: 'Dismissed', bg: 'bg-gray-100', text: 'text-secondary', dot: 'bg-secondary-light' },
};

const priorityConfig = {
  high: { label: 'High', bg: 'bg-red-50', text: 'text-negative', dot: 'bg-negative' },
  medium: { label: 'Medium', bg: 'bg-orange-light/40', text: 'text-orange-dark', dot: 'bg-orange-DEFAULT' },
  low: { label: 'Low', bg: 'bg-blue-light/30', text: 'text-blue-dark', dot: 'bg-blue-dark' },
};

export default function StatusBadge({ value, variant = 'status', size = 'sm' }) {
  const config = variant === 'priority'
    ? priorityConfig[value] || priorityConfig.low
    : statusConfig[value] || statusConfig.pending;

  const padding = size === 'xs' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]';

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md font-semibold ${padding} ${config.bg} ${config.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}
