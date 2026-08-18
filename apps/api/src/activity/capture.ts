import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import type { ActivityEngine, ActivityEventType, ActorKind } from "@datahub/contracts";
import { blankRecord } from "./types.js";
import type { ActivityWriter } from "./writer.js";

/** What a module hands to `emitActivity` — the transport half is filled in for it. */
export interface SemanticEventInput {
  event_type: ActivityEventType;
  subject_id?: string | null;
  company_id?: string | null;
  /** Overrides the envelope's actor where the module knows better (see D3). */
  actor_id?: string | null;
  payload?: Record<string, unknown>;
}

export interface ActivityEmitter {
  event(input: SemanticEventInput): void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      activity?: ActivityEmitter;
      activityCorrelationId?: string;
      activityEngine?: ActivityEngine;
    }
  }
}

/**
 * Collapse identifier-shaped path segments so the log aggregates:
 * `/companies/8f1e.../folders/42` → `/companies/:id/folders/:id`. The raw path is
 * stored alongside, so nothing is lost — this is an index for reading, not a
 * redaction.
 */
export function normalizePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return ":id";
      }
      if (/^\d+$/.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/** Strip the query string; it is captured separately (or not at all) per policy. */
function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

export interface ActorAttribution {
  actorId: string | null;
  actorKind: ActorKind;
}

/**
 * Attribute a request to the actor its credential asserts — signature verified,
 * **no database lookup** (design D3): tier 1 runs on every request, and a session
 * lookup per request would put the audit log on the latency path of the product.
 *
 * Legacy tokens are HS256 JWTs carrying `sub`. Better Auth's bearer tokens are
 * opaque session tokens, so they do not verify here and are recorded as anonymous
 * — that is the documented limit of tier 1, and those requests are attributed by
 * the tier-2 event the module emits with its validated session identity.
 */
export function attributeActor(req: Request, secret: string | undefined): ActorAttribution {
  const header = req.headers.authorization;
  if (!secret || !header?.startsWith("Bearer ")) return { actorId: null, actorKind: "anonymous" };
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return { actorId: null, actorKind: "anonymous" };
  try {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload | string;
    if (typeof payload === "string") return { actorId: null, actorKind: "anonymous" };
    const subject = payload.sub ?? (payload as { userId?: string }).userId ?? null;
    return subject
      ? { actorId: String(subject), actorKind: "user" }
      : { actorId: null, actorKind: "anonymous" };
  } catch {
    // An invalid or unverifiable credential is itself worth recording — SE-0004
    // asks for failed and denied attempts, and an unauthenticated probe is one.
    return { actorId: null, actorKind: "anonymous" };
  }
}

export interface ActivityCaptureOptions {
  writer: ActivityWriter;
  /** Signing secret for tier-1 attribution. Absent → every request is anonymous. */
  jwtSecret?: string;
  now?: () => Date;
}

/** Mark a request as served by the legacy backend. Called from the proxy hook. */
export function markProxiedToLegacy(res: Response): void {
  res.locals.activityEngine = "legacy";
}

/**
 * Tier-1 capture: one envelope per request, whichever engine served it.
 *
 * Two constraints shape this and are easy to break by accident:
 *
 *   - **It never reads the body.** The gateway deliberately runs no body parser so
 *     uploads and downloads stream through (`gateway.ts`, `shared/router.ts`), and
 *     consuming the stream here would forward body-less requests to legacy. Capture
 *     therefore attaches to the response's `finish` event, where status and duration
 *     are known and the body has already streamed past.
 *   - **It never alters the response.** No header is set, no status touched. A
 *     capture failure is contained inside the writer.
 */
export function createActivityCapture(options: ActivityCaptureOptions): RequestHandler {
  const { writer, jwtSecret } = options;
  const now = options.now ?? ((): Date => new Date());

  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = now();
    const startedHr = process.hrtime.bigint();
    const correlationId = randomUUID();
    const { actorId, actorKind } = attributeActor(req, jwtSecret);

    res.locals.activityCorrelationId = correlationId;
    // Default to "module": the proxy hook overwrites it when legacy serves the
    // request, so a route nobody proxied is correctly attributed in-process.
    res.locals.activityEngine = "module";
    res.locals.activity = {
      event(input: SemanticEventInput): void {
        const record = blankRecord("event", now());
        record.correlationId = correlationId;
        record.actorId = input.actor_id ?? actorId;
        record.actorKind = input.actor_id ? "user" : actorKind;
        record.eventType = input.event_type;
        record.subjectId = input.subject_id ?? null;
        record.companyId = input.company_id ?? null;
        record.payload = input.payload ?? {};
        writer.record(record);
      },
    };

    res.on("finish", () => {
      const durationMs = Number((process.hrtime.bigint() - startedHr) / 1_000_000n);
      const rawPath = pathOf(req.originalUrl ?? req.url ?? "/");
      const record = blankRecord("envelope", startedAt);
      record.correlationId = correlationId;
      record.actorId = actorId;
      record.actorKind = actorKind;
      record.engine = res.locals.activityEngine ?? "module";
      record.method = req.method;
      record.rawPath = rawPath;
      record.path = normalizePath(rawPath);
      record.status = res.statusCode;
      record.durationMs = durationMs;
      record.ip = req.ip ?? null;
      record.userAgent = req.headers["user-agent"] ?? null;
      writer.record(record);
    });

    next();
  };
}

/**
 * Emit a semantic event from a module. A no-op when capture is disabled, so
 * modules carry one line rather than a conditional and a dependency.
 */
export function emitActivity(res: Response, input: SemanticEventInput): void {
  res.locals.activity?.event(input);
}
