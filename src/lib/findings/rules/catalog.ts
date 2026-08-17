import { ageInDays } from "../confidence";
import type {
  AssetInput,
  ConfidenceInput,
  DataCategoryInput,
  Rule,
  RuleCandidate,
  RuleInputs,
} from "./types";

/**
 * Rule catalog v1 (ATL-101, architecture §11.1, ADR-001).
 *
 * Every rule here is a pure function of the snapshot it is given. None reads a
 * clock, a database, or another rule's output, so each one's tests are a
 * snapshot literal and an expectation.
 *
 * ## Seven rules, not eight
 *
 * **R-007 (rejected_request_unresolved) is not in this catalog.** Its predicate
 * is "request rejected with no follow-up action for 30 days", which needs more
 * than the table ATL-056 created: it needs the lifecycle to *mean* something —
 * a `rejected` status a request actually reached, and the transitions that
 * would clear it. A rule registered against a subsystem that cannot move could
 * never fire, and a rule that can never fire is indistinguishable from one that
 * is broken. **ATL-057 owns the lifecycle; the rule lands with the ticket that
 * registers it, which is not ATL-056 or ATL-057.**
 *
 * **R-006 evaluates only the first of its two conjuncts, and since ATL-056 that
 * is a real gap rather than a vacuous one.** §11.1's predicate is "archived asset
 * still lists data categories *and has no deletion request*". While no request
 * could exist, the second conjunct held for every asset and the rule's conclusion
 * was correct as written. `data_requests` now exists, so an archived asset with a
 * deletion request already sent can raise R-006 — a finding telling someone to
 * act on something they have already acted on.
 *
 * Not fixed here: adding the conjunct changes what a rule concludes, which
 * ADR-001 requires to move `RULES_VERSION` to `rules-v2` and to be recorded on
 * every finding the changed rule generates. That is a rules-catalog ticket, not
 * ATL-056's schema or ATL-057's lifecycle. Until it lands, the gap is bounded:
 * it needs an archived asset, retained data categories, **and** a request — a
 * combination nothing in the product can produce yet, because no surface creates
 * a request.
 *
 * ## Versioning
 *
 * `RULES_VERSION` is stamped on every finding and forms `source_reference`
 * (`rule_id@version`). Changing any predicate, severity mapping, or template in
 * this file requires bumping it — that is what lets someone reading an old
 * finding know which logic produced it.
 */

export const RULES_VERSION = "rules-v1";

/** §11.1's thresholds, named so a predicate reads as the rule does. */
export const STALE_REVIEW_DAYS = 180;
export const STALE_REVIEW_ESCALATION_DAYS = 365;
export const STALE_PERMISSION_DAYS = 365;
export const SENSITIVE_CATEGORY_ESCALATION_COUNT = 3;
export const CATEGORY_CONCENTRATION_ASSETS = 5;

/** The statuses §11.1 means by "active asset". */
const isActive = (asset: AssetInput): boolean => asset.status === "active";

/** How the confidence model sees an asset. */
const assetInput = (asset: AssetInput): ConfidenceInput => ({
  sourceType: asset.sourceType,
  lastVerifiedAt: asset.lastVerifiedAt,
  createdAt: asset.createdAt,
});

/**
 * How the confidence model sees a child record.
 *
 * A category or permission inherits its asset's source: the child was recorded
 * in the same act as the parent, and `asset_data_categories` has no source of
 * its own to disagree with.
 */
const childInput = (
  child: { lastVerifiedAt?: string | null; createdAt: string },
  asset: AssetInput,
): ConfidenceInput => ({
  sourceType: asset.sourceType,
  lastVerifiedAt: child.lastVerifiedAt ?? null,
  createdAt: child.createdAt,
});

/** Sorted for determinism: the same snapshot must always produce the same order. */
const byId = <T extends { id: string }>(records: readonly T[]): T[] =>
  [...records].sort((a, b) => a.id.localeCompare(b.id));

const categoriesOf = (inputs: RuleInputs, assetId: string): DataCategoryInput[] =>
  byId(inputs.dataCategories.filter((category) => category.assetId === assetId));

/**
 * Age of an asset's review, in days. Never-reviewed counts from creation.
 *
 * R-001 exists to surface records the user has not confirmed. Skipping
 * never-reviewed assets would let the least-checked records escape the check
 * entirely, which is the same reasoning ATL-029 applied to R-005.
 */
const reviewAgeDays = (asset: AssetInput, now: Date): number =>
  ageInDays(asset.lastVerifiedAt ?? asset.createdAt, now);

/**
 * R-001 · stale_review — hygiene.
 *
 * Active asset not reviewed in 180 days. Low, escalating to medium after 365.
 */
export const staleReview: Rule = {
  id: "R-001",
  type: "hygiene",
  recommendedAction: "Review what this service holds and confirm it is still accurate.",
  evaluate(inputs) {
    return byId(inputs.assets.filter(isActive))
      .filter((asset) => reviewAgeDays(asset, inputs.now) > STALE_REVIEW_DAYS)
      .map((asset) => {
        const days = reviewAgeDays(asset, inputs.now);
        const escalated = days > STALE_REVIEW_ESCALATION_DAYS;

        return {
          assetId: asset.id,
          severity: escalated ? "medium" : "low",
          evidence: { assetIds: [asset.id] },
          evidenceSummary: asset.lastVerifiedAt
            ? `Last reviewed ${asset.lastVerifiedAt.slice(0, 10)}, ${days} days ago.`
            : `Added ${asset.createdAt.slice(0, 10)} and never reviewed since.`,
          title: `${asset.serviceName} has not been reviewed recently`,
          description: `You have not confirmed what ${asset.serviceName} holds about you in ${days} days. Records drift as services change what they collect.`,
          inputs: [assetInput(asset)],
        } satisfies RuleCandidate;
      });
  },
};

/**
 * R-002 · inactive_account_with_data — hygiene.
 *
 * Asset marked inactive that still lists data categories. Medium, high if any of
 * them is high-sensitivity.
 */
export const inactiveAccountWithData: Rule = {
  id: "R-002",
  type: "hygiene",
  recommendedAction: "Consider requesting deletion, or archive the service if you have already.",
  evaluate(inputs) {
    return byId(inputs.assets.filter((asset) => asset.status === "inactive"))
      .map((asset) => ({ asset, categories: categoriesOf(inputs, asset.id) }))
      .filter(({ categories }) => categories.length > 0)
      .map(({ asset, categories }) => {
        const sensitive = categories.filter((category) => category.sensitivity === "high");

        return {
          assetId: asset.id,
          severity: sensitive.length > 0 ? "high" : "medium",
          evidence: {
            assetIds: [asset.id],
            dataCategoryIds: categories.map((category) => category.id),
          },
          evidenceSummary: `Marked inactive and still recorded as holding ${categories.length} ${categories.length === 1 ? "category" : "categories"} of data: ${categories.map((category) => category.category).join(", ")}.`,
          title: `${asset.serviceName} is inactive but still holds your data`,
          description: `You no longer use ${asset.serviceName}, but it is recorded as still holding data about you. Stopping use does not remove what a service already has.`,
          inputs: [assetInput(asset), ...categories.map((category) => childInput(category, asset))],
        } satisfies RuleCandidate;
      });
  },
};

/**
 * R-003 · sensitive_data_active — exposure.
 *
 * Active asset holding high-sensitivity data. Low, medium at three or more
 * sensitive categories on one asset.
 *
 * The sensitive set is ADR-004's (financial, health, biometric, location) and is
 * read from the `sensitivity` column, which the database generates — so this
 * rule and the score cannot disagree about which categories count.
 */
export const sensitiveDataActive: Rule = {
  id: "R-003",
  type: "exposure",
  recommendedAction: "Check whether this service still needs the sensitive data it holds.",
  evaluate(inputs) {
    return byId(inputs.assets.filter(isActive))
      .map((asset) => ({
        asset,
        sensitive: categoriesOf(inputs, asset.id).filter(
          (category) => category.sensitivity === "high",
        ),
      }))
      .filter(({ sensitive }) => sensitive.length > 0)
      .map(({ asset, sensitive }) => ({
        assetId: asset.id,
        severity: sensitive.length >= SENSITIVE_CATEGORY_ESCALATION_COUNT ? "medium" : "low",
        evidence: {
          assetIds: [asset.id],
          dataCategoryIds: sensitive.map((category) => category.id),
        },
        evidenceSummary: `Holds ${sensitive.length} more sensitive ${sensitive.length === 1 ? "category" : "categories"}: ${sensitive.map((category) => category.category).join(", ")}.`,
        title: `${asset.serviceName} holds more sensitive information`,
        description: `${asset.serviceName} is recorded as holding data that is harder to replace if it is exposed. That is not a problem by itself — it is worth knowing where it is.`,
        inputs: [assetInput(asset), ...sensitive.map((category) => childInput(category, asset))],
      }));
  },
};

/**
 * R-004 · broad_permission — permissions.
 *
 * Active permission with broad scope. Medium.
 *
 * One finding per permission, not per asset: each grant is separately revocable,
 * and collapsing them would make a finding that half-clears when the user
 * revokes one.
 */
export const broadPermission: Rule = {
  id: "R-004",
  type: "permissions",
  recommendedAction: "Review this permission and revoke it if the service no longer needs it.",
  evaluate(inputs) {
    const assets = new Map(inputs.assets.map((asset) => [asset.id, asset]));

    return byId(inputs.permissions)
      .filter((permission) => permission.scope === "broad" && permission.status === "active")
      .flatMap((permission) => {
        const asset = assets.get(permission.assetId);
        if (!asset) return [];

        return [
          {
            assetId: asset.id,
            severity: "medium",
            evidence: { assetIds: [asset.id], permissionIds: [permission.id] },
            evidenceSummary: `Active broad-scope permission recorded on ${asset.serviceName}.`,
            title: `${asset.serviceName} has a broad permission`,
            description: `${asset.serviceName} holds a permission recorded as broad in scope, which grants more than a single specific action.`,
            inputs: [assetInput(asset), childInput(permission, asset)],
          } satisfies RuleCandidate,
        ];
      });
  },
};

/**
 * R-005 · stale_permission — permissions.
 *
 * Active permission not verified in 365 days. Low.
 *
 * Never-verified counts from creation, matching R-001 and ATL-029's note that
 * "never verified is at least as stale as verified long ago".
 */
export const stalePermission: Rule = {
  id: "R-005",
  type: "permissions",
  recommendedAction: "Confirm this permission is still granted, or revoke it.",
  evaluate(inputs) {
    const assets = new Map(inputs.assets.map((asset) => [asset.id, asset]));

    return byId(inputs.permissions)
      .filter((permission) => permission.status === "active")
      .flatMap((permission) => {
        const asset = assets.get(permission.assetId);
        if (!asset) return [];

        const days = ageInDays(permission.lastVerifiedAt ?? permission.createdAt, inputs.now);
        if (days <= STALE_PERMISSION_DAYS) return [];

        return [
          {
            assetId: asset.id,
            severity: "low",
            evidence: { assetIds: [asset.id], permissionIds: [permission.id] },
            evidenceSummary: permission.lastVerifiedAt
              ? `Last verified ${permission.lastVerifiedAt.slice(0, 10)}, ${days} days ago.`
              : `Recorded ${permission.createdAt.slice(0, 10)} and never verified since.`,
            title: `A permission on ${asset.serviceName} has not been checked in a year`,
            description: `This permission is still recorded as active, but nobody has confirmed it in ${days} days. Services change what a permission covers.`,
            inputs: [assetInput(asset), childInput(permission, asset)],
          } satisfies RuleCandidate,
        ];
      });
  },
};

/**
 * R-006 · archived_asset_data_remains — exposure.
 *
 * Archived asset that still lists data categories. Medium.
 *
 * §11.1's predicate also requires "and has no deletion request". That conjunct
 * is not evaluated because `data_requests` does not exist yet — no request can
 * exist, so the condition holds for every archived asset and this rule's
 * conclusion is exactly what §11.1 describes. The conjunct and a version bump
 * arrive with the table.
 */
export const archivedAssetDataRemains: Rule = {
  id: "R-006",
  type: "exposure",
  recommendedAction: "Request deletion if you want this service to remove what it still holds.",
  evaluate(inputs) {
    return byId(inputs.assets.filter((asset) => asset.status === "archived"))
      .map((asset) => ({ asset, categories: categoriesOf(inputs, asset.id) }))
      .filter(({ categories }) => categories.length > 0)
      .map(({ asset, categories }) => ({
        assetId: asset.id,
        severity: "medium",
        evidence: {
          assetIds: [asset.id],
          dataCategoryIds: categories.map((category) => category.id),
        },
        evidenceSummary: `Archived in Atlas and still recorded as holding ${categories.length} ${categories.length === 1 ? "category" : "categories"} of data.`,
        title: `${asset.serviceName} is archived but its data is not`,
        description: `Archiving ${asset.serviceName} tidied your Atlas records. It did not ask the service to delete anything, and the data above is still recorded as held.`,
        inputs: [assetInput(asset), ...categories.map((category) => childInput(category, asset))],
      }));
  },
};

/**
 * R-008 · category_concentration — exposure.
 *
 * The same high-sensitivity category held by five or more active assets. Medium.
 *
 * The only rule with no `assetId`: it is a statement about the user's footprint,
 * and naming one of the five services would make the finding say something it
 * does not mean. Its evidence names all of them.
 */
export const categoryConcentration: Rule = {
  id: "R-008",
  type: "exposure",
  recommendedAction: "Consider reducing how many services hold this kind of information.",
  evaluate(inputs) {
    const activeIds = new Set(inputs.assets.filter(isActive).map((asset) => asset.id));
    const byCategory = new Map<string, DataCategoryInput[]>();

    for (const category of byId(inputs.dataCategories)) {
      if (category.sensitivity !== "high" || !activeIds.has(category.assetId)) continue;
      byCategory.set(category.category, [...(byCategory.get(category.category) ?? []), category]);
    }

    const assets = new Map(inputs.assets.map((asset) => [asset.id, asset]));

    return [...byCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([category, records]) => {
        // Distinct assets, because one asset listing a category twice is not
        // concentration — and the unique constraint should prevent it anyway.
        const assetIds = [...new Set(records.map((record) => record.assetId))].sort();
        if (assetIds.length < CATEGORY_CONCENTRATION_ASSETS) return [];

        const involved = assetIds.flatMap((id) => {
          const asset = assets.get(id);
          return asset ? [asset] : [];
        });

        return [
          {
            assetId: null,
            severity: "medium",
            evidence: {
              assetIds,
              dataCategoryIds: records
                .filter((record) => assetIds.includes(record.assetId))
                .map((record) => record.id),
            },
            evidenceSummary: `${assetIds.length} active services are recorded as holding ${category} data.`,
            title: `Several services hold your ${category} information`,
            description: `${assetIds.length} services you still use are recorded as holding ${category} data. The more places it exists, the more places it can be exposed.`,
            inputs: involved.map(assetInput),
          } satisfies RuleCandidate,
        ];
      });
  },
};

/**
 * The catalog, in rule-id order.
 *
 * Order matters only for determinism — rules never see each other's output, so
 * evaluation order cannot change what any of them concludes.
 */
export const RULE_CATALOG: readonly Rule[] = [
  staleReview,
  inactiveAccountWithData,
  sensitiveDataActive,
  broadPermission,
  stalePermission,
  archivedAssetDataRemains,
  categoryConcentration,
];

/** `rule_id@rule_version`, the value §11.1 puts in `source_reference`. */
export function sourceReferenceFor(ruleId: string): string {
  return `${ruleId}@${RULES_VERSION}`;
}
