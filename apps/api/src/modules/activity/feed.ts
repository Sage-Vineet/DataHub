/**
 * The broker activity feed: six unrelated tables merged into one ordered story.
 *
 * Pure, because everything interesting here is ordering and labelling. Legacy
 * built the feed inline with its six queries, so the only way to check that a
 * narrative update sorts above a document upload from the same second was to
 * arrange six tables and look at the HTTP response.
 */

export const DEFAULT_ACTIVITY_LIMIT = 120;
export const MAX_ACTIVITY_LIMIT = 250;
/** How many rows to take from each source before merging. */
export const PER_SOURCE_LIMIT = 40;

/**
 * Tiebreak order for events sharing a timestamp.
 *
 * Bulk writes land in the same second constantly — a company import creates the
 * company, its folders and its first requests at once — so without this the
 * feed's order changes between identical requests. Lower sorts first.
 */
const EVENT_ORDER: Readonly<Record<string, number>> = {
  activity: 10,
  user_added: 20,
  user_assigned: 21,
  company_created: 15,
  group_created: 30,
  group_member_added: 31,
  folder_created: 40,
  folder_access_granted: 41,
  request_created: 50,
  request_updated: 51,
  request_approved: 52,
  request_document_linked: 53,
  request_narrative_updated: 54,
  reminder_created: 60,
  reminder_sent: 61,
  document_uploaded: 70,
  document_status_changed: 71,
  message_sent: 80,
  direct_message_sent: 81,
};

export interface ActivityEvent {
  id: string;
  type: string;
  message: string;
  detail: string | null;
  actor_name: string | null;
  created_at: string;
  /** 1-based position in the returned page, for stable keys in the UI. */
  sequence: number;
}

/** Rows from each source, already scoped to what the caller may see. */
export interface BrokerActivitySources {
  companies: ReadonlyArray<{
    id: string;
    name: string | null;
    projectName: string | null;
    industry: string | null;
    createdAt: string | null;
  }>;
  buyers: ReadonlyArray<{
    id: string;
    name: string | null;
    email: string | null;
    companyId: string | null;
    createdAt: string | null;
  }>;
  documents: ReadonlyArray<{
    id: string;
    name: string | null;
    companyId: string | null;
    uploadedBy: string | null;
    uploadedAt: string | null;
  }>;
  requests: ReadonlyArray<{
    id: string;
    title: string | null;
    companyId: string | null;
    createdBy: string | null;
    createdAt: string | null;
  }>;
  narratives: ReadonlyArray<{
    id: string;
    requestId: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
  }>;
  activityLog: ReadonlyArray<{
    id: string;
    type: string | null;
    message: string | null;
    companyId: string | null;
    createdBy: string | null;
    createdAt: string | null;
  }>;
  /** Requests referenced by narratives, already filtered to the caller's scope. */
  requestById: ReadonlyMap<string, { title: string | null; companyId: string | null }>;
  companyNameById: ReadonlyMap<string, string>;
  userNameById: ReadonlyMap<string, string>;
}

/** A caller-supplied limit, clamped. Anything unparseable falls back to the default. */
export function clampLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

/** Normalize a timestamp, or null if it cannot be read as one. */
export function asIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type Draft = Omit<ActivityEvent, "sequence">;

function sortDrafts(items: readonly Draft[]): Draft[] {
  return [...items].sort((a, b) => {
    const left = new Date(a.created_at).getTime();
    const right = new Date(b.created_at).getTime();
    if (right !== left) return right - left;

    const leftOrder = EVENT_ORDER[a.type] ?? EVENT_ORDER.activity!;
    const rightOrder = EVENT_ORDER[b.type] ?? EVENT_ORDER.activity!;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;

    // Last resort, so the order is total and a re-request returns the same page.
    return a.id.localeCompare(b.id);
  });
}

/**
 * Merge the sources into one feed, newest first.
 *
 * `isAdmin` affects exactly one thing: a narrative whose request could not be
 * resolved is dropped for a non-admin, because an unresolvable request is one
 * outside their companies and its title would leak.
 */
export function buildBrokerFeed(
  sources: BrokerActivitySources,
  options: { isAdmin: boolean; limit: number },
): ActivityEvent[] {
  const drafts: Draft[] = [];
  const label = (companyId: string | null | undefined): string | null =>
    (companyId ? sources.companyNameById.get(companyId) : null) ?? null;
  const actor = (userId: string | null | undefined): string | null =>
    (userId ? sources.userNameById.get(userId) : null) ?? null;

  const push = (draft: Omit<Draft, "created_at"> & { created_at: string | null }): void => {
    // An event with no readable timestamp cannot be placed in a chronological
    // feed, so it is dropped rather than sorted to an arbitrary end.
    if (!draft.created_at) return;
    drafts.push(draft as Draft);
  };

  for (const c of sources.companies) {
    push({
      id: `company-created-${c.id}`,
      type: "company_created",
      message: `Company added: ${c.projectName ?? c.name ?? "Company"}`,
      detail: c.industry,
      actor_name: null,
      created_at: asIsoDate(c.createdAt),
    });
  }

  for (const u of sources.buyers) {
    push({
      id: `user-added-${u.id}`,
      type: "user_added",
      message: `Client added: ${u.name ?? u.email ?? "User"}`,
      detail: label(u.companyId),
      actor_name: null,
      created_at: asIsoDate(u.createdAt),
    });
  }

  for (const d of sources.documents) {
    push({
      id: `document-uploaded-${d.id}`,
      type: "document_uploaded",
      message: `Document uploaded: ${d.name ?? "Document"}`,
      detail: label(d.companyId),
      actor_name: actor(d.uploadedBy),
      created_at: asIsoDate(d.uploadedAt),
    });
  }

  for (const r of sources.requests) {
    push({
      id: `request-created-${r.id}`,
      type: "request_created",
      message: `Request created: ${r.title ?? "Untitled"}`,
      detail: label(r.companyId),
      actor_name: actor(r.createdBy),
      created_at: asIsoDate(r.createdAt),
    });
  }

  for (const n of sources.narratives) {
    const request = n.requestId ? sources.requestById.get(n.requestId) : undefined;
    if (!options.isAdmin && !request) continue;
    push({
      id: `request-answered-${n.id}`,
      type: "request_narrative_updated",
      message: `Request answered: ${request?.title ?? "Untitled request"}`,
      detail: label(request?.companyId),
      actor_name: actor(n.updatedBy),
      created_at: asIsoDate(n.updatedAt),
    });
  }

  for (const log of sources.activityLog) {
    push({
      id: `activity-log-${log.id}`,
      type: log.type ?? "activity",
      message: log.message ?? "Activity recorded",
      detail: label(log.companyId),
      actor_name: actor(log.createdBy),
      created_at: asIsoDate(log.createdAt),
    });
  }

  // Deduplicate by id: the same underlying row can reach the feed from two
  // sources — an upload writes both `documents` and `activity_log`.
  const byId = new Map<string, Draft>();
  for (const draft of drafts) byId.set(draft.id, draft);

  return sortDrafts([...byId.values()])
    .slice(0, options.limit)
    .map((draft, index) => ({ ...draft, sequence: index + 1 }));
}
