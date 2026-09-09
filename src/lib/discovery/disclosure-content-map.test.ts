/**
 * Tests for the disclosure content map (ATL-217, ADR-008 §3).
 *
 * Proves that:
 *   1. The approved identifying_lookup v1 entry is present and returns non-null.
 *   2. The returned content exactly matches the approved copy.
 *   3. Unknown class/version pairs still return null (fail-closed gate intact).
 *   4. No change to the getDisclosureContent API or DisclosureContent type shape.
 */

import { describe, it, expect } from "vitest";
import { getDisclosureContent } from "./disclosure-content-map";

describe("getDisclosureContent", () => {
  describe("identifying_lookup v1 — GitHub profile lookup (ATL-217)", () => {
    it("returns non-null for the registered key", () => {
      const result = getDisclosureContent("identifying_lookup", "v1");
      expect(result).not.toBeNull();
    });

    it("returns the approved title exactly", () => {
      const result = getDisclosureContent("identifying_lookup", "v1");
      expect(result?.title).toBe("Share this username with GitHub?");
    });

    it("returns the approved notice exactly", () => {
      const result = getDisclosureContent("identifying_lookup", "v1");
      expect(result?.notice).toBe(
        "Atlas will send the username shown in this dialog to GitHub to look for a public profile that may match you.",
      );
    });

    it("returns the approved transmissionStatement exactly", () => {
      const result = getDisclosureContent("identifying_lookup", "v1");
      expect(result?.transmissionStatement).toBe(
        "This username will leave Atlas and be sent to GitHub for this lookup. Atlas will not sign in to your GitHub account.",
      );
    });

    it("content satisfies the DisclosureContent shape (title, notice, transmissionStatement all present)", () => {
      const result = getDisclosureContent("identifying_lookup", "v1");
      expect(typeof result?.title).toBe("string");
      expect(typeof result?.notice).toBe("string");
      expect(typeof result?.transmissionStatement).toBe("string");
      expect(result?.title.length).toBeGreaterThan(0);
      expect(result?.notice.length).toBeGreaterThan(0);
      expect(result?.transmissionStatement.length).toBeGreaterThan(0);
    });
  });

  describe("fail-closed gate — unknown keys return null", () => {
    it("returns null for an unknown disclosure class", () => {
      // @ts-expect-error — intentionally passing an unregistered class to test runtime behaviour
      expect(getDisclosureContent("unknown_class", "v1")).toBeNull();
    });

    it("returns null for a known class with an unknown version", () => {
      expect(getDisclosureContent("identifying_lookup", "v99")).toBeNull();
    });

    it("returns null for an empty string key", () => {
      // @ts-expect-error — intentionally invalid input
      expect(getDisclosureContent("", "")).toBeNull();
    });

    it("does not return content for the hashed_query class (not registered)", () => {
      expect(getDisclosureContent("hashed_query", "v1")).toBeNull();
    });
  });
});
