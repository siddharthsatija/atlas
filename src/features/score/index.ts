/**
 * Public surface of the score feature (ATL-046).
 *
 * The ESLint boundary rule restricts deep imports into a feature, so everything
 * the route needs is re-exported here and the layout inside this folder stays
 * its own business.
 */

export { ScoreSummary, type ScoreSummaryProps } from "./score-summary";
export {
  ScoreBreakdown,
  contributors,
  type ScoreBreakdownProps,
  type ScoreFactorView,
} from "./score-breakdown";
export { ScoreChart, type ScoreChartProps } from "./score-chart";
export { ScoreHistory, type ScoreHistoryProps } from "./score-history";
export { ScoreLimitations } from "./score-limitations";
