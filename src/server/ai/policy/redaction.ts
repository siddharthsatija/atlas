import { maskEmail, maskIdentifier, maskPhone } from "@/lib/formatting/mask";

/**
 * AI context redaction (ATL-049, security §10).
 *
 * ## Why this is not the telemetry redactor
 *
 * `src/lib/telemetry/redaction.ts` solves a different problem. It is an
 * allowlist for **log sinks**: unlisted keys are dropped, and what survives is
 * whatever an operator needs to debug. AI context has the opposite requirement —
 * it must *retain* meaning, because a finding stripped of its evidence explains
 * nothing — while removing the values a processor must never receive.
 *
 * Extending the telemetry policy to fit would have meant loosening it until it
 * stopped being the control it is. So this is a separate layer, reusing ATL-035's
 * masking helpers for the part that genuinely is shared: turning an identifier
 * into something recognisable without being disclosive.
 *
 * ## What is removed versus masked
 *
 * **Masked**, because the model needs to know a value of that shape exists:
 * emails, phone numbers, account identifiers. `alex@example.com` becomes
 * `a•••@example.com` — enough for "the account you registered with this address"
 * to make sense, not enough to be the address.
 *
 * **Removed entirely**, because no purpose needs them and their presence would
 * be a leak: anything matching a secret or token shape.
 *
 * Personal-field *values* never reach this layer at all. They are gated by
 * per-request approval upstream (ADR-002), and a redactor that could be relied
 * on to strip them would invite sending them and hoping.
 */

/**
 * Token-shaped strings, removed rather than masked.
 *
 * Deliberately broad: a false positive costs a few characters of context, a
 * false negative sends a credential to a third party.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\beyJ[A-Za-z0-9._-]{16,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
];

const EMAIL_PATTERN = /\b[^\s@]+@[^\s@.]+\.[^\s@]+\b/g;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;

/**
 * UUID shape, used to *exclude* matches from phone masking.
 *
 * A UUID is digits and hyphens, so `11111111-1111-1111-1111-111111111111`
 * satisfies the phone pattern exactly. Masking it would be a quiet catastrophe:
 * entity ids must appear in context verbatim, because ATL-050 rejects any
 * `evidenceReference` that was not in the context sent. A mangled id means the
 * model cannot cite anything valid, every explanation fails the invariant check,
 * and the surface falls back on every request.
 *
 * Found by a test rather than by reading — which is why the id path below is
 * also kept out of free-text redaction entirely.
 */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const SECRET_PLACEHOLDER = "[removed]";

/**
 * Redacts free text that is about to enter the context block.
 *
 * Order matters: secrets are removed before masking runs, so a token that
 * happens to contain an `@` cannot be partially preserved by the email masker.
 */
export function redactForContext(text: string): string {
  let output = text;

  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, SECRET_PLACEHOLDER);
  }

  output = output.replace(EMAIL_PATTERN, (match) => maskEmail(match));
  output = output.replace(PHONE_PATTERN, (match) =>
    UUID_SHAPE.test(match.trim()) ? match : maskPhone(match),
  );

  return output;
}

/**
 * Redacts a service account identifier.
 *
 * Separate from the free-text path because the whole value is an identifier —
 * running the free-text redactor over it would mask only the parts that happen
 * to look like an email or phone number.
 */
export function redactIdentifier(value: string): string {
  if (value.includes("@")) return maskEmail(value);
  return maskIdentifier(value);
}
