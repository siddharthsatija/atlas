import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import { AssetActionForm, AssetEditForm } from "@/features/assets";
import { ASSET_STATUSES } from "@/lib/assets/asset-fields";
import { DATA_CATEGORIES } from "@/lib/assets/data-categories";
import { PERMISSION_SCOPES, PERMISSION_TYPES } from "@/lib/assets/permissions";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import { editAssetChildrenAction, markReviewedAction, setAssetStatusAction } from "./actions";
import { saveAssetAction } from "./actions";
import { INITIAL_ASSET_ACTION_STATE, INITIAL_EDIT_ASSET_STATE } from "./form-state";

/**
 * Edit a service (ATL-033).
 *
 * Four independent forms rather than one, matching the four actions. The
 * acceptance criteria force the split: the review date must move only on an
 * explicit review, and status changes emit their own activity — neither is
 * expressible if everything shares a submit button.
 *
 * Status, review, and the child lists post to Server Actions through
 * `AssetActionForm`, which reports a failure the user would otherwise never see
 * (ATL-112). Submission still works without client JavaScript — React renders a
 * real form with a real action; only the error message needs the hook.
 */

export const metadata: Metadata = { title: "Edit service" };

/** Reads a session and per-user data, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

/** Statuses the edit form may set. `archived` is ATL-036's, with its own affordances. */
const EDITABLE_STATUSES = ASSET_STATUSES.filter((status) => status !== "archived");

const STATUS_LABELS: Record<string, string> = {
  active: "Active — I still use this",
  inactive: "Inactive — I no longer use it",
  removed: "Removed — the account no longer exists",
  archived: "Archived",
};

const PERMISSION_LABELS = new Map<string, string>(
  PERMISSION_TYPES.map((entry) => [entry.id, entry.label]),
);

export default async function EditAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireVerifiedUser();
  const { id } = await params;

  const result = await AssetService.create().listAssetDetails(user.id, id);

  if (!result.ok) {
    // 404 for both "no such asset" and "not yours" — the service makes them
    // indistinguishable so a guessed id cannot confirm existence.
    if (result.code === "NOT_FOUND") notFound();
    throw new Error(`Could not load service: ${result.code}`);
  }

  const { asset, dataCategories, permissions } = result.data;

  return (
    <PageContainer>
      <PageHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageTitle>Edit {asset.serviceName}</PageTitle>
            <PageDescription>
              Change what Atlas records about this service. Nothing here changes the service itself.
            </PageDescription>
          </div>
          <Button variant="tertiary" asChild>
            <Link href={`/assets/${asset.id}`}>Cancel</Link>
          </Button>
        </div>
      </PageHeader>

      <div className="flex flex-col gap-6 pb-16">
        <Card>
          <CardHeader>
            <h2 className="text-body font-medium text-text-primary">Details</h2>
          </CardHeader>
          <CardContent>
            <AssetEditForm
              action={saveAssetAction}
              initialState={INITIAL_EDIT_ASSET_STATE}
              assetId={asset.id}
              asset={{
                serviceName: asset.serviceName,
                category: asset.category,
                serviceDomain: asset.serviceDomain ?? "",
                notes: asset.notes ?? "",
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-body font-medium text-text-primary">Status and review</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <AssetActionForm
              action={setAssetStatusAction}
              initialState={INITIAL_ASSET_ACTION_STATE}
              assetId={asset.id}
              label="Update status"
              className="flex flex-wrap items-end gap-3"
            >
              <div className="flex flex-col gap-1">
                <label htmlFor="status" className="text-body-sm text-text-secondary">
                  Status
                </label>
                <select
                  id="status"
                  name="status"
                  defaultValue={asset.status === "archived" ? "active" : asset.status}
                  className="h-11 rounded-control border border-border-default bg-surface px-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                >
                  {EDITABLE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status] ?? status}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="secondary">
                Update status
              </Button>
              {asset.status === "archived" && (
                <p className="text-body-sm text-text-muted">
                  This service is archived. Restoring it is done from the Archive.
                </p>
              )}
            </AssetActionForm>

            <AssetActionForm
              action={markReviewedAction}
              initialState={INITIAL_ASSET_ACTION_STATE}
              assetId={asset.id}
              label="Mark as reviewed"
              className="flex flex-wrap items-center gap-3"
            >
              <Button type="submit" variant="secondary">
                Mark as reviewed
              </Button>
              <p className="text-body-sm text-text-muted">
                {asset.lastVerifiedAt
                  ? `Last reviewed ${asset.lastVerifiedAt.slice(0, 10)}.`
                  : "Never reviewed."}{" "}
                Saving other changes does not count as a review.
              </p>
            </AssetActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-body font-medium text-text-primary">Information held</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2">
              {dataCategories.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className="text-body-sm text-text-primary">{entry.category}</span>
                    {entry.sensitivity === "high" && <Badge tone="warning">More sensitive</Badge>}
                  </span>
                  <AssetActionForm
                    action={editAssetChildrenAction}
                    initialState={INITIAL_ASSET_ACTION_STATE}
                    assetId={asset.id}
                    label={`Remove ${entry.category}`}
                  >
                    <input type="hidden" name="intent" value="remove-category" />
                    <input type="hidden" name="categoryId" value={entry.id} />
                    <Button type="submit" variant="tertiary">
                      Remove
                    </Button>
                  </AssetActionForm>
                </li>
              ))}
              {dataCategories.length === 0 && (
                <li className="text-body-sm text-text-muted">Nothing recorded yet.</li>
              )}
            </ul>

            <AssetActionForm
              action={editAssetChildrenAction}
              initialState={INITIAL_ASSET_ACTION_STATE}
              assetId={asset.id}
              label="Add what this service holds"
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="intent" value="add-category" />
              <div className="flex flex-col gap-1">
                <label htmlFor="category-add" className="text-body-sm text-text-secondary">
                  Add what this service holds
                </label>
                <select
                  id="category-add"
                  name="category"
                  className="h-11 rounded-control border border-border-default bg-surface px-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                >
                  {DATA_CATEGORIES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="secondary">
                Add
              </Button>
            </AssetActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-body font-medium text-text-primary">Permissions</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2">
              {permissions.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className="text-body-sm text-text-primary">
                      {PERMISSION_LABELS.get(entry.permissionType) ?? entry.permissionType}
                    </span>
                    <Badge tone={entry.scope === "broad" ? "warning" : "neutral"}>
                      {entry.scope}
                    </Badge>
                    <Badge tone="neutral">{entry.status}</Badge>
                  </span>
                  <span className="flex items-center gap-2">
                    {entry.status === "active" && (
                      <AssetActionForm
                        action={editAssetChildrenAction}
                        initialState={INITIAL_ASSET_ACTION_STATE}
                        assetId={asset.id}
                        label={`Revoke ${PERMISSION_LABELS.get(entry.permissionType) ?? entry.permissionType}`}
                      >
                        <input type="hidden" name="intent" value="revoke-permission" />
                        <input type="hidden" name="permissionId" value={entry.id} />
                        {/*
                          Revoking keeps the row, which is what lets ADR-004's
                          permission factor improve rather than simply forget.
                        */}
                        <Button type="submit" variant="tertiary">
                          Revoke
                        </Button>
                      </AssetActionForm>
                    )}
                    <AssetActionForm
                      action={editAssetChildrenAction}
                      initialState={INITIAL_ASSET_ACTION_STATE}
                      assetId={asset.id}
                      label={`Remove ${PERMISSION_LABELS.get(entry.permissionType) ?? entry.permissionType}`}
                    >
                      <input type="hidden" name="intent" value="remove-permission" />
                      <input type="hidden" name="permissionId" value={entry.id} />
                      <Button type="submit" variant="tertiary">
                        Remove
                      </Button>
                    </AssetActionForm>
                  </span>
                </li>
              ))}
              {permissions.length === 0 && (
                <li className="text-body-sm text-text-muted">Nothing recorded yet.</li>
              )}
            </ul>

            <AssetActionForm
              action={editAssetChildrenAction}
              initialState={INITIAL_ASSET_ACTION_STATE}
              assetId={asset.id}
              label="Add permission"
              className="flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="intent" value="add-permission" />
              <div className="flex flex-col gap-1">
                <label htmlFor="permissionType" className="text-body-sm text-text-secondary">
                  Permission
                </label>
                {/*
                  A fixed choice, not free text: ATL-029's design is
                  shape-checked in SQL and vocabulary-checked in the application,
                  and a text box would let one grant be recorded under two names.
                */}
                <select
                  id="permissionType"
                  name="permissionType"
                  className="h-11 rounded-control border border-border-default bg-surface px-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                >
                  {PERMISSION_TYPES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="scope" className="text-body-sm text-text-secondary">
                  How much it grants
                </label>
                <select
                  id="scope"
                  name="scope"
                  className="h-11 rounded-control border border-border-default bg-surface px-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                >
                  {PERMISSION_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="secondary">
                Add
              </Button>
            </AssetActionForm>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
