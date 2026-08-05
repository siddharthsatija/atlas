import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Envelope-encryption primitives (ATL-084, ADR-003).
 *
 * AES-256-GCM with a random 96-bit nonce per value and AAD bound to
 * `table.column:record_id`, so ciphertext cannot be moved between rows or
 * columns.
 *
 * ## Why this module holds no secrets
 *
 * Every function here takes its key material as an argument. It reads no
 * environment variable, opens no connection, and knows nothing about the current
 * request. That is deliberate on two counts:
 *
 *   1. It is the only way these tests run in the **unit** project on every pull
 *      request. A `server-only` marker would push them into the node project,
 *      and round-trip/tamper/wrong-key coverage is exactly what must not be
 *      gated behind a milestone.
 *   2. Secrets are supplied by `kek.ts` and `encryption-service.ts`, which *are*
 *      `server-only`. Key handling and key use are separate concerns, and only
 *      one of them needs to touch the environment.
 *
 * The module still lives under `src/server/`, which the ESLint layer boundaries
 * forbid `src/components` and `src/features` from importing, and a repository
 * guard asserts no client module reaches it.
 *
 * ## What never appears in an error
 *
 * Plaintext, ciphertext, key material, nonces, and record identifiers. Failures
 * carry a code from a closed set and nothing else — see `CryptoError`.
 */

/** AES-256 key length. */
export const KEY_BYTES = 32;

/** GCM standard nonce length. 96 bits is the size GCM is specified for. */
export const NONCE_BYTES = 12;

/** GCM authentication tag length. */
export const TAG_BYTES = 16;

/** Envelope format marker. A future format change bumps this rather than guessing. */
export const ENVELOPE_VERSION = "v1";

const ENVELOPE_PREFIX = "atlas";

/**
 * Closed set of failure reasons.
 *
 * Deliberately coarse where cryptography is coarse. GCM cannot distinguish a
 * wrong key from wrong AAD from a flipped ciphertext bit — all three are simply
 * "the tag did not verify" — and inventing a distinction would be a lie that also
 * leaks which guess an attacker got closer on. They collapse to
 * `integrity_failure`.
 */
export type CryptoFailureCode =
  /** The stored string is not a well-formed envelope. */
  | "invalid_envelope"
  /** The envelope is well-formed but from a format this build does not know. */
  | "unsupported_version"
  /** Authentication failed: wrong key, wrong AAD, or tampered ciphertext. */
  | "integrity_failure"
  /** Key material was the wrong size or otherwise unusable. */
  | "invalid_key"
  /** The AAD descriptor was incomplete, so no binding could be formed. */
  | "invalid_aad"
  /** The key row could not be read or created. Storage fault, not a crypto fault. */
  | "key_unavailable"
  /**
   * The user's DEK has been crypto-shredded.
   *
   * Distinct from `key_unavailable` because it is permanent and expected: after
   * account deletion the ciphertext is unreadable by design, and a caller that
   * treats it as a transient storage failure would retry forever.
   */
  | "key_destroyed";

/**
 * The only error this module throws.
 *
 * Carries a code and nothing else. `message` is the code, so even a caller that
 * logs `error.message` — which nothing should, but code drifts — discloses no
 * plaintext, ciphertext, or key material.
 */
export class CryptoError extends Error {
  override readonly name = "CryptoError";

  /**
   * Declared explicitly rather than as a constructor parameter property: the
   * latter is TypeScript-only syntax that Node's `--experimental-strip-types`
   * cannot erase, and this module must stay loadable by the repository's
   * plain-Node tooling.
   */
  readonly code: CryptoFailureCode;

  constructor(code: CryptoFailureCode) {
    super(code);
    this.code = code;
  }

  /** Keeps the code and nothing else if an error is ever serialised. */
  toJSON(): { name: string; code: CryptoFailureCode } {
    return { name: "CryptoError", code: this.code };
  }
}

/**
 * Identifies the exact cell a ciphertext belongs to.
 *
 * Passing the three parts separately rather than a pre-built string means a
 * caller cannot accidentally omit one and still produce a plausible-looking AAD.
 */
export interface EncryptionContext {
  table: string;
  column: string;
  recordId: string;
}

/**
 * Builds the AAD exactly as security §8 and ADR-003 specify:
 * `table.column:record_id`.
 *
 * Any missing or empty part is rejected rather than rendered as an empty
 * segment. `"assets.":"x"` and `"assets.col:"` would both be well-formed strings
 * that bind far less than they appear to.
 */
export function buildAad(context: EncryptionContext): Buffer {
  const { table, column, recordId } = context;

  for (const part of [table, column, recordId]) {
    if (typeof part !== "string" || part.trim().length === 0) {
      throw new CryptoError("invalid_aad");
    }
  }
  // Separators must not be forgeable from the parts themselves, or
  // `table="a.b"` could impersonate another column.
  if (table.includes(".") || table.includes(":") || column.includes(".") || column.includes(":")) {
    throw new CryptoError("invalid_aad");
  }

  return Buffer.from(`${table}.${column}:${recordId}`, "utf8");
}

/** Generates a fresh 256-bit data-encryption key. */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Best-effort overwrite of key material.
 *
 * Node offers no guarantee: the garbage collector may already have copied the
 * buffer, and V8 strings are immutable. Stated plainly rather than implied —
 * this narrows the window in which a heap dump yields a key, it does not close
 * it. Never rely on it as a control.
 */
export function zeroize(secret: Buffer): void {
  secret.fill(0);
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new CryptoError("invalid_key");
  }
}

/**
 * Encrypts one value.
 *
 * Returns `atlas.v1.<nonce>.<ciphertext+tag>`, base64url. The nonce is random per
 * call — never derived, never reused — because GCM nonce reuse under one key is
 * catastrophic, leaking the authentication subkey.
 */
export function seal(key: Buffer, plaintext: string, context: EncryptionContext): string {
  assertKey(key);
  const aad = buildAad(context);

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX,
    ENVELOPE_VERSION,
    nonce.toString("base64url"),
    Buffer.concat([ciphertext, tag]).toString("base64url"),
  ].join(".");
}

/**
 * Decrypts one value, or throws.
 *
 * Fail-closed throughout: there is no path that returns a partial result, a
 * placeholder, or the raw ciphertext when authentication fails. A caller that
 * wants to tolerate failure must catch, and must then decide what to show —
 * this module will not decide for it.
 */
export function open(key: Buffer, envelope: string, context: EncryptionContext): string {
  assertKey(key);
  const aad = buildAad(context);
  const { nonce, ciphertext, tag } = parseEnvelope(envelope);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The underlying error text is discarded on purpose: OpenSSL messages vary
    // by version and say nothing a caller may act on differently.
    throw new CryptoError("integrity_failure");
  }
}

interface ParsedEnvelope {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * Parses and validates the envelope shape before any key is used.
 *
 * Structural rejection happens first so a malformed value fails as
 * `invalid_envelope` rather than as an integrity failure, which would be
 * misleading during an incident: one means corrupted storage, the other means
 * tampering or the wrong key.
 */
function parseEnvelope(envelope: string): ParsedEnvelope {
  if (typeof envelope !== "string") throw new CryptoError("invalid_envelope");

  const parts = envelope.split(".");
  if (parts.length !== 4) throw new CryptoError("invalid_envelope");

  const [prefix, version, nonceB64, payloadB64] = parts as [string, string, string, string];
  if (prefix !== ENVELOPE_PREFIX) throw new CryptoError("invalid_envelope");
  if (version !== ENVELOPE_VERSION) throw new CryptoError("unsupported_version");

  const nonce = decodeBase64Url(nonceB64);
  const payload = decodeBase64Url(payloadB64);

  if (nonce.length !== NONCE_BYTES) throw new CryptoError("invalid_envelope");
  // A payload must hold at least the tag; an empty plaintext is legitimate.
  if (payload.length < TAG_BYTES) throw new CryptoError("invalid_envelope");

  return {
    nonce,
    ciphertext: payload.subarray(0, payload.length - TAG_BYTES),
    tag: payload.subarray(payload.length - TAG_BYTES),
  };
}

/**
 * Strict base64url decode.
 *
 * Node's decoder is lenient — it silently ignores characters it does not
 * recognise — so a round-trip comparison is used to reject anything that was not
 * exactly this encoding. Without it, `"!!!!"` decodes to empty rather than
 * failing.
 */
function decodeBase64Url(value: string): Buffer {
  if (value.length === 0) throw new CryptoError("invalid_envelope");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new CryptoError("invalid_envelope");
  return decoded;
}

/**
 * Wraps a DEK under the KEK.
 *
 * Wrapping is the same AES-256-GCM construction, with AAD binding the wrapped
 * key to the user and KEK generation that produced it. A wrapped DEK therefore
 * cannot be copied onto another user's key row: the AAD would not match, and the
 * unwrap would fail rather than silently hand back a usable key for the wrong
 * account.
 */
export function wrapDek(kek: Buffer, dek: Buffer, userId: string, kekVersion: number): string {
  assertKey(kek);
  assertKey(dek);

  return seal(kek, dek.toString("base64"), wrapContext(userId, kekVersion));
}

/** Unwraps a DEK. Throws `integrity_failure` if it was moved, altered, or is under a different KEK. */
export function unwrapDek(
  kek: Buffer,
  wrapped: string,
  userId: string,
  kekVersion: number,
): Buffer {
  assertKey(kek);

  const dek = Buffer.from(open(kek, wrapped, wrapContext(userId, kekVersion)), "base64");
  if (dek.length !== KEY_BYTES) throw new CryptoError("invalid_key");
  return dek;
}

/** AAD for a wrapped DEK: the key row's own table/column, bound to user and KEK generation. */
function wrapContext(userId: string, kekVersion: number): EncryptionContext {
  if (!Number.isInteger(kekVersion) || kekVersion <= 0) throw new CryptoError("invalid_aad");
  return {
    table: "user_encryption_keys",
    column: `wrapped_dek@${kekVersion}`,
    recordId: userId,
  };
}

/** Constant-time comparison, for tests and any future key-equality check. */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
