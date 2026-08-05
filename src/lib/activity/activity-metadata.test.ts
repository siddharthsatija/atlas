import { describe, expect, it } from "vitest";
import { ACTIVITY_METADATA_POLICY, redactActivityMetadata } from "./activity-metadata";

/**
 * ATL-068 — the `metadata_redacted_json` allowlist.
 *
 * The acceptance criterion is that this column is "schema-validated against an
 * allowlist". Most of these tests assert what is *removed*, because that is the
 * property the column name promises and the one a future feature ticket is most
 * likely to erode by adding a convenient key.
 */

describe("permitted metadata", () => {
  it("keeps statuses and transitions", () => {
    const { value, droppedKeys } = redactActivityMetadata({
      status: "sent",
      fromStatus: "draft",
      toStatus: "sent",
      reason: "user_action",
    });

    expect(value).toEqual({
      status: "sent",
      fromStatus: "draft",
      toStatus: "sent",
      reason: "user_action",
    });
    expect(droppedKeys).toEqual([]);
  });

  it("keeps counts and scores", () => {
    const { value } = redactActivityMetadata({
      count: 3,
      previousCount: 1,
      score: 72,
      previousScore: 65,
    });

    expect(value).toEqual({ count: 3, previousCount: 1, score: 72, previousScore: 65 });
  });

  it("keeps classification labels and versions", () => {
    const { value } = redactActivityMetadata({
      category: "social",
      severity: "high",
      actor: "system",
      ruleVersion: "rules-v1",
    });

    expect(value).toEqual({
      category: "social",
      severity: "high",
      actor: "system",
      ruleVersion: "rules-v1",
    });
  });

  it("keeps the demo-data flag", () => {
    // Demo data must be labelled, never silently mixed with real data.
    expect(redactActivityMetadata({ isDemo: true }).value).toEqual({ isDemo: true });
  });

  it("treats absent metadata as an empty object", () => {
    expect(redactActivityMetadata(undefined).value).toEqual({});
  });
});

describe("restricted values are dropped", () => {
  /**
   * Security §data classification, Restricted list — one case each.
   *
   * These are exactly the inputs the *summaries* are generated from, which is
   * why the allowlist matters: a service that had the recipient address to hand
   * could pass it here without noticing.
   */
  const restricted: { name: string; metadata: Record<string, unknown> }[] = [
    { name: "an email address", metadata: { email: "dana@example.com" } },
    { name: "a request recipient", metadata: { recipient: "privacy@example.com" } },
    { name: "a phone number", metadata: { phone: "+14155552671" } },
    { name: "an address", metadata: { address: "1 Example Street" } },
    { name: "an account identifier", metadata: { accountIdentifier: "acct-99" } },
    { name: "a personal field value", metadata: { value: "Dana Whitfield" } },
    { name: "a draft subject", metadata: { subject: "Delete my data" } },
    { name: "a draft body", metadata: { body: "Please delete everything." } },
    { name: "an auth token", metadata: { accessToken: "sk_live_9f2b7c1d" } },
    { name: "a raw user id", metadata: { userId: "11111111-2222-3333-4444-555555555555" } },
  ];

  for (const { name, metadata } of restricted) {
    it(`drops ${name} and counts it`, () => {
      const { value, droppedKeys } = redactActivityMetadata(metadata);

      const key = Object.keys(metadata)[0]!;
      expect(droppedKeys).toContain(key);
      expect(value).not.toHaveProperty(key);
    });
  }

  it("drops free text even under an allowlisted-sounding name", () => {
    // `note` and `description` read as harmless and are exactly how a sentence
    // built from a personal field would arrive.
    const { value } = redactActivityMetadata({
      note: "Requested deletion for dana@example.com",
      description: "Asset for +14155552671",
    });

    expect(value).toEqual({});
    expect(JSON.stringify(value)).not.toContain("dana@example.com");
  });

  it("keeps the allowlisted keys while dropping the rest of the same payload", () => {
    // The realistic failure: a service spreads a domain object into metadata.
    const { value, droppedKeys } = redactActivityMetadata({
      status: "sent",
      recipient: "privacy@example.com",
      count: 2,
      draftBody: "Please delete my account",
    });

    expect(value).toEqual({ status: "sent", count: 2 });
    expect(droppedKeys.sort()).toEqual(["draftBody", "recipient"]);
  });
});

describe("shape validation", () => {
  it("removes an allowlisted key whose value is the wrong shape", () => {
    // A permitted key is not a permitted value: `status` may not carry a
    // sentence, which is how free text would sneak through a name check.
    const { value, redactedKeys } = redactActivityMetadata({
      status: "Sent to dana@example.com",
    });

    expect(value).not.toHaveProperty("status");
    expect(redactedKeys).toContain("status");
  });

  it("rejects a non-integer or out-of-range score", () => {
    for (const score of [101, -1, 72.5, "72"]) {
      expect(redactActivityMetadata({ score }).value).not.toHaveProperty("score");
    }
  });

  it("rejects a non-boolean demo flag", () => {
    expect(redactActivityMetadata({ isDemo: "true" }).value).not.toHaveProperty("isDemo");
  });
});

describe("the policy itself", () => {
  it("names no free-text field", () => {
    /**
     * A regression guard on the allowlist rather than on a payload. The way this
     * column stops being redacted is somebody adding `note`, `message`, or
     * `details` because it was convenient — so those names are refused here, at
     * the point the policy is written.
     */
    const freeText = ["note", "notes", "message", "description", "details", "text", "summary"];
    for (const name of freeText) {
      expect(Object.keys(ACTIVITY_METADATA_POLICY)).not.toContain(name);
    }
  });

  it("names no identifier field", () => {
    const identifiers = ["email", "phone", "address", "userId", "recipient", "accountIdentifier"];
    for (const name of identifiers) {
      expect(Object.keys(ACTIVITY_METADATA_POLICY)).not.toContain(name);
    }
  });
});
