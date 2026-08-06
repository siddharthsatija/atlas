import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_STATUS,
  PERMISSION_SCOPES,
  PERMISSION_STATUSES,
  isBroadExposure,
  isPermissionScope,
  isPermissionStatus,
  isPermissionType,
  isPermissionTypeShape,
  permissionExposureScore,
  PERMISSION_TYPES,
} from "./permissions";

/**
 * ATL-029 — the scope classification unit test the ticket names.
 *
 * This mapping is not cosmetic: R-004 raises a finding from it and ADR-004's
 * permission factor is computed from it, so getting `broad` or `active` wrong
 * changes both what users are told and the number they are scored on.
 */

const permission = (scope: string, status: string) => ({ scope, status });

describe("vocabularies", () => {
  it("offers exactly the two documented scope values", () => {
    // `broad` is the one the specification names (R-004, ADR-004); `limited` is
    // its complement. A binary is all either consumer reads.
    expect([...PERMISSION_SCOPES]).toEqual(["broad", "limited"]);
  });

  it("offers active, revoked, and unknown", () => {
    expect([...PERMISSION_STATUSES]).toEqual(["active", "revoked", "unknown"]);
  });

  it("defaults to active, matching the migration", () => {
    expect(DEFAULT_PERMISSION_STATUS).toBe("active");
  });

  it("recognises its own values and nothing else", () => {
    expect(isPermissionScope("broad")).toBe(true);
    expect(isPermissionScope("partial")).toBe(false);
    expect(isPermissionStatus("unknown")).toBe(true);
    expect(isPermissionStatus("expired")).toBe(false);
  });

  it("constrains permission_type by shape only", () => {
    /**
     * No document enumerates permission kinds, so the vocabulary is deferred to
     * ATL-032/033. The shape still keeps the column from holding arbitrary text.
     */
    expect(isPermissionTypeShape("oauth_access")).toBe(true);
    expect(isPermissionTypeShape("marketing")).toBe(true);
    expect(isPermissionTypeShape("OAuth")).toBe(false);
    expect(isPermissionTypeShape("read profile")).toBe(false);
    expect(isPermissionTypeShape("")).toBe(false);
  });
});

describe("broad exposure requires both conditions", () => {
  it("counts a broad permission that is active", () => {
    expect(isBroadExposure(permission("broad", "active"))).toBe(true);
  });

  it.each([
    ["broad but revoked", "broad", "revoked"],
    ["broad but unknown", "broad", "unknown"],
    ["limited and active", "limited", "active"],
    ["limited and revoked", "limited", "revoked"],
  ])("does not count %s", (_label, scope, status) => {
    expect(isBroadExposure(permission(scope, status))).toBe(false);
  });

  it("stops counting once a permission is revoked", () => {
    /**
     * The behaviour that makes the score useful as feedback. If a revoked broad
     * permission still counted, taking the action Atlas recommends would leave
     * the number unchanged — and the user would reasonably conclude the advice
     * was pointless.
     */
    const before = permissionExposureScore([
      permission("broad", "active"),
      permission("limited", "active"),
    ]);
    const after = permissionExposureScore([
      permission("broad", "revoked"),
      permission("limited", "active"),
    ]);

    expect(before).toBe(50);
    expect(after).toBe(100);
  });
});

describe("ADR-004's permission-exposure factor", () => {
  it("reproduces the worked example: 1 of 5 permissions broad", () => {
    // ADR-004: "1 of 5 permissions broad ... Permissions = 80".
    const permissions = [
      permission("broad", "active"),
      permission("limited", "active"),
      permission("limited", "active"),
      permission("limited", "active"),
      permission("limited", "active"),
    ];

    expect(permissionExposureScore(permissions)).toBe(80);
  });

  it("divides by every recorded permission, not only the active ones", () => {
    /**
     * ADR-004 says "total recorded". Narrowing the denominator to active rows
     * would make revoking a *limited* permission lower the score, which is the
     * opposite of what the user did.
     */
    const permissions = [
      permission("broad", "active"),
      permission("limited", "revoked"),
      permission("limited", "unknown"),
      permission("limited", "active"),
    ];

    expect(permissionExposureScore(permissions)).toBe(75);
  });

  it("returns 100 when nothing is broad", () => {
    expect(permissionExposureScore([permission("limited", "active")])).toBe(100);
  });

  it("returns 0 when everything is broad and active", () => {
    expect(
      permissionExposureScore([permission("broad", "active"), permission("broad", "active")]),
    ).toBe(0);
  });

  it("excludes the factor entirely when nothing is recorded", () => {
    /**
     * ADR-004: "a factor with no underlying records is excluded and remaining
     * weights are renormalized". Returning 100 instead would award a perfect
     * permission score for having recorded no permissions — the false confidence
     * the score-coverage rule exists to prevent.
     */
    expect(permissionExposureScore([])).toBeNull();
  });

  it("rounds rather than returning a fraction", () => {
    // 1 broad of 3 → 66.67 → 67. Snapshots store integers (ADR-004).
    expect(
      permissionExposureScore([
        permission("broad", "active"),
        permission("limited", "active"),
        permission("limited", "active"),
      ]),
    ).toBe(67);
  });
});

describe("the permission vocabulary (ATL-033)", () => {
  it("is the five values the architecture records", () => {
    /**
     * Pinned rather than derived: §7.4 now names this list, the UI offers
     * exactly it, and `AssetService.addPermission` refuses anything else. A
     * silent addition here would start counting in ADR-004's "total recorded"
     * denominator without the document that explains it.
     */
    expect(PERMISSION_TYPES.map((entry) => entry.id)).toEqual([
      "account_access",
      "data_sharing",
      "marketing",
      "device_access",
      "other",
    ]);
  });

  it("puts the escape hatch last", () => {
    // An `other` that appears first becomes the default answer, and the whole
    // point of the list is that similar grants land under one name.
    expect(PERMISSION_TYPES.at(-1)?.id).toBe("other");
  });

  it("gives every entry a label and a hint in plain language", () => {
    for (const entry of PERMISSION_TYPES) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
    }
  });

  it("accepts the vocabulary and nothing else", () => {
    expect(isPermissionType("account_access")).toBe(true);
    expect(isPermissionType("other")).toBe(true);

    // Well-shaped but not in the vocabulary: the two constraints are separate,
    // and this is the gap the application closes.
    expect(isPermissionTypeShape("oauth_access")).toBe(true);
    expect(isPermissionType("oauth_access")).toBe(false);

    for (const value of ["", "Account_Access", "account access", "marketing "]) {
      expect(isPermissionType(value)).toBe(false);
    }
  });

  it("keeps every value storable by the migration's check", () => {
    // The database constrains the shape; a vocabulary entry the column would
    // reject is a defect that only appears at insert time.
    for (const entry of PERMISSION_TYPES) {
      expect(isPermissionTypeShape(entry.id)).toBe(true);
    }
  });

  it("has no duplicate ids", () => {
    const ids = PERMISSION_TYPES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
