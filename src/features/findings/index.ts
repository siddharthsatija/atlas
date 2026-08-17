/**
 * Public surface of the findings feature (ATL-040).
 *
 * The ESLint boundary rule restricts deep imports into a feature — its internals
 * are its own. Everything the route needs is re-exported here, so the module
 * layout inside this folder can change without touching a caller.
 */

/**
 * `FindingAssistant` is exported because a second surface renders it (ATL-054).
 *
 * The asset page uses the same component, given its own copy and its own action.
 * It stays in this folder rather than moving: the boundary rule exists so a
 * feature's *internals* cannot be reached into, and re-exporting here is the
 * sanctioned way to make one part of a feature public. Promoting it to `lib/` or
 * `components/ui` would be wrong on both counts — it holds request state and is
 * not a presentational primitive.
 *
 * The name still says "finding" because ATL-053 built it and renaming it would
 * churn every slot and selector for no behavioural gain. Its props do not: they
 * were renamed to `subjectId` and `request` when the second caller arrived.
 */
export { FindingAssistant, type FindingAssistantProps } from "./finding-assistant";
export { FindingCard, type FindingSummary, type FindingCardProps } from "./finding-card";
export { FindingDetail, type FindingDetailProps, type FindingDetailView } from "./finding-detail";
export { FindingList, FindingViewNav, type FindingViewsProps } from "./finding-views";
export {
  FindingsAllEmptyState,
  FindingsDismissedEmptyState,
  FindingsFirstRunEmptyState,
  FindingsRecommendedEmptyState,
  FindingsResolvedEmptyState,
} from "./finding-empty-states";
