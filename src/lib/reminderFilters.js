export const REMINDER_STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'due', label: 'Due now' },
  { value: 'active', label: 'Scheduled' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'blocked', label: 'Blocked' },
];

export const REMINDER_PRIORITY_OPTIONS = [
  { value: 'all', label: 'All priorities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export const REMINDER_SORT_OPTIONS = [
  { value: 'next_due', label: 'Next reminder' },
  { value: 'due_date', label: 'Request due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'recent', label: 'Recently sent' },
];

const PRIORITY_WEIGHT = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

function timestamp(value) {
  const time = value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function recentTimestamp(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

export function filterAndSortReminders(reminders, filters) {
  const query = normalized(filters.search);
  const status = normalized(filters.status || 'all');
  const priority = normalized(filters.priority || 'all');
  const workflowStatus = normalized(filters.workflowStatus || 'all');
  const sortBy = filters.sortBy || 'next_due';

  const filtered = (reminders || []).filter((reminder) => {
    if (status !== 'all' && normalized(reminder.status) !== status) return false;
    if (priority !== 'all' && normalized(reminder.priority) !== priority) return false;
    if (workflowStatus !== 'all' && normalized(reminder.workflow_status || 'active') !== workflowStatus) return false;
    if (!query) return true;

    const haystack = [
      reminder.title,
      reminder.message,
      reminder.request_id,
      reminder.company_name,
      reminder.company_contact_name,
      reminder.company_contact_email,
      reminder.company_contact_phone,
      reminder.frequency_label,
      reminder.workflow_status,
      reminder.status,
      reminder.priority,
    ].map(normalized).join(' ');

    return haystack.includes(query);
  });

  return filtered.sort((left, right) => {
    if (sortBy === 'priority') {
      const priorityDelta = (PRIORITY_WEIGHT[normalized(right.priority)] || 0) - (PRIORITY_WEIGHT[normalized(left.priority)] || 0);
      if (priorityDelta !== 0) return priorityDelta;
      return timestamp(left.next_reminder_at || left.next_due_at || left.due_date) - timestamp(right.next_reminder_at || right.next_due_at || right.due_date);
    }

    if (sortBy === 'due_date') {
      return timestamp(left.due_date) - timestamp(right.due_date);
    }

    if (sortBy === 'recent') {
      return recentTimestamp(right.last_sent_at || right.first_sent_at) - recentTimestamp(left.last_sent_at || left.first_sent_at);
    }

    return timestamp(left.next_reminder_at || left.next_due_at || left.due_date) - timestamp(right.next_reminder_at || right.next_due_at || right.due_date);
  });
}

export function getWorkflowStatusOptions(reminders) {
  const statuses = Array.from(new Set(
    (reminders || [])
      .map((reminder) => normalized(reminder.workflow_status || 'active'))
      .filter(Boolean)
  ));

  return [
    { value: 'all', label: 'All workflows' },
    ...statuses.map((value) => ({ value, label: value.replace(/-/g, ' ') })),
  ];
}

export function hasActiveReminderFilters(filters) {
  return Boolean(
    filters.search?.trim() ||
    filters.status !== 'all' ||
    filters.priority !== 'all' ||
    filters.workflowStatus !== 'all' ||
    filters.sortBy !== 'next_due'
  );
}
