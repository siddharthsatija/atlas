/**
 * Disclosure content map (ATL-210, ADR-008 §3).
 *
 * Maps `(disclosureClass, disclosureContractVersion)` pairs to the notice
 * content shown before a first-disclosure acknowledgment. ATL-217 populates
 * this map for each concrete provider; ATL-210 ships it empty.
 *
 * ## Fail-closed when content is absent
 *
 * If a pair has no entry, `getDisclosureContent` returns null. The component
 * renders a placeholder but the acknowledgment button is disabled — ADR-008 §3
 * requires a truthful notice before transmission, and a missing entry means
 * no verified content exists yet. The user can cancel; they cannot acknowledge.
 *
 * ## Disclosure classes
 *
 * Declared in `@/lib/discovery/types` — a single source of truth shared by
 * this module and `server/discovery/provider-adapter.ts`. Re-exported here
 * so existing importers of `DisclosureClass` from this path continue to work.
 */

import type { DisclosureClass } from "./types";
export type { DisclosureClass } from "./types";

/**
 * The notice content for one `(disclosureClass, disclosureContractVersion)` pair.
 *
 * ADR-008 §3 mandates five elements for identifying_lookup providers:
 *   - what exact value will be transmitted
 *   - to whom (named provider)
 *   - for what purpose
 *   - a statement that the value leaves Atlas
 *   - a cancel option that does not affect stored data or standing consent
 *
 * `transmissionStatement` carries the "leaves Atlas" language; `notice` frames
 * the purpose and recipient. The exact value and field identity are injected at
 * render time rather than stored here (they vary per field, not per provider).
 */
export interface DisclosureContent {
  /** Short heading for the dialog. */
  readonly title: string;
  /**
   * Full notice body: names the provider, states the purpose, and frames the
   * legal basis per ADR-008 §3. Written by the provider team in ATL-217.
   */
  readonly notice: string;
  /**
   * The required ADR-008 §3 statement that the field value leaves Atlas.
   *
   * E.g. "Your email address will be transmitted to [Provider] over HTTPS."
   * Must be present and truthful for identifying_lookup; ATL-210 leaves
   * this field in the type but the map starts empty.
   */
  readonly transmissionStatement: string;
}

/**
 * Maps `${disclosureClass}:${disclosureContractVersion}` to notice content.
 *
 * Empty in ATL-210. ATL-217 registers entries for each concrete adapter.
 * Do not add placeholder entries here — absence is how the fail-closed gate
 * knows to disable the acknowledgment button.
 */
const DISCLOSURE_CONTENT_MAP: ReadonlyMap<string, DisclosureContent> = new Map();

/**
 * Looks up notice content for one `(disclosureClass, disclosureContractVersion)` pair.
 *
 * Returns null when no entry exists. Callers must treat null as "not yet
 * registered" and render a placeholder with acknowledgment disabled (fail-closed).
 */
export function getDisclosureContent(
  disclosureClass: DisclosureClass,
  disclosureContractVersion: string,
): DisclosureContent | null {
  return DISCLOSURE_CONTENT_MAP.get(`${disclosureClass}:${disclosureContractVersion}`) ?? null;
}
