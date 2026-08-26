import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_MS,
  idleProgress,
  isStalled,
  percentageOf,
  toProgress,
  type SyncRunRecord,
} from "./progress.js";

/**
 * Reading a sync run.
 *
 * The judgement worth testing is whether a run that SAYS it is running
 * actually is. Getting it wrong in one direction leaves a progress bar spinning
 * forever with no way to start again; in the other it lets a user launch a
 * second sync of the same source while the first is still writing.
 */

const NOW = new Date("2024-06-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const run = (over: Partial<SyncRunRecord> = {}): SyncRunRecord => ({
  id: "run-1",
  companyId: "co-1",
  sourceKey: "manual_upload_excel_pdf",
  kind: "documents",
  status: "running",
  totalFiles: 10,
  processedFiles: 4,
  currentFile: "BS 2024.pdf",
  currentStep: "extracting",
  result: {},
  errorMessage: null,
  startedAt: ago(60_000),
  heartbeatAt: ago(1_000),
  finishedAt: null,
  ...over,
});

describe("a percentage", () => {
  it("is a whole number of the way through", () => {
    expect(percentageOf(4, 10)).toBe(40);
    expect(percentageOf(1, 3)).toBe(33);
  });

  it("is zero when nothing is known about the total", () => {
    // A sync that has not counted its files yet, not a divide by zero.
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(percentageOf(5, total)).toBe(0);
    }
  });

  it("never exceeds a hundred", () => {
    // A miscounted total would otherwise render a bar past its own end, which
    // reads as a bug in the page rather than in the count.
    expect(percentageOf(15, 10)).toBe(100);
  });

  it("never goes below zero", () => {
    expect(percentageOf(-3, 10)).toBe(0);
  });
});

describe("whether a run has gone quiet", () => {
  it("believes one that beat a moment ago", () => {
    expect(isStalled(run({ heartbeatAt: ago(1_000) }), NOW)).toBe(false);
  });

  it("believes one right up to the limit", () => {
    expect(isStalled(run({ heartbeatAt: ago(STALE_AFTER_MS) }), NOW)).toBe(false);
  });

  it("stops believing one past it", () => {
    expect(isStalled(run({ heartbeatAt: ago(STALE_AFTER_MS + 1) }), NOW)).toBe(true);
  });

  it("treats a missing heartbeat as stalled", () => {
    expect(isStalled(run({ heartbeatAt: null }), NOW)).toBe(true);
  });

  it("never calls a finished run stalled", () => {
    // It is not going anywhere; it arrived.
    for (const status of ["completed", "failed", "cancelled"]) {
      const finished = run({ status, heartbeatAt: ago(999_999), finishedAt: ago(999_000) });
      expect(isStalled(finished, NOW)).toBe(false);
    }
  });

  it("applies to a queued run too", () => {
    // A run that was queued and never picked up is exactly as stuck.
    expect(isStalled(run({ status: "queued", heartbeatAt: ago(STALE_AFTER_MS + 1) }), NOW)).toBe(
      true,
    );
  });
});

describe("what the page renders", () => {
  it("reports a live run as active, with its position", () => {
    const progress = toProgress(run(), NOW);
    expect(progress.active).toBe(true);
    expect(progress.percentage).toBe(40);
    expect(progress.currentFile).toBe("BS 2024.pdf");
    expect(progress.currentStep).toBe("extracting");
    expect(progress.stalled).toBe(false);
  });

  it("reports a stalled run as inactive, but says what happened", () => {
    // Inactive so the button comes back; the status and last position stay so
    // the page can explain rather than pretending nothing happened.
    const progress = toProgress(run({ heartbeatAt: ago(STALE_AFTER_MS + 1) }), NOW);
    expect(progress.active).toBe(false);
    expect(progress.stalled).toBe(true);
    expect(progress.status).toBe("running");
    expect(progress.processedFiles).toBe(4);
  });

  it("shows a completed run at a hundred whatever the counters say", () => {
    // A sync that skipped four unreadable files would otherwise sit at 60%
    // forever, on a run that is over.
    const progress = toProgress(
      run({ status: "completed", processedFiles: 6, finishedAt: ago(1_000) }),
      NOW,
    );
    expect(progress.percentage).toBe(100);
    expect(progress.active).toBe(false);
  });

  it("carries the error off a failed run", () => {
    const progress = toProgress(
      run({ status: "failed", errorMessage: "Could not read page 4.", finishedAt: ago(1_000) }),
      NOW,
    );
    expect(progress.active).toBe(false);
    expect(progress.errorMessage).toBe("Could not read page 4.");
    // NOT forced to 100: it did not finish, and showing a full bar over a
    // failure is the most misleading thing this could do.
    expect(progress.percentage).toBe(40);
  });

  it("answers idle for a company that has never synced", () => {
    const progress = toProgress(null, NOW);
    expect(progress).toEqual(idleProgress());
    expect(progress.active).toBe(false);
    expect(progress.currentStep).toBe("idle");
  });

  it("falls back to the status when there is no step to name", () => {
    const progress = toProgress(run({ currentStep: null, currentFile: null }), NOW);
    expect(progress.currentStep).toBe("running");
    expect(progress.currentFile).toBe("");
  });
});
