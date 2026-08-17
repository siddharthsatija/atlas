import { describe, expect, it } from "vitest";
import {
  CATEGORY_CONCENTRATION_ASSETS,
  RULES_VERSION,
  RULE_CATALOG,
  archivedAssetDataRemains,
  broadPermission,
  categoryConcentration,
  inactiveAccountWithData,
  sensitiveDataActive,
  sourceReferenceFor,
  stalePermission,
  staleReview,
} from "./catalog";
import type { AssetInput, DataCategoryInput, PermissionInput, Rule, RuleInputs } from "./types";

/**
 * ATL-101 — the rule catalog, rule by rule (ADR-001, architecture §11.1).
 *
 * Table-driven and entirely synchronous, which is the point of keeping rules
 * pure: every case below is a snapshot literal and an expectation, with no
 * database, no mocks, and no clock. Boundary dates are exact rather than
 * approximate — §11.1's thresholds are the difference between a finding and
 * silence, and "about 180 days" is not a specification.
 */

const NOW = new Date("2026-08-09T12:00:00.000Z");

/** An ISO timestamp exactly `days` before `NOW`. */
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const asset = (overrides: Partial<AssetInput> = {}): AssetInput => ({
  id: "asset-1",
  serviceName: "Spotify",
  category: "entertainment",
  status: "active",
  sourceType: "manual",
  lastVerifiedAt: daysAgo(1),
  createdAt: daysAgo(400),
  ...overrides,
});

const category = (overrides: Partial<DataCategoryInput> = {}): DataCategoryInput => ({
  id: "cat-1",
  assetId: "asset-1",
  category: "contact",
  sensitivity: "standard",
  createdAt: daysAgo(10),
  ...overrides,
});

const permission = (overrides: Partial<PermissionInput> = {}): PermissionInput => ({
  id: "perm-1",
  assetId: "asset-1",
  permissionType: "account_access",
  scope: "limited",
  status: "active",
  lastVerifiedAt: daysAgo(1),
  createdAt: daysAgo(10),
  ...overrides,
});

const snapshot = (overrides: Partial<RuleInputs> = {}): RuleInputs => ({
  assets: [],
  dataCategories: [],
  permissions: [],
  now: NOW,
  ...overrides,
});

/** Runs one rule and returns what it concluded. */
const run = (rule: Rule, inputs: Partial<RuleInputs>) => rule.evaluate(snapshot(inputs));

describe("the catalog itself", () => {
  it("registers seven rules, and R-007 is deliberately absent", () => {
    /**
     * R-007 (rejected_request_unresolved) reads `data_requests`, which §7.7
     * specifies but no migration creates. A rule that structurally cannot fire is
     * indistinguishable from one that is broken, so it lands with the table.
     */
    const ids = RULE_CATALOG.map((rule) => rule.id);

    expect(ids).toEqual(["R-001", "R-002", "R-003", "R-004", "R-005", "R-006", "R-008"]);
    expect(ids).not.toContain("R-007");
  });

  it("gives every rule a category and a recommended action", () => {
    for (const rule of RULE_CATALOG) {
      expect(["hygiene", "exposure", "permissions", "requests"]).toContain(rule.type);
      expect(rule.recommendedAction.length).toBeGreaterThan(0);
    }
  });

  it("builds source references as rule_id@version", () => {
    // §11.1's explainability handle: an old finding must say which logic made it.
    expect(sourceReferenceFor("R-001")).toBe(`R-001@${RULES_VERSION}`);
  });

  it("is deterministic: the same snapshot produces the same output twice", () => {
    const inputs = snapshot({
      assets: [asset({ id: "b" }), asset({ id: "a", lastVerifiedAt: daysAgo(300) })],
    });

    expect(RULE_CATALOG.flatMap((rule) => rule.evaluate(inputs))).toEqual(
      RULE_CATALOG.flatMap((rule) => rule.evaluate(inputs)),
    );
  });
});

describe("R-001 stale_review", () => {
  it("does not fire at exactly 180 days", () => {
    // §11.1 says "not reviewed in 180 days"; degrading on the threshold itself
    // would give 179 days of grace, not 180.
    expect(run(staleReview, { assets: [asset({ lastVerifiedAt: daysAgo(180) })] })).toHaveLength(0);
  });

  it("fires at 181 days, at low", () => {
    const [found] = run(staleReview, { assets: [asset({ lastVerifiedAt: daysAgo(181) })] });

    expect(found?.severity).toBe("low");
    expect(found?.assetId).toBe("asset-1");
  });

  it("stays low at exactly 365 days and escalates at 366", () => {
    const at365 = run(staleReview, { assets: [asset({ lastVerifiedAt: daysAgo(365) })] });
    const at366 = run(staleReview, { assets: [asset({ lastVerifiedAt: daysAgo(366) })] });

    expect(at365[0]?.severity).toBe("low");
    expect(at366[0]?.severity).toBe("medium");
  });

  it("counts a never-reviewed asset from when it was added", () => {
    // The least-checked records must not escape the check entirely.
    const [found] = run(staleReview, {
      assets: [asset({ lastVerifiedAt: null, createdAt: daysAgo(200) })],
    });

    expect(found?.evidenceSummary).toContain("never reviewed");
  });

  it("ignores assets that are not active", () => {
    for (const status of ["inactive", "archived", "removed"]) {
      expect(
        run(staleReview, { assets: [asset({ status, lastVerifiedAt: daysAgo(400) })] }),
      ).toHaveLength(0);
    }
  });

  it("cites only the asset it read", () => {
    const [found] = run(staleReview, { assets: [asset({ lastVerifiedAt: daysAgo(400) })] });

    expect(found?.evidence).toEqual({ assetIds: ["asset-1"] });
  });
});

describe("R-002 inactive_account_with_data", () => {
  it("fires for an inactive asset that still lists data", () => {
    const [found] = run(inactiveAccountWithData, {
      assets: [asset({ status: "inactive" })],
      dataCategories: [category()],
    });

    expect(found?.severity).toBe("medium");
  });

  it("escalates to high when any category is sensitive", () => {
    const [found] = run(inactiveAccountWithData, {
      assets: [asset({ status: "inactive" })],
      dataCategories: [
        category(),
        category({ id: "cat-2", category: "financial", sensitivity: "high" }),
      ],
    });

    expect(found?.severity).toBe("high");
  });

  it("does not fire when nothing is recorded as held", () => {
    // Inactive on its own is not exposure — it is just a status.
    expect(run(inactiveAccountWithData, { assets: [asset({ status: "inactive" })] })).toHaveLength(
      0,
    );
  });

  it("ignores active and archived assets", () => {
    for (const status of ["active", "archived"]) {
      expect(
        run(inactiveAccountWithData, {
          assets: [asset({ status })],
          dataCategories: [category()],
        }),
      ).toHaveLength(0);
    }
  });

  it("cites every category it counted", () => {
    const [found] = run(inactiveAccountWithData, {
      assets: [asset({ status: "inactive" })],
      dataCategories: [category(), category({ id: "cat-2" })],
    });

    expect(found?.evidence.dataCategoryIds).toEqual(["cat-1", "cat-2"]);
  });
});

describe("R-003 sensitive_data_active", () => {
  it("fires at one sensitive category, at low", () => {
    const [found] = run(sensitiveDataActive, {
      assets: [asset()],
      dataCategories: [category({ category: "health", sensitivity: "high" })],
    });

    expect(found?.severity).toBe("low");
  });

  it("escalates at three, not at two", () => {
    const sensitive = (n: number) =>
      Array.from({ length: n }, (_, index) =>
        category({ id: `cat-${index}`, category: `c${index}`, sensitivity: "high" }),
      );

    expect(
      run(sensitiveDataActive, { assets: [asset()], dataCategories: sensitive(2) })[0]?.severity,
    ).toBe("low");
    expect(
      run(sensitiveDataActive, { assets: [asset()], dataCategories: sensitive(3) })[0]?.severity,
    ).toBe("medium");
  });

  it("ignores standard-sensitivity categories entirely", () => {
    expect(
      run(sensitiveDataActive, { assets: [asset()], dataCategories: [category()] }),
    ).toHaveLength(0);
  });

  it("ignores inactive assets", () => {
    expect(
      run(sensitiveDataActive, {
        assets: [asset({ status: "inactive" })],
        dataCategories: [category({ sensitivity: "high" })],
      }),
    ).toHaveLength(0);
  });
});

describe("R-004 broad_permission", () => {
  it("fires for an active broad permission, at medium", () => {
    const [found] = run(broadPermission, {
      assets: [asset()],
      permissions: [permission({ scope: "broad" })],
    });

    expect(found?.severity).toBe("medium");
    expect(found?.evidence.permissionIds).toEqual(["perm-1"]);
  });

  it("ignores limited scope and non-active statuses", () => {
    expect(run(broadPermission, { assets: [asset()], permissions: [permission()] })).toHaveLength(
      0,
    );

    for (const status of ["revoked", "unknown"]) {
      expect(
        run(broadPermission, {
          assets: [asset()],
          permissions: [permission({ scope: "broad", status })],
        }),
      ).toHaveLength(0);
    }
  });

  it("fires once per permission, not once per asset", () => {
    // Each grant is separately revocable; collapsing them would produce a finding
    // that half-clears.
    const found = run(broadPermission, {
      assets: [asset()],
      permissions: [
        permission({ scope: "broad" }),
        permission({ id: "perm-2", permissionType: "data_sharing", scope: "broad" }),
      ],
    });

    expect(found).toHaveLength(2);
  });

  it("ignores a permission whose asset is not in the snapshot", () => {
    // Demo partitioning can exclude the parent; a finding citing an asset the
    // rule cannot see would be unexplainable.
    expect(run(broadPermission, { permissions: [permission({ scope: "broad" })] })).toHaveLength(0);
  });
});

describe("R-005 stale_permission", () => {
  it("does not fire at exactly 365 days, and fires at 366", () => {
    expect(
      run(stalePermission, {
        assets: [asset()],
        permissions: [permission({ lastVerifiedAt: daysAgo(365) })],
      }),
    ).toHaveLength(0);

    const [found] = run(stalePermission, {
      assets: [asset()],
      permissions: [permission({ lastVerifiedAt: daysAgo(366) })],
    });
    expect(found?.severity).toBe("low");
  });

  it("counts a never-verified permission from when it was recorded", () => {
    const [found] = run(stalePermission, {
      assets: [asset()],
      permissions: [permission({ lastVerifiedAt: null, createdAt: daysAgo(400) })],
    });

    expect(found?.evidenceSummary).toContain("never verified");
  });

  it("ignores permissions that are not active", () => {
    expect(
      run(stalePermission, {
        assets: [asset()],
        permissions: [permission({ status: "revoked", lastVerifiedAt: daysAgo(400) })],
      }),
    ).toHaveLength(0);
  });
});

describe("R-006 archived_asset_data_remains", () => {
  it("fires for an archived asset that still lists data, at medium", () => {
    const [found] = run(archivedAssetDataRemains, {
      assets: [asset({ status: "archived" })],
      dataCategories: [category()],
    });

    expect(found?.severity).toBe("medium");
  });

  it("does not fire when the archived asset lists nothing", () => {
    expect(run(archivedAssetDataRemains, { assets: [asset({ status: "archived" })] })).toHaveLength(
      0,
    );
  });

  it("says plainly that archiving did not delete anything", () => {
    // The honesty rule: Atlas never implies it removed data from a service.
    const [found] = run(archivedAssetDataRemains, {
      assets: [asset({ status: "archived" })],
      dataCategories: [category()],
    });

    expect(found?.description).toContain("did not ask the service to delete");
  });

  it("ignores every other status", () => {
    for (const status of ["active", "inactive", "removed"]) {
      expect(
        run(archivedAssetDataRemains, {
          assets: [asset({ status })],
          dataCategories: [category()],
        }),
      ).toHaveLength(0);
    }
  });
});

describe("R-008 category_concentration", () => {
  const spread = (count: number, categoryName = "financial") => ({
    assets: Array.from({ length: count }, (_, index) => asset({ id: `asset-${index}` })),
    dataCategories: Array.from({ length: count }, (_, index) =>
      category({
        id: `cat-${index}`,
        assetId: `asset-${index}`,
        category: categoryName,
        sensitivity: "high",
      }),
    ),
  });

  it(`does not fire below ${String(CATEGORY_CONCENTRATION_ASSETS)} assets`, () => {
    expect(run(categoryConcentration, spread(CATEGORY_CONCENTRATION_ASSETS - 1))).toHaveLength(0);
  });

  it(`fires at exactly ${String(CATEGORY_CONCENTRATION_ASSETS)}, at medium`, () => {
    const [found] = run(categoryConcentration, spread(CATEGORY_CONCENTRATION_ASSETS));

    expect(found?.severity).toBe("medium");
  });

  it("names no single asset, because it is about the whole footprint", () => {
    const [found] = run(categoryConcentration, spread(CATEGORY_CONCENTRATION_ASSETS));

    expect(found?.assetId).toBeNull();
    expect(found?.evidence.assetIds).toHaveLength(CATEGORY_CONCENTRATION_ASSETS);
  });

  it("counts only active assets", () => {
    const inputs = spread(CATEGORY_CONCENTRATION_ASSETS);
    const [first, ...rest] = inputs.assets;

    expect(
      run(categoryConcentration, {
        ...inputs,
        assets: [asset({ ...first, status: "archived" }), ...rest],
      }),
    ).toHaveLength(0);
  });

  it("counts distinct assets, not duplicate rows", () => {
    // One asset listing a category twice is not concentration.
    expect(
      run(categoryConcentration, {
        assets: [asset()],
        dataCategories: Array.from({ length: CATEGORY_CONCENTRATION_ASSETS }, (_, index) =>
          category({ id: `cat-${index}`, category: "financial", sensitivity: "high" }),
        ),
      }),
    ).toHaveLength(0);
  });

  it("treats each sensitive category separately", () => {
    const financial = spread(CATEGORY_CONCENTRATION_ASSETS, "financial");
    const health = spread(CATEGORY_CONCENTRATION_ASSETS, "health");

    const found = run(categoryConcentration, {
      assets: financial.assets,
      dataCategories: [
        ...financial.dataCategories,
        ...health.dataCategories.map((entry) => category({ ...entry, id: `h-${entry.id}` })),
      ],
    });

    expect(found).toHaveLength(2);
  });
});

describe("evidence summaries carry no restricted values", () => {
  it("renders only service names, categories, dates and counts", () => {
    /**
     * §11.1's evidence model. The snapshot a rule receives has no account
     * identifier and no notes in it at all — that is the structural guarantee —
     * and this asserts the templates do not reintroduce anything else.
     */
    const inputs = snapshot({
      assets: [asset({ status: "inactive", lastVerifiedAt: daysAgo(400) })],
      dataCategories: [category({ sensitivity: "high", category: "financial" })],
      permissions: [permission({ scope: "broad", lastVerifiedAt: daysAgo(400) })],
    });

    for (const rule of RULE_CATALOG) {
      for (const found of rule.evaluate(inputs)) {
        expect(found.evidenceSummary).not.toContain("@");
        expect(found.evidenceSummary.length).toBeLessThanOrEqual(2000);
        expect(found.title.length).toBeLessThanOrEqual(200);
        expect(found.description.length).toBeLessThanOrEqual(2000);
      }
    }
  });
});
