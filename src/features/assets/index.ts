/**
 * Public surface of the assets feature (ATL-031).
 *
 * The ESLint boundary rule restricts deep imports into a feature — its internals
 * are its own. Everything the route needs is re-exported here, so the module
 * layout inside this folder can change without touching a caller.
 */

export { AccountIdentifier, type AccountIdentifierProps } from "./account-identifier";
export {
  AssetActionForm,
  type AssetActionFormProps,
  type AssetActionFormState,
} from "./asset-action-form";
export { AssetCard, type AssetSummary } from "./asset-card";
/** ATL-034's detail surface. The route composes these; the order lives inside. */
export {
  AssetDetailHeaderActions,
  type AssetDetailHeaderActionsProps,
} from "./asset-detail-header";
export { AssetDetailSections, type AssetDetailSectionsProps } from "./asset-detail-sections";
export { AssetCreateForm, type AssetCreateFormProps } from "./asset-create-form";
export { AssetEditForm, type AssetEditFormProps } from "./asset-edit-form";
export { AssetFilters } from "./asset-filters";
export { AssetList } from "./asset-list";
export { AssetsFilteredEmptyState, AssetsFirstRunEmptyState } from "./asset-empty-states";
