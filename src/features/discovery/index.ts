/**
 * Public API for the discovery feature (ATL-210).
 */

// View models
export type {
  DiscoveryProviderView,
  DiscoveryConsentState,
  DiscoveryAcknowledgmentView,
  DiscoveryRunStatus,
  DiscoveryConsentActionState,
  DisclosureAcknowledgmentActionState,
} from "./discovery-view";
export {
  INITIAL_DISCOVERY_CONSENT_ACTION_STATE,
  INITIAL_DISCLOSURE_ACK_ACTION_STATE,
} from "./discovery-view";

// Components
export { DiscoverySection } from "./discovery-section";
export type { DiscoverySectionProps } from "./discovery-section";

export { DiscoveryConsentSection } from "./discovery-consent-section";
export type { DiscoveryConsentSectionProps } from "./discovery-consent-section";

export { DiscoveryConsentNotice } from "./discovery-consent-notice";
export type {
  DiscoveryConsentNoticeProps,
  DiscoveryConsentGrantAction,
  DiscoveryConsentRevokeAction,
} from "./discovery-consent-notice";

export { FirstDisclosureDialog } from "./first-disclosure-dialog";
export type {
  FirstDisclosureDialogProps,
  DisclosureAcknowledgmentAction,
} from "./first-disclosure-dialog";

export {
  DiscoveryRunStatusBadge,
  DiscoveryRunStatusRow,
  DiscoveryRunStatusPanel,
} from "./discovery-run-status";
export type {
  DiscoveryRunStatusBadgeProps,
  DiscoveryRunStatusRowProps,
} from "./discovery-run-status";

// ATL-211: candidate adjudication
export type {
  CandidateReviewItem,
  AggregatorEvidenceItem,
  AdjudicationActionState,
  AdjudicationOutcome,
} from "./candidate-view";
export { INITIAL_ADJUDICATION_ACTION_STATE } from "./candidate-view";

export { CandidateCard } from "./candidate-card";
export type { CandidateCardProps, BoundAdjudicationAction } from "./candidate-card";

export { CandidateReviewSection } from "./candidate-review-section";
export type {
  CandidateReviewSectionProps,
  AdjudicationActionFactory,
} from "./candidate-review-section";
