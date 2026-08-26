import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { STALE_AFTER_MS } from "./progress.js";
import { InMemorySyncRepository } from "./repository.memory.js";
import { SyncService } from "./service.js";

/**
 * Sync runs.
 *
 * Legacy kept this in two module-level Maps, which fail in three ways a table
 * fixes: progress vanishes on restart, a poll landing on a second process
 * reports idle, and there is no history. The tests below are mostly about the
 * consequence of moving it into a table — a run whose process died now leaves
 * a row behind, and that row must not hold its company's source hostage.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE = "manual_upload_excel_pdf";
const NOW = new Date("2024-06-01T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

const make = () => {
  const repo = new InMemorySyncRepository();
  repo.now = NOW;
  return { repo, service: new SyncService({ repo }) };
};

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "Dana",
  email: "dana@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

describe("starting a run", () => {
  it("records it as running, and the progress bar picks it up", async () => {
    const { service } = make();
    const user = session();
    const run = await service.start(user, COMPANY, { sourceKey: SOURCE, totalFiles: 10 }, NOW);

    expect(run.status).toBe("running");
    const progress = await service.progress(user, COMPANY, {}, NOW);
    expect(progress.active).toBe(true);
    expect(progress.runId).toBe(run.id);
    expect(progress.totalFiles).toBe(10);
  });

  it("refuses a second run of the same source with a 409", async () => {
    // Two syncs of one source race each other into the same tables, and the
    // later writer wins by accident of timing.
    const { service } = make();
    const user = session();
    const first = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);

    await expect(
      service.start(user, COMPANY, { sourceKey: SOURCE }, NOW),
    ).rejects.toMatchObject({ status: 409 });

    // And it names which run to watch instead.
    try {
      await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    } catch (err) {
      expect((err as Error).message).toContain(first.id);
    }
  });

  it("allows a different source at the same time", async () => {
    // They write to different places; there is nothing to race.
    const { service } = make();
    const user = session();
    await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    const other = await service.start(user, COMPANY, { sourceKey: "quickbooks_online" }, NOW);
    expect(other.status).toBe("running");
  });

  it("allows another after the first finishes", async () => {
    const { service } = make();
    const user = session();
    const first = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    await service.finish(user, COMPANY, first.id, { status: "completed" });

    const second = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    expect(second.id).not.toBe(first.id);
  });

  it("refuses one that names no source", async () => {
    const { service } = make();
    await expect(service.start(session(), COMPANY, { sourceKey: "" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

describe("a run whose process died", () => {
  it("stops being reported as active once it goes quiet", async () => {
    const { service } = make();
    const user = session();
    await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);

    const soon = await service.progress(user, COMPANY, {}, later(1_000));
    expect(soon.active).toBe(true);

    const late = await service.progress(user, COMPANY, {}, later(STALE_AFTER_MS + 1));
    expect(late.active).toBe(false);
  });

  it("does not hold the source hostage — a new run can start", async () => {
    // This is the cost of moving off an in-memory Map: a corpse survives. The
    // unique index would refuse every future run for this company and source,
    // and the button would never work again.
    const { repo, service } = make();
    const user = session();
    await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);

    repo.now = later(STALE_AFTER_MS + 1);
    const fresh = await service.start(user, COMPANY, { sourceKey: SOURCE }, repo.now);
    expect(fresh.status).toBe("running");
  });

  it("closes it out as failed, saying what happened", async () => {
    const { repo, service } = make();
    const user = session();
    const stalled = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);

    repo.now = later(STALE_AFTER_MS + 1);
    await service.progress(user, COMPANY, {}, repo.now);

    const [latest, previous] = await service.history(user, COMPANY);
    expect([latest, previous].some((r) => r?.id === stalled.id)).toBe(true);
    const closed = (await service.history(user, COMPANY)).find((r) => r.id === stalled.id)!;
    expect(closed.status).toBe("failed");
    expect(closed.errorMessage).toContain("stopped reporting");
  });

  it("leaves a live run alone", async () => {
    const { repo, service } = make();
    const user = session();
    const run = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);

    repo.now = later(60_000);
    await service.advance(user, COMPANY, run.id, { processedFiles: 3 });
    await service.progress(user, COMPANY, {}, repo.now);

    const still = (await service.history(user, COMPANY))[0]!;
    expect(still.status).toBe("running");
  });

  it("does not reap one company's run when another is read", async () => {
    const { repo, service } = make();
    const dana = session();
    const sam = session({ company_ids: [OTHER] });
    const mine = await service.start(dana, COMPANY, { sourceKey: SOURCE }, NOW);

    repo.now = later(STALE_AFTER_MS + 1);
    await service.progress(sam, OTHER, {}, repo.now);

    const untouched = (await service.history(dana, COMPANY)).find((r) => r.id === mine.id)!;
    expect(untouched.status).toBe("running");
  });
});

describe("advancing and finishing", () => {
  it("moves the bar and keeps the run alive", async () => {
    const { repo, service } = make();
    const user = session();
    const run = await service.start(user, COMPANY, { sourceKey: SOURCE, totalFiles: 4 }, NOW);

    repo.now = later(120_000);
    await service.advance(user, COMPANY, run.id, {
      processedFiles: 2,
      currentFile: "BS.pdf",
      currentStep: "extracting",
    });

    const progress = await service.progress(user, COMPANY, {}, repo.now);
    expect(progress.percentage).toBe(50);
    expect(progress.currentFile).toBe("BS.pdf");
    // The advance was itself a heartbeat, so it is still live two minutes on.
    expect(progress.active).toBe(true);
  });

  it("refuses to advance a run that already finished", async () => {
    // The page would show a completed sync creeping forward.
    const { service } = make();
    const user = session();
    const run = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    await service.finish(user, COMPANY, run.id, { status: "completed" });

    await expect(
      service.advance(user, COMPANY, run.id, { processedFiles: 9 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("keeps what a failed run managed to produce", async () => {
    // Nine imports and one error is not the same as nothing.
    const { service } = make();
    const user = session();
    const run = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    await service.finish(user, COMPANY, run.id, {
      status: "failed",
      result: { imported: 9 },
      errorMessage: "Could not read page 4.",
    });

    const finished = (await service.history(user, COMPANY))[0]!;
    expect(finished.result).toEqual({ imported: 9 });
    expect(finished.errorMessage).toBe("Could not read page 4.");
  });

  it("does not overwrite the first outcome when finished twice", async () => {
    const { service } = make();
    const user = session();
    const run = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    await service.finish(user, COMPANY, run.id, { status: "failed", errorMessage: "first" });
    await service.finish(user, COMPANY, run.id, { status: "completed", errorMessage: null });

    const finished = (await service.history(user, COMPANY))[0]!;
    expect(finished.status).toBe("failed");
    expect(finished.errorMessage).toBe("first");
  });

  it("404s a run that is not there, or belongs to someone else", async () => {
    const { service } = make();
    const user = session();
    const mine = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);

    await expect(
      service.advance(user, COMPANY, randomUUID(), { processedFiles: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.advance(session({ company_ids: [OTHER] }), OTHER, mine.id, { processedFiles: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("history", () => {
  it("answers what the Maps never could — did the last run finish?", async () => {
    const { service } = make();
    const user = session();
    const first = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    await service.finish(user, COMPANY, first.id, { status: "failed", errorMessage: "boom" });
    const second = await service.start(user, COMPANY, { sourceKey: SOURCE }, NOW);
    await service.finish(user, COMPANY, second.id, { status: "completed" });

    const runs = await service.history(user, COMPANY);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status)).toContain("failed");
  });

  it("caps the list", async () => {
    const { service } = make();
    const user = session();
    for (let i = 0; i < 30; i++) {
      const run = await service.start(user, COMPANY, { sourceKey: `source-${i}` }, NOW);
      await service.finish(user, COMPANY, run.id, { status: "completed" });
    }
    expect(await service.history(user, COMPANY, 5)).toHaveLength(5);
    expect(await service.history(user, COMPANY)).toHaveLength(20);
    expect(await service.history(user, COMPANY, Number.NaN)).toHaveLength(20);
  });
});

describe("scoping and access", () => {
  it("narrows the progress read to one source", async () => {
    const { service } = make();
    const user = session();
    await service.start(user, COMPANY, { sourceKey: "quickbooks_online" }, NOW);

    const wrong = await service.progress(user, COMPANY, { sourceKey: SOURCE }, NOW);
    expect(wrong.active).toBe(false);
    const right = await service.progress(user, COMPANY, { sourceKey: "quickbooks_online" }, NOW);
    expect(right.active).toBe(true);
  });

  it("answers idle for a company that has never synced", async () => {
    const { service } = make();
    const progress = await service.progress(session(), COMPANY, {}, NOW);
    expect(progress.active).toBe(false);
    expect(progress.currentStep).toBe("idle");
  });

  it("refuses a company the caller cannot reach", async () => {
    const { service } = make();
    const stranger = session({ role: "buyer", company_ids: [OTHER] });
    await expect(service.progress(stranger, COMPANY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.start(stranger, COMPANY, { sourceKey: SOURCE }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.history(stranger, COMPANY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses a request naming no company", async () => {
    const { service } = make();
    await expect(service.progress(session(), "")).rejects.toBeInstanceOf(BadRequestError);
  });
});
