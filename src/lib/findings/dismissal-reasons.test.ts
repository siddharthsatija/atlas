import { describe, expect, it } from "vitest";
import { DISMISSAL_REASONS, dismissalReasonLabel, isDismissalReason } from "./dismissal-reasons";
import { ACTIVITY_METADATA_POLICY } from "@/lib/activity/activity-metadata";
import { redactActivityMetadata } from "@/lib/activity/activity-metadata";

/**
 * ATL-043 — the dismissal reason vocabulary.
 *
 * Small on purpose. What is worth asserting is the boundary it forms with two
 * other modules: the OQ-04 decision that removed `incorrect`, and the activity
 * metadata allowlist that has to accept every id or the reason would vanish on
 * its way to the timeline.
 */

describe("the vocabulary", () => {
  it("offers not_relevant and accepted_risk", () => {
    expect(DISMISSAL_REASONS.map((entry) => entry.id)).toEqual(["not_relevant", "accepted_risk"]);
  });

  it("does not offer incorrect", () => {
    /**
     * OQ-04, resolved as "correction, not compensation": a user who believes a
     * finding is wrong corrects the record, and the engine re-evaluates. Offered
     * here, it would let someone declare the finding wrong while the data that
     * produced it stayed exactly as it was.
     */
    expect(DISMISSAL_REASONS.map((entry) => entry.id)).not.toContain("incorrect");
    expect(isDismissalReason("incorrect")).toBe(false);
  });

  it("gives every reason a label and a description", () => {
    // The description is what makes the choice a decision rather than a guess.
    for (const entry of DISMISSAL_REASONS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("recognises exactly its own ids", () => {
    for (const entry of DISMISSAL_REASONS) expect(isDismissalReason(entry.id)).toBe(true);

    for (const value of ["", " ", "not relevant", "NOT_RELEVANT", "shrugged", "__proto__"]) {
      expect(isDismissalReason(value)).toBe(false);
    }
  });

  it("labels a known id and passes an unknown one through unchanged", () => {
    expect(dismissalReasonLabel("accepted_risk")).toBe("I accept this risk");
    expect(dismissalReasonLabel("mystery")).toBe("mystery");
  });
});

describe("compatibility with the activity metadata allowlist", () => {
  it("uses `reason`, a key the policy already permits", () => {
    // No policy change was needed for ATL-043, and this is why.
    expect(Object.keys(ACTIVITY_METADATA_POLICY)).toContain("reason");
  });

  it("survives redaction, so a dismissal reason actually reaches the timeline", () => {
    /**
     * The allowlist is the second gate. A reason that failed its pattern would
     * be dropped silently, leaving a dismissal that claimed a reason nobody
     * could read — so every id is checked against the real redactor rather than
     * against a copy of the regex.
     */
    for (const entry of DISMISSAL_REASONS) {
      const outcome = redactActivityMetadata({ reason: entry.id });

      expect(outcome.value).toEqual({ reason: entry.id });
      expect(outcome.droppedKeys).toEqual([]);
    }
  });
});
