import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGateway } from "../gateway.js";
import { parseRoutingTable } from "../routing.js";
import { withCommonMiddleware } from "../shared/router.js";
import {
  attributeActor,
  createActivityCapture,
  emitActivity,
  normalizePath,
} from "./capture.js";
import { InMemoryActivityRepository } from "./repository.memory.js";
import { ActivityWriter } from "./writer.js";

const SECRET = "test-secret-value";

interface Upstream {
  url: string;
  server: Server;
}

/** Mock legacy backend: echoes what it received so we can prove the proxy is intact. */
function startLegacy(): Promise<Upstream> {
  const app = express();
  app.use(express.raw({ type: "*/*", limit: "50mb" }));
  app.get("/legacy/boom", (_req, res) => {
    res.status(500).json({ error: "legacy exploded" });
  });
  app.all("/*", (req, res) => {
    const body = req.body as Buffer;
    res.status(200).json({
      served: "legacy",
      method: req.method,
      url: req.url,
      bodyLength: Buffer.isBuffer(body) ? body.length : 0,
      bodySha: Buffer.isBuffer(body) ? body.toString("utf8").slice(0, 32) : null,
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

let legacy: Upstream;
let repo: InMemoryActivityRepository;
let writer: ActivityWriter;

/** A module that serves a couple of paths in-process; everything else proxies. */
function moduleRouter(): express.Router {
  const router = express.Router();
  withCommonMiddleware(router, [express.json()]);
  router.get("/companies/:id", (req, res) => {
    emitActivity(res, {
      event_type: "access.granted",
      subject_id: "user-2",
      payload: { scope: "company" },
    });
    res.json({ served: "module", id: req.params.id });
  });
  router.get("/companies/:id/denied", (_req, res) => {
    res.status(403).json({ error: "nope" });
  });
  // An event that names its own actor, and one that names nothing else.
  router.get("/companies/:id/impersonated", (_req, res) => {
    emitActivity(res, { event_type: "access.granted", actor_id: "acting-as" });
    res.json({ served: "module" });
  });
  return router;
}

function buildGateway(options: { capture: boolean }): Express {
  const table = parseRoutingTable({ LEGACY_ORIGIN: legacy.url });
  return createGateway(table, {
    modules: [{ path: "/", router: moduleRouter() }],
    activityCapture: options.capture
      ? createActivityCapture({ writer, jwtSecret: SECRET })
      : undefined,
  });
}

/** Let the response-finished hook run, then drain the writer. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writer.flush();
}

beforeAll(async () => {
  legacy = await startLegacy();
});

afterAll(async () => {
  await new Promise((resolve) => legacy.server.close(resolve));
});

beforeEach(() => {
  repo = new InMemoryActivityRepository();
  writer = new ActivityWriter(repo, { flushIntervalMs: 0 });
});

describe("attributing a request to an actor", () => {
  // Signature verified, no database lookup: tier 1 runs on every request, and
  // a session read per request would put the audit log on the product's
  // latency path.
  const withAuth = (header?: string) =>
    ({ headers: header === undefined ? {} : { authorization: header } }) as never;

  it("reads the subject out of a token it can verify", () => {
    const token = jwt.sign({ sub: "user-7" }, SECRET);
    expect(attributeActor(withAuth(`Bearer ${token}`), SECRET)).toEqual({
      actorId: "user-7",
      actorKind: "user",
    });
  });

  it("reads the other spelling legacy tokens use", () => {
    const token = jwt.sign({ userId: "user-8" }, SECRET);
    expect(attributeActor(withAuth(`Bearer ${token}`), SECRET)).toMatchObject({
      actorId: "user-8",
    });
  });

  it("is anonymous with no header, no scheme, or an empty token", () => {
    for (const header of [undefined, "Basic abc", "Bearer", "Bearer    "]) {
      expect(attributeActor(withAuth(header), SECRET).actorKind).toBe("anonymous");
    }
  });

  it("is anonymous when this deployment has no secret to verify against", () => {
    const token = jwt.sign({ sub: "user-7" }, SECRET);
    expect(attributeActor(withAuth(`Bearer ${token}`), undefined).actorKind).toBe("anonymous");
  });

  it("is anonymous for a token signed with a different secret", () => {
    // An unverifiable credential is itself worth recording — SE-0004 asks for
    // failed and denied attempts, and an unauthenticated probe is one.
    const token = jwt.sign({ sub: "user-7" }, "some-other-secret");
    expect(attributeActor(withAuth(`Bearer ${token}`), SECRET).actorKind).toBe("anonymous");
  });

  it("is anonymous for a verified token that names no subject", () => {
    const token = jwt.sign({ scope: "read" }, SECRET);
    expect(attributeActor(withAuth(`Bearer ${token}`), SECRET)).toEqual({
      actorId: null,
      actorKind: "anonymous",
    });
  });

  it("is anonymous for a token whose payload is not an object", () => {
    // `jwt.sign("a string", secret)` is legal and verifies. There is no `sub`
    // to read off a string, and treating one as an actor id would attribute
    // the request to whatever the string happened to be.
    const token = jwt.sign("just a string", SECRET);
    expect(attributeActor(withAuth(`Bearer ${token}`), SECRET).actorKind).toBe("anonymous");
  });
});

describe("an event that names its own actor", () => {
  it("is attributed to that actor, as a user, whoever made the request", async () => {
    // A module that has validated a session knows who is acting; tier 1 only
    // knows what the bearer token asserted. The module's identity wins, and
    // the record says "user" rather than carrying the request's anonymity.
    const app = buildGateway({ capture: true });
    await request(app).get("/companies/c-1/impersonated").expect(200);
    await settle();

    const event = (await repo.list()).find((r) => r.kind === "event");
    expect(event).toMatchObject({ actorId: "acting-as", actorKind: "user" });
  });

  it("carries no subject, company or payload when the event names none", async () => {
    // Nulls and an empty object rather than absent fields: the column is NOT
    // NULL for the payload, and a reader distinguishing "no subject" from
    // "field missing" would be distinguishing nothing.
    const app = buildGateway({ capture: true });
    await request(app).get("/companies/c-1/impersonated").expect(200);
    await settle();

    const event = (await repo.list()).find((r) => r.kind === "event");
    expect(event).toMatchObject({ subjectId: null, companyId: null, payload: {} });
  });
});

describe("path normalization", () => {
  it("collapses uuid and numeric segments, keeping the shape", () => {
    expect(normalizePath("/companies/8f1e2d3c-4b5a-4968-8776-655443332211/folders/42")).toBe(
      "/companies/:id/folders/:id",
    );
    expect(normalizePath("/auth/login")).toBe("/auth/login");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("tier-1 capture — coverage", () => {
  it("captures a request the legacy backend served", async () => {
    const app = buildGateway({ capture: true });
    const res = await request(app).get("/requests/open");
    expect(res.status).toBe(200);
    expect(res.body.served).toBe("legacy");

    await settle();
    const [record] = await repo.list();
    expect(record?.kind).toBe("envelope");
    expect(record?.engine).toBe("legacy");
    expect(record?.method).toBe("GET");
    expect(record?.rawPath).toBe("/requests/open");
    expect(record?.status).toBe(200);
  });

  it("captures a request a module served", async () => {
    const app = buildGateway({ capture: true });
    const res = await request(app).get("/companies/8f1e2d3c-4b5a-4968-8776-655443332211");
    expect(res.body.served).toBe("module");

    await settle();
    const envelope = (await repo.list()).find((r) => r.kind === "envelope");
    expect(envelope?.engine).toBe("module");
    expect(envelope?.path).toBe("/companies/:id");
    expect(envelope?.rawPath).toBe("/companies/8f1e2d3c-4b5a-4968-8776-655443332211");
  });

  it("captures denied and failed requests, not only successful ones", async () => {
    const app = buildGateway({ capture: true });
    await request(app).get("/companies/11111111-2222-4333-8444-555566667777/denied");
    await request(app).get("/legacy/boom");

    await settle();
    const statuses = (await repo.list())
      .filter((r) => r.kind === "envelope")
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([403, 500]);
  });

  it("records duration and user agent", async () => {
    const app = buildGateway({ capture: true });
    await request(app).get("/requests/open").set("User-Agent", "vitest-agent");

    await settle();
    const [record] = await repo.list();
    expect(record?.userAgent).toBe("vitest-agent");
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("tier-1 capture — actor attribution", () => {
  it("attributes a request carrying a verifiable token", async () => {
    const token = jwt.sign({ sub: "user-42" }, SECRET);
    const app = buildGateway({ capture: true });
    await request(app).get("/requests/open").set("Authorization", `Bearer ${token}`);

    await settle();
    const [record] = await repo.list();
    expect(record?.actorId).toBe("user-42");
    expect(record?.actorKind).toBe("user");
  });

  it("records an unauthenticated request as anonymous rather than dropping it", async () => {
    const app = buildGateway({ capture: true });
    await request(app).get("/requests/open");

    await settle();
    const [record] = await repo.list();
    expect(record?.actorId).toBeNull();
    expect(record?.actorKind).toBe("anonymous");
  });

  it("records a request with an unverifiable token as anonymous", async () => {
    const forged = jwt.sign({ sub: "user-42" }, "a-different-secret");
    const app = buildGateway({ capture: true });
    await request(app).get("/requests/open").set("Authorization", `Bearer ${forged}`);

    await settle();
    const [record] = await repo.list();
    expect(record?.actorKind).toBe("anonymous");
    expect(record?.actorId).toBeNull();
  });
});

describe("tier-2 semantic events", () => {
  it("joins its envelope by correlation id", async () => {
    const app = buildGateway({ capture: true });
    await request(app).get("/companies/8f1e2d3c-4b5a-4968-8776-655443332211");

    await settle();
    const records = await repo.list();
    const event = records.find((r) => r.kind === "event");
    const envelope = records.find((r) => r.kind === "envelope");

    expect(event?.eventType).toBe("access.granted");
    expect(event?.subjectId).toBe("user-2");
    expect(event?.payload).toEqual({ scope: "company" });
    expect(event?.correlationId).toBe(envelope?.correlationId);
  });

  it("is a no-op when capture is disabled, so modules need no conditional", async () => {
    const app = buildGateway({ capture: false });
    const res = await request(app).get("/companies/8f1e2d3c-4b5a-4968-8776-655443332211");

    expect(res.status).toBe(200);
    await settle();
    expect(await repo.list()).toHaveLength(0);
  });
});

describe("capture does not disturb the request path", () => {
  // The regression this guards: reading the body at the gateway consumes the
  // stream, and legacy then receives a body-less request (shared/router.ts).
  it("streams a POST body through to legacy untouched", async () => {
    const payload = "x".repeat(200_000);

    const withCapture = await request(buildGateway({ capture: true }))
      .post("/uploads/raw")
      .set("Content-Type", "application/octet-stream")
      .send(payload);
    const withoutCapture = await request(buildGateway({ capture: false }))
      .post("/uploads/raw")
      .set("Content-Type", "application/octet-stream")
      .send(payload);

    expect(withCapture.body.bodyLength).toBe(payload.length);
    expect(withCapture.body).toEqual(withoutCapture.body);
  });

  it("leaves status, headers and body identical", async () => {
    const on = await request(buildGateway({ capture: true })).get("/requests/open?a=1");
    const off = await request(buildGateway({ capture: false })).get("/requests/open?a=1");

    expect(on.status).toBe(off.status);
    expect(on.body).toEqual(off.body);
    expect(on.headers["content-type"]).toBe(off.headers["content-type"]);
    // Capture adds no header of its own.
    const added = Object.keys(on.headers).filter((h) => !(h in off.headers));
    expect(added).toEqual([]);
  });

  it("does not record the request body", async () => {
    const app = buildGateway({ capture: true });
    await request(app)
      .post("/uploads/raw")
      .set("Content-Type", "application/json")
      .send({ password: "hunter2" });

    await settle();
    const serialized = JSON.stringify(await repo.list());
    expect(serialized).not.toContain("hunter2");
  });

  it("still serves requests when the capture write path is broken", async () => {
    repo.appendHook = (): never => {
      throw new Error("storage down");
    };
    writer = new ActivityWriter(repo, { flushIntervalMs: 0, onError: () => {} });

    const res = await request(buildGateway({ capture: true })).get("/requests/open");
    expect(res.status).toBe(200);
    expect(res.body.served).toBe("legacy");
  });

  it("writes nothing at all when capture is disabled", async () => {
    const app = buildGateway({ capture: false });
    await request(app).get("/requests/open");
    await request(app).get("/companies/8f1e2d3c-4b5a-4968-8776-655443332211");

    await settle();
    expect(await repo.list()).toHaveLength(0);
  });
});
