/**
 * Public surface of the assets feature (ATL-031).
 *
 * The ESLint boundary rule restricts deep imports into a feature — its internals
 * are its own. Everything the route needs is re-exported here, so the module
 * layout inside this folder can change without touching a caller.
 */

export { AssetCard, type AssetSummary } from "./asset-card";
export { AssetCreateForm, type AssetCreateFormProps } from "./asset-create-form";
export { AssetEditForm, type AssetEditFormProps } from "./asset-edit-form";
export { AssetFilters } from "./asset-filters";
export { AssetList } from "./asset-list";
export { AssetsFilteredEmptyState, AssetsFirstRunEmptyState } from "./asset-empty-states";
