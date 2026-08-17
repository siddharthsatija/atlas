import { describe, expect, it } from "vitest";
import {
  accountHygieneFactor,
  dataSensitivityFactor,
  openFindingsFactor,
  permissionExposureFactor,
  protectiveActionsFactor,
  verificationFreshnessFactor,
  type ScoreAsset,
  type ScoreFinding,
} from "./factors";

/**
 * ATL-044 — the six factors, one at a time.
 *
 * Every boundary ADR-004's edge-case amendment fixed is asserted here, because
 * each was a place where a plausible reading produced a different number:
 * which population a factor counts, whether zero records means 100 or excluded,
 * and whether an absent sub-factor is zero.
 *
 * Time is injected, never ambient (.claude/skills/testing/SKILL.md).
 */

const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const asset = (overrides: Partial<ScoreAsset> = {}): ScoreAsset => ({
  id: crypto.randomUUID(),
  status: "active",
  lastVerifiedAt: daysAgo(10),
  ...overrides,
});

const finding = (overrides: Partial<ScoreFinding> = {}): ScoreFinding => ({
  severity: "medium",
  status: "open",
  resolvedBy: null,
  resolvedAt: null,
  ...overrides,
});

describe("account hygiene", () => {
  it("applies the 60/40 split when both populations exist", () => {
    // 3 of 4 active reviewed, 1 of 2 addressable addressed.
    const assets = [
      asset(),
      asset(),
      asset(),
      asset({ lastVerifiedAt: daysAgo(200) }),
      asset({ status: "inactive" }),
      asset({ status: "archived" }),
    ];

    expect(accountHygieneFactor(assets, NOW)).toBeCloseTo(0.6 * 75 + 0.4 * 50, 10);
  });

  it("counts archived and removed as addressed", () => {
    /**
     * The population fix: read literally, archiving moved an asset *out* of a
     * denominator of `inactive` rather than into the numerator, so the
     * sub-factor could never rise. Addressing an asset has to be able to help.
     */
    const assets = [asset({ status: "archived" }), asset({ status: "removed" })];

    expect(accountHygieneFactor(assets, NOW)).toBe(100);
  });

  it("scores an inactive asset nobody addressed at zero for that sub-factor", () => {
    const assets = [asset({ status: "inactive" })];

    expect(accountHygieneFactor(assets, NOW)).toBe(0);
  });

  it("lets the active-review share carry the factor when nothing is addressable", () => {
    // Internal renormalisation. Scoring the absent sub-factor 0 would deduct 40%
    // of hygiene from a user who simply has nothing to tidy up.
    const assets = [asset(), asset(), asset(), asset({ lastVerifiedAt: daysAgo(200) })];

    expect(accountHygieneFactor(assets, NOW)).toBe(75);
  });

  it("lets the addressed share carry the factor when nothing is active", () => {
    const assets = [asset({ status: "archived" }), asset({ status: "inactive" })];

    expect(accountHygieneFactor(assets, NOW)).toBe(50);
  });

  it("is excluded when no asset is in either population", () => {
    expect(accountHygieneFactor([], NOW)).toBeNull();
  });

  it("treats a never-reviewed asset as not reviewed", () => {
    expect(accountHygieneFactor([asset({ lastVerifiedAt: null })], NOW)).toBe(0);
  });

  it("uses a 180-day window, inclusive at the boundary", () => {
    expect(accountHygieneFactor([asset({ lastVerifiedAt: daysAgo(180) })], NOW)).toBe(100);
    expect(accountHygieneFactor([asset({ lastVerifiedAt: daysAgo(181) })], NOW)).toBe(0);
  });
});

describe("open findings", () => {
  it("deducts by severity", () => {
    expect(openFindingsFactor([finding({ severity: "critical" })])).toBe(60);
    expect(openFindingsFactor([finding({ severity: "high" })])).toBe(75);
    expect(openFindingsFactor([finding({ severity: "medium" })])).toBe(90);
    expect(openFindingsFactor([finding({ severity: "low" })])).toBe(96);
  });

  it("scores 100 with no findings, rather than being excluded", () => {
    // Nothing wrong is a result. Excluding it would make the best possible
    // outcome look like missing data.
    expect(openFindingsFactor([])).toBe(100);
  });

  it("keeps a dismissed finding's full deduction", () => {
    /**
     * ADR-004's integrity rule and the OQ-04 sign-off: a dismissal states an
     * intention, and an intention is not a change to the user's exposure.
     */
    expect(openFindingsFactor([finding({ severity: "high", status: "dismissed" })])).toBe(75);
  });

  it("counts in_progress findings, which are still true", () => {
    expect(openFindingsFactor([finding({ severity: "high", status: "in_progress" })])).toBe(75);
  });

  it("stops deducting once a finding is resolved", () => {
    const resolved = finding({ severity: "critical", status: "resolved", resolvedBy: "user" });

    expect(openFindingsFactor([resolved])).toBe(100);
  });

  it("floors at zero rather than going negative", () => {
    const many = Array.from({ length: 5 }, () => finding({ severity: "critical" }));

    expect(openFindingsFactor(many)).toBe(0);
  });
});

describe("data sensitivity footprint", () => {
  it("deducts 10 per active-asset x high-sensitivity-category pair", () => {
    const active = asset();
    const categories = [
      { assetId: active.id, category: "financial" },
      { assetId: active.id, category: "health" },
    ];

    expect(dataSensitivityFactor([active], categories)).toBe(80);
  });

  it("ignores standard-sensitivity categories", () => {
    const active = asset();

    expect(dataSensitivityFactor([active], [{ assetId: active.id, category: "contact" }])).toBe(
      100,
    );
  });

  it("counts only active assets, so archiving actually helps", () => {
    const archived = asset({ status: "archived" });

    expect(
      dataSensitivityFactor([archived], [{ assetId: archived.id, category: "financial" }]),
    ).toBe(100);
  });

  it("scores 100 with nothing sensitive, rather than being excluded", () => {
    expect(dataSensitivityFactor([asset()], [])).toBe(100);
  });

  it("floors at 40, however large the footprint", () => {
    const active = asset();
    const categories = Array.from({ length: 20 }, () => ({
      assetId: active.id,
      category: "financial",
    }));

    expect(dataSensitivityFactor([active], categories)).toBe(40);
  });
});

describe("permission exposure", () => {
  it("scores the share of permissions that are not broad and active", () => {
    const permissions = [
      { scope: "broad", status: "active" },
      { scope: "limited", status: "active" },
      { scope: "limited", status: "active" },
      { scope: "limited", status: "active" },
      { scope: "limited", status: "active" },
    ];

    expect(permissionExposureFactor(permissions)).toBe(80);
  });

  it("stops counting a broad permission once it is revoked", () => {
    // Revoking has to improve the score, or the number is useless as feedback.
    const permissions = [
      { scope: "broad", status: "revoked" },
      { scope: "limited", status: "active" },
    ];

    expect(permissionExposureFactor(permissions)).toBe(100);
  });

  it("keeps a revoked permission in the denominator", () => {
    // ADR-004's asymmetry: "broad **active** ÷ **total recorded**".
    const permissions = [
      { scope: "broad", status: "active" },
      { scope: "broad", status: "revoked" },
    ];

    expect(permissionExposureFactor(permissions)).toBe(50);
  });

  it("is excluded when nothing is recorded", () => {
    // Not 100: Atlas does not know what any service can do, which is missing
    // information rather than a clean footprint.
    expect(permissionExposureFactor([])).toBeNull();
  });

  it("does not round, so the combiner can round once", () => {
    const permissions = [
      { scope: "broad", status: "active" },
      { scope: "limited", status: "active" },
      { scope: "limited", status: "active" },
    ];

    expect(permissionExposureFactor(permissions)).toBeCloseTo(66.6667, 3);
  });
});

describe("protective actions", () => {
  it("credits 10 per finding the user resolved in the window", () => {
    const resolved = finding({ status: "resolved", resolvedBy: "user", resolvedAt: daysAgo(10) });

    expect(protectiveActionsFactor([resolved, resolved], NOW)).toBe(20);
  });

  it("credits nothing for the engine's auto-resolution", () => {
    /**
     * The engine resolves whenever a predicate stops holding, which happens
     * through decay as well as through fixes. Crediting it would pay the user
     * for doing nothing — the reason `resolved_by` exists at all.
     */
    const auto = finding({ status: "resolved", resolvedBy: "system", resolvedAt: daysAgo(10) });

    expect(protectiveActionsFactor([auto], NOW)).toBe(0);
  });

  it("ignores resolutions older than the trailing 180 days", () => {
    const old = finding({ status: "resolved", resolvedBy: "user", resolvedAt: daysAgo(181) });

    expect(protectiveActionsFactor([old], NOW)).toBe(0);
  });

  it("scores zero rather than being excluded when nothing has been done", () => {
    /**
     * Always included. Excluding it while empty and including it at 10 after one
     * resolution would let a user's *first* resolution lower their total score.
     */
    expect(protectiveActionsFactor([], NOW)).toBe(0);
  });

  it("credits 20 per completed request, when requests exist", () => {
    // Nothing can supply one today — no `data_requests` table — so this asserts
    // the term is wired for M8 rather than that it fires now.
    expect(protectiveActionsFactor([], NOW, 2)).toBe(40);
  });

  it("caps at 100", () => {
    const resolved = finding({ status: "resolved", resolvedBy: "user", resolvedAt: daysAgo(1) });
    const many = Array.from({ length: 15 }, () => resolved);

    expect(protectiveActionsFactor(many, NOW)).toBe(100);
  });

  it("ignores a dismissal entirely", () => {
    // Dismissing is not a protective action; it changes nothing.
    expect(protectiveActionsFactor([finding({ status: "dismissed" })], NOW)).toBe(0);
  });
});

describe("verification freshness", () => {
  it("scores the share verified within 365 days", () => {
    const assets = [asset(), asset(), asset({ lastVerifiedAt: daysAgo(400) })];

    expect(verificationFreshnessFactor(assets, NOW)).toBeCloseTo(66.6667, 3);
  });

  it("counts active and inactive assets only", () => {
    /**
     * Atlas never asks a user to review a service they have archived, so
     * counting one would deduct for not doing something the product does not
     * request.
     */
    const assets = [
      asset(),
      asset({ status: "archived", lastVerifiedAt: null }),
      asset({ status: "removed", lastVerifiedAt: null }),
    ];

    expect(verificationFreshnessFactor(assets, NOW)).toBe(100);
  });

  it("includes inactive assets, which the user still holds", () => {
    const assets = [asset(), asset({ status: "inactive", lastVerifiedAt: null })];

    expect(verificationFreshnessFactor(assets, NOW)).toBe(50);
  });

  it("is excluded when no asset is eligible", () => {
    expect(verificationFreshnessFactor([asset({ status: "archived" })], NOW)).toBeNull();
    expect(verificationFreshnessFactor([], NOW)).toBeNull();
  });
});
