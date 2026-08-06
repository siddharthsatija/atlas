import { describe, expect, it } from "vitest";
import {
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
  parseCreateAssetForm,
  preservedValues,
  readCreateAssetForm,
} from "./asset-form";
import { MAX_NOTES_LENGTH, MAX_SERVICE_NAME_LENGTH } from "./asset-fields";

/**
 * ATL-032 — create-asset validation.
 *
 * This is the schema both the client form and the Server Action run, so these
 * tests cover both sides at once. That shared-ness is the point: two schemas
 * would let the form accept something the server rejects, and the user would
 * meet an unexplained failure after filling the whole form in.
 */

const valid = {
  serviceName: "Spotify",
  category: "entertainment",
  serviceDomain: "spotify.com",
  accountIdentifier: "dana.scully@example.com",
  notes: "Family plan",
};

describe("accepting good input", () => {
  it("accepts a complete form", () => {
    const result = parseCreateAssetForm(valid);

    expect(result.success).toBe(true);
    expect(result.values?.serviceName).toBe("Spotify");
    expect(result.values?.serviceDomain).toBe("spotify.com");
  });

  it("accepts the required fields alone", () => {
    // The objective says "optional identifier"; domain and notes are optional too.
    const result = parseCreateAssetForm({ serviceName: "Monzo", category: "finance" });

    expect(result.success).toBe(true);
    expect(result.values?.accountIdentifier).toBeUndefined();
    expect(result.values?.serviceDomain).toBeUndefined();
  });

  it("treats blank optional fields as absent, not as empty strings", () => {
    /**
     * A form sends untouched inputs as `""`. Without normalising, an untouched
     * optional field would fail a rule it was never meant to be held to.
     */
    const result = parseCreateAssetForm({
      serviceName: "Monzo",
      category: "finance",
      serviceDomain: "   ",
      accountIdentifier: "",
      notes: "  ",
    });

    expect(result.success).toBe(true);
    expect(result.values?.serviceDomain).toBeUndefined();
    expect(result.values?.notes).toBeUndefined();
  });

  it("trims the service name", () => {
    expect(parseCreateAssetForm({ ...valid, serviceName: "  Spotify  " }).values?.serviceName).toBe(
      "Spotify",
    );
  });

  it("lowercases a domain someone typed with capitals", () => {
    /**
     * The column's check constraint is lowercase-only. Rejecting "Spotify.com"
     * would be technically correct and unhelpful — the user meant the right
     * thing and the fix is mechanical.
     */
    expect(
      parseCreateAssetForm({ ...valid, serviceDomain: "Spotify.COM" }).values?.serviceDomain,
    ).toBe("spotify.com");
  });
});

describe("rejecting bad input", () => {
  it.each([
    ["a missing service name", { ...valid, serviceName: "" }, "serviceName"],
    ["a whitespace-only service name", { ...valid, serviceName: "   " }, "serviceName"],
    [
      "an over-long service name",
      { ...valid, serviceName: "x".repeat(MAX_SERVICE_NAME_LENGTH + 1) },
      "serviceName",
    ],
    ["a missing category", { ...valid, category: "" }, "category"],
    ["an unknown category", { ...valid, category: "astrological" }, "category"],
    ["a domain with a scheme", { ...valid, serviceDomain: "https://spotify.com" }, "serviceDomain"],
    ["a domain with a path", { ...valid, serviceDomain: "spotify.com/account" }, "serviceDomain"],
    ["a bare word as a domain", { ...valid, serviceDomain: "spotify" }, "serviceDomain"],
    ["over-long notes", { ...valid, notes: "x".repeat(MAX_NOTES_LENGTH + 1) }, "notes"],
    [
      "an over-long identifier",
      { ...valid, accountIdentifier: "x".repeat(MAX_ACCOUNT_IDENTIFIER_LENGTH + 1) },
      "accountIdentifier",
    ],
  ])("rejects %s", (_label, input, field) => {
    const result = parseCreateAssetForm(input);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveProperty(field);
    expect(result.values).toBeUndefined();
  });

  it("mirrors the database's bounds, so nothing the form accepts can be rejected on write", () => {
    // The bounds come from `asset-fields.ts`, which mirrors ATL-027's checks.
    // A form that accepted a longer value would produce an unexplained failure
    // after the user had already filled everything in.
    expect(
      parseCreateAssetForm({ ...valid, serviceName: "x".repeat(MAX_SERVICE_NAME_LENGTH) }).success,
    ).toBe(true);
    expect(parseCreateAssetForm({ ...valid, notes: "x".repeat(MAX_NOTES_LENGTH) }).success).toBe(
      true,
    );
  });

  it("reports one message per field, not a list", () => {
    // Three simultaneous complaints on one field are harder to act on than the
    // first; the user sees the next after fixing this one.
    const result = parseCreateAssetForm({ serviceName: "", category: "", serviceDomain: "!!" });

    expect(Object.keys(result.errors).sort()).toEqual(["category", "serviceDomain", "serviceName"]);
    for (const message of Object.values(result.errors)) {
      expect(typeof message).toBe("string");
    }
  });

  it("never echoes the submitted value back in an error message", () => {
    /**
     * An error message is rendered and could be logged. Quoting the rejected
     * value would put a Restricted identifier into both.
     */
    const result = parseCreateAssetForm({
      serviceName: "",
      category: "entertainment",
      accountIdentifier: "x".repeat(MAX_ACCOUNT_IDENTIFIER_LENGTH + 1),
    });

    expect(JSON.stringify(result.errors)).not.toContain("xxx");
  });
});

describe("reading the form", () => {
  it("reads every field as a string", () => {
    const data = new FormData();
    data.set("serviceName", "Spotify");
    data.set("category", "entertainment");

    const fields = readCreateAssetForm(data);

    expect(fields.serviceName).toBe("Spotify");
    expect(fields.serviceDomain).toBe("");
  });

  it("survives a field that is not a string", () => {
    const data = new FormData();
    data.set("serviceName", new Blob(["x"]), "upload.txt");

    expect(readCreateAssetForm(data).serviceName).toBe("");
  });
});

describe("what survives a failed submission", () => {
  it("keeps everything the user typed", () => {
    // ATL-032: "Form preserves input on recoverable errors".
    const preserved = preservedValues(valid);

    expect(preserved.serviceName).toBe("Spotify");
    expect(preserved.category).toBe("entertainment");
    expect(preserved.serviceDomain).toBe("spotify.com");
    expect(preserved.notes).toBe("Family plan");
  });

  it("drops the account identifier", () => {
    /**
     * It is Restricted (security §3). Returning it from a Server Action would
     * put it back into the response payload and the React tree on every failed
     * attempt — a value the architecture keeps encrypted at rest and masked on
     * screen. Retyping one field is the smaller cost.
     */
    const preserved = preservedValues(valid);

    expect(preserved).not.toHaveProperty("accountIdentifier");
    expect(JSON.stringify(preserved)).not.toContain("dana.scully");
  });
});
