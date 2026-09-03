import "server-only";

import { createHmac } from "node:crypto";
import type { RejectionKey } from "@/server/crypto/rejection-key-service";

/**
 * Shared rejection-fingerprint builder (ATL-208, ADR-008 §5).
 *
 * Extracted from `hibp-result-writer.ts` so the adjudication service can
 * build fingerprints for any provider, not just HIBP.
 *
 * ## HMAC input
 *
 * `provider_class + NUL + source_identifier` — the NUL byte is the separator
 * used by the original HIBP implementation and must be preserved for
 * fingerprint compatibility across rotations and provider classes.
 *
 * ## Output format
 *
 * `{"v":1,"alg":"hmac-sha256","value":"<base64url>"}` — the ADR-008 §5
 * envelope stored verbatim in `discovery_rejections.fingerprint`.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * The fingerprint value must never appear in logs. The function is pure and
 * does not log; callers must enforce the same constraint.
 */
export function buildRejectionFingerprint(
  key: RejectionKey,
  providerClass: string,
  sourceIdentifier: string,
): string {
  const hmacInput = `${providerClass}\x00${sourceIdentifier}`;
  const value = createHmac("sha256", key).update(hmacInput).digest("base64url");
  return JSON.stringify({ v: 1, alg: "hmac-sha256", value });
}
