import { describe, expect, it } from "vitest";
import { ACTIVITY_EVENT_TYPES } from "@/lib/activity/activity-events";
import { recordingFor } from "./request-transitions";
import { REQUEST_EVENT_TYPES } from "./request-events";
import { ALLOWED_REQUEST_TRANSITIONS, REQUEST_STATUSES } from "./requests";

/**
 * ATL-057 — how each §13 transition is named in the two timelines that record it.
 *
 * The mapping decides what a person reads, so what is asserted here is coverage
 * and vocabulary membership: every allowed transition resolves to a recording,
 * and every recording names a type that actually exists. A mapping to an
 * unregistered type would throw at the writer — at the moment of a transition,
 * which is the worst possible time to discover it.
 */

/** Every edge §13 permits, as `[from, to]`. */
const EDGES = REQUEST_STATUSES.flatMap((from) =>
  ALLOWED_REQUEST_TRANSITIONS[from].map((to) => [from, to] as const),
);

describe("every allowed transition has a recording", () => {
  it("covers all 18 of §13's edges", () => {
    // A guard on the fixture itself: if the graph changed, the sweep below would
    // quietly cover a different set.
    expect(EDGES).toHaveLength(18);
  });

  it.each(EDGES)("maps %s -> %s to types that exist", (from, to) => {
    const recording = recordingFor(from, to);

    /**
     * Membership, not shape. `RequestEventRepository.append` throws
     * `UnknownRequestEventTypeError` for an unregistered type and `ActivityWriter`
     * throws `UnknownActivityEventTypeError` — both at transition time.
     */
    expect(REQUEST_EVENT_TYPES).toContain(recording.requestEvent);
    expect(ACTIVITY_EVENT_TYPES).toContain(recording.activity);
  });
});

describe("the specific wordings", () => {
  it("says the person marked it sent, not that Atlas sent it", () => {
    // Security §11, frontend §9. `request.sent`'s template is about the person.
    expect(recordingFor("ready", "sent")).toEqual({
      requestEvent: "marked_sent",
      activity: "request.sent",
    });
  });

  it("distinguishes a follow-up from the first send", () => {
    /**
     * Both are `sent` and both record a new `sent_at` (§13), but the request's
     * own timeline should not say "you marked this as sent" a second time.
     */
    expect(recordingFor("follow_up_due", "sent").requestEvent).toBe("follow_up_sent");
    expect(recordingFor("ready", "sent").requestEvent).toBe("marked_sent");
  });

  it("names completion from all four routes to it", () => {
    for (const from of ["sent", "awaiting_response", "follow_up_due", "rejected"] as const) {
      expect(recordingFor(from, "completed")).toEqual({
        requestEvent: "completed",
        activity: "request.completed",
      });
    }
  });

  it("names rejection from all three routes to it", () => {
    for (const from of ["sent", "awaiting_response", "follow_up_due"] as const) {
      expect(recordingFor(from, "rejected").requestEvent).toBe("rejected");
    }
  });

  it("names cancellation from every nonterminal state", () => {
    for (const from of REQUEST_STATUSES.filter((s) => s !== "completed" && s !== "canceled")) {
      expect(recordingFor(from, "canceled").requestEvent).toBe("canceled");
    }
  });
});

describe("the fallback", () => {
  it("covers §13's two system transitions", () => {
    /**
     * Nothing happened except time passing, which is exactly what
     * `status_changed` says — so these deliberately have no specific wording.
     */
    expect(recordingFor("sent", "awaiting_response")).toEqual({
      requestEvent: "status_changed",
      activity: "request.transitioned",
    });
    expect(recordingFor("awaiting_response", "follow_up_due")).toEqual({
      requestEvent: "status_changed",
      activity: "request.transitioned",
    });
  });

  it("answers for a pair §13 does not permit, without asserting it is legal", () => {
    /**
     * `recordingFor` is a naming function, not a gate — `isAllowedTransition` is
     * the gate, and the service consults it first. This asserts the fallback is
     * total so a future edge added to the graph cannot produce `undefined` at the
     * writer before anyone notices the mapping was missed.
     */
    expect(recordingFor("completed", "draft")).toEqual({
      requestEvent: "status_changed",
      activity: "request.transitioned",
    });
  });
});
