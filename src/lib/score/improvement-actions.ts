/**
 * Where a factor sends a user who wants to improve it (ATL-046, frontend §12).
 *
 * §12 asks the detail view for "actions that may improve the score", and
 * ATL-046's criterion is that they "deep-link to real flows". Both words matter:
 * *real* rules out anything M8 has not built, and *flows* rules out a link that
 * lands somewhere with nothing to do.
 *
 * ## A fixed map, not impact ranking
 *
 * Every factor maps to one existing destination, chosen once and stated here.
 * Ranking the six by how much each could move the score would mean deciding what
 * a user should do next from a number — and ADR-004's factors are weighted for
 * *scoring*, not for prioritising work. Atlas already has a surface whose whole
 * job is "what next": Privacy Insights, ordered by ATL-039's recommendation
 * rules. Two competing priority orders in one product is how they end up
 * disagreeing.
 *
 * ## Nothing here points at requests
 *
 * ADR-004's protective-actions factor credits completed data requests, and §7.7
 * specifies `data_requests` — but no migration creates it and `/requests` is
 * still a shell placeholder. A link there would be an action the user cannot
 * take, which is the ATL-005 rule this project has followed since: present and
 * visibly unavailable, or absent. Absent is right for a suggestion.
 *
 * Kept in `lib/` and exported so ATL-021's score card and ATL-047's chart reuse
 * the same mapping rather than each restating it.
 */

import type { ScoreFactorId } from "./score-config";

export interface ImprovementAction {
  /** An existing route. Never a placeholder, never a route that does not exist. */
  href: string;
  /** What the user would do there, in their own terms. */
  label: string;
  /** Why it would help this factor, stated without promising a number. */
  description: string;
}

/**
 * One destination per factor.
 *
 * `Record<ScoreFactorId, …>` rather than a partial map: adding a seventh factor
 * to `score-v1` would fail to compile until someone decided where it sends
 * people, which is the moment to decide it.
 */
export const IMPROVEMENT_ACTIONS: Record<ScoreFactorId, ImprovementAction> = {
  account_hygiene: {
    href: "/assets",
    label: "Review your services",
    description:
      "Confirming what a service still holds keeps your records current, and lets Atlas stop " +
      "treating them as stale.",
  },
  open_findings: {
    href: "/insights",
    label: "Work through your findings",
    description:
      "Resolving a finding clears its deduction once the underlying situation has actually " +
      "changed.",
  },
  data_sensitivity: {
    href: "/assets",
    label: "Review what your services hold",
    description:
      "Sensitive information recorded against a service you no longer use is exposure you may " +
      "be able to end.",
  },
  permission_exposure: {
    href: "/assets",
    label: "Check what your services can do",
    description:
      "Recording permissions lets Atlas include this factor at all, and revoking a broad one " +
      "narrows what a service can reach.",
  },
  protective_actions: {
    href: "/insights",
    label: "Work through your findings",
    description:
      "This factor credits findings you resolve yourself. Findings that clear on their own are " +
      "not counted here.",
  },
  verification_freshness: {
    href: "/assets",
    label: "Review your services",
    description: "A service you have not confirmed in over a year counts against this factor.",
  },
};

/** The action for a factor. Total by construction — every factor has one. */
export function improvementActionFor(factor: ScoreFactorId): ImprovementAction {
  return IMPROVEMENT_ACTIONS[factor];
}
