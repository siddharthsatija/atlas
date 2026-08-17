import { describe, expect, it } from "vitest";
import { dedupKey, dedupScope } from "./dedup";

/**
 * ATL-101 — deduplication keys (§11.1, ADR-001).
 *
 * Named `.integration.` for the environment, not the kind: the module imports
 * `server-only`, which throws under the unit project's jsdom, and the `server`
 * project is the one that resolves it the way a Server Component does. The tests
 * themselves are pure.
 *
 * `dedup_key = hash(rule_id + sorted entity IDs in scope)`, unique per user, is
 * what makes "a rule fires once per condition" true. Its stability is the whole
 * property: a key that changed between runs would raise a duplicate beside every
 * finding a user already has, and ATL-038's unique constraint would then start
 * rejecting legitimate writes.
 */

describe("the canonical scope", () => {
  it("is stable however the ids arrive", () => {
    // Repositories are free to order rows as they like; the condition is the
    // same either way.
    expect(dedupScope("R-004", { assetIds: ["b", "a"], permissionIds: ["y", "x"] })).toBe(
      dedupScope("R-004", { assetIds: ["a", "b"], permissionIds: ["x", "y"] }),
    );
  });

  it("keeps the kinds of record separate", () => {
    // An asset id and a permission id that happen to be equal describe different
    // things, and a scope that flattened them could conflate two conditions.
    expect(dedupScope("R-001", { assetIds: ["a"] })).not.toBe(
      dedupScope("R-001", { permissionIds: ["a"] }),
    );
  });

  it("distinguishes rules over identical records", () => {
    // R-004 and R-005 both read one permission on one asset, and both can be
    // true at once. They are two findings, not one.
    expect(dedupScope("R-004", { assetIds: ["a"], permissionIds: ["p"] })).not.toBe(
      dedupScope("R-005", { assetIds: ["a"], permissionIds: ["p"] }),
    );
  });

  it("distinguishes one id from two", () => {
    expect(dedupScope("R-008", { assetIds: ["a"] })).not.toBe(
      dedupScope("R-008", { assetIds: ["a", "b"] }),
    );
  });

  it("is readable, so a failing test says what the condition was", () => {
    expect(dedupScope("R-001", { assetIds: ["asset-1"] })).toBe("R-001|asset-1||");
  });
});

describe("the stored key", () => {
  it("is deterministic across calls", () => {
    const evidence = { assetIds: ["a"], dataCategoryIds: ["c"] };

    expect(dedupKey("R-002", evidence)).toBe(dedupKey("R-002", evidence));
  });

  it("fits the column's 200-character limit", () => {
    const key = dedupKey("R-008", { assetIds: Array.from({ length: 50 }, (_, i) => `asset-${i}`) });

    expect(key).toHaveLength(64);
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it("differs whenever the scope differs", () => {
    expect(dedupKey("R-001", { assetIds: ["a"] })).not.toBe(dedupKey("R-001", { assetIds: ["b"] }));
  });

  it("carries no readable record id", () => {
    // Not a privacy requirement — findings are Confidential and owner-scoped —
    // but a hex digest keeps the column a key rather than a second copy of the
    // evidence, which `evidence_refs_json` already holds.
    expect(dedupKey("R-001", { assetIds: ["asset-1"] })).not.toContain("asset-1");
    expect(dedupKey("R-001", { assetIds: ["asset-1"] })).toMatch(/^[0-9a-f]{64}$/);
  });
});
