import { redact, scalar, type FieldPolicy, type RedactionOutcome } from "@/lib/telemetry/redaction";

/**
 * The `activity_events.metadata_redacted_json` allowlist (ATL-068).
 *
 * Built on the ATL-085 redaction utility rather than a second implementation —
 * the traversal, the shape validation, and the drop counting are the same
 * problem `audit_events` solved, and two allowlist engines would eventually
 * disagree about what "allowlisted" means.
 *
 * In `lib/` rather than `server/` because the Activity page (ATL-070) renders
 * filters and entity links from these fields, and the layer boundaries stop
 * components importing `src/server`. Holds no logic that touches a secret.
 *
 * ## Why an allowlist at all
 *
 * Activity summaries are Confidential, not Restricted (security §data
 * classification) — but the *inputs* that produce them are frequently
 * Restricted. An event about a data request is generated from a recipient
 * address; an event about a personal field is generated from its value. A
 * denylist would have to anticipate every such field as features arrive across
 * M5 to M8. Naming what may be stored inverts that: a new feature's metadata is
 * dropped and counted until someone adds it deliberately.
 *
 * ## This list grows
 *
 * Only categories that are knowable and non-identifying today are here. Each
 * feature milestone that emits new events extends it, exactly as the ADR-006
 * audit inventory does. That is a code change with a reviewer — not a silent
 * widening.
 */

/** Lowercase snake vocabulary: statuses, categories, reasons. */
const VOCABULARY = /^[a-z][a-z0-9_]{0,63}$/;

/** Version identifiers, e.g. `rules-v1` or `2026-08-01`. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const matches = (pattern: RegExp) => (value: unknown) =>
  typeof value === "string" && pattern.test(value);

const isInt = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const isBoolean = (value: unknown) => typeof value === "boolean";

/**
 * Permitted metadata keys.
 *
 * Notably absent, and deliberately so: anything free-text, any email or address,
 * any raw identifier beyond the `entity_id` column the table already models, and
 * any personal-field value. `summary` is where human-readable text belongs, and
 * it is the writer's job to keep it masked (ATL-069).
 */
export const ACTIVITY_METADATA_POLICY: FieldPolicy = {
  // Statuses and transitions — what the Activity page filters on.
  status: scalar(matches(VOCABULARY)),
  fromStatus: scalar(matches(VOCABULARY)),
  toStatus: scalar(matches(VOCABULARY)),
  reason: scalar(matches(VOCABULARY)),
  outcome: scalar(matches(VOCABULARY)),

  // Classification labels, all fixed vocabularies defined by their own tickets.
  category: scalar(matches(VOCABULARY)),
  severity: scalar(matches(VOCABULARY)),
  source: scalar(matches(VOCABULARY)),
  /** Who caused the event: `user`, `system`. Mirrors the audit actor vocabulary. */
  actor: scalar(matches(VOCABULARY)),

  // Counts. A count carries no identity, which is what makes it safe here.
  count: scalar(isInt(0, 1_000_000_000)),
  previousCount: scalar(isInt(0, 1_000_000_000)),

  // Scores are integers in a known range (ADR-004).
  score: scalar(isInt(0, 100)),
  previousScore: scalar(isInt(0, 100)),

  // Versions, so an event can be interpreted against the rules that produced it.
  ruleVersion: scalar(matches(VERSION)),
  scoreVersion: scalar(matches(VERSION)),
  policyVersion: scalar(matches(VERSION)),

  /** Whether the event concerns demo data — labelled, never silently mixed in. */
  isDemo: scalar(isBoolean),
};

export type ActivityMetadata = Record<string, unknown>;

/**
 * Filters metadata to the allowlist.
 *
 * Returns the drop and redaction counts alongside the value rather than
 * swallowing them, so a caller — and a test — can tell "nothing was removed"
 * from "the whole payload was removed". ATL-069 is expected to surface a
 * non-empty count as a telemetry warning, the same way the audit writer does.
 */
export function redactActivityMetadata(
  metadata: ActivityMetadata | undefined,
): RedactionOutcome<ActivityMetadata> {
  return redact<ActivityMetadata>(metadata ?? {}, ACTIVITY_METADATA_POLICY);
}
