/**
 * Identifier masking (ATL-069, security §8: "Mask identifiers by default").
 *
 * The first server-side masking in Atlas. `SensitiveValue` (ATL-009) has always
 * required its caller to pass an already-masked string — this is what produces
 * it, and the output format matches the examples that component documents
 * (`••••••@example.com`, `····4821`) so a value masked here renders correctly
 * there without translation.
 *
 * In `lib/` because both the activity writer (server) and any future surface
 * that renders a masked value need it, and the layer boundaries stop components
 * importing `src/server`.
 *
 * ## Masking is not redaction
 *
 * Redaction (ATL-085) removes a value. Masking keeps enough of it to be
 * *recognisable to the person it belongs to* while useless to anyone else — a
 * user reading their timeline should be able to tell which of their two email
 * addresses a request went to. That is the whole reason ATL-069 permits "masked
 * identifiers at most" in summaries rather than banning identifiers outright.
 *
 * ## Everything here is lossy on purpose
 *
 * No function returns enough to reconstruct the input. A mask that preserved,
 * say, the full local part of an email would be a redaction failure wearing a
 * disguise, so the retained characters are deliberately few and fixed.
 */

/**
 * The mask character used throughout, matching `SensitiveValue`'s examples.
 *
 * Exported because callers need to *verify* a value was masked, not only
 * produce one: a masked email still looks like an email to a pattern scanner,
 * so the presence of this character is how a masked value is told apart from an
 * unmasked one (ATL-069).
 */
export const MASK_CHAR = "•";

const DOT = MASK_CHAR;

/** What a value masks to when nothing meaningful can be retained. */
const OPAQUE = DOT.repeat(6);

/**
 * Masks an email address as `d••••a@example.com`.
 *
 * The domain is kept in full: it is rarely identifying on its own, and it is the
 * part that makes a timeline entry legible ("you contacted Acme"). The local
 * part keeps only its first and last character, which is enough for the owner to
 * distinguish their own addresses and not enough for anyone else to guess one.
 *
 * A local part of one or two characters keeps nothing — retaining "both ends" of
 * a two-character string would return it verbatim.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return OPAQUE;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  if (local.length <= 2) return `${DOT.repeat(4)}@${domain}`;

  return `${local[0]}${DOT.repeat(4)}${local[local.length - 1]}@${domain}`;
}

/**
 * Masks a phone number as `••••4821`, keeping the last four digits.
 *
 * Last four is the convention people are used to from banks and carriers, and it
 * is what lets someone recognise their own number. Non-digits are discarded
 * before masking so `+1 (415) 555-4821` and `14155554821` mask identically —
 * otherwise the same number could appear two different ways in one timeline.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return OPAQUE;

  return `${DOT.repeat(4)}${digits.slice(-4)}`;
}

/**
 * Masks an opaque account identifier as `····4821`, keeping the last four.
 *
 * Used for handles, member numbers, and anything else that is neither an email
 * nor a phone number. Short values mask entirely rather than partially: keeping
 * the last four of a five-character identifier reveals almost all of it.
 */
export function maskIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 8) return OPAQUE;

  return `${DOT.repeat(4)}${trimmed.slice(-4)}`;
}

/**
 * Masks a value by detecting what it is.
 *
 * For callers that hold an identifier without knowing its kind. Detection is
 * deliberately conservative: anything unrecognised is masked **opaquely** rather
 * than passed through, so a value this function fails to classify still cannot
 * leak. Failing the other way — returning the input when unsure — would make the
 * safe-looking call the dangerous one.
 */
export function maskValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return OPAQUE;

  if (trimmed.includes("@")) return maskEmail(trimmed);

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7 && digits.length / trimmed.length > 0.5) return maskPhone(trimmed);

  return maskIdentifier(trimmed);
}
