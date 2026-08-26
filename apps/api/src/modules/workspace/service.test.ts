import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import { InMemoryWorkspaceRepository } from "./repository.memory.js";
import { CIM_QUESTIONNAIRE_PAGE_KEY, scopedPageKey, WorkspaceService } from "./service.js";

/**
 * Workspace page state.
 *
 * The design worth pinning: the table is unique on (company, page key) and has
 * no user column, so privacy comes from scoping the *key*. Ordinary page state
 * appends the user id and is private; the CIM questionnaire deliberately does
 * not and is shared. Get that backwards and either two brokers overwrite each
 * other's drafts, or a client cannot see the questionnaire sent to them.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "Dana",
  email: "dana@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

function make() {
  const repo = new InMemoryWorkspaceRepository();
  return {
    repo,
    service: new WorkspaceService({ repo, now: () => new Date("2024-06-01T12:00:00.000Z") }),
  };
}

describe("page state is private per user", () => {
  it("round-trips a payload the server never inspects", async () => {
    const { service } = make();
    const user = session();

    const saved = await service.savePageState(user, COMPANY, "cim-prep", { step: 3, notes: "x" });
    expect(saved).toMatchObject({ success: true, userId: user.id });
    expect(saved.state).toEqual({ step: 3, notes: "x" });

    expect((await service.getPageState(user, COMPANY, "cim-prep")).state).toEqual({
      step: 3,
      notes: "x",
    });
  });

  it("scopes the stored key to the user", async () => {
    const { repo, service } = make();
    const user = session();
    await service.savePageState(user, COMPANY, "cim-prep", { a: 1 });
    expect(repo.storedKeys()).toEqual([scopedPageKey("cim-prep", user.id)]);
  });

  it("keeps two users' drafts of the same page apart", async () => {
    // The failure this prevents: one unique row per (company, page), so without
    // key scoping the second save silently overwrites the first.
    const { service } = make();
    const dana = session();
    const sam = session();

    await service.savePageState(dana, COMPANY, "cim-prep", { owner: "dana" });
    await service.savePageState(sam, COMPANY, "cim-prep", { owner: "sam" });

    expect((await service.getPageState(dana, COMPANY, "cim-prep")).state).toEqual({ owner: "dana" });
    expect((await service.getPageState(sam, COMPANY, "cim-prep")).state).toEqual({ owner: "sam" });
  });

  it("reports null rather than failing when nothing is stored", async () => {
    const { service } = make();
    expect(await service.getPageState(session(), COMPANY, "never-saved")).toMatchObject({
      state: null,
      updatedAt: null,
    });
  });

  it("stores an empty object when given no payload", async () => {
    const { service } = make();
    expect((await service.savePageState(session(), COMPANY, "k", undefined)).state).toEqual({});
  });

  it("clears only the caller's own state", async () => {
    const { service } = make();
    const dana = session();
    const sam = session();
    await service.savePageState(dana, COMPANY, "cim-prep", { owner: "dana" });
    await service.savePageState(sam, COMPANY, "cim-prep", { owner: "sam" });

    expect(await service.clearPageState(dana, COMPANY, "cim-prep")).toEqual({
      success: true,
      deleted: true,
    });
    expect((await service.getPageState(sam, COMPANY, "cim-prep")).state).toEqual({ owner: "sam" });
  });

  it("reports deleted:false when there was nothing to clear", async () => {
    const { service } = make();
    expect(await service.clearPageState(session(), COMPANY, "nothing")).toEqual({
      success: true,
      deleted: false,
    });
  });
});

describe("the CIM questionnaire is shared", () => {
  it("is stored under an unscoped key, so both sides see one document", async () => {
    const { repo, service } = make();
    const broker = session();
    await service.saveQuestionnaire(broker, COMPANY, { items: { q1: "a" } });

    expect(repo.storedKeys()).toEqual([CIM_QUESTIONNAIRE_PAGE_KEY]);
  });

  it("is readable by a different user on the same company", async () => {
    const { service } = make();
    await service.saveQuestionnaire(session(), COMPANY, { items: { q1: "answer" } });

    const client = session({ role: "buyer" });
    const read = await service.getQuestionnaire(client, COMPANY);
    expect((read.state as { items: unknown }).items).toEqual({ q1: "answer" });
  });

  it("stamps who last touched it and when", async () => {
    const { service } = make();
    const user = session();
    const saved = await service.saveQuestionnaire(user, COMPANY, { items: {} });

    expect(saved.state).toMatchObject({
      version: 1,
      updatedAt: "2024-06-01T12:00:00.000Z",
      updatedBy: { id: user.id, name: "Dana", email: "dana@example.com", role: "broker" },
    });
  });

  it("will not let a caller backdate the workflow stamps it does not own", async () => {
    // `updatedAt` and `updatedBy` are server facts. A client posting its own
    // would rewrite who answered the questionnaire and when.
    const { service } = make();
    const saved = await service.saveQuestionnaire(session(), COMPANY, {
      items: {},
      updatedAt: "1999-01-01T00:00:00.000Z",
      updatedBy: { id: "someone-else", name: "Not Me", email: "x@y.z", role: "admin" },
    });

    expect((saved.state as { updatedAt: string }).updatedAt).toBe("2024-06-01T12:00:00.000Z");
    expect((saved.state as { updatedBy: { name: string } }).updatedBy.name).toBe("Dana");
  });

  it("preserves the workflow fields a caller does own", async () => {
    const { service } = make();
    const saved = await service.saveQuestionnaire(session(), COMPANY, {
      items: { q1: "a" },
      currentBatchId: "batch-2",
      history: [{ batch: 1 }],
      sentAt: "2024-05-01T00:00:00.000Z",
      clientSubmittedAt: "2024-05-09T00:00:00.000Z",
    });

    expect(saved.state).toMatchObject({
      currentBatchId: "batch-2",
      history: [{ batch: 1 }],
      sentAt: "2024-05-01T00:00:00.000Z",
      clientSubmittedAt: "2024-05-09T00:00:00.000Z",
    });
  });

  it("defaults a malformed envelope rather than storing it", async () => {
    const { service } = make();
    const saved = await service.saveQuestionnaire(session(), COMPANY, {
      items: "not an object",
      history: "not an array",
      currentBatchId: 42,
    });

    expect(saved.state).toMatchObject({ items: {}, history: [], currentBatchId: "" });
  });

  it("takes a save with nothing in it, and fills the envelope", async () => {
    // The page saves as somebody types, including before they have typed
    // anything. A save with no payload must not throw — it is the first one.
    const { service } = make();
    const saved = await service.saveQuestionnaire(session(), COMPANY, undefined);

    expect(saved.state).toMatchObject({
      version: 1,
      items: {},
      currentBatchId: "",
      history: [],
      createdAt: "2024-06-01T12:00:00.000Z",
    });
  });

  it("ignores fields sent in the wrong shape rather than storing them", async () => {
    // Stored as sent, a string `items` breaks every reader afterwards, and the
    // questionnaire is unopenable until somebody edits the database.
    const { service } = make();
    const saved = await service.saveQuestionnaire(session(), COMPANY, {
      items: "not an object",
      currentBatchId: 42,
      history: "not a list",
      createdAt: 1999,
    } as never);

    expect(saved.state).toMatchObject({
      items: {},
      currentBatchId: "",
      history: [],
      createdAt: "2024-06-01T12:00:00.000Z",
    });
  });

  it("keeps the creation time across later saves", async () => {
    // It is when the questionnaire was started, not when it was last touched —
    // `updatedAt` is the other one.
    const { service } = make();
    await service.saveQuestionnaire(session(), COMPANY, { items: {} });
    const again = await service.saveQuestionnaire(session(), COMPANY, {
      items: { q1: "a" },
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    expect((again.state as { createdAt: string }).createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("names a user who has no name, and one who has nothing at all", async () => {
    // The stamp goes on screen as "last edited by". An empty one reads as a
    // rendering fault rather than as an unnamed account.
    const { service } = make();
    const nameless = await service.saveQuestionnaire(
      session({ name: "", email: "someone@example.com" }),
      COMPANY,
      { items: {} },
    );
    expect((nameless.state as { updatedBy: { name: string } }).updatedBy.name).toBe(
      "someone@example.com",
    );

    const anonymous = await service.saveQuestionnaire(
      session({ name: "", email: "", role: "" as never }),
      COMPANY,
      { items: {} },
    );
    expect((anonymous.state as { updatedBy: { name: string } }).updatedBy.name).toBe("User");
  });

  it("returns null for a company with no questionnaire yet", async () => {
    const { service } = make();
    expect((await service.getQuestionnaire(session(), COMPANY)).state).toBeNull();
  });
});

describe("access", () => {
  it("requires a company id", async () => {
    const { service } = make();
    const user = session();
    await expect(service.getPageState(user, undefined, "k")).rejects.toThrow(BadRequestError);
    await expect(service.savePageState(user, undefined, "k", {})).rejects.toThrow(BadRequestError);
    await expect(service.clearPageState(user, undefined, "k")).rejects.toThrow(BadRequestError);
    await expect(service.getQuestionnaire(user, undefined)).rejects.toThrow(BadRequestError);
    await expect(service.saveQuestionnaire(user, undefined, {})).rejects.toThrow(BadRequestError);
  });

  it("refuses a company the caller is not on", async () => {
    // The company arrives from a header, a query parameter or the Referer — all
    // caller-controlled — so this check is the only thing standing behind it.
    const { service } = make();
    const outsider = session({ company_ids: [OTHER] });
    await expect(service.getPageState(outsider, COMPANY, "k")).rejects.toThrow(ForbiddenError);
    await expect(service.getQuestionnaire(outsider, COMPANY)).rejects.toThrow(ForbiddenError);
  });

  it("lets an admin through", async () => {
    const { service } = make();
    const admin = session({ role: "admin", company_ids: [] });
    await expect(service.getPageState(admin, COMPANY, "k")).resolves.toMatchObject({
      success: true,
    });
  });
});
