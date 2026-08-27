import { describe, expect, it } from "vitest";
import { PERSONAL_FIELD_KEYS } from "@/lib/personal-fields";
import {
  checkRecipient,
  hasUncertainEvidence,
  keysWithHiddenAlternatives,
  reviewSelection,
  selectableFields,
  UNVERIFIED_RECIPIENT_NOTICE,
  type SelectableField,
} from "./request-draft";

/**
 * ATL-058 — the three decisions Step 1 makes.
 *
 * Each is a product rule with a consequence: which of a person's stored fields
 * they may approve, whether an address is usable, and when Atlas admits it is
 * unsure. All three are asserted here against literals, so the route and the
 * components can be tested for what they *render* rather than for what they
 * decide.
 */

const field = (overrides: Partial<SelectableField> = {}): SelectableField => ({
  id: "f1",
  fieldKey: "email",
  label: "Personal Gmail",
  maskedValue: "a•••@example.com",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("which fields the checklist offers (D1)", () => {
  it("offers one field per key, keeping the most recently updated", () => {
    /**
     * The vault permits two emails — the ATL-105 migration says so explicitly —
     * but `included_fields_json` stores keys, so approving one of two is not
     * representable. The newer wins and its label says which it is.
     */
    const offered = selectableFields([
      field({ id: "old", label: "Old address", updatedAt: "2026-01-01T00:00:00.000Z" }),
      field({ id: "new", label: "Current address", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ]);

    expect(offered).toHaveLength(1);
    expect(offered[0]?.id).toBe("new");
    expect(offered[0]?.label).toBe("Current address");
  });

  it("keeps fields of different keys", () => {
    const offered = selectableFields([
      field({ id: "e", fieldKey: "email" }),
      field({ id: "p", fieldKey: "phone" }),
      field({ id: "n", fieldKey: "full_name" }),
    ]);

    expect(offered.map((f) => f.fieldKey)).toEqual(["full_name", "email", "phone"]);
  });

  it("orders by the vocabulary, not by recency", () => {
    /**
     * A checklist that reshuffled between visits would make a person re-read it
     * to find the box they meant. `PERSONAL_FIELD_KEYS` is the fixed order.
     */
    const offered = selectableFields([
      field({ id: "u", fieldKey: "username", updatedAt: "2026-09-01T00:00:00.000Z" }),
      field({ id: "n", fieldKey: "full_name", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    expect(offered.map((f) => f.fieldKey)).toEqual(["full_name", "username"]);
    expect(PERSONAL_FIELD_KEYS.indexOf("full_name")).toBeLessThan(
      PERSONAL_FIELD_KEYS.indexOf("username"),
    );
  });

  it("is stable when two fields of a key share a timestamp", () => {
    // Strictly-newer-wins, so a tie keeps the first the caller gave — and
    // `listMasked` orders deterministically, so renders do not swap.
    const same = "2026-03-01T00:00:00.000Z";
    const offered = selectableFields([
      field({ id: "first", updatedAt: same }),
      field({ id: "second", updatedAt: same }),
    ]);

    expect(offered[0]?.id).toBe("first");
  });

  it("offers nothing when the vault is empty", () => {
    // FR-08 makes every field optional; a draft with no approved fields is valid.
    expect(selectableFields([])).toEqual([]);
  });

  it("names the keys whose alternatives are hidden", () => {
    /**
     * The surface tells the person rather than silently dropping one — otherwise
     * someone with two emails wonders why the other is missing.
     */
    const fields = [
      field({ id: "e1", fieldKey: "email" }),
      field({ id: "e2", fieldKey: "email" }),
      field({ id: "p1", fieldKey: "phone" }),
    ];

    expect(keysWithHiddenAlternatives(fields)).toEqual(["email"]);
  });

  it("names nothing when every key appears once", () => {
    expect(keysWithHiddenAlternatives([field({ fieldKey: "email" })])).toEqual([]);
  });
});

describe("the recipient address", () => {
  it("accepts a plausible address and trims it", () => {
    expect(checkRecipient("  privacy@acme.example  ")).toEqual({
      ok: true,
      recipient: "privacy@acme.example",
    });
  });

  it("distinguishes missing from invalid", () => {
    /**
     * Two different sentences: one asks the person to enter something, the other
     * says what they entered will not work. Collapsing them would tell someone
     * who typed a typo that they had typed nothing.
     */
    expect(checkRecipient("")).toEqual({ ok: false, problem: "missing" });
    expect(checkRecipient("   ")).toEqual({ ok: false, problem: "missing" });
    expect(checkRecipient(undefined)).toEqual({ ok: false, problem: "missing" });
    expect(checkRecipient("not-an-address")).toEqual({ ok: false, problem: "invalid" });
  });

  it.each([
    "no-at-sign",
    "two@@at.example",
    "trailing@dot.",
    "@nolocal.example",
    "spaces in@x.example",
  ])("refuses %s", (value) => {
    expect(checkRecipient(value).ok).toBe(false);
  });

  it("says Atlas does not verify it", () => {
    /**
     * FR-08 requires the address to be "clearly marked unverified" — there is no
     * service directory until Phase 2. The notice is a constant so Step 1 and
     * ATL-060's Step 2 cannot word the same claim differently.
     */
    expect(UNVERIFIED_RECIPIENT_NOTICE).toMatch(/does not verify/i);
    expect(UNVERIFIED_RECIPIENT_NOTICE).not.toMatch(/verified|confirmed by Atlas/i);
  });
});

describe("the uncertain-evidence warning (D5)", () => {
  const evidence = (confidence: string) => ({ label: "Contact details", confidence, source: null });

  it("warns when the service's own confidence is low", () => {
    expect(hasUncertainEvidence("low", [])).toBe(true);
  });

  it("warns when any single category is low, however many are not", () => {
    /**
     * Not an average. One shaky fact among several confident ones is exactly the
     * case the warning exists for — averaging would hide it.
     */
    expect(
      hasUncertainEvidence("high", [evidence("high"), evidence("high"), evidence("low")]),
    ).toBe(true);
  });

  it("does not warn on medium", () => {
    /**
     * §11.1 caps confidence at medium for anything older than 180 days, so
     * warning on medium would warn on almost every mature account and teach
     * people to ignore it.
     */
    expect(hasUncertainEvidence("medium", [evidence("medium")])).toBe(false);
  });

  it("does not warn when everything is high", () => {
    expect(hasUncertainEvidence("high", [evidence("high")])).toBe(false);
  });

  it("does not warn for a service with no recorded categories", () => {
    // Nothing uncertain has been claimed, because nothing has been claimed.
    expect(hasUncertainEvidence("high", [])).toBe(false);
  });
});

describe("turning a submission into a selection", () => {
  const offered = [field({ id: "e", fieldKey: "email" }), field({ id: "p", fieldKey: "phone" })];

  it("carries both the keys and the ids", () => {
    /**
     * The keys are stored and checked by the AI policy layer; the ids are what
     * `markUsed` stamps. Deriving one from the other later would cost a second
     * read of the vault.
     */
    const selection = reviewSelection(offered, ["e"], "privacy@acme.example");

    expect(selection).toEqual({
      fieldIds: ["e"],
      fieldKeys: ["email"],
      recipient: "privacy@acme.example",
    });
  });

  it("drops an id that was never offered", () => {
    /**
     * The ids come from a form and are untrusted. The offered list was built from
     * this person's own vault, so an id outside it is either not theirs or not on
     * offer — and both are refused the same way, which says nothing about which.
     */
    const selection = reviewSelection(offered, ["e", "someone-elses-field"], "x@y.example");

    expect(selection.fieldIds).toEqual(["e"]);
    expect(selection.fieldKeys).toEqual(["email"]);
  });

  it("approves nothing when nothing was ticked", () => {
    // Unchecked by default is the whole point (FR-08, ADR-002).
    expect(reviewSelection(offered, [], "x@y.example").fieldKeys).toEqual([]);
  });

  it("keeps the offered order rather than the submitted order", () => {
    /**
     * A form serialises checkboxes in DOM order, but a tampered or reordered
     * submission should not change what is stored — the keys land in the order
     * the checklist showed them.
     */
    const selection = reviewSelection(offered, ["p", "e"], "x@y.example");

    expect(selection.fieldKeys).toEqual(["email", "phone"]);
  });
});
