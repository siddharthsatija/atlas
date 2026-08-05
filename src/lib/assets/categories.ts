/**
 * Asset categories — the kinds of online account a person holds (ATL-016).
 *
 * Architecture §7.2 lists `digital_assets.category` without enumerating it,
 * unlike §7.3 which spells out the *data* categories an asset holds. The two are
 * different axes and are easy to confuse: `social` is what a service **is**,
 * `contact` is what it **stores**. This file defines the first; §7.3 defines the
 * second, and neither should be substituted for the other.
 *
 * Defined here because onboarding step 3 is the first surface that needs it
 * (`profiles.selected_categories`). **ATL-027 inherits this list** for
 * `digital_assets.category` — a later ticket may extend it, but it should not
 * fork it, or the two halves of the product will disagree about what a category
 * is.
 *
 * In `lib/` so both the onboarding UI and the server-side validation read one
 * definition. A duplicated list is how a category becomes selectable in the UI
 * and rejected by the service.
 */

export interface AssetCategory {
  id: string;
  /** Sentence-case label shown to the user. */
  label: string;
  /** One short line explaining what belongs here, for the onboarding chooser. */
  hint: string;
}

/**
 * The MVP list.
 *
 * Chosen to cover where people actually hold accounts without becoming a
 * taxonomy exercise — a user picking categories during onboarding is answering
 * "where do I have accounts?", and a list they have to read twice defeats the
 * step. `other` exists so nobody is forced into a wrong bucket, which matters
 * more than completeness here.
 */
export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  { id: "social", label: "Social", hint: "Networks, forums, and messaging" },
  { id: "shopping", label: "Shopping", hint: "Retailers and marketplaces" },
  { id: "finance", label: "Finance", hint: "Banking, payments, and investing" },
  { id: "email", label: "Email", hint: "Mail and calendar providers" },
  { id: "entertainment", label: "Entertainment", hint: "Streaming, music, and games" },
  { id: "health", label: "Health", hint: "Fitness, medical, and wellbeing" },
  { id: "work", label: "Work", hint: "Employers, tools, and professional networks" },
  { id: "travel", label: "Travel", hint: "Airlines, hotels, and booking sites" },
  { id: "other", label: "Something else", hint: "Anything that does not fit above" },
] as const;

export const ASSET_CATEGORY_IDS: readonly string[] = ASSET_CATEGORIES.map((c) => c.id);

const IDS: ReadonlySet<string> = new Set(ASSET_CATEGORY_IDS);

export function isAssetCategory(value: string): boolean {
  return IDS.has(value);
}
