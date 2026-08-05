/**
 * The central redaction utility (ATL-085).
 *
 * Security §T4 names exactly one control for sensitive data reaching logs: a
 * *central* redaction utility with allowlisted telemetry fields. Every logging,
 * monitoring, and analytics path routes through this module, and the ESLint
 * rules added with this ticket make bypassing it a lint failure rather than a
 * code-review question.
 *
 * ## Allowlist, not denylist
 *
 * A key survives only if the policy names it. This is the one decision here that
 * is not a matter of taste: a denylist has to anticipate the field somebody adds
 * next year, and the cost of guessing wrong is personal data sitting in a
 * third-party system, discovered late and difficult to unwind. An allowlist
 * fails the other way — a new field is silently missing until someone adds it,
 * which is a bug report rather than a breach.
 *
 * ## Two independent layers
 *
 * 1. **Structural.** The policy names each permitted key and the shape its value
 *    must have. A value that fails its shape check is removed, not coerced: a
 *    half-repaired identifier is still a correlation handle.
 * 2. **Pattern scrubbing.** Allowlisted string values are additionally scanned
 *    for emails, phone numbers, and credentials, and matches are replaced.
 *
 * The second layer is defense in depth, and the acceptance criteria ask for it
 * explicitly. It exists because the structural layer trusts a *shape*, and some
 * shapes are permissive enough to smuggle a value through — a free-ish text
 * field that a future caller populates from user input, for instance. Neither
 * layer is sufficient alone; the structural one cannot see inside a permitted
 * string, and the pattern one cannot know that `userId` should never be sent.
 *
 * ## Why scrubbing is deliberately conservative
 *
 * An earlier, narrower version of this logic in `monitoring-event.ts` carried a
 * generic "looks like a phone number" pattern — `\+?\d[\d\s().-]{7,}\d` — which
 * matches `2026-07-30T09:15:00.000Z`. Every event silently lost its timestamp.
 * That is the characteristic failure of resemblance-based matching: it is
 * invisible, it destroys good data, and it inspires the exact wrong fix
 * (loosening the pattern until the leak returns).
 *
 * The patterns below are therefore anchored to formats humans actually write
 * phone numbers in, and the regression is pinned by a test. Recall is
 * intentionally traded for precision, because the structural allowlist — not
 * this layer — is what the guarantee rests on.
 */

/** Replacement for a scrubbed span. Fixed so tests and log readers can spot it. */
export const REDACTED = "[redacted]";

/**
 * Guard rails against pathological input.
 *
 * A log payload is not a document. These caps mean a deeply nested or enormous
 * object degrades into a truncated log line rather than blocking the event loop
 * or filling a collector, and they bound the work an attacker can cause by
 * controlling a value that ends up in telemetry.
 */
export const MAX_DEPTH = 8;
export const MAX_STRING_LENGTH = 2048;
export const MAX_ARRAY_LENGTH = 64;

/**
 * A rule describing one permitted field.
 *
 * `scalar` covers strings, numbers, booleans, and null. `validate` is optional:
 * when a caller knows the exact shape (as monitoring does) it produces a much
 * stronger guarantee than pattern scrubbing alone, so it is always preferred
 * where the shape is knowable.
 */
export type FieldRule =
  | { readonly kind: "scalar"; readonly validate?: (value: unknown) => boolean }
  | { readonly kind: "object"; readonly fields: FieldPolicy }
  | { readonly kind: "array"; readonly items: FieldRule };

export type FieldPolicy = Readonly<Record<string, FieldRule>>;

/** Convenience constructors — they read better than object literals at call sites. */
export const scalar = (validate?: (value: unknown) => boolean): FieldRule =>
  validate ? { kind: "scalar", validate } : { kind: "scalar" };
export const object = (fields: FieldPolicy): FieldRule => ({ kind: "object", fields });
export const array = (items: FieldRule): FieldRule => ({ kind: "array", items });

export interface RedactionOutcome<T = Record<string, unknown>> {
  /** The payload, containing only what survived. */
  value: T;
  /** Dotted paths removed because the policy does not name them. */
  droppedKeys: string[];
  /**
   * Dotted paths whose value was removed or altered — a failed shape check, a
   * scrubbed pattern, a truncation, or a cap being hit.
   */
  redactedKeys: string[];
}

/**
 * Restricted patterns, scanned inside every permitted string.
 *
 * Ordering matters: credentials are scrubbed before the generic long-run rule so
 * a JWT is reported as a credential rather than as an opaque blob.
 */
const RESTRICTED_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  // Email. Safe to match generously — no structured value Atlas logs contains
  // an `@` between two word runs.
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },

  // JWTs and bearer credentials.
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "bearer", pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g },

  // Common secret prefixes (Supabase, Stripe, GitHub, OpenAI, Slack).
  {
    name: "keyed-secret",
    pattern: /\b(?:sb|sk|pk|rk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  },

  /**
   * Phone numbers, anchored to formats people actually write.
   *
   * Each alternative requires punctuation or a leading `+` that an ISO instant,
   * a version string, or an integer does not have. The regression test pins
   * `2026-07-30T09:15:00.000Z` specifically.
   */
  {
    name: "phone",
    pattern:
      /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)|\+\d{10,15}\b/g,
  },
];

/**
 * Scrubs restricted patterns out of one string.
 *
 * Returns the original reference when nothing matched, so the caller can tell
 * "clean" from "cleaned" by identity rather than by comparing content.
 */
export function scrubString(input: string): { value: string; scrubbed: boolean } {
  let out = input;

  for (const { pattern } of RESTRICTED_PATTERNS) {
    // `lastIndex` is per-regex state on a `g` pattern shared across calls.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }

  return out === input ? { value: input, scrubbed: false } : { value: out, scrubbed: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Context {
  droppedKeys: string[];
  redactedKeys: string[];
  /** Cycle protection. An object already on the current path is not descended into. */
  seen: WeakSet<object>;
}

function path(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/**
 * Applies one rule to one value. Returns `undefined` when the value cannot be
 * kept, having already recorded why.
 */
function applyRule(
  rule: FieldRule,
  value: unknown,
  at: string,
  ctx: Context,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    ctx.redactedKeys.push(at);
    return undefined;
  }

  if (rule.kind === "object") {
    if (!isPlainRecord(value)) {
      ctx.redactedKeys.push(at);
      return undefined;
    }
    return walk(value, rule.fields, at, ctx, depth);
  }

  if (rule.kind === "array") {
    if (!Array.isArray(value)) {
      ctx.redactedKeys.push(at);
      return undefined;
    }
    if (ctx.seen.has(value)) {
      ctx.redactedKeys.push(at);
      return undefined;
    }
    ctx.seen.add(value);

    const capped = value.slice(0, MAX_ARRAY_LENGTH);
    if (capped.length < value.length) ctx.redactedKeys.push(at);

    const items: unknown[] = [];
    for (const [index, item] of capped.entries()) {
      const kept = applyRule(rule.items, item, `${at}[${index}]`, ctx, depth + 1);
      // Holes would change the meaning of positions, so a rejected element is
      // omitted and the removal is already recorded against its own path.
      if (kept !== undefined) items.push(kept);
    }
    ctx.seen.delete(value);
    return items;
  }

  // scalar
  if (rule.validate && !rule.validate(value)) {
    ctx.redactedKeys.push(at);
    return undefined;
  }

  if (typeof value === "string") {
    let next = value;

    if (next.length > MAX_STRING_LENGTH) {
      next = next.slice(0, MAX_STRING_LENGTH);
      ctx.redactedKeys.push(at);
    }

    const { value: scrubbed, scrubbed: didScrub } = scrubString(next);
    if (didScrub) ctx.redactedKeys.push(at);
    return scrubbed;
  }

  if (typeof value === "number") {
    // NaN and Infinity do not survive JSON and would arrive at a collector as
    // `null`, which reads as "absent" rather than "broken".
    if (!Number.isFinite(value)) {
      ctx.redactedKeys.push(at);
      return undefined;
    }
    return value;
  }

  if (typeof value === "boolean" || value === null) return value;

  // Functions, symbols, bigints, undefined, class instances — nothing that
  // belongs in a log line, and each serialises unpredictably.
  ctx.redactedKeys.push(at);
  return undefined;
}

function walk(
  source: Record<string, unknown>,
  policy: FieldPolicy,
  prefix: string,
  ctx: Context,
  depth: number,
): Record<string, unknown> {
  if (ctx.seen.has(source)) {
    ctx.redactedKeys.push(prefix);
    return {};
  }
  ctx.seen.add(source);

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    const at = path(prefix, key);
    const rule = policy[key];

    if (!rule) {
      // Not named by the policy. Dropped whatever it holds, and counted — the
      // count is what lets a team notice a caller trying to log something new
      // without having to read every payload.
      ctx.droppedKeys.push(at);
      continue;
    }

    // An explicitly-undefined key is absent rather than rejected, so building a
    // payload with optional fields does not inflate the redaction counts.
    if (value === undefined) continue;

    const kept = applyRule(rule, value, at, ctx, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }

  ctx.seen.delete(source);
  return out;
}

/**
 * Redacts a payload against a policy.
 *
 * Total: any input is acceptable, including `null`, a primitive, or a value with
 * circular references. A non-object collapses to `{}` with the whole payload
 * counted as dropped, because the alternative — throwing — would mean a logging
 * call could crash a request path, and telemetry must never do that.
 */
export function redact<T = Record<string, unknown>>(
  payload: unknown,
  policy: FieldPolicy,
): RedactionOutcome<T> {
  const ctx: Context = { droppedKeys: [], redactedKeys: [], seen: new WeakSet() };

  if (!isPlainRecord(payload)) {
    return { value: {} as T, droppedKeys: ["<root>"], redactedKeys: [] };
  }

  const value = walk(payload, policy, "", ctx, 0);
  return { value: value as T, droppedKeys: ctx.droppedKeys, redactedKeys: ctx.redactedKeys };
}
