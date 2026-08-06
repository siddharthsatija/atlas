import { describe, expect, it } from "vitest";
import { ASSET_CATEGORIES } from "./categories";
import {
  DATA_CATEGORIES,
  DATA_SENSITIVITY_LEVELS,
  HIGH_SENSITIVITY_CATEGORIES,
  isDataCategory,
  isHighSensitivity,
  sensitivityFor,
} from "./data-categories";

/**
 * ATL-028 — the data-category vocabulary and its sensitivity mapping.
 *
 * The mapping is not cosmetic: ADR-004's score reads it, and changing which
 * categories are high-sensitivity changes every user's number. These tests pin
 * it to the ADR rather than to whatever the code currently says.
 */

describe("the §7.3 vocabulary", () => {
  it("lists exactly the eleven categories the specification names", () => {
    expect(DATA_CATEGORIES.map((entry) => entry.id)).toEqual([
      "identity",
      "contact",
      "location",
      "financial",
      "behavioral",
      "biometric",
      "content",
      "device",
      "professional",
      "health",
      "other",
    ]);
  });

  it("gives every category a label and a hint", () => {
    for (const category of DATA_CATEGORIES) {
      expect(category.label.length, `${category.id} label`).toBeGreaterThan(0);
      expect(category.hint.length, `${category.id} hint`).toBeGreaterThan(0);
    }
  });

  it("recognises its own ids and nothing else", () => {
    expect(DATA_CATEGORIES.every((entry) => isDataCategory(entry.id))).toBe(true);
    expect(isDataCategory("astrological")).toBe(false);
    expect(isDataCategory("")).toBe(false);
  });

  it("is a different axis from the asset categories", () => {
    /**
     * `social` is what a service **is**; `contact` is what it **stores**.
     *
     * The two lists share exactly two ids, and both are intentional: `other` is
     * the escape hatch on each axis, and `health` is genuinely both — a fitness
     * tracker is a health *service* that holds health *data*. Any third overlap
     * would be the first sign someone had started substituting one list for the
     * other, which §7.2 and §7.3 both warn against.
     */
    const assetIds = new Set(ASSET_CATEGORIES.map((entry) => entry.id));
    const shared = DATA_CATEGORIES.map((entry) => entry.id).filter((id) => assetIds.has(id));

    expect(shared.sort()).toEqual(["health", "other"]);
  });
});

describe("sensitivity follows ADR-004", () => {
  it("marks exactly financial, health, biometric, and location as high", () => {
    // Quoted from ADR-004's score table. Changing this set requires a new
    // score_version, so it is pinned rather than derived from the code.
    expect([...HIGH_SENSITIVITY_CATEGORIES].sort()).toEqual([
      "biometric",
      "financial",
      "health",
      "location",
    ]);
  });

  it.each(["financial", "health", "biometric", "location"])("rates %s high", (category) => {
    expect(sensitivityFor(category)).toBe("high");
    expect(isHighSensitivity(category)).toBe(true);
  });

  it.each(["identity", "contact", "behavioral", "content", "device", "professional", "other"])(
    "rates %s standard",
    (category) => {
      expect(sensitivityFor(category)).toBe("standard");
      expect(isHighSensitivity(category)).toBe(false);
    },
  );

  it("covers every category, so none is left without a level", () => {
    for (const category of DATA_CATEGORIES) {
      expect(DATA_SENSITIVITY_LEVELS).toContain(sensitivityFor(category.id));
    }
  });

  it("treats an unknown category as standard rather than throwing", () => {
    /**
     * The database constrains the column, so an unknown value should be
     * unreachable — but if one ever arrives, the score must keep working. The
     * conservative direction here is `standard`: inventing a high rating for a
     * category nobody defined would deduct points for something the product
     * cannot explain to the user.
     */
    expect(sensitivityFor("astrological")).toBe("standard");
  });

  it("names every high-sensitivity category in the §7.3 list", () => {
    // A guard against the two lists drifting: a high-sensitivity id that is not
    // a real category would silently never match a row.
    const known = new Set(DATA_CATEGORIES.map((entry) => entry.id));
    expect(HIGH_SENSITIVITY_CATEGORIES.filter((id) => !known.has(id))).toEqual([]);
  });
});
