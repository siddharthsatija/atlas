import { describe, expect, it } from "vitest";
import {
  allowedTransitionsFrom,
  isAllowedTransition,
  isDeliveryMethod,
  isRequestActorType,
  isRequestStatus,
  isRequestType,
  isTerminalStatus,
  ALLOWED_REQUEST_TRANSITIONS,
  DELIVERY_METHODS,
  EXTERNAL_REFERENCE_MAX_LENGTH,
  REQUEST_ACTOR_TYPES,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  TERMINAL_REQUEST_STATUSES,
  type RequestStatus,
} from "./requests";

/**
 * ATL-056 — the request vocabularies and architecture §13's lifecycle.
 *
 * The transition table is a transcription of a specification, so the tests are
 * written as a transcription of the same specification rather than as a
 * restatement of the table. Every §13 line appears below as its own expectation,
 * and the exhaustive sweep asserts that **nothing else** is permitted — which is
 * the half a hand-written list of allowed moves cannot cover, and the half that
 * would silently widen if a future edit added a pair.
 *
 * ATL-057 owns *enforcing* these. What is asserted here is only what the table
 * says, because that is all this ticket ships.
 */

/**
 * Architecture §13's allowed transitions, written out.
 *
 * Deliberately a second, independent copy: a test that imported the table and
 * compared it to itself would pass for any table at all.
 */
const SPEC_TRANSITIONS: readonly [RequestStatus, RequestStatus][] = [
  ["draft", "ready"],
  ["draft", "canceled"],
  ["ready", "sent"],
  ["ready", "canceled"],
  ["sent", "awaiting_response"],
  ["sent", "completed"],
  ["sent", "rejected"],
  ["awaiting_response", "follow_up_due"],
  ["awaiting_response", "completed"],
  ["awaiting_response", "rejected"],
  ["follow_up_due", "sent"],
  ["follow_up_due", "completed"],
  ["follow_up_due", "rejected"],
  ["rejected", "completed"],
  /** "any nonterminal state -> canceled" — the four not already listed above. */
  ["sent", "canceled"],
  ["awaiting_response", "canceled"],
  ["follow_up_due", "canceled"],
  ["rejected", "canceled"],
];

describe("the status vocabulary", () => {
  it("is exactly the eight statuses §13, FR-08 and frontend §9 name", () => {
    expect([...REQUEST_STATUSES].sort()).toEqual([
      "awaiting_response",
      "canceled",
      "completed",
      "draft",
      "follow_up_due",
      "ready",
      "rejected",
      "sent",
    ]);
  });

  it("recognises its own members and nothing else", () => {
    for (const status of REQUEST_STATUSES) expect(isRequestStatus(status)).toBe(true);

    expect(isRequestStatus("archived")).toBe(false);
    expect(isRequestStatus("awaiting response")).toBe(false);
    expect(isRequestStatus("")).toBe(false);
    expect(isRequestStatus(undefined)).toBe(false);
  });

  it("uses identifiers the audit reason allowlist accepts", () => {
    /**
     * FR-08 writes these with spaces ("awaiting response"). Stored values are
     * snake_case so they can travel as an audit `reason`, whose allowlist is
     * /^[a-z][a-z0-9_]{0,63}$/ — a status that could not be recorded in the audit
     * log would make §12's "request state transitions" unrecordable.
     */
    for (const status of REQUEST_STATUSES) {
      expect(status).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });
});

describe("the request-type and delivery vocabularies", () => {
  it("supports deletion and correction (FR-08, §7.7)", () => {
    expect([...REQUEST_TYPES].sort()).toEqual(["correction", "deletion"]);
    expect(isRequestType("deletion")).toBe(true);
    expect(isRequestType("erasure")).toBe(false);
  });

  it("names only things the person did, never Atlas", () => {
    /**
     * Security §11 and frontend §9: Atlas drafts and never sends, and "no control
     * may imply Atlas sent the request unless it actually did". The absence of a
     * value meaning "Atlas sent it" is what makes that structural rather than a
     * rule to remember.
     */
    expect([...DELIVERY_METHODS].sort()).toEqual(["copy", "mailto", "manual"]);
    expect(isDeliveryMethod("atlas")).toBe(false);
    expect(isDeliveryMethod("automatic")).toBe(false);
  });

  it("has two actor types, matching §7.8", () => {
    expect([...REQUEST_ACTOR_TYPES].sort()).toEqual(["system", "user"]);
    /** ADR-006's audit log has `operator`; a request has nothing that acts as one. */
    expect(isRequestActorType("operator")).toBe(false);
  });
});

describe("terminal states", () => {
  it("is completed and canceled only", () => {
    expect([...TERMINAL_REQUEST_STATUSES].sort()).toEqual(["canceled", "completed"]);
  });

  it("does not treat rejected as terminal", () => {
    /**
     * §13 is explicit: a rejection is an answer, not an ending. `rejected ->
     * completed` means the person acknowledges it and closes the matter.
     */
    expect(isTerminalStatus("rejected")).toBe(false);
    expect(allowedTransitionsFrom("rejected")).toContain("completed");
  });

  it("lets nothing leave a terminal state", () => {
    for (const status of TERMINAL_REQUEST_STATUSES) {
      expect(allowedTransitionsFrom(status)).toEqual([]);
    }
  });
});

describe("the §13 transition table", () => {
  it("lists every status as a key, including the terminal ones", () => {
    /**
     * A caller iterating the table should see the whole state machine. An absent
     * key would make "no transitions from here" indistinguishable from "this
     * status was forgotten".
     */
    expect(Object.keys(ALLOWED_REQUEST_TRANSITIONS).sort()).toEqual([...REQUEST_STATUSES].sort());
  });

  it.each(SPEC_TRANSITIONS)("permits %s -> %s", (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(true);
  });

  it("permits nothing beyond what §13 lists", () => {
    /**
     * The exhaustive half. Every one of the 64 ordered pairs is checked against
     * the independently written specification list above, so a future edit that
     * widened the table — say, allowing `completed -> sent` — fails here rather
     * than in whatever ATL-057 builds on top of it.
     */
    const permitted = new Set(SPEC_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

    const unexpected: string[] = [];
    for (const from of REQUEST_STATUSES) {
      for (const to of REQUEST_STATUSES) {
        const pair = `${from}->${to}`;
        if (isAllowedTransition(from, to) && !permitted.has(pair)) unexpected.push(pair);
      }
    }

    expect(unexpected).toEqual([]);
  });

  it("reaches canceled from every nonterminal state", () => {
    // §13's "any nonterminal state -> canceled", written out per state rather
    // than applied as an exception at validation time.
    for (const status of REQUEST_STATUSES.filter((s) => !isTerminalStatus(s))) {
      expect(isAllowedTransition(status, "canceled")).toBe(true);
    }
  });

  it("refuses a status moving to itself", () => {
    /**
     * §13 lists no self-transition. Treating one as a harmless no-op is how a
     * double submission writes a second event for something that happened once —
     * the reasoning ATL-039 applied to refusing an already-closed finding.
     */
    for (const status of REQUEST_STATUSES) {
      expect(isAllowedTransition(status, status)).toBe(false);
    }
  });

  it("does not let a follow-up skip being sent again", () => {
    /**
     * `follow_up_due -> sent` exists because sending a follow-up records a new
     * `sent_at`; there is no direct `follow_up_due -> awaiting_response`, which
     * would claim a reply arrived without a message having gone out.
     */
    expect(isAllowedTransition("follow_up_due", "awaiting_response")).toBe(false);
    expect(isAllowedTransition("follow_up_due", "sent")).toBe(true);
  });

  it("cannot go back to draft once it has left", () => {
    // Nothing in §13 returns to `draft`. A sent request that became editable
    // again would let the record disagree with what the service received.
    for (const status of REQUEST_STATUSES) {
      expect(isAllowedTransition(status, "draft")).toBe(false);
    }
  });
});

describe("bounded metadata (D10)", () => {
  it("caps the external reference", () => {
    /**
     * A service's own case number is metadata, not prose. The cap is what keeps
     * "reference" from becoming a second notes field — which would be free text
     * in an unencrypted column.
     */
    expect(EXTERNAL_REFERENCE_MAX_LENGTH).toBe(120);
  });
});
