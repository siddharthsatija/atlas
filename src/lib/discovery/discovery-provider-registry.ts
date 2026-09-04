/**
 * Discovery provider registry (ATL-210, ATL-217).
 *
 * The central registry of metadata about active discovery providers. ATL-210
 * ships it empty; ATL-217 populates it with a concrete entry for each provider
 * adapter that is ready for production dispatch.
 *
 * ## Why a registry, not runtime registration
 *
 * Discovery consent surfaces (onboarding, Settings > Discovery) need to know
 * what providers exist before any dispatch occurs. Runtime registration via a
 * mutable array would let an adapter's import side-effect alter the set during
 * a request, making the list non-deterministic. A module-level constant is
 * evaluated once per process and read many times — no mutation path.
 *
 * ## `discovery_connected_sources` deferred (ADR-008 §11)
 *
 * No provider may be registered with `consentType = "discovery_connected_sources"`
 * until ATL-212 implements the OAuth flows that type requires. The registry type
 * system does not block it, but the surfaces exclude it at render time.
 */

import type { DiscoveryConsentType } from "@/lib/consent";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import type { DisclosureClass } from "./types";

/**
 * The static metadata for one discovery provider adapter.
 *
 * Mirrors all `readonly` fields of `DiscoveryProviderAdapter` in
 * `server/discovery/provider-adapter.ts`, excluding `query()`. Structural
 * compatibility is maintained intentionally — a concrete adapter object satisfies
 * this interface, so registration is a no-op cast.
 */
export interface DiscoveryProviderMetadata {
  readonly providerClass: string;
  readonly consentType: DiscoveryConsentType;
  readonly disclosureClass: DisclosureClass;
  readonly disclosureContractVersion: string;
  readonly eligibleFieldTypes: ReadonlySet<PersonalFieldKey>;
}

/**
 * The list of active discovery providers.
 *
 * Empty in ATL-210. ATL-217 adds entries here for each production-ready
 * provider adapter. When this list is empty, the discovery consent section
 * in onboarding and Settings > Discovery are hidden entirely.
 */
export const ACTIVE_DISCOVERY_PROVIDERS: readonly DiscoveryProviderMetadata[] = [];

/**
 * Returns the subset of ACTIVE_DISCOVERY_PROVIDERS that the consent UI should
 * render — all providers whose consent type is NOT `discovery_connected_sources`.
 *
 * `discovery_connected_sources` is deferred to ATL-212 (OAuth flows not yet built).
 * Even if an adapter with that type were registered, it must not appear in the UI.
 */
export function getUiVisibleProviders(): readonly DiscoveryProviderMetadata[] {
  return ACTIVE_DISCOVERY_PROVIDERS.filter((p) => p.consentType !== "discovery_connected_sources");
}

/**
 * Returns only the providers whose `consentType` matches the given type.
 */
export function getActiveProvidersForConsentType(
  consentType: Exclude<DiscoveryConsentType, "discovery_connected_sources">,
): readonly DiscoveryProviderMetadata[] {
  return ACTIVE_DISCOVERY_PROVIDERS.filter((p) => p.consentType === consentType);
}
