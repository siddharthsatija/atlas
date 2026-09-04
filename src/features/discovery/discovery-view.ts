/**
 * View models for the discovery feature (ATL-210).
 *
 * Declared in the feature rather than imported from `server/` or `app/` —
 * a feature does not reach into those layers. The server page resolves data
 * and maps it to these shapes before passing it to feature components.
 *
 * ## Discovery consent types
 *
 * `discovery_connected_sources` is deliberately excluded from all UI surfaces
 * in ATL-210 (ADR-008 §11). Any runtime filtering of that type is in the page
 * and action layers; these types represent what the UI actually renders.
 */

import type { DiscoveryConsentType } from "@/lib/consent";
import type { DisclosureClass } from "@/lib/discovery/types";

/**
 * One active discovery provider as the consent UI renders it.
 */
export interface DiscoveryProviderView {
  readonly providerClass: string;
  readonly consentType: DiscoveryConsentType;
  readonly disclosureClass: DisclosureClass;
  readonly disclosureContractVersion: string;
}

/**
 * The consent state for one discovery consent type.
 */
export interface DiscoveryConsentState {
  readonly consentType: DiscoveryConsentType;
  readonly granted: boolean;
  /** ISO timestamp of the most recent grant, null if not granted. */
  readonly grantedAt: string | null;
}

/**
 * One first-disclosure acknowledgment as Settings > Discovery renders it.
 */
export interface DiscoveryAcknowledgmentView {
  readonly fieldId: string;
  readonly fieldLabel: string;
  readonly maskedValue: string;
  readonly providerClass: string;
  readonly disclosureContractVersion: string;
  /** ISO timestamp when the acknowledgment was recorded. */
  readonly acknowledgedAt: string;
}

/**
 * The six possible states of one discovery run (ATL-210 §3, ADR-008 §10).
 */
export type DiscoveryRunStatus =
  "running" | "completed_candidates" | "completed_zero" | "partial" | "blocked" | "failed";

/**
 * Result shape for a grant/revoke consent action.
 */
export interface DiscoveryConsentActionState {
  readonly failure: "unavailable" | null;
  readonly attempt: number;
}

export const INITIAL_DISCOVERY_CONSENT_ACTION_STATE: DiscoveryConsentActionState = {
  failure: null,
  attempt: 0,
};

/**
 * Result shape for a first-disclosure acknowledgment action.
 */
export interface DisclosureAcknowledgmentActionState {
  readonly failure: "unavailable" | null;
  readonly attempt: number;
}

export const INITIAL_DISCLOSURE_ACK_ACTION_STATE: DisclosureAcknowledgmentActionState = {
  failure: null,
  attempt: 0,
};
