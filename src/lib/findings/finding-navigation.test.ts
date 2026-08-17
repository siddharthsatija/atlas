import { describe, expect, it } from "vitest";
import { findingDestination } from "./finding-navigation";
import { FINDING_TYPES } from "./findings";

/**
 * ATL-041 — where a finding's recommended action sends the user.
 *
 * The mapping is derived from §11.1's categories rather than declared per rule,
 * so these tests are the statement of that contract: change a route here and
 * nowhere else.
 */

const ASSET = "11111111-1111-4111-8111-111111111111";

describe("findings about one service", () => {
  it("sends a hygiene finding to the service itself", () => {
    // R-001 is "you have not reviewed this" — the record, not its children.
    expect(findingDestination("hygiene", ASSET)).toEqual({
      available: true,
      href: `/assets/${ASSET}`,
      label: "Open this service",
    });
  });

  it("sends an exposure finding to where the held information is listed", () => {
    const destination = findingDestination("exposure", ASSET);

    expect(destination).toMatchObject({ available: true, href: `/assets/${ASSET}/edit` });
  });

  it("sends a permission finding to where permissions are listed", () => {
    // Both child lists live on the edit page; the label names which section.
    const destination = findingDestination("permissions", ASSET);

    expect(destination).toMatchObject({ available: true, href: `/assets/${ASSET}/edit` });
    expect(destination).toHaveProperty("label", "Review this service's permissions");
  });
});

describe("a footprint-wide finding", () => {
  it("sends the user to the list, because no single service is named", () => {
    // R-008 is about the whole footprint; `asset_id` is null by design.
    expect(findingDestination("exposure", null)).toEqual({
      available: true,
      href: "/assets",
      label: "Review your services",
    });
  });
});

describe("requests, which do not exist yet", () => {
  it("reports the destination as unavailable rather than inventing a route", () => {
    /**
     * R-007's category. M8 has not been built, and a link to a route that does
     * not exist is a promise the product cannot keep — the ATL-005 precedent is
     * present, announced, and visibly unavailable.
     */
    const destination = findingDestination("requests", ASSET);

    expect(destination.available).toBe(false);
    expect(destination).toHaveProperty("unavailableReason", "Requests are not part of Atlas yet.");
  });

  it("stays unavailable even with no asset", () => {
    expect(findingDestination("requests", null).available).toBe(false);
  });
});

describe("the mapping is total", () => {
  it("answers for every documented category", () => {
    // A fifth category added to §11.1 without a destination would silently fall
    // through; this fails instead.
    for (const type of FINDING_TYPES) {
      expect(findingDestination(type.id, ASSET).label.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the service for a category this build does not know", () => {
    /**
     * `finding_type` is a text column whose vocabulary lives in the application
     * (§7.2), so a row can carry a value this build has never heard of. Sending
     * the user to the service the finding is about beats guessing.
     */
    expect(findingDestination("something-new", ASSET)).toMatchObject({
      available: true,
      href: `/assets/${ASSET}`,
    });
  });

  it("never produces a bare identifier as a label", () => {
    for (const type of [...FINDING_TYPES.map((entry) => entry.id), "unknown"]) {
      expect(findingDestination(type, ASSET).label).not.toContain(ASSET);
    }
  });
});
