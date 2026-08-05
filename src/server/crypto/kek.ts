import "server-only";

import { env } from "@/config/env";
import { CryptoError, KEY_BYTES } from "./envelope";

/**
 * Key-encryption key resolution (ATL-084, ADR-003).
 *
 * One KEK per environment, held in managed secret storage and reaching the
 * process only through `ATLAS_KEK`. This module is the single place it is
 * decoded, and it is `server-only` so the import fails the build if anything
 * client-reachable ever pulls it in.
 *
 * The KEK is never returned to callers as a string, never placed on an error,
 * and never logged. `env.ts` already guarantees it is 32 bytes of base64 at boot
 * (`base64Key(32, "ATLAS_KEK")`), and the environment-isolation rules guarantee
 * it differs from `AUDIT_HMAC_KEY` and is not a placeholder in hosted
 * environments.
 *
 * ## Why a previous generation exists
 *
 * KEK rotation re-wraps every DEK, and that sweep is not instantaneous. Between
 * the moment a new KEK is deployed and the moment the last DEK is re-wrapped,
 * rows exist under both generations. Without the previous KEK in the process,
 * every un-swept user would be locked out of their own data mid-rotation — so
 * the optional `ATLAS_KEK_PREVIOUS` pair is what makes the documented rotation
 * procedure actually survivable rather than a flag day.
 */

export interface KekGeneration {
  version: number;
  key: Buffer;
}

/** Decodes base64 key material, rejecting anything not exactly 32 bytes. */
function decodeKek(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) throw new CryptoError("invalid_key");
  return key;
}

/** The generation new DEKs are wrapped under, and that rotation re-wraps toward. */
export function currentKek(): KekGeneration {
  return { version: env.ATLAS_KEK_VERSION, key: decodeKek(env.ATLAS_KEK) };
}

/** The superseded generation, present only while a rotation is in flight. */
export function previousKek(): KekGeneration | null {
  if (!env.ATLAS_KEK_PREVIOUS || env.ATLAS_KEK_PREVIOUS_VERSION === undefined) return null;
  return {
    version: env.ATLAS_KEK_PREVIOUS_VERSION,
    key: decodeKek(env.ATLAS_KEK_PREVIOUS),
  };
}

/**
 * Selects the KEK that wrapped a given DEK.
 *
 * Fails closed on an unknown version. The alternative — trying every KEK in turn
 * — would work, but it turns a configuration error into a silent success and
 * removes the signal that a rotation was rolled back or a version was skipped.
 */
export function kekForVersion(version: number): Buffer {
  const current = currentKek();
  if (version === current.version) return current.key;

  const previous = previousKek();
  if (previous && version === previous.version) return previous.key;

  throw new CryptoError("invalid_key");
}
