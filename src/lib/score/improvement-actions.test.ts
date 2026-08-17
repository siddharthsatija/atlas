import { describe, expect, it } from "vitest";
import { IMPROVEMENT_ACTIONS, improvementActionFor } from "./improvement-actions";
import { SCORE_FACTORS } from "./score-config";

/**
 * ATL-046 — where each factor sends a user.
 *
 * ATL-046's criterion is that improvement actions "deep-link to real flows", and
 * the failure mode is silent: a link to a route that does not exist, or to a
 * surface with nothing to do, looks perfectly fine in a screenshot.
 */

/** Routes that exist and have something on them today. */
const REAL_ROUTES = new Set(["/assets", "/insights"]);

describe("every factor has a destination", () => {
  it.each(SCORE_FACTORS.map((factor) => factor.id))("maps %s", (id) => {
    expect(improvementActionFor(id)).toBeDefined();
  });

  it("covers the whole model and nothing else", () => {
    expect(Object.keys(IMPROVEMENT_ACTIONS).sort()).toEqual(
      SCORE_FACTORS.map((factor) => factor.id).sort(),
    );
  });
});

describe("every destination is real", () => {
  it.each(Object.entries(IMPROVEMENT_ACTIONS))("%s points at a built route", (_id, action) => {
    expect(REAL_ROUTES.has(action.href)).toBe(true);
  });

  it("never links to requests", () => {
    /**
     * ADR-004 credits completed data requests, but §7.7's `data_requests` has no
     * migration and `/requests` is a shell placeholder. A suggestion the user
     * cannot act on is worse than no suggestion.
     */
    for (const action of Object.values(IMPROVEMENT_ACTIONS)) {
      expect(action.href).not.toMatch(/request/i);
    }
  });

  it("sends finding-related factors to Insights and record-related ones to Assets", () => {
    expect(improvementActionFor("open_findings").href).toBe("/insights");
    expect(improvementActionFor("protective_actions").href).toBe("/insights");
    expect(improvementActionFor("account_hygiene").href).toBe("/assets");
    expect(improvementActionFor("data_sensitivity").href).toBe("/assets");
    expect(improvementActionFor("permission_exposure").href).toBe("/assets");
    expect(improvementActionFor("verification_freshness").href).toBe("/assets");
  });
});

describe("what the actions say", () => {
  it("gives each one a label and an explanation", () => {
    for (const action of Object.values(IMPROVEMENT_ACTIONS)) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
    }
  });

  it("promises no specific improvement", () => {
    // The score is a guide. "Raise your score by 10" would be a guarantee the
    // model cannot make, since every factor is renormalised against the others.
    for (const action of Object.values(IMPROVEMENT_ACTIONS)) {
      expect(action.description).not.toMatch(/\bby \d+\b|guarantee|will raise|will improve/i);
    }
  });

  it("says plainly that automatic resolutions earn nothing", () => {
    expect(improvementActionFor("protective_actions").description).toMatch(/on their own|automat/i);
  });
});
