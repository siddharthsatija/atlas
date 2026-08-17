import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LoggerModule from "@/lib/telemetry/logger";

/**
 * ATL-045 — the recalculation seam, now that it is real.
 *
 * `SnapshotScoreRecalculationQueue` is the one piece of production wiring this
 * ticket adds, and it sits inside every asset and finding mutation. What matters
 * about it is not the score — `PrivacyScoreService` has its own suite — but its
 * contract with the callers around it:
 *
 *   - it asks for a snapshot for the right user, with the trigger that caused it
 *   - it **never throws**, because every call site's mutation has already
 *     succeeded and must not be undone by a derived number failing to update
 *   - a failure is reported, because §14 requires jobs to be observable and a
 *     score that silently stops moving is exactly what someone would hunt for
 */

vi.mock("@/config/env", () => ({
  env: {
    ATLAS_KEK: Buffer.alloc(32, 9).toString("base64"),
    ATLAS_KEK_VERSION: 1,
    AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
  },
}));

const { SnapshotScoreRecalculationQueue, NoopScoreRecalculationQueue } =
  await import("./recalculation-queue");
const { setLogSink } = await import("@/lib/telemetry/logger");

type LogRecord = Parameters<NonNullable<Parameters<(typeof LoggerModule)["setLogSink"]>[0]>>[0];

const USER = "11111111-1111-4111-8111-111111111111";

const createSnapshot = vi.fn();
const logged: LogRecord[] = [];

/** Only the one method the queue uses; the service has its own suite. */
const service = () =>
  ({ createSnapshot }) as unknown as ConstructorParameters<
    typeof SnapshotScoreRecalculationQueue
  >[0];

beforeEach(() => {
  createSnapshot.mockReset();
  createSnapshot.mockResolvedValue({ ok: true, data: { status: "written" } });
  logged.length = 0;
  setLogSink((record) => logged.push(record));
});

describe("what the queue asks for", () => {
  it("requests a snapshot for the user, naming the trigger", async () => {
    await new SnapshotScoreRecalculationQueue(service()).enqueue({
      userId: USER,
      reason: "asset.updated",
    });

    expect(createSnapshot).toHaveBeenCalledWith(USER, "asset.updated");
  });

  it.each(["asset.created", "asset.archived", "finding.changed"] as const)(
    "passes %s through as the reason",
    async (reason) => {
      await new SnapshotScoreRecalculationQueue(service()).enqueue({ userId: USER, reason });

      expect(createSnapshot).toHaveBeenCalledWith(USER, reason);
    },
  );

  it("supplies no timestamp, leaving the service to read the clock", async () => {
    // The snapshot's `recorded_at` is the database's (ATL-113), and the
    // calculation's `now` is the service's default. A queue that injected one
    // would put a third clock into a chain that deliberately has one.
    await new SnapshotScoreRecalculationQueue(service()).enqueue({
      userId: USER,
      reason: "asset.updated",
    });

    expect(createSnapshot.mock.calls[0]).toHaveLength(2);
  });
});

describe("when the snapshot cannot be written", () => {
  it("does not throw, so the user's mutation survives", async () => {
    /**
     * Every call site wraps this in its own try/catch, but relying on that would
     * make correctness depend on three separate callers remembering. A dropped
     * recalculation costs a stale score until the next trigger; a thrown one
     * could cost the user their edit.
     */
    createSnapshot.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    await expect(
      new SnapshotScoreRecalculationQueue(service()).enqueue({
        userId: USER,
        reason: "asset.updated",
      }),
    ).resolves.toBeUndefined();
  });

  it("reports the failure at error level", async () => {
    createSnapshot.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    await new SnapshotScoreRecalculationQueue(service()).enqueue({
      userId: USER,
      reason: "finding.changed",
    });

    const failure = logged.find((record) => record.event === "score.recalculation_failed");
    expect(failure?.level).toBe("error");
    expect(failure?.operation).toBe("finding.changed");
  });

  it("logs no user id", async () => {
    // Architecture §10: no internal record identifiers in logs.
    createSnapshot.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    await new SnapshotScoreRecalculationQueue(service()).enqueue({
      userId: USER,
      reason: "asset.updated",
    });

    expect(JSON.stringify(logged)).not.toContain(USER);
  });

  it("stays quiet when the snapshot succeeded", async () => {
    await new SnapshotScoreRecalculationQueue(service()).enqueue({
      userId: USER,
      reason: "asset.updated",
    });

    expect(logged.filter((record) => record.event === "score.recalculation_failed")).toHaveLength(
      0,
    );
  });

  it("stays quiet when nothing changed, which is a success", async () => {
    // Write-on-change: an unchanged recalculation is the rule working, not a
    // failure, and logging it at error level would train operators to ignore it.
    createSnapshot.mockResolvedValue({ ok: true, data: { status: "unchanged" } });

    await new SnapshotScoreRecalculationQueue(service()).enqueue({
      userId: USER,
      reason: "asset.updated",
    });

    expect(logged.filter((record) => record.event === "score.recalculation_failed")).toHaveLength(
      0,
    );
  });
});

describe("the no-op it replaced", () => {
  it("still exists for tests and explicit injection, and writes nothing", async () => {
    /**
     * Kept deliberately: `NoopScoreRecalculationQueue` is the constructor
     * default for every service, so a test can build one without a score
     * calculation running underneath it. No production path reaches it — every
     * `create()` passes the snapshot queue explicitly.
     */
    await new NoopScoreRecalculationQueue().enqueue({ userId: USER, reason: "asset.updated" });

    expect(createSnapshot).not.toHaveBeenCalled();
  });
});
