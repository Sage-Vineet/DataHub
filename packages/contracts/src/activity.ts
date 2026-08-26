import { z } from "zod";

/**
 * Activity log capture contracts (SE-0004).
 *
 * Three record kinds share one table and one hash chain:
 *   - `envelope` — written by the gateway for EVERY request, whichever engine
 *     served it. Transport metadata only.
 *   - `event`    — written by a migrated module, carrying domain meaning and the
 *     same correlation id as its envelope.
 *   - `gap`      — written when the capture path shed load, so a loss is visible
 *     in the log rather than invisible (design D6).
 *
 * The envelope schema is `.strict()` on purpose: capture must never carry request
 * or response body content (design D2), and a strict schema makes that a test
 * rather than a convention.
 */

const uuid = z.string().uuid();

export const activityKind = z.enum(["envelope", "event", "gap"]);
export type ActivityKind = z.infer<typeof activityKind>;

export const activityEngine = z.enum(["legacy", "module"]);
export type ActivityEngine = z.infer<typeof activityEngine>;

export const actorKind = z.enum(["user", "anonymous"]);
export type ActorKind = z.infer<typeof actorKind>;

/**
 * The semantic events landing with this change. Deliberately a closed set: an
 * event type nobody declared is a typo, not a feature. Capture points that need
 * a feature that does not exist yet (view duration, print, add-back changes,
 * signature execution) are listed in the change's design D8, not here.
 */
export const activityEventType = z.enum([
  "auth.login.succeeded",
  "auth.login.failed",
  // Broker self-registration. The rejection is logged as well as the success:
  // a run of them against one address is someone probing the signup flow with
  // forged or stale verification grants, and nothing else would record it.
  "auth.signup.succeeded",
  "auth.signup.rejected",
  "auth.password.changed",
  "auth.session.terminated",
  "access.granted",
  "access.modified",
  "access.revoked",
  "document.opened",
  "document.downloaded",
  "integration.connected",
  "integration.disconnected",
  // Data room versioning and comments (DR - 0001).
  "document.version.created",
  "document.version.restored",
  "document.comment.added",
  // Deal Q&A (QA - 0001/0002/0003). The exchange has to be reconstructable from
  // the log alone: who asked, who was made accountable, who answered, and what
  // the broker chose to present onward.
  "qa.item.created",
  "qa.response.posted",
  "qa.assignment.changed",
  "qa.presentation.published",
]);
export type ActivityEventType = z.infer<typeof activityEventType>;

/** Transport metadata for one request. No body content — see the module docblock. */
export const activityEnvelope = z
  .object({
    correlation_id: uuid,
    occurred_at: z.date(),
    actor_id: z.string().nullable(),
    actor_kind: actorKind,
    engine: activityEngine,
    method: z.string(),
    raw_path: z.string(),
    path: z.string(),
    status: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
  })
  .strict();
export type ActivityEnvelope = z.infer<typeof activityEnvelope>;

/** A domain event from a migrated module, joinable to its envelope by correlation id. */
export const activitySemanticEvent = z
  .object({
    correlation_id: uuid,
    occurred_at: z.date(),
    actor_id: z.string().nullable(),
    actor_kind: actorKind,
    event_type: activityEventType,
    /** Subject of the action — the affected user, document, or company. */
    subject_id: z.string().nullable(),
    company_id: uuid.nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ActivitySemanticEvent = z.infer<typeof activitySemanticEvent>;

/**
 * A recorded loss. `dropped_count` is what the writer shed between `gap_from`
 * and `gap_to`; a reader seeing a quiet period can then tell "nothing happened"
 * from "capture was shedding".
 */
export const activityGapMarker = z
  .object({
    occurred_at: z.date(),
    gap_from: z.date(),
    gap_to: z.date(),
    dropped_count: z.number().int().positive(),
    reason: z.string(),
  })
  .strict();
export type ActivityGapMarker = z.infer<typeof activityGapMarker>;

/** A stored record as read back, including its chain position. */
export const activityRecordResponse = z.object({
  seq: z.number().int().positive(),
  kind: activityKind,
  occurred_at: z.string(),
  correlation_id: uuid.nullable(),
  actor_id: z.string().nullable(),
  actor_kind: actorKind,
  engine: activityEngine.nullable(),
  method: z.string().nullable(),
  raw_path: z.string().nullable(),
  path: z.string().nullable(),
  status: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  event_type: activityEventType.nullable(),
  subject_id: z.string().nullable(),
  company_id: uuid.nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  dropped_count: z.number().int().nullable(),
  gap_from: z.string().nullable(),
  gap_to: z.string().nullable(),
  reason: z.string().nullable(),
  content_hash: z.string(),
  prev_hash: z.string().nullable(),
});
export type ActivityRecordResponse = z.infer<typeof activityRecordResponse>;

/** Result of a chain verification pass over a range. */
export const activityVerification = z.object({
  ok: z.boolean(),
  checked: z.number().int().nonnegative(),
  /** Sequence number of the first record whose chain does not hold, if any. */
  broken_at_seq: z.number().int().nullable(),
  reason: z.string().nullable(),
});
export type ActivityVerification = z.infer<typeof activityVerification>;
