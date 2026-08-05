import { describe, expect, it } from "vitest";
import { scrubString } from "@/lib/telemetry/redaction";
import { maskEmail } from "@/lib/formatting/mask";
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_TEMPLATES,
  buildActivitySummary,
  isActivityEventType,
  type ActivityParams,
} from "./activity-events";

/**
 * ATL-069 — the event vocabulary and its summary templates.
 *
 * The ticket asks for "summary redaction unit tests" and "event types
 * enumerated and typed; unknown types rejected". Both are here; the writer's
 * enforcement of them lives in `activity-writer.integration.test.ts`.
 */

describe("the vocabulary", () => {
  it("covers every category the documentation says emits activity", () => {
    const prefixes = new Set(ACTIVITY_EVENT_TYPES.map((t) => t.split(".")[0]));

    // assets (ATL-030/036), findings (ATL-043, §11.1), requests (§13),
    // consent (ATL-078), score (ADR-004).
    for (const required of ["asset", "finding", "request", "consent", "score"]) {
      expect(prefixes).toContain(required);
    }
  });

  it("accepts a known type and rejects an invented one", () => {
    expect(isActivityEventType("asset.created")).toBe(true);
    expect(isActivityEventType("asset.invented")).toBe(false);
    expect(isActivityEventType("")).toBe(false);
  });

  it("uses a consistent entity.action shape", () => {
    // The Activity page filters on the entity half, so a stray format would
    // silently drop out of the filters.
    for (const type of ACTIVITY_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});

describe("summaries", () => {
  it("reads as a sentence about what the user did", () => {
    expect(buildActivitySummary("asset.created", { service: "Acme" })).toBe("Added Acme");
    expect(
      buildActivitySummary("request.transitioned", {
        service: "Acme",
        fromStatus: "sent",
        toStatus: "awaiting response",
      }),
    ).toBe("Data request to Acme moved from sent to awaiting response");
  });

  it("degrades to a generic noun rather than breaking when a label is absent", () => {
    // A caller with nothing safe to name still gets a readable row.
    expect(buildActivitySummary("asset.created")).toBe("Added a service");
    expect(buildActivitySummary("consent.granted")).toBe("Granted consent for a feature");
  });

  it("includes a masked identifier when one is supplied", () => {
    // ATL-069 permits "masked identifiers at most" — this is that case.
    const summary = buildActivitySummary("request.sent", {
      service: "Acme",
      maskedIdentifier: maskEmail("privacy@acme.example"),
    });

    expect(summary).toBe("Sent a data request to Acme (p••••y@acme.example)");
    expect(summary).not.toContain("privacy@acme.example");
  });

  it("produces a non-empty summary for every type in the vocabulary", () => {
    // A blank summary is an unreadable timeline row; the table also refuses it.
    for (const type of ACTIVITY_EVENT_TYPES) {
      const summary = buildActivitySummary(type);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("summary redaction", () => {
  /**
   * Realistic, safe parameters — what a correct caller passes.
   *
   * `maskedIdentifier` is deliberately absent here and covered separately. A
   * masked email keeps its domain (`p••••y@acme.example`), so it still matches
   * an email pattern; that is by design, and compensating for it is the
   * writer's job, not the template's.
   */
  const SAFE: ActivityParams = {
    service: "Acme",
    label: "Work account",
    status: "sent",
    fromStatus: "draft",
    toStatus: "sent",
    category: "social",
    severity: "high",
    count: 72,
    consentType: "ai processing",
  };

  it.each(ACTIVITY_EVENT_TYPES)("%s emits a clean summary from safe params", (type) => {
    // The everyday path: nothing a template does on its own introduces a
    // restricted value.
    expect(scrubString(buildActivitySummary(type, SAFE)).scrubbed).toBe(false);
  });

  it("a masked identifier still matches the email pattern, which the writer handles", () => {
    /**
     * Recorded because it is surprising and cost a real bug.
     *
     * Masking preserves the domain so the owner can recognise the address, which
     * means the result is still email-shaped. A naive summary scan would
     * therefore reject the exact case ATL-069 permits — "masked identifiers at
     * most". `ActivityWriter` scans a control sentence with the masked value
     * substituted out, so it asks whether anything *else* is restricted.
     */
    const masked = maskEmail("privacy@acme.example");
    expect(scrubString(masked).scrubbed).toBe(true);
  });

  /**
   * Templates interpolate their parameters verbatim — they do not sanitise.
   *
   * This is deliberate and is exactly why `ActivityWriter` scans the *composed*
   * summary and refuses it. Asserting the leak here proves that guard is
   * load-bearing rather than decorative; the writer's rejection is asserted in
   * `activity-writer.integration.test.ts`.
   */
  it("lets a poisoned parameter reach the summary, which is why the writer scans", () => {
    const summary = buildActivitySummary("asset.created", { service: "dana@example.com" });

    expect(summary).toContain("dana@example.com");
    expect(scrubString(summary).scrubbed).toBe(true);
  });

  it("cannot be poisoned through a numeric parameter", () => {
    // `count` is typed as a number, so there is no string to smuggle.
    expect(scrubString(buildActivitySummary("score.recalculated", { count: 72 })).scrubbed).toBe(
      false,
    );
  });

  it("has no template that interpolates an unlisted parameter", () => {
    /**
     * A structural guard. `ActivityParams` is the allowlist; a template reading
     * anything else would be reaching for data the type system does not police.
     */
    const allowed = new Set([
      "service",
      "label",
      "maskedIdentifier",
      "status",
      "fromStatus",
      "toStatus",
      "category",
      "severity",
      "count",
      "consentType",
    ]);

    for (const [type, template] of Object.entries(ACTIVITY_TEMPLATES)) {
      const source = template.toString();
      for (const match of source.matchAll(/\bp\.([a-zA-Z]+)/g)) {
        expect(allowed, `${type} reads p.${match[1]}`).toContain(match[1]);
      }
    }
  });
});
