import { describe, it, expect } from "vitest";

/**
 * Navigation and sidebar — ATL-212 additions.
 *
 * Tested invariants:
 *   NAV ORDER
 *   1. NAV_ORDER contains "discover".
 *   2. "discover" is at position 2 in NAV_ORDER (PRD §12: Overview → Discover → …).
 *   3. "overview" is at position 1 (immediately before "discover").
 *
 *   NAV DEFINITIONS
 *   4. The "discover" nav item has label "Discover".
 *   5. The "discover" nav item links to "/discover".
 *   6. "discover" is in PRIMARY_NAV_ITEMS (not a footer item).
 *   7. NAV_ITEMS order matches PRD §12: overview before discover, discover before assets.
 *
 *   BADGE COUNTS
 *   8. NavKey type includes "discover" (compile-time via usage).
 */

import { NAV_ORDER, type NavKey } from "@/config/app";
import { PRIMARY_NAV_ITEMS, NAV_ITEMS } from "@/config/navigation";

describe("ATL-212 — navigation order", () => {
  it("NAV_ORDER contains 'discover'", () => {
    expect(NAV_ORDER).toContain("discover");
  });

  it("'discover' is at index 1 in NAV_ORDER (PRD §12 position 2)", () => {
    // PRD §12: Overview → Discover → Digital Assets → …
    expect(NAV_ORDER[1]).toBe("discover");
  });

  it("'overview' immediately precedes 'discover' in NAV_ORDER", () => {
    const overviewIdx = NAV_ORDER.indexOf("overview");
    const discoverIdx = NAV_ORDER.indexOf("discover");
    expect(discoverIdx).toBe(overviewIdx + 1);
  });

  it("'discover' precedes 'assets' in NAV_ORDER", () => {
    const discoverIdx = NAV_ORDER.indexOf("discover");
    const assetsIdx = NAV_ORDER.indexOf("assets");
    expect(discoverIdx).toBeLessThan(assetsIdx);
  });
});

describe("ATL-212 — discover nav item definition", () => {
  it("PRIMARY_NAV_ITEMS includes a Discover item", () => {
    const discover = PRIMARY_NAV_ITEMS.find((item) => item.key === "discover");
    expect(discover).toBeDefined();
  });

  it("Discover nav item has label 'Discover'", () => {
    const discover = PRIMARY_NAV_ITEMS.find((item) => item.key === "discover");
    expect(discover?.label).toBe("Discover");
  });

  it("Discover nav item href is '/discover'", () => {
    const discover = PRIMARY_NAV_ITEMS.find((item) => item.key === "discover");
    expect(discover?.href).toBe("/discover");
  });

  it("Discover nav item is not a footer item", () => {
    const discover = PRIMARY_NAV_ITEMS.find((item) => item.key === "discover");
    expect(discover?.footer).toBeFalsy();
  });

  it("Discover appears at index 1 in NAV_ITEMS (after overview)", () => {
    const overviewIdx = NAV_ITEMS.findIndex((item) => item.key === "overview");
    const discoverIdx = NAV_ITEMS.findIndex((item) => item.key === "discover");
    expect(discoverIdx).toBe(overviewIdx + 1);
  });

  it("Discover appears before 'assets' in NAV_ITEMS", () => {
    const discoverIdx = NAV_ITEMS.findIndex((item) => item.key === "discover");
    const assetsIdx = NAV_ITEMS.findIndex((item) => item.key === "assets");
    expect(discoverIdx).toBeLessThan(assetsIdx);
  });

  it("NavKey type assignment compiles — 'discover' is a valid NavKey", () => {
    // Type-level: if NavKey does not include 'discover' this line would produce
    // a TypeScript error. The runtime test is trivially true.
    const key: NavKey = "discover";
    expect(key).toBe("discover");
  });
});
