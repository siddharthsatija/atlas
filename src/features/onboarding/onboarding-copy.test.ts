import { describe, expect, it } from "vitest";
import {
  AI_CONSENT_COPY,
  ONBOARDING_INTRO,
  ONBOARDING_LIMITATIONS,
  ONBOARDING_STEP_COPY,
} from "./onboarding-copy";

/**
 * ATL-016 — onboarding copy, held to the honesty rules.
 *
 * The acceptance criterion asks for limitations copy that states what Atlas does
 * not do. Copy drifts by a word at a time, and "Atlas scans for your accounts"
 * is one edit away from "Atlas helps you record your accounts" — so the claims
 * are asserted rather than reviewed.
 */

const ALL_COPY = JSON.stringify({
  ONBOARDING_INTRO,
  ONBOARDING_LIMITATIONS,
  ONBOARDING_STEP_COPY,
  AI_CONSENT_COPY,
}).toLowerCase();

describe("limitations", () => {
  it("states that Atlas does not scan", () => {
    // Architecture §11: findings come from the user's own records and "no
    // internet scanning is performed or claimed".
    const scanning = ONBOARDING_LIMITATIONS.items.find((i) =>
      i.title.toLowerCase().includes("scan"),
    );
    expect(scanning).toBeDefined();
    expect(scanning?.body.toLowerCase()).toContain("only from what you add");
  });

  it("states that deletion is not guaranteed", () => {
    const deletion = ONBOARDING_LIMITATIONS.items.find((i) =>
      i.title.toLowerCase().includes("deletion"),
    );
    expect(deletion).toBeDefined();
    expect(deletion?.body.toLowerCase()).toContain("up to them");
  });

  it("says it is not legal advice", () => {
    expect(ALL_COPY).toContain("not advice");
  });

  it("has a heading of its own rather than being fine print", () => {
    // A limitation shown as a footnote after the user has committed is an
    // apology, not an informed choice.
    expect(ONBOARDING_LIMITATIONS.title).toBe("What Atlas does not do");
    expect(ONBOARDING_LIMITATIONS.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("capability claims", () => {
  it("promises nothing Atlas cannot do", () => {
    /**
     * The specific overclaims this product is most likely to drift into. Each
     * would be a documentation violation, not merely optimistic marketing.
     */
    const forbidden = [
      "scan the internet for you to find",
      "we find your accounts",
      "guarantee",
      "guaranteed",
      "automatically delete",
      "remove your data for you",
    ];

    for (const phrase of forbidden) {
      const capabilities = JSON.stringify(ONBOARDING_INTRO).toLowerCase();
      expect(capabilities).not.toContain(phrase);
    }
  });

  it("describes recording rather than discovering", () => {
    expect(ONBOARDING_INTRO.capabilities.join(" ").toLowerCase()).toContain("you have told it");
  });
});

describe("AI consent copy", () => {
  it("says data leaves only when an AI feature is used", () => {
    expect(AI_CONSENT_COPY.body.toLowerCase()).toContain("only when you use");
  });

  it("says it can be withdrawn and that Atlas works without it", () => {
    // ATL-078 makes withdrawal real; the copy must not imply otherwise.
    expect(AI_CONSENT_COPY.body.toLowerCase()).toContain("withdraw");
    expect(AI_CONSENT_COPY.body.toLowerCase()).toContain("works without it");
  });
});

describe("tone", () => {
  it("avoids alarm and pressure", () => {
    // The product voice is calm; onboarding is where a privacy product is most
    // tempted to frighten someone into engagement.
    for (const phrase of ["urgent", "at risk", "danger", "exposed right now", "act now"]) {
      expect(ALL_COPY).not.toContain(phrase);
    }
  });

  it("is honest that the dashboard starts empty", () => {
    expect(ONBOARDING_STEP_COPY.ready.lede.toLowerCase()).toContain("empty");
  });
});
