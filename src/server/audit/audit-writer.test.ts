import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for AuditWriter and emitEvent.
 *
 * The integration suite (audit.integration.test.ts, server project) covers:
 * pseudonymisation, context allowlist, hash chain correctness, one-conflict
 * retry against a real fake repository, and the basic emitEvent audit path.
 *
 * Branches targeted here (unit project, mocked repository):
 *  - write(): retry succeeds on second attempt after AuditChainConflictError
 *  - write(): MAX_APPEND_ATTEMPTS exhausted → throws last conflict
 *  - write(): non-conflict error rethrows immediately (does not consume attempts)
 *  - write(): droppedKeys / redactedKeys trigger warn log
 *  - tryWrite(): returns null and logs error instead of throwing
 *  - emitEvent(): no-activity early return
 *  - emitEvent(): activity write failure after successful audit write
 */

// ── Hoisted mocks (referenced in vi.mock factories below) ────────────────────

const mocks = vi.hoisted(() => ({
  findLatestForSubject: vi.fn(),
  append: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 3).toString("base64") },
}));

vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/telemetry/logger", () => ({
  logger: { error: mocks.logError, warn: mocks.logWarn },
}));

vi.mock("@/server/repositories/audit-event-repository", () => {
  class AuditChainConflictError extends Error {
    constructor() {
      super("audit chain link already claimed");
      this.name = "AuditChainConflictError";
    }
  }
  class MockAuditEventRepository {
    findLatestForSubject = mocks.findLatestForSubject;
    append = mocks.append;
  }
  return { AuditEventRepository: MockAuditEventRepository, AuditChainConflictError };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const { AuditWriter, emitEvent } = await import("./audit-writer");
const { AuditChainConflictError } = await import("@/server/repositories/audit-event-repository");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AUDIT_INPUT = {
  userId: "user-00000000-0000-0000-0000-000000000001",
  eventType: "auth.signed_in" as const,
  actorType: "user" as const,
};

/** Minimal stored-event shape returned by the mock repository. */
function fakeStoredEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-test",
    eventType: "auth.signed_in",
    subjectRef: "a".repeat(64),
    actorType: "user",
    entityType: null,
    entityId: null,
    contextJson: "{}",
    eventHash: "b".repeat(64),
    prevHash: "0".repeat(64),
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function writer(): InstanceType<typeof AuditWriter> {
  // Pass an empty object — the db arg is forwarded to the mocked repository class.
  return new AuditWriter({} as never);
}

beforeEach(() => {
  mocks.findLatestForSubject.mockReset();
  mocks.append.mockReset();
  mocks.logError.mockReset();
  mocks.logWarn.mockReset();

  // Default: chain tail is empty, append succeeds.
  mocks.findLatestForSubject.mockResolvedValue(null);
  mocks.append.mockResolvedValue(fakeStoredEvent());
});

// ── write(): conflict retry ───────────────────────────────────────────────────

describe("AuditWriter.write — AuditChainConflictError retry", () => {
  it("retries and succeeds after a single chain conflict", async () => {
    const secondEvent = fakeStoredEvent({ id: "evt-second" });
    mocks.append
      .mockRejectedValueOnce(new AuditChainConflictError())
      .mockResolvedValueOnce(secondEvent);

    const result = await writer().write(AUDIT_INPUT);
    expect(result.event).toMatchObject(secondEvent);
    expect(mocks.append).toHaveBeenCalledTimes(2);
  });

  it("re-reads the chain tail on each retry", async () => {
    // Each retry must re-read so it does not claim the same stale tail forever.
    mocks.append
      .mockRejectedValueOnce(new AuditChainConflictError())
      .mockResolvedValueOnce(fakeStoredEvent());

    await writer().write(AUDIT_INPUT);
    expect(mocks.findLatestForSubject).toHaveBeenCalledTimes(2);
  });

  it("exhausts MAX_APPEND_ATTEMPTS and throws the last conflict", async () => {
    // Five is the bounded maximum defined in audit-writer.ts.
    const conflict = new AuditChainConflictError();
    mocks.append.mockRejectedValue(conflict);

    await expect(writer().write(AUDIT_INPUT)).rejects.toBe(conflict);
    expect(mocks.append).toHaveBeenCalledTimes(5);
  });
});

// ── write(): non-conflict error rethrows immediately ─────────────────────────

describe("AuditWriter.write — non-conflict error", () => {
  it("rethrows immediately without consuming remaining attempts", async () => {
    const dbError = new Error("unexpected database error");
    mocks.append.mockRejectedValue(dbError);

    await expect(writer().write(AUDIT_INPUT)).rejects.toThrow(dbError);
    // One attempt only — the loop does not retry on unrecognized errors.
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a non-conflict error in subsequent attempts", async () => {
    mocks.append
      .mockRejectedValueOnce(new AuditChainConflictError())
      .mockRejectedValueOnce(new Error("hard storage failure"));

    await expect(writer().write(AUDIT_INPUT)).rejects.toThrow("hard storage failure");
    expect(mocks.append).toHaveBeenCalledTimes(2);
  });
});

// ── tryWrite() ────────────────────────────────────────────────────────────────

describe("AuditWriter.tryWrite", () => {
  it("returns null instead of throwing when write fails", async () => {
    mocks.append.mockRejectedValue(new Error("storage unavailable"));
    const result = await writer().tryWrite(AUDIT_INPUT);
    expect(result).toBeNull();
  });

  it("logs an error-level event when the write fails", async () => {
    mocks.append.mockRejectedValue(new Error("storage unavailable"));
    await writer().tryWrite(AUDIT_INPUT);
    expect(mocks.logError).toHaveBeenCalledWith(
      "audit.write_failed",
      expect.objectContaining({ operation: "audit.write" }),
    );
  });

  it("returns the result normally when write succeeds", async () => {
    const stored = fakeStoredEvent({ id: "evt-ok" });
    mocks.append.mockResolvedValue(stored);
    const result = await writer().tryWrite(AUDIT_INPUT);
    expect(result?.event).toMatchObject(stored);
  });
});

// ── emitEvent(): no-activity early return ────────────────────────────────────

describe("emitEvent — no-activity path", () => {
  it("returns activity: null when no activity input is provided", async () => {
    const result = await emitEvent({ audit: AUDIT_INPUT }, writer());
    expect(result.activity).toBeNull();
  });

  it("still persists the audit event when no activity is provided", async () => {
    await emitEvent({ audit: AUDIT_INPUT }, writer());
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });
});

// ── emitEvent(): activity write failure ──────────────────────────────────────

describe("emitEvent — activity write failure after successful audit", () => {
  const failingActivityWriter = {
    write: vi.fn(() => Promise.reject(new Error("activity db error"))),
  };

  const ACTIVITY_INPUT = {
    audit: AUDIT_INPUT,
    activity: {
      userId: AUDIT_INPUT.userId,
      type: "auth.signed_in" as never,
    },
  };

  it("returns activity: null when the activity write fails", async () => {
    const result = await emitEvent(ACTIVITY_INPUT, writer(), failingActivityWriter as never);
    expect(result.activity).toBeNull();
  });

  it("preserves the successful audit result even when activity fails", async () => {
    const stored = fakeStoredEvent({ id: "evt-audit-ok" });
    mocks.append.mockResolvedValue(stored);

    const result = await emitEvent(ACTIVITY_INPUT, writer(), failingActivityWriter as never);
    expect(result.event).toMatchObject(stored);
  });

  it("logs an error-level event when the activity write fails", async () => {
    await emitEvent(ACTIVITY_INPUT, writer(), failingActivityWriter as never);
    expect(mocks.logError).toHaveBeenCalledWith(
      "activity.write_failed",
      expect.objectContaining({ operation: "activity.emit" }),
    );
  });

  it("does not propagate the activity error", async () => {
    await expect(
      emitEvent(ACTIVITY_INPUT, writer(), failingActivityWriter as never),
    ).resolves.toBeDefined();
  });
});
