import { describe, expect, it } from "vitest";
import { scrubString } from "@/lib/telemetry/redaction";
import {
  buildRequestEventSummary,
  isRequestEventType,
  REQUEST_EVENT_TEMPLATES,
  REQUEST_EVENT_TYPES,
  type RequestEventType,
} from "./request-events";
import { REQUEST_STATUSES } from "./requests";

/**
 * ATL-056 — the `request_events` template vocabulary.
 *
 * §7.8 gives the table a `summary` column, and D3 settled how it is filled:
 * templates keyed by event type, with no free-form API. These tests hold that
 * line, because it is the one thing about this column that could quietly stop
 * being true — a `summary?: string` parameter added later would compile, pass
 * every other test, and put a recipient address in a timeline the first time a
 * caller was holding one.
 */

describe("the vocabulary", () => {
  it("recognises its own members and nothing else", () => {
    for (const type of REQUEST_EVENT_TYPES) expect(isRequestEventType(type)).toBe(true);

    expect(isRequestEventType("emailed_service")).toBe(false);
    expect(isRequestEventType("")).toBe(false);
    expect(isRequestEventType(undefined)).toBe(false);
  });

  it("uses identifiers the column's shape check accepts", () => {
    // `event_type text not null check (event_type ~ '^[a-z][a-z0-9_]{0,63}$')`.
    // A type this pattern rejected would fail at the insert instead of here.
    for (const type of REQUEST_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });

  it("covers the transitions §13 describes", () => {
    /**
     * Not an exhaustive map — one template serves every plain status change —
     * but the moments that need their own wording must exist, because
     * `status_changed` would describe them in the system's voice rather than the
     * person's.
     */
    for (const required of [
      "created",
      "marked_sent",
      "response_noted",
      "follow_up_sent",
      "rejected",
      "completed",
      "canceled",
      "status_changed",
    ]) {
      expect(REQUEST_EVENT_TYPES).toContain(required);
    }
  });
});

describe("the templates", () => {
  it("produces a non-empty summary for every type, with no parameters", () => {
    /**
     * Most events carry no statuses at all. A template that returned an empty
     * string would violate `char_length(summary) between 1 and 500` and fail at
     * the insert.
     */
    for (const type of REQUEST_EVENT_TYPES) {
      expect(buildRequestEventSummary(type).length).toBeGreaterThan(0);
    }
  });

  it("stays inside the column's length cap for every status pair", () => {
    for (const from of REQUEST_STATUSES) {
      for (const to of REQUEST_STATUSES) {
        const summary = buildRequestEventSummary("status_changed", {
          fromStatus: from,
          toStatus: to,
        });
        expect(summary.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("names both ends of a transition in the person's words", () => {
    const summary = buildRequestEventSummary("status_changed", {
      fromStatus: "sent",
      toStatus: "awaiting_response",
    });

    // The stored identifiers are snake_case; a timeline is not.
    expect(summary).toContain("sent");
    expect(summary).toContain("awaiting a response");
    expect(summary).not.toContain("awaiting_response");
  });

  it("degrades to something true when a status is missing", () => {
    const summary = buildRequestEventSummary("status_changed", { toStatus: "completed" });

    expect(summary).not.toContain("undefined");
    expect(summary.length).toBeGreaterThan(0);
  });

  it("never says Atlas sent anything", () => {
    /**
     * Security §11 and frontend §9: Atlas drafts and never sends. `marked_sent`
     * and `follow_up_sent` are the two templates that could get this wrong, and
     * both are written about the person.
     */
    expect(buildRequestEventSummary("marked_sent")).toMatch(/^You /);
    expect(buildRequestEventSummary("follow_up_sent")).toMatch(/^You /);

    for (const type of REQUEST_EVENT_TYPES) {
      expect(buildRequestEventSummary(type)).not.toMatch(/Atlas (sent|submitted|emailed)/i);
    }
  });

  it("has no parameter that carries free text (D3)", () => {
    /**
     * The structural claim. `RequestEventParams` has exactly two members, both
     * statuses from a closed vocabulary — no `summary`, no `message`, no
     * `maskedIdentifier` of the kind `ActivityParams` permits. A caller holding
     * the recipient, the subject or the draft body therefore has no parameter
     * that could legitimately carry any of them.
     *
     * Asserted by exercising every template with every status pair and scanning
     * the output: whatever these produce, it is drawn from a fixed set of
     * phrases and cannot contain caller data, because there is no caller data to
     * contain.
     */
    for (const type of REQUEST_EVENT_TYPES) {
      for (const from of REQUEST_STATUSES) {
        for (const to of REQUEST_STATUSES) {
          const summary = buildRequestEventSummary(type, { fromStatus: from, toStatus: to });
          expect(scrubString(summary).scrubbed).toBe(false);
        }
      }
    }
  });

  it("exposes one template per declared type, and no more", () => {
    // Guards against a type declared in the union without a template, which
    // would throw at call time rather than fail here.
    expect(Object.keys(REQUEST_EVENT_TEMPLATES).sort()).toEqual([...REQUEST_EVENT_TYPES].sort());
  });

  it.each(REQUEST_EVENT_TYPES)("is a function for %s", (type: RequestEventType) => {
    expect(typeof REQUEST_EVENT_TEMPLATES[type]).toBe("function");
  });
});
