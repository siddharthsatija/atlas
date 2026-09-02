import { describe, expect, it, vi } from "vitest";
import type { ConsentProof } from "@/server/discovery/discovery-consent-service";
import type { DispatchResult } from "./dispatch-engine";
import { HibpDiscoveryService } from "./hibp-discovery-service";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64"),
    // ATL-216: HIBP_API_KEY is optional at boot but HibpAdapter.create() requires
    // it at instantiation time. HibpDiscoveryService constructs a HibpAdapter in
    // its constructor, so the test mock must supply a placeholder key.
    HIBP_API_KEY: "test-hibp-key",
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Creates a minimal ConsentProof-shaped object for testing. */
function makeProof(userId = "user-1"): ConsentProof {
  return { userId } as unknown as ConsentProof;
}

function makeEngine(result: DispatchResult) {
  return { dispatch: vi.fn().mockResolvedValue(result) };
}

function makeWriter() {
  return { write: vi.fn().mockResolvedValue(undefined) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HibpDiscoveryService", () => {
  describe("dispatch", () => {
    it("calls engine.dispatch with the consent proof, invocation id, and a HibpAdapter", async () => {
      const engine = makeEngine({ outcome: "rate_limited" });
      const writer = makeWriter();
      const service = new HibpDiscoveryService(engine as never, writer as never);

      await service.dispatch(makeProof(), "inv-1");

      expect(engine.dispatch).toHaveBeenCalledOnce();
      const [proof, invId, adapter] = engine.dispatch.mock.calls[0] as [
        ConsentProof,
        string,
        { providerClass: string },
      ];
      expect(proof.userId).toBe("user-1");
      expect(invId).toBe("inv-1");
      expect(adapter.providerClass).toBe("discovery_hashed_query");
    });

    it("calls writer.write with userId, invocationId, and providerData on success", async () => {
      const providerData = { fieldId: "f", breaches: [] };
      const engine = makeEngine({ outcome: "success", providerData });
      const writer = makeWriter();
      const service = new HibpDiscoveryService(engine as never, writer as never);

      await service.dispatch(makeProof("user-2"), "inv-99");

      expect(writer.write).toHaveBeenCalledOnce();
      expect(writer.write).toHaveBeenCalledWith("user-2", "inv-99", providerData);
    });

    it("returns the DispatchResult from the engine", async () => {
      const engine = makeEngine({ outcome: "success", providerData: {} });
      const writer = makeWriter();
      const service = new HibpDiscoveryService(engine as never, writer as never);

      const result = await service.dispatch(makeProof(), "inv-1");

      expect(result.outcome).toBe("success");
    });

    it.each([
      ["blocked", { outcome: "blocked", blockCode: "proof.run_mismatch" }],
      ["rate_limited", { outcome: "rate_limited" }],
      ["error", { outcome: "error", errorCode: "some_error" }],
      ["already_dispatched", { outcome: "already_dispatched" }],
    ] as const)("does not call writer when outcome is %s", async (_, engineResult) => {
      const engine = makeEngine(engineResult as DispatchResult);
      const writer = makeWriter();
      const service = new HibpDiscoveryService(engine as never, writer as never);

      await service.dispatch(makeProof(), "inv-1");

      expect(writer.write).not.toHaveBeenCalled();
    });

    it("propagates writer errors to the caller", async () => {
      const engine = makeEngine({ outcome: "success", providerData: {} });
      const writer = { write: vi.fn().mockRejectedValue(new Error("writer failed")) };
      const service = new HibpDiscoveryService(engine as never, writer as never);

      await expect(service.dispatch(makeProof(), "inv-1")).rejects.toThrow("writer failed");
    });
  });
});
