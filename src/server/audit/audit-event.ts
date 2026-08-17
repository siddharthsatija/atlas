import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/config/env";
import { redact, scalar, type FieldPolicy } from "@/lib/telemetry/redaction";

/**
 * Audit event model, pseudonymisation, and hash chaining (ATL-103, ADR-006).
 *
 * Pure with respect to the database: this module decides *what* an audit event
 * is and *what its hash must be*. Writing is `audit-writer.ts`, and verification
 * is `chain-verification.ts`. Keeping the algebra separate is what lets the
 * chain be tested exhaustively without a database.
 *
 * `server-only` because it reads `AUDIT_HMAC_KEY`. The key never leaves this
 * module: callers pass a user ID and receive an opaque `subject_ref`.
 */

/**
 * The MVP event inventory (security §12, ADR-006).
 *
 * A closed union rather than a free string. An audit log whose event types are
 * ad-hoc strings cannot be queried reliably during an incident — which is the
 * only moment it matters — and typos are invisible until then.
 *
 * The list grows with the milestones that introduce the behaviour. Types for
 * features that do not exist yet are included because the *inventory* is
 * specified now; emitting them is each feature ticket's job.
 */
export const AUDIT_EVENT_TYPES = [
  // Authentication (ATL-011 – ATL-014)
  "auth.signed_in",
  "auth.signed_out",
  "auth.sign_in_failed",
  "auth.session_revoked",

  // Export (M11)
  "export.requested",
  "export.downloaded",
  "export.expired",

  // Account deletion (M11)
  "account.deletion_initiated",
  "account.deletion_completed",

  // Encryption keys (ATL-084)
  "encryption.dek_created",
  "encryption.dek_destroyed",
  "encryption.kek_rotated",

  // Requests (M8)
  "request.transitioned",

  // Consent (ATL-078)
  "consent.granted",
  "consent.revoked",

  // Sensitive-value reveal (ATL-035)
  "personal_field.revealed",

  /**
   * Finding resolution (ATL-042).
   *
   * ADR-006's MVP inventory did not name it, and the decision to add it was
   * taken deliberately rather than by widening this list quietly: ATL-042's
   * acceptance criterion requires an audit event, and the ADR's inventory is
   * amended to match. Written *after* the status change commits, so the record
   * describes a resolution that happened rather than one that was attempted.
   *
   * The engine's auto-resolution is not audited — nobody acted.
   */
  "finding.resolved",

  /**
   * AI conversation history destroyed (ATL-109).
   *
   * ADR-006's MVP inventory did not name it, and the addition is deliberate
   * rather than a quiet widening — the same amendment `finding.resolved` made.
   * Two reasons it belongs:
   *
   *   1. It is irreversible destruction of user content. Security §12 audits
   *      deletions, and "the user asked for it" is exactly the claim an audit
   *      record exists to substantiate later.
   *   2. `consent.revoked` alone would not say the data went. Consent is a
   *      decision; deletion is an act. Recording only the decision would leave
   *      no evidence that the obligation it triggered was discharged.
   *
   * Written after the rows are gone, so the event describes a deletion that
   * happened rather than one that was attempted. The context carries a count and
   * never any message content.
   */
  "ai.history_cleared",

  // Operator elevation
  "operator.elevated",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

const EVENT_TYPES: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);

export function isAuditEventType(value: string): value is AuditEventType {
  return EVENT_TYPES.has(value);
}

export type ActorType = "user" | "system" | "operator";

/**
 * The subject's first event points at this instead of null.
 *
 * A sentinel rather than NULL so the `(subject_ref, prev_hash)` unique index
 * actually constrains the root of the chain — Postgres treats NULLs as
 * distinct, so a nullable link would leave the first event unprotected against
 * a concurrent fork.
 */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The context allowlist (ADR-006: "allowlisted keys only").
 *
 * Built on the ATL-085 redaction utility rather than a second implementation:
 * the traversal, the drop counting, and the credential scrubbing are the same
 * problem, and ADR-006's "unknown keys are dropped and counted as a telemetry
 * warning" is exactly that utility's contract.
 *
 * Every key here is a version, an identifier that carries no identity, a status,
 * or a count — the four categories ADR-006 permits. Notably absent: anything
 * free-text, any raw identifier, any value from a personal field.
 */
export const AUDIT_CONTEXT_POLICY: FieldPolicy = {
  // Versions
  policyVersion: scalar(matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  scoreVersion: scalar(matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  promptVersion: scalar(matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  ruleVersion: scalar(matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/)),
  schemaVersion: scalar(isInt(0, 1_000_000)),

  // Correlation
  requestId: scalar(matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)),

  // Statuses and transitions
  status: scalar(matches(/^[a-z][a-z0-9_]{0,63}$/)),
  fromStatus: scalar(matches(/^[a-z][a-z0-9_]{0,63}$/)),
  toStatus: scalar(matches(/^[a-z][a-z0-9_]{0,63}$/)),
  reason: scalar(matches(/^[a-z][a-z0-9_]{0,63}$/)),
  outcome: scalar(matches(/^[a-z][a-z0-9_]{0,63}$/)),

  // Counts
  count: scalar(isInt(0, 1_000_000_000)),
  recordCount: scalar(isInt(0, 1_000_000_000)),
  keyVersion: scalar(isInt(0, 1_000_000)),

  // Fixed vocabularies
  consentType: scalar(matches(/^[a-z][a-z0-9_]{0,63}$/)),
  method: scalar(matches(/^[a-z][a-z0-9_]{0,31}$/)),
};

function matches(pattern: RegExp): (value: unknown) => boolean {
  return (value) => typeof value === "string" && pattern.test(value);
}

function isInt(min: number, max: number): (value: unknown) => boolean {
  return (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export type AuditContext = Record<string, unknown>;

/** What a caller supplies. `subject_ref` is derived, never passed in. */
export interface AuditEventInput {
  userId: string;
  eventType: AuditEventType;
  actorType: ActorType;
  entityType?: string;
  entityId?: string;
  context?: AuditContext;
  occurredAt?: Date;
}

/** The row-shaped event, after pseudonymisation, redaction, and hashing. */
export interface AuditEventRecord {
  eventType: AuditEventType;
  subjectRef: string;
  actorType: ActorType;
  entityType: string | null;
  entityId: string | null;
  context: AuditContext;
  occurredAt: string;
  prevHash: string;
  eventHash: string;
}

/**
 * Pseudonymous, stable reference to a user.
 *
 * HMAC rather than a plain hash: a bare `sha256(userId)` is trivially reversible
 * for anyone holding the user ID space, and user IDs are UUIDs that appear in
 * URLs, logs, and support tickets. The key turns the mapping into something an
 * attacker with the database alone cannot invert.
 *
 * Stability is the point — the same user always yields the same reference, so a
 * chain can be assembled per subject — and it is also the limitation: this is
 * pseudonymisation, not anonymisation. ADR-006 is explicit that the mapping is
 * irreversible in practice only once the auth record is gone.
 */
export function subjectRefFor(userId: string): string {
  return createHmac("sha256", Buffer.from(env.AUDIT_HMAC_KEY, "base64"))
    .update(userId, "utf8")
    .digest("hex");
}

/**
 * Canonical serialisation of the hashed fields.
 *
 * Two properties matter, and both are about verification years later:
 *
 *  1. **Deterministic key order.** `JSON.stringify` follows insertion order, so
 *     two events with identical content but differently-ordered context objects
 *     would hash differently and one would fail verification for no reason.
 *     Keys are sorted at every level.
 *  2. **Unambiguous field separation.** Fields are emitted as a JSON array of
 *     tagged pairs rather than concatenated, so no value can be crafted to
 *     impersonate a field boundary — the classic length-extension-adjacent
 *     mistake where `a="x|y", b="z"` and `a="x", b="y|z"` hash identically.
 */
export function canonicalise(event: Omit<AuditEventRecord, "eventHash">): string {
  return JSON.stringify([
    ["event_type", event.eventType],
    ["subject_ref", event.subjectRef],
    ["actor_type", event.actorType],
    ["entity_type", event.entityType],
    ["entity_id", event.entityId],
    ["occurred_at", event.occurredAt],
    ["prev_hash", event.prevHash],
    ["context", sortValue(event.context)],
  ]);
}

/** Recursively orders object keys so serialisation is order-independent. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

/** `event_hash = sha256(canonical event)`, where the canonical form includes `prev_hash`. */
export function hashEvent(event: Omit<AuditEventRecord, "eventHash">): string {
  return createHash("sha256").update(canonicalise(event), "utf8").digest("hex");
}

export interface BuiltAuditEvent {
  record: AuditEventRecord;
  /** Context keys the allowlist removed. ADR-006 requires these to be counted. */
  droppedKeys: string[];
  redactedKeys: string[];
}

/**
 * Builds a complete, hashed event from caller input and the subject's previous
 * hash.
 *
 * Redaction happens here rather than at the call site so no code path can insert
 * an unfiltered context: the writer accepts only what this function produces.
 */
export function buildAuditEvent(input: AuditEventInput, prevHash: string): BuiltAuditEvent {
  const {
    value: context,
    droppedKeys,
    redactedKeys,
  } = redact(input.context ?? {}, AUDIT_CONTEXT_POLICY);

  const withoutHash: Omit<AuditEventRecord, "eventHash"> = {
    eventType: input.eventType,
    subjectRef: subjectRefFor(input.userId),
    actorType: input.actorType,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    context,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    prevHash,
  };

  return {
    record: { ...withoutHash, eventHash: hashEvent(withoutHash) },
    droppedKeys,
    redactedKeys,
  };
}

/**
 * Constant-time hash comparison.
 *
 * Verification compares an attacker-influenced value against a computed one. A
 * short-circuiting `===` leaks how many leading characters matched, which is
 * enough to forge a hash byte by byte given enough attempts.
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
