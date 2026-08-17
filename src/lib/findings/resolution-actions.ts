/**
 * What a user did about a finding (ATL-042).
 *
 * ATL-042 requires resolution to record "the action taken". Nothing in the
 * documents defined that vocabulary, so this is the minimum set the ticket
 * needs, chosen to cover what the seven live rules in ADR-001's catalog can
 * actually produce — not an open-ended taxonomy.
 *
 * The application half of the §7.2 split: the migration constrains these values
 * in SQL *and* they are listed here, because the UI offers them and a drifted
 * value would be rejected by the database at the moment a user tried to resolve
 * something.
 *
 * ## Why a closed set rather than free text
 *
 * §11.1 keeps user-typed values out of anything a rule or a score reads, and
 * this column is meant to be the source for later reporting — which free text
 * cannot be. It also keeps the value usable as an audit `reason`, whose
 * allowlist pattern (`^[a-z][a-z0-9_]{0,63}$`) these ids satisfy by
 * construction.
 *
 * ATL-043 reuses this vocabulary for dismissal reasons rather than inventing a
 * second, parallel concept.
 */

export const RESOLUTION_ACTIONS = [
  {
    id: "reviewed",
    label: "I reviewed the service",
    description: "You checked what this service holds and it is as you expect.",
  },
  {
    id: "permission_revoked",
    label: "I removed or narrowed a permission",
    description: "You revoked access, or reduced how much it grants.",
  },
  {
    id: "data_removed",
    label: "I removed information from the service",
    description: "The service no longer holds what this finding was about.",
  },
  {
    id: "account_closed",
    label: "I closed the account",
    description: "The account no longer exists at that service.",
  },
  {
    id: "other",
    label: "Something else",
    description: "You dealt with it another way.",
  },
] as const;

export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number]["id"];

const ACTIONS: ReadonlySet<string> = new Set(RESOLUTION_ACTIONS.map((entry) => entry.id));

/**
 * Narrows an unvalidated value to a known action.
 *
 * Used at the Server Action boundary, where the value arrives from a form and
 * is therefore untrusted. Anything unrecognised is refused there rather than
 * being sent to the database to fail a check constraint — the constraint is the
 * second gate, not the first.
 */
export function isResolutionAction(value: unknown): value is ResolutionAction {
  return typeof value === "string" && ACTIONS.has(value);
}

/** The label a surface shows for a stored action, or the raw id if unknown. */
export function resolutionActionLabel(action: string): string {
  return RESOLUTION_ACTIONS.find((entry) => entry.id === action)?.label ?? action;
}
