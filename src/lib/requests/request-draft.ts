import { isPlausibleEmail } from "@/lib/auth/auth-result";
import { PERSONAL_FIELD_KEYS, type PersonalFieldKey } from "@/lib/personal-fields";

/**
 * The decisions Step 1 makes, as pure functions (ATL-058, frontend §10).
 *
 * Which stored fields a person may choose from, whether a recipient address is
 * usable, and whether the evidence is uncertain enough to warn about. All three
 * are product rules rather than storage or rendering concerns, so they live here
 * where they can be tested against a literal and reused by the route, the
 * components and the service without any of them re-deriving one.
 *
 * Nothing here reads a database, a clock, or a request. Nothing here decrypts.
 */

/**
 * A stored field as the checklist offers it: identified, labelled, masked.
 *
 * Structurally what `MaskedPersonalField` gives, narrowed to what the choice
 * needs. Declared locally rather than imported from `@/server` because features
 * may not reach into the server layer — the same split
 * `personal-fields-view.ts` documents.
 */
export interface SelectableField {
  id: string;
  fieldKey: PersonalFieldKey;
  label: string;
  /** Produced server-side. Never the full value. */
  maskedValue: string;
  /** Used to pick the most recent field of a key. */
  updatedAt: string;
}

/**
 * Resolves the fields a person may choose from: **at most one per key**.
 *
 * ## Why one per key, when storage allows several
 *
 * `user_personal_fields` deliberately permits two fields with the same key — the
 * ATL-105 migration says so explicitly, because ADR-002's own example ("Personal
 * Gmail") only makes sense if a person can hold more than one `email`. But
 * `data_requests.included_fields_json` stores **keys**, not ids, and ATL-050's
 * subset check compares keys: it is what stops a model claiming it used a field
 * nobody approved.
 *
 * So approving *both* of two emails, or approving one of them, is not
 * representable in the record that governs what may be sent. Offering the choice
 * anyway would produce an approval the storage cannot describe and the AI policy
 * layer cannot enforce — the failure mode ADR-002 exists to prevent.
 *
 * The resolution is to offer one field per key, most recently updated first, and
 * to show its label so the person can see *which* one it is. A person who wants
 * the other address edits it in Settings, where both remain visible, masked and
 * individually deletable.
 *
 * Ordered by `PERSONAL_FIELD_KEYS` rather than by recency, so the checklist reads
 * in the same order every time — a list that reshuffled between visits would make
 * a person re-read it to find the box they meant.
 */
export function selectableFields(fields: readonly SelectableField[]): SelectableField[] {
  const newestByKey = new Map<PersonalFieldKey, SelectableField>();

  for (const field of fields) {
    const held = newestByKey.get(field.fieldKey);

    /**
     * Strictly newer wins. A tie keeps the first seen, which is stable because
     * the caller's order is stable (`listMasked` sorts by `created_at desc, id
     * desc`) — so two fields updated in the same millisecond do not swap places
     * between renders.
     */
    if (!held || field.updatedAt > held.updatedAt) newestByKey.set(field.fieldKey, field);
  }

  return PERSONAL_FIELD_KEYS.map((key) => newestByKey.get(key)).filter(
    (field): field is SelectableField => field !== undefined,
  );
}

/**
 * Whether more than one stored field shares a key.
 *
 * The surface says so rather than hiding it: a person with two emails should
 * learn that only the most recent is offered here, instead of wondering why the
 * other is missing. Returns the keys that are doubled, so the copy can name them.
 */
export function keysWithHiddenAlternatives(fields: readonly SelectableField[]): PersonalFieldKey[] {
  const counts = new Map<PersonalFieldKey, number>();

  for (const field of fields) {
    counts.set(field.fieldKey, (counts.get(field.fieldKey) ?? 0) + 1);
  }

  return PERSONAL_FIELD_KEYS.filter((key) => (counts.get(key) ?? 0) > 1);
}

/** Why a recipient address was refused. */
export type RecipientProblem = "missing" | "invalid";

export type RecipientCheck =
  { ok: true; recipient: string } | { ok: false; problem: RecipientProblem };

/**
 * Validates the recipient address the person entered.
 *
 * FR-08: "The recipient address is entered or confirmed by the user in MVP (no
 * verified service directory until Phase 2) and is clearly marked unverified."
 * So this checks *shape* and nothing else — it does not look the address up,
 * probe it, or imply Atlas knows it is right. `UNVERIFIED_RECIPIENT_NOTICE`
 * below is the copy that keeps that honest, and it is not optional.
 *
 * Reuses `isPlausibleEmail` (ATL-011) rather than defining a second email
 * pattern: two validators for one concept drift, and the sign-in flow's is
 * already the product's answer to "does this look like an address".
 */
export function checkRecipient(value: string | undefined): RecipientCheck {
  const trimmed = (value ?? "").trim();

  if (trimmed.length === 0) return { ok: false, problem: "missing" };
  if (!isPlausibleEmail(trimmed)) return { ok: false, problem: "invalid" };

  return { ok: true, recipient: trimmed };
}

/**
 * The label every surface showing a recipient must carry (FR-08, frontend §10).
 *
 * Exported as a constant so the same sentence appears in Step 1 and in ATL-060's
 * Step 2 — a claim about verification that is worded differently in two places
 * is a claim a reader has to reconcile.
 */
export const UNVERIFIED_RECIPIENT_NOTICE =
  "Atlas does not verify this address. Check it against the service's own privacy page before you send.";

/** One piece of evidence Step 1 renders, as the review reads it. */
export interface EvidenceItem {
  /** e.g. a data category label. */
  label: string;
  /** `low | medium | high`, the §11.1 scale shared by assets and categories. */
  confidence: string;
  /** Where it came from, when recorded. */
  source: string | null;
}

/**
 * Whether the evidence behind this request is uncertain enough to warn about.
 *
 * The acceptance criterion asks for a warning state without defining the
 * threshold, and D5 settled it: **any** low confidence — the asset's own, or any
 * included category's — warns. Not an average, because averaging hides the case
 * the warning exists for: one shaky fact among several confident ones is exactly
 * what a person should check before telling a service what it holds.
 *
 * `medium` does not warn. §11.1 derives confidence from source and staleness and
 * caps it at medium for anything older than 180 days, so warning on medium would
 * warn on almost every mature account and teach people to ignore it.
 */
export function hasUncertainEvidence(
  assetConfidence: string,
  evidence: readonly EvidenceItem[],
): boolean {
  if (assetConfidence === "low") return true;
  return evidence.some((item) => item.confidence === "low");
}

/**
 * What Step 1 submits, once validated.
 *
 * `fieldIds` and `fieldKeys` are both carried because they answer different
 * questions and neither derives the other at the point of use: the keys are what
 * `included_fields_json` stores and what the AI policy layer checks, and the ids
 * are what `PersonalFieldService.markUsed` stamps. Resolving one from the other
 * later would mean a second read of the vault.
 */
export interface ReviewedSelection {
  fieldIds: string[];
  fieldKeys: PersonalFieldKey[];
  recipient: string;
}

/**
 * Turns the chosen field ids into a selection, dropping anything not on offer.
 *
 * The ids arrive from a form, so they are untrusted: a tampered submission could
 * name a field belonging to someone else, or a second field of a key the
 * checklist only offered once. Intersecting against `selectableFields` refuses
 * both without needing to say which — the offered list was built from this
 * person's own vault, so an id outside it is either not theirs or not offered.
 *
 * Returns keys deduplicated and in vocabulary order, matching what
 * `DataRequestRepository.create` will store.
 */
export function reviewSelection(
  offered: readonly SelectableField[],
  chosenIds: readonly string[],
  recipient: string,
): ReviewedSelection {
  const chosen = new Set(chosenIds);
  const included = offered.filter((field) => chosen.has(field.id));

  return {
    fieldIds: included.map((field) => field.id),
    fieldKeys: included.map((field) => field.fieldKey),
    recipient,
  };
}
