/**
 * Data categories — what a service *stores* about the user (ATL-028, §7.3).
 *
 * ## Not the same axis as `categories.ts`
 *
 * `ASSET_CATEGORIES` is what a service **is**: social, finance, shopping.
 * These are what it **holds**: contact, financial, health. A `social` service
 * commonly holds `contact`, `content`, and `behavioral` data, so the two lists
 * are never interchangeable and neither is a subset of the other. They are kept
 * in separate files for exactly that reason — one import site, one meaning.
 *
 * ## Sensitivity is derived, never chosen
 *
 * ADR-004 fixes the high-sensitivity set at financial, health, biometric, and
 * location, and the score's data-sensitivity factor counts active-asset ×
 * high-sensitivity-category pairs from that list. So sensitivity is a property
 * of the category, not of the row: the database generates the column from
 * `category`, and this module is where the same mapping lives for the
 * application.
 *
 * A per-row sensitivity a user could set would let a stored value disagree with
 * the ADR the score reads — and would let someone downgrade a `financial`
 * category to keep it out of their own score, which makes the number meaningless
 * for the person it is meant to inform.
 */

export interface DataCategory {
  id: string;
  /** Sentence-case label shown to the user. */
  label: string;
  /** One short line explaining what belongs here. */
  hint: string;
}

/** §7.3, in the order that specification lists them. */
export const DATA_CATEGORIES: readonly DataCategory[] = [
  { id: "identity", label: "Identity", hint: "Name, date of birth, or government identifiers" },
  { id: "contact", label: "Contact", hint: "Email address, phone number, or postal address" },
  { id: "location", label: "Location", hint: "Where you are, or where you have been" },
  { id: "financial", label: "Financial", hint: "Payment cards, bank details, or transactions" },
  { id: "behavioral", label: "Behavioural", hint: "What you click, watch, buy, or search for" },
  { id: "biometric", label: "Biometric", hint: "Face, fingerprint, or voice data" },
  { id: "content", label: "Content", hint: "Photos, messages, documents, or posts you created" },
  { id: "device", label: "Device", hint: "Hardware, browser, or network information" },
  { id: "professional", label: "Professional", hint: "Employer, job history, or qualifications" },
  { id: "health", label: "Health", hint: "Medical, fitness, or wellbeing information" },
  { id: "other", label: "Other", hint: "Anything that does not fit the categories above" },
] as const;

export type DataCategoryId = (typeof DATA_CATEGORIES)[number]["id"];

const CATEGORY_IDS: ReadonlySet<string> = new Set(DATA_CATEGORIES.map((entry) => entry.id));

export function isDataCategory(value: string): boolean {
  return CATEGORY_IDS.has(value);
}

/**
 * The high-sensitivity set, quoted from ADR-004.
 *
 * Changing this list changes the privacy score, which ADR-004 says requires a
 * new `score_version`. It is not a UI preference.
 */
export const HIGH_SENSITIVITY_CATEGORIES = [
  "financial",
  "health",
  "biometric",
  "location",
] as const;

export const DATA_SENSITIVITY_LEVELS = ["standard", "high"] as const;

export type DataSensitivity = (typeof DATA_SENSITIVITY_LEVELS)[number];

const HIGH: ReadonlySet<string> = new Set(HIGH_SENSITIVITY_CATEGORIES);

/**
 * The mapping the database generates the `sensitivity` column from.
 *
 * Stated twice — here and in the migration — deliberately, and the schema test
 * asserts the two agree. The database copy is what makes a wrong value
 * unrepresentable; this copy is what lets the application reason about
 * sensitivity without a round trip.
 */
export function sensitivityFor(category: string): DataSensitivity {
  return HIGH.has(category) ? "high" : "standard";
}

export function isHighSensitivity(category: string): boolean {
  return HIGH.has(category);
}
