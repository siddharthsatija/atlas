import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for ActivityWriter branches not covered by the integration suite
 * (activity-writer.integration.test.ts, server project).
 *
 * Integration coverage already includes:
 *  - Unknown event type → UnknownActivityEventTypeError
 *  - Unmasked maskedIdentifier → UnsafeActivitySummaryError
 *  - scrubString hit on composed control sentence → UnsafeActivitySummaryError
 *  - Metadata drop/redact → warn log (counted, never echoed)
 *  - entityType / entityId optional spreads (via the shared-emitter test)
 *
 * Genuine gap targeted here:
 *  - occurredAt optional spread: the input.occurredAt → .toISOString() path is
 *    never exercised by the integration suite; the absent branch is the only one
 *    covered. This matters for persistence: events with a known timestamp must
 *    reach the repository with that value, not a server-assigned one.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  logWarn: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));

vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/telemetry/logger", () => ({
  logger: { warn: mocks.logWarn, error: vi.fn() },
}));

vi.mock("@/server/repositories/activity-event-repository", () => ({
  ActivityEventRepository: class MockActivityEventRepository {
    append = mocks.append;
  },
}));

// Real implementations used for: isActivityEventType, buildActivitySummary,
// scrubString, redactActivityMetadata, MASK_CHAR — their real behaviour is what
// the integration suite tests; the mock boundary here is only the repository.

// ── Imports ───────────────────────────────────────────────────────────────────

const { ActivityWriter } = await import("./activity-writer");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALICE = "user-00000000-0000-0000-0000-000000000001";

function fakeActivityRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "act-test",
    userId: ALICE,
    eventType: "auth.signed_in",
    summary: "Signed in.",
    entityType: null,
    entityId: null,
    metadata: {},
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function writer(): InstanceType<typeof ActivityWriter> {
  return new ActivityWriter({} as never);
}

beforeEach(() => {
  mocks.append.mockReset();
  mocks.logWarn.mockReset();
  mocks.append.mockResolvedValue(fakeActivityRecord());
});

// ── occurredAt optional spread ────────────────────────────────────────────────

describe("ActivityWriter.write — occurredAt propagation", () => {
  /**
   * The `...(input.occurredAt ? { occurredAt: ... } : {})` ternary in write()
   * has only its absent branch covered by the integration suite. The present
   * branch — forward a caller-supplied timestamp — is the meaningful one: it is
   * what allows an event to be recorded at a point in time other than when the
   * write happens (e.g. a retroactive activity row after an import or replay).
   */
  it("forwards a caller-supplied occurredAt as an ISO string to the repository", async () => {
    const at = new Date("2025-03-15T10:00:00.000Z");

    await writer().write({
      userId: ALICE,
      type: "onboarding.completed",
      occurredAt: at,
    });

    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: at.toISOString() }),
    );
  });

  it("omits occurredAt from the repository call when the input does not supply one", async () => {
    await writer().write({
      userId: ALICE,
      type: "onboarding.completed",
    });

    const call = mocks.append.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(call).not.toHaveProperty("occurredAt");
  });

  it("calls toISOString, not toString, on the supplied Date", async () => {
    // Belt-and-suspenders: the branch must produce the ISO 8601 form that the
    // database column expects, not a locale-dependent string.
    const at = new Date("2024-12-01T00:00:00.000Z");
    await writer().write({ userId: ALICE, type: "onboarding.completed", occurredAt: at });

    const { occurredAt } = mocks.append.mock.calls[0]?.[0] as unknown as Record<string, string>;
    expect(occurredAt).toBe("2024-12-01T00:00:00.000Z");
  });
});

// ── entityType / entityId optional spreads ────────────────────────────────────

describe("ActivityWriter.write — optional entity spreads", () => {
  /**
   * entityType and entityId are a required pair by table constraint. The writer
   * uses ternary spreads for each independently — both present paths must reach
   * the repository so the constraint is satisfiable.
   */
  it("includes entityType and entityId when both are supplied", async () => {
    await writer().write({
      userId: ALICE,
      type: "asset.created",
      params: { service: "Acme" },
      entityType: "asset",
      entityId: "asset-1",
    });

    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "asset", entityId: "asset-1" }),
    );
  });

  it("omits entityType and entityId from the repository call when not supplied", async () => {
    await writer().write({ userId: ALICE, type: "onboarding.completed" });

    const call = mocks.append.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(call).not.toHaveProperty("entityType");
    expect(call).not.toHaveProperty("entityId");
  });
});
