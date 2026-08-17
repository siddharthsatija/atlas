import { describe, expect, it } from "vitest";
import type { RuleInputs } from "@/lib/findings/rules/types";
import { inputHash, inputScope, inputsChanged } from "./input-hash";

/**
 * ATL-102 — the input hash (§11.1's "unless the rule inputs materially change").
 *
 * Named `.integration.` for the environment, not the kind: the module imports
 * `server-only`, which throws under the unit project's jsdom. The tests are pure.
 *
 * What this file is really testing is a promise to the user. A dismissal is the
 * one place Atlas overrides an explicit "I have dealt with this", and the hash is
 * what decides when that happens. Every case below is either "this should bring
 * it back" or "this must not".
 */

const NOW = new Date("2026-08-10T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const snapshot = (overrides: Partial<RuleInputs> = {}): RuleInputs => ({
  assets: [
    {
      id: "asset-1",
      serviceName: "Spotify",
      category: "entertainment",
      status: "active",
      sourceType: "manual",
      lastVerifiedAt: daysAgo(400),
      createdAt: daysAgo(500),
    },
  ],
  dataCategories: [
    {
      id: "cat-1",
      assetId: "asset-1",
      category: "financial",
      sensitivity: "high",
      createdAt: daysAgo(100),
    },
  ],
  permissions: [
    {
      id: "perm-1",
      assetId: "asset-1",
      permissionType: "account_access",
      scope: "broad",
      status: "active",
      lastVerifiedAt: daysAgo(400),
      createdAt: daysAgo(500),
    },
  ],
  now: NOW,
  ...overrides,
});

const ASSET_ONLY = { assetIds: ["asset-1"] };

/** The hash of a snapshot with one field changed. */
const withAsset = (changes: Partial<RuleInputs["assets"][number]>) => {
  const base = snapshot();
  const [asset] = base.assets;
  if (!asset) throw new Error("fixture asset missing");
  return inputHash(ASSET_ONLY, { ...base, assets: [{ ...asset, ...changes }] });
};

describe("what counts as a material change", () => {
  it("notices a review date moving", () => {
    // The user actually confirmed the record. That is a change to their data.
    expect(withAsset({ lastVerifiedAt: daysAgo(1) })).not.toBe(inputHash(ASSET_ONLY, snapshot()));
  });

  it("notices a status change", () => {
    expect(withAsset({ status: "inactive" })).not.toBe(inputHash(ASSET_ONLY, snapshot()));
  });

  it("notices a source change", () => {
    // Demo and real records are different claims about where a fact came from.
    expect(withAsset({ sourceType: "demo" })).not.toBe(inputHash(ASSET_ONLY, snapshot()));
  });

  it("notices a permission's scope or status changing", () => {
    const base = snapshot();
    const [permission] = base.permissions;
    if (!permission) throw new Error("fixture permission missing");
    const evidence = { assetIds: ["asset-1"], permissionIds: ["perm-1"] };
    const original = inputHash(evidence, base);

    expect(
      inputHash(evidence, { ...base, permissions: [{ ...permission, scope: "limited" }] }),
    ).not.toBe(original);
    expect(
      inputHash(evidence, { ...base, permissions: [{ ...permission, status: "revoked" }] }),
    ).not.toBe(original);
  });

  it("notices a category's sensitivity changing", () => {
    const base = snapshot();
    const [entry] = base.dataCategories;
    if (!entry) throw new Error("fixture category missing");
    const evidence = { assetIds: ["asset-1"], dataCategoryIds: ["cat-1"] };

    expect(
      inputHash(evidence, { ...base, dataCategories: [{ ...entry, sensitivity: "standard" }] }),
    ).not.toBe(inputHash(evidence, base));
  });

  it("notices a cited record disappearing", () => {
    // A record the rule read and that no longer exists is itself a change.
    expect(inputHash(ASSET_ONLY, { ...snapshot(), assets: [] })).not.toBe(
      inputHash(ASSET_ONLY, snapshot()),
    );
  });
});

describe("what does not count", () => {
  it("ignores the passage of time", () => {
    /**
     * The decision that matters most to a person. Someone who dismisses "Spotify
     * has not been reviewed" and leaves it another year does not get the finding
     * back — nothing about their records changed, only the calendar. It returns
     * when they actually touch the record.
     */
    const later = new Date(NOW.getTime() + 400 * 86_400_000);

    expect(inputHash(ASSET_ONLY, { ...snapshot(), now: later })).toBe(
      inputHash(ASSET_ONLY, snapshot()),
    );
  });

  it("ignores fields used only for rendering", () => {
    // A user renaming a service has not changed their exposure.
    expect(withAsset({ serviceName: "Spotify Family", category: "work" })).toBe(
      inputHash(ASSET_ONLY, snapshot()),
    );
  });

  it("ignores creation dates, which cannot change anyway", () => {
    expect(withAsset({ createdAt: daysAgo(999) })).toBe(inputHash(ASSET_ONLY, snapshot()));
  });

  it("ignores records the candidate did not cite", () => {
    // A rule's finding must not return because something it never read moved.
    const base = snapshot();
    const [asset] = base.assets;
    if (!asset) throw new Error("fixture asset missing");
    const unrelated = { ...asset, id: "asset-2", status: "archived" };

    expect(inputHash(ASSET_ONLY, { ...base, assets: [asset, unrelated] })).toBe(
      inputHash(ASSET_ONLY, base),
    );
  });
});

describe("stability", () => {
  it("does not depend on the order records arrive in", () => {
    const base = snapshot();
    const [asset] = base.assets;
    if (!asset) throw new Error("fixture asset missing");
    const second = { ...asset, id: "asset-2" };
    const evidence = { assetIds: ["asset-1", "asset-2"] };

    expect(inputHash(evidence, { ...base, assets: [asset, second] })).toBe(
      inputHash(evidence, { ...base, assets: [second, asset] }),
    );
  });

  it("produces a digest the column's check constraint accepts", () => {
    expect(inputHash(ASSET_ONLY, snapshot())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a readable canonical form, so a failure says which field moved", () => {
    expect(inputScope(ASSET_ONLY, snapshot())).toContain("asset-1|active|");
  });

  it("distinguishes null from a value rather than eliding it", () => {
    // Never verified and verified-at-some-date are different states.
    expect(withAsset({ lastVerifiedAt: null })).not.toBe(inputHash(ASSET_ONLY, snapshot()));
  });
});

describe("comparing against what was stored", () => {
  it("reports a change when the hashes differ", () => {
    expect(inputsChanged("a".repeat(64), "b".repeat(64))).toBe(true);
  });

  it("reports no change when they match", () => {
    expect(inputsChanged("a".repeat(64), "a".repeat(64))).toBe(false);
  });

  it("treats a missing stored hash as unknown, not as changed", () => {
    /**
     * Findings written before ATL-102 have no hash. Reading absence as "changed"
     * would resurrect every dismissed finding the moment this shipped, overriding
     * dismissals the user made deliberately. The engine records a hash instead
     * and leaves the status alone, so the ambiguity resolves once.
     */
    expect(inputsChanged(null, "a".repeat(64))).toBe(false);
  });
});
