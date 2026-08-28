import "server-only";

import type { DiscoveryConsentType } from "@/lib/consent";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import type { DiscoveryEligibleField } from "@/server/personal-fields/personal-field-service";

/**
 * The outbound adapter contract for a discovery provider (ATL-206, ADR-008 §4).
 *
 * A concrete adapter implements this interface for each provider class. The
 * dispatch engine holds no direct dependency on any adapter — it receives one
 * at call time and accesses it only through this contract.
 *
 * ## Responsibility boundary
 *
 * The adapter is responsible for the HTTP call and for translating the HTTP
 * response into a `ProviderQueryResult`. The dispatch engine is responsible for
 * all pre-call authorization checks. Neither side reaches into the other.
 *
 * ## Adapter immutability
 *
 * All properties are `readonly`. The dispatch engine reads them but never
 * writes them. A provider adapter that mutated its own `providerClass` or
 * `consentType` mid-dispatch would silently invalidate every binding check
 * that ran before the mutation.
 */

/**
 * Disclosure classification (ADR-008 §2, table 1).
 *
 * Describes how identity data crosses the outbound boundary. Used in audit
 * context for `discovery.provider.invoked` (ATL-206).
 *
 * - `hashed_query`: a partial hash is transmitted; the raw value never leaves
 *   Atlas (e.g. HIBP k-anonymity prefix lookup).
 * - `identifying_lookup`: the plaintext handle or value is transmitted to a
 *   third-party API (e.g. username enumeration against a platform API).
 * - `broker_query`: the value is submitted to a data-broker service.
 */
export type DisclosureClass = "hashed_query" | "identifying_lookup" | "broker_query";

/**
 * The result of one provider HTTP call.
 *
 * `success` carries the raw provider response as `data: unknown`. The dispatch
 * engine does not interpret provider payloads — interpretation is the candidate
 * writer's responsibility (ATL-207/ATL-208).
 *
 * `rate_limited` and `error` are transport-level outcomes that the adapter
 * translates from the HTTP response. The adapter must never throw — all
 * transport failures must be returned as `error` or `rate_limited`.
 */
export type ProviderQueryResult =
  | { status: "success"; data: unknown }
  | { status: "rate_limited" }
  | { status: "error"; errorCode: string };

/**
 * The contract every concrete discovery provider adapter must satisfy.
 *
 * Implemented once per provider class. The dispatch engine calls `query` only
 * after all eight authorization checks have passed and all authorized fields
 * have been decrypted.
 */
export interface DiscoveryProviderAdapter {
  /**
   * Identifies this provider class.
   *
   * Must match the `provider_class` column in `discovery_provider_invocations`
   * for any invocation the adapter is asked to dispatch. Checked against both
   * the invocation row and the `ConsentProof` in checks 3 of the eight-check
   * sequence.
   */
  readonly providerClass: string;

  /**
   * The discovery consent type this provider requires.
   *
   * The dispatch engine checks this against `consentProof.consentType` (check
   * 4) and verifies live consent for this type (check 5). A provider that
   * requires `discovery_identifying` consent cannot dispatch under a proof
   * scoped to `discovery_hashed_query`.
   */
  readonly consentType: DiscoveryConsentType;

  /**
   * How identity data crosses the outbound boundary for this provider.
   *
   * Stored in the `discovery.provider.invoked` audit context (ADR-008 §4).
   * The dispatch engine reads this value but does not interpret it.
   */
  readonly disclosureClass: DisclosureClass;

  /**
   * The disclosure contract version this adapter implements.
   *
   * Used in check 8 (`hasAcknowledged`). The adapter declares the version it
   * honours; the dispatcher supplies it to the acknowledgment repository.
   * Changing this version requires that users re-acknowledge before the adapter
   * can be dispatched.
   */
  readonly disclosureContractVersion: string;

  /**
   * The `PersonalFieldKey` values this adapter can process.
   *
   * Declarative rather than a method: the dispatcher uses `.has()` to check
   * eligibility (check 7c), so no adapter call is made during the check and
   * the eligible set cannot change between checks. Any field whose live type is
   * not in this set causes the dispatch to block with `field.type_ineligible`.
   */
  readonly eligibleFieldTypes: ReadonlySet<PersonalFieldKey>;

  /**
   * Executes the provider query with the authorized, decrypted fields.
   *
   * Called only after all eight authorization checks have passed and every
   * mapped field has been decrypted via `PersonalFieldService.getDiscoveryEligibleFields`.
   * `authorizedFields` is the intersection of: the invocation's field mapping,
   * currently-eligible fields (`include_in_discovery = true`), and fields whose
   * `fieldKey` is in `eligibleFieldTypes`.
   *
   * Must never throw — transport and provider errors must be captured and
   * returned as `{ status: "error", errorCode }` or `{ status: "rate_limited" }`.
   * An unhandled throw would leave the invocation without a terminal state.
   */
  query(authorizedFields: readonly DiscoveryEligibleField[]): Promise<ProviderQueryResult>;
}
