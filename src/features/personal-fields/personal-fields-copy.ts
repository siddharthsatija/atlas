import { PERSONAL_FIELD_KEYS, type PersonalFieldKey } from "@/lib/personal-fields";

/**
 * Copy for Settings → Personal data (ATL-106, frontend §15).
 *
 * Held in one module rather than inline, for the reason `assistant-copy.ts`
 * gives: the wording here makes promises about encryption and about what reaches
 * the AI, and those sentences are asserted by tests. Scattering them through JSX
 * would mean a promise could be softened in one place and still pass.
 *
 * ## Two claims that have to stay exactly this honest
 *
 * ADR-003's tradeoffs section is explicit: "Server can decrypt: this is not
 * end-to-end encryption, and documentation **must not claim otherwise**." So the
 * encryption sentence says server-side and says Atlas can read the values. A
 * warmer phrasing would be a lie the architecture already forbids.
 *
 * The AI sentence is bounded the same way. ADR-002 and AI behavior §5 permit a
 * stored field to reach a provider **only** with per-request approval, and that
 * approval step is ATL-058 — it does not exist yet. So the copy says approval is
 * required and never implies the assistant can reach these values today.
 */

export interface PersonalFieldsCopy {
  sectionTitle: string;
  sectionDescription: string;
  /** The honest encryption disclosure (ADR-003). */
  encryptionNote: string;
  /** What can and cannot happen with AI (ADR-002, AI behavior §5). */
  aiUsageNote: string;

  emptyTitle: string;
  emptyBody: string;

  /** Shown when `personal_fields_storage` consent has never been granted. */
  consentTitle: string;
  consentWhy: string;
  consentWhatIsStored: string;
  consentGrant: string;

  /** Shown when consent existed and was withdrawn, while fields remain. */
  revokedTitle: string;
  revokedBody: string;

  addTitle: string;
  addSubmit: string;
  labelField: string;
  labelHint: string;
  valueField: string;
  kindField: string;

  /** The row control that opens the editor. Distinct from the form's submit. */
  editAction: string;
  editSubmit: string;
  editCancel: string;

  deleteAction: string;
  deleteTitle: string;
  deleteBody: string;
  deleteConfirm: string;
  deleteCancel: string;

  revealLabel: string;
  neverUsed: string;
  lastUsedPrefix: string;

  failureConsentRequired: string;
  failureInvalid: string;
  failureNotFound: string;
  failureUnavailable: string;
}

export const PERSONAL_FIELDS_COPY: PersonalFieldsCopy = {
  sectionTitle: "Personal data",
  sectionDescription:
    "Identity details you can reuse when Atlas helps you draft a request. Every field is optional, and you can remove any of them at any time.",

  /**
   * ADR-003 tradeoffs, stated plainly. "Encrypted" on its own would let a reader
   * assume end-to-end, which is not what Atlas does.
   */
  encryptionNote:
    "Values are encrypted before they are stored. This is server-side encryption, not end-to-end: Atlas can decrypt a value to show it to you or to include it in a draft you approve.",

  /**
   * Present tense is deliberate about what is *not* possible. Request drafting is
   * ATL-058; until it exists nothing sends these anywhere.
   */
  aiUsageNote:
    "Atlas never sends these to the AI assistant on its own. A field is only ever included in a draft you have approved for that specific request, and you choose it each time.",

  emptyTitle: "No personal details saved",
  emptyBody:
    "Add a detail when you want Atlas to reuse it in a request draft. Nothing is collected until you choose to save it.",

  consentTitle: "Saving personal details needs your permission",
  consentWhy:
    "Atlas will not store identity details until you agree to it, because these are the most sensitive values in the product and keeping them is your decision rather than a default.",
  consentWhatIsStored:
    "What is stored: the kind of detail, a label you choose, and the value itself. Nothing else.",
  consentGrant: "Allow Atlas to save personal details",

  revokedTitle: "Saving new details is turned off",
  revokedBody:
    "You withdrew permission to store personal details. What you saved earlier is still here and still yours: you can reveal a value or delete it. Adding and editing stay unavailable until you allow saving again.",

  addTitle: "Add a personal detail",
  addSubmit: "Save detail",
  labelField: "Label",
  labelHint: "Your own name for it, so you can tell two of the same kind apart.",
  valueField: "Value",
  kindField: "Kind of detail",

  /**
   * The trigger names what it opens; the submit names what it writes. Sharing one
   * word would give the collapsed row a button reading "Save changes" for a form
   * that is not on screen yet.
   */
  editAction: "Edit",
  editSubmit: "Save changes",
  editCancel: "Cancel",

  deleteAction: "Delete",
  deleteTitle: "Delete this detail?",
  /**
   * Explicit language, per the acceptance criterion. It names the consequence and
   * does not soften it: `remove` is a hard delete, and the value is gone.
   */
  deleteBody:
    "This permanently deletes the saved value. It cannot be recovered, and any request you draft afterwards will not be able to use it.",
  deleteConfirm: "Delete permanently",
  deleteCancel: "Keep it",

  revealLabel: "Personal detail",
  /**
   * Accurate today and after ATL-058 lands. `last_used_at` is null for every row
   * until request drafting exists, so a blank cell would read as a bug.
   */
  neverUsed: "Not yet used in a request",
  lastUsedPrefix: "Last used in a request",

  failureConsentRequired:
    "Atlas needs your permission to save personal details. Nothing was stored.",
  failureInvalid: "A label and a value are both needed. Nothing was stored.",
  failureNotFound: "That detail is no longer here. Nothing changed.",
  failureUnavailable: "Atlas could not save that just now. Nothing changed — please try again.",
};

/** Human-readable names for the six §7.13 keys, for the kind selector. */
export const PERSONAL_FIELD_KIND_LABELS: Record<PersonalFieldKey, string> = {
  full_name: "Name",
  email: "Email address",
  phone: "Phone number",
  address: "Postal address",
  username: "Username",
  other: "Something else",
};

/**
 * The selector's options, ordered as §7.13 lists them.
 *
 * Derived from `PERSONAL_FIELD_KEYS` rather than written out again, so a seventh
 * key cannot appear in the vocabulary without appearing in the UI.
 */
export const PERSONAL_FIELD_KIND_OPTIONS: readonly { key: PersonalFieldKey; label: string }[] =
  PERSONAL_FIELD_KEYS.map((key) => ({ key, label: PERSONAL_FIELD_KIND_LABELS[key] }));
