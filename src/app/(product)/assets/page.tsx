import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import { AssetFilters, AssetList } from "@/features/assets";
import { parseAssetQuery, type AssetQuery } from "@/lib/assets/asset-query";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";

/**
 * Digital Assets list (ATL-031, frontend §6).
 *
 * A Server Component that calls `AssetService` directly. CLAUDE.md: "prefer
 * server components for reads and server-only services for protected
 * operations" — so there is no route handler and therefore no `ApiEnvelope` to
 * build. The service's `AssetResult` is handled here, which is the boundary.
 *
 * Filter state lives entirely in `searchParams`. The filter control is a plain
 * GET form, so applying a filter is a navigation: back and forward work, a
 * filtered view can be shared, and none of it needs client JavaScript.
 */

export const metadata: Metadata = { title: "Digital Assets" };

/** Reads a session and per-user data, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Normalises `searchParams` into the shape `parseAssetQuery` validates.
 *
 * Next gives a single value or an array depending on how many times a key
 * appears, so a one-category filter arrives as a string and a two-category
 * filter as an array. The multi-select filters are always coerced to arrays;
 * `limit` is coerced to a number because the URL only ever carries text.
 *
 * Nothing is trusted: whatever survives this shaping is still validated, and
 * anything unrecognised falls back to a default rather than erroring.
 */
function toQueryInput(params: SearchParams): Record<string, unknown> {
  const many = (value: string | string[] | undefined): string[] | undefined => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  };
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const limit = one(params.limit);

  return {
    ...(many(params.category) ? { category: many(params.category) } : {}),
    ...(many(params.status) ? { status: many(params.status) } : {}),
    ...(many(params.source) ? { source: many(params.source) } : {}),
    ...(one(params.reviewedBefore) ? { reviewedBefore: one(params.reviewedBefore) } : {}),
    ...(one(params.search) ? { search: one(params.search) } : {}),
    ...(one(params.sort) ? { sort: one(params.sort) } : {}),
    ...(one(params.cursor) ? { cursor: one(params.cursor) } : {}),
    ...(limit && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
  };
}

/** True when the query asks for anything narrower than "all my assets". */
function isFiltered(query: AssetQuery): boolean {
  return Boolean(
    query.category ?? query.status ?? query.source ?? query.reviewedBefore ?? query.search,
  );
}

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireVerifiedUser();
  const params = await searchParams;

  const { query } = parseAssetQuery(toQueryInput(params));
  const compact = (Array.isArray(params.view) ? params.view[0] : params.view) === "compact";

  const result = await AssetService.create().listAssets(user.id, query);

  if (!result.ok) {
    /**
     * Thrown to the route-level error boundary (ATL-010) rather than rendered
     * inline. A list that failed to load has nothing to show, and a bespoke
     * error panel here would be a second, less-tested version of the boundary
     * the shell already provides.
     */
    throw new Error(`Could not load assets: ${result.code}`);
  }

  const { items, nextCursor } = result.data;

  /**
   * "First run" means the user has no assets at all, which is only knowable when
   * nothing is filtered. With a filter applied an empty result means the filter
   * matched nothing — a different situation needing different words.
   */
  const isFirstRun = items.length === 0 && !isFiltered(query);

  const queryString = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((entry) => [key, entry] as [string, string])
          : [[key, value] as [string, string]],
    ),
  ).toString();

  return (
    <PageContainer>
      <PageHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageTitle>Digital Assets</PageTitle>
            <PageDescription>
              Services and accounts connected to you. Atlas shows what you have recorded — it does
              not scan the internet to find more.
            </PageDescription>
          </div>
          <div className="flex items-center gap-2">
            {/*
              The view toggle is a link, so it is part of the URL state like
              every other list preference and survives a reload.
            */}
            <Button variant="tertiary" asChild>
              <Link href={compact ? "/assets" : "/assets?view=compact"}>
                {compact ? "Card view" : "Compact view"}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/assets/new">Add service</Link>
            </Button>
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-col gap-6 pb-16">
        <AssetFilters query={query} />

        <section aria-labelledby="asset-results-heading">
          <h2 id="asset-results-heading" className="sr-only">
            Services
          </h2>
          <AssetList
            assets={items}
            isFirstRun={isFirstRun}
            compact={compact}
            nextCursor={nextCursor}
            queryString={queryString}
          />
        </section>
      </div>
    </PageContainer>
  );
}
