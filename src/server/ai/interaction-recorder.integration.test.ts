import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type { InteractionRecord } from "./interaction-recorder";
import type { AiInteractionRepository } from "@/server/repositories/ai-interaction-repository";
import type { LogRecord } from "@/lib/telemetry/logger";

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64"),
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { PersistentInteractionRecorder, noopInteractionRecorder } =
  await import("./interaction-recorder");
const { setLogSink } = await import("@/lib/telemetry/logger");

/**
 * Task #109 — the recorder returns the row id it wrote.
 *
 * The id originates in Postgres and the repository already returns it; before
 * this it was discarded one layer up. What these assert is that the id reaching
 * a caller is **the row's**, not one manufactured here — the difference between
 * feedback attaching to a real interaction and attaching to nothing.
 */

const interaction: InteractionRecord = {
  userId: "user-1",
  purpose: "explain_finding",
  model: "claude-sonnet-5",
  promptVersion: 1,
  policyVersion: 1,
  recordsReferenced: ["11111111-1111-1111-1111-111111111111"],
  outputSchemaVersion: 1,
  status: "validated",
  latencyMs: 900,
};

let logs: LogRecord[] = [];
let restoreSink: (record: LogRecord) => void;

beforeEach(() => {
  logs = [];
  restoreSink = setLogSink((record) => logs.push(record));
});

afterEach(() => {
  setLogSink(restoreSink);
});

describe("the id comes from the row, not from here", () => {
  it("returns exactly what the repository reported", async () => {
    /**
     * Asserted by identity against the repository's own value rather than
     * `expect.any(String)`: a generated id would satisfy a shape assertion and
     * still point at no row.
     */
    const repository = {
      record: () => Promise.resolve({ id: "db-generated-uuid" }),
    } as unknown as AiInteractionRepository;

    const id = await new PersistentInteractionRecorder(repository).record(interaction);

    expect(id).toBe("db-generated-uuid");
  });

  it("passes the interaction through unchanged", async () => {
    const seen: InteractionRecord[] = [];
    const repository = {
      record: (input: InteractionRecord) => {
        seen.push(input);
        return Promise.resolve({ id: "x" });
      },
    } as unknown as AiInteractionRepository;

    await new PersistentInteractionRecorder(repository).record(interaction);

    expect(seen[0]).toEqual(interaction);
  });
});

describe("a storage failure surfaces no id and fails nothing", () => {
  const failing = {
    record: () => Promise.reject(new Error("store down")),
  } as unknown as AiInteractionRepository;

  it("returns null rather than throwing", async () => {
    /**
     * ATL-052's rule holds: bookkeeping never fails the user's request. And
     * without a row there is nothing for feedback to attach to, so `null` is the
     * honest answer rather than a fabricated id.
     */
    const id = await new PersistentInteractionRecorder(failing).record(interaction);

    expect(id).toBeNull();
  });

  it("still logs the failure so it is visible", async () => {
    await new PersistentInteractionRecorder(failing).record(interaction);

    expect(logs.map((record) => record.event)).toContain("ai.interaction_record_failed");
  });

  it("logs no identifier from the interaction", async () => {
    await new PersistentInteractionRecorder(failing).record(interaction);

    expect(JSON.stringify(logs)).not.toContain("11111111-1111-1111-1111-111111111111");
  });
});

describe("the inert recorder", () => {
  it("returns null, because it wrote nothing", async () => {
    expect(await noopInteractionRecorder.record(interaction)).toBeNull();
  });
});
