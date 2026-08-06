import { describe, expect, it } from "vitest";
import { ASSET_METADATA_POLICY, redactAssetMetadata } from "./asset-metadata";

/**
 * ATL-027 — `metadata_json` validation.
 *
 * The column is not in the §8 encrypted-column inventory, so anything that lands
 * here is stored in plaintext. That is what makes an allowlist the right shape:
 * the question these tests ask is not "is this well-formed?" but "could a
 * restricted value reach storage?".
 */

const filtered = (metadata: Record<string, unknown>) => redactAssetMetadata(metadata).value;

describe("permitted keys", () => {
  it("keeps the documented vocabulary", () => {
    const metadata = {
      plan: "premium",
      accountKind: "personal",
      mfaEnabled: true,
      openedOn: "2019-04-01",
      linkedAccountCount: 3,
      tags: ["work", "shared_household"],
      importSource: { provider: "csv", reference: "batch_a", importedOn: "2026-01-05" },
    };

    expect(filtered(metadata)).toEqual(metadata);
  });

  it("reports that nothing was removed", () => {
    const outcome = redactAssetMetadata({ plan: "free" });

    expect(outcome.droppedKeys).toEqual([]);
    expect(outcome.redactedKeys).toEqual([]);
  });

  it("treats absent metadata as empty rather than failing", () => {
    expect(redactAssetMetadata(undefined).value).toEqual({});
  });
});

describe("restricted values cannot reach storage", () => {
  it.each([
    ["an email", { email: "dana@example.com" }],
    ["a phone number", { phone: "+1 202 555 0134" }],
    ["a username", { username: "dscully" }],
    ["an account identifier", { accountIdentifier: "ACC-99182" }],
    ["a profile URL", { profileUrl: "https://social.example/dscully" }],
    ["a display name", { displayName: "Dana Scully" }],
    ["a postal address", { address: "1013 Bureau Way" }],
  ])("drops %s", (_label, metadata) => {
    const outcome = redactAssetMetadata(metadata);

    expect(outcome.value).toEqual({});
    expect(outcome.droppedKeys).toHaveLength(1);
    expect(JSON.stringify(outcome.value)).not.toContain("example");
  });

  it("drops an unlisted key even when its value looks harmless", () => {
    // The allowlist is the control, not a value heuristic — a key nobody
    // reviewed is a key nobody decided was safe.
    expect(filtered({ colour: "blue" })).toEqual({});
  });

  it("keeps the permitted keys while dropping the rest", () => {
    // Partial acceptance: one bad key must not cost the user their whole payload.
    expect(filtered({ plan: "free", email: "dana@example.com" })).toEqual({ plan: "free" });
  });
});

describe("shape enforcement inside permitted keys", () => {
  it.each([
    ["free text in a vocabulary field", { plan: "Premium Family Plan, renewed yearly" }],
    ["a timestamp where a date is required", { openedOn: "2019-04-01T09:30:00Z" }],
    ["a non-integer count", { linkedAccountCount: 2.5 }],
    ["a negative count", { linkedAccountCount: -1 }],
    ["a string where a boolean is required", { mfaEnabled: "yes" }],
  ])("rejects %s", (_label, metadata) => {
    const outcome = redactAssetMetadata(metadata);

    expect(outcome.value).toEqual({});
    expect(outcome.redactedKeys.length + outcome.droppedKeys.length).toBeGreaterThan(0);
  });

  it("strips an email smuggled into a tag, leaving the key empty rather than absent", () => {
    /**
     * Arrays are filtered element by element, so the key survives with nothing
     * in it. That is the correct outcome and worth pinning: the guarantee is
     * that the value cannot reach storage, not that the shape collapses.
     */
    const outcome = redactAssetMetadata({ tags: ["dana@example.com"] });

    expect(outcome.value).toEqual({ tags: [] });
    expect(JSON.stringify(outcome.value)).not.toContain("example.com");
    expect(outcome.redactedKeys.length + outcome.droppedKeys.length).toBeGreaterThan(0);
  });

  it("filters nested provenance field by field", () => {
    const outcome = redactAssetMetadata({
      importSource: { provider: "csv", reference: "https://example.com/export.csv" },
    });

    expect(outcome.value).toEqual({ importSource: { provider: "csv" } });
  });

  it("filters tags element by element", () => {
    expect(filtered({ tags: ["work", "dana@example.com", "old"] })).toEqual({
      tags: ["work", "old"],
    });
  });
});

describe("the policy itself", () => {
  it("names no key that suggests an identifier", () => {
    /**
     * A structural guard on future edits. Widening this allowlist is a security
     * decision, and a key called `handle` or `email` is the shape that mistake
     * takes.
     */
    const forbidden = /(email|phone|identifier|username|handle|address|url|name)/i;
    const offenders = Object.keys(ASSET_METADATA_POLICY).filter((key) => forbidden.test(key));

    expect(offenders).toEqual([]);
  });

  it("has no free-text field", () => {
    // `notes` is the one place a user may type freely, and it is bounded,
    // classified, and handled. A second such field here would have none of that.
    expect(Object.keys(ASSET_METADATA_POLICY)).not.toContain("notes");
    expect(Object.keys(ASSET_METADATA_POLICY)).not.toContain("description");
  });
});
