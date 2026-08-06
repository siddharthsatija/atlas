import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import { ASSET_SOURCE_TYPES, ASSET_STATUSES } from "@/lib/assets/asset-fields";
import { ASSET_SORT_ORDERS, type AssetQuery } from "@/lib/assets/asset-query";

/**
 * Search, filters, and sort for the asset list (ATL-031, frontend §6).
 *
 * ## A plain GET form, not client state
 *
 * The whole control is a `<form method="get" action="/assets">`. Submitting it
 * navigates, which means the filter state *is* the URL — frontend §6's
 * requirement — for free, and without a single line of client JavaScript. Back
 * and forward work, a filtered view can be bookmarked or shared, and the page
 * stays a Server Component that reads `searchParams`.
 *
 * The alternative — client state pushed into the URL with `useRouter` — needs
 * hydration before any filter works, and reimplements history handling the
 * browser already does correctly.
 *
 * ## Nothing sensitive travels here
 *
 * Every filter is an id from a closed vocabulary. The one free-text field is the
 * search term, which matches `service_name` and `service_domain` — both
 * Confidential. Notes and account identifiers are excluded from search by
 * design, so no URL can carry or surface them.
 *
 * `cursor` is deliberately absent from this form: submitting a changed filter
 * must start from page one, and carrying a stale cursor forward would open the
 * new result set partway down.
 */

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  archived: "Archived",
  removed: "Removed",
};

const SOURCE_LABELS: Record<string, string> = {
  manual: "Added by me",
  demo: "Sample data",
  connector: "Connected service",
  import: "Imported",
};

const SORT_LABELS: Record<string, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

/** A native multi-select: keyboard-operable and multi-value without any script. */
function FilterSelect({
  id,
  name,
  label,
  options,
  selected,
}: {
  id: string;
  name: string;
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        name={name}
        multiple
        defaultValue={selected}
        className="min-h-24 rounded-control border border-border-default bg-surface px-2 py-1 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface AssetFiltersProps {
  query: AssetQuery;
}

export function AssetFilters({ query }: AssetFiltersProps) {
  return (
    <form
      method="get"
      action="/assets"
      data-slot="asset-filters"
      // A landmark so the filter region can be reached directly, and named so it
      // is distinguishable from the page's other regions (frontend §20).
      aria-label="Search and filter services"
      role="search"
      className="flex flex-col gap-4 rounded-panel border border-border-default bg-surface p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 grow flex-col gap-1">
          <Label htmlFor="asset-search">Search</Label>
          <Input
            id="asset-search"
            name="search"
            type="search"
            defaultValue={query.search ?? ""}
            placeholder="Service name or domain"
            // The scope of the search, stated where a screen-reader user meets
            // the field rather than left for them to discover.
            aria-describedby="asset-search-hint"
          />
          <p id="asset-search-hint" className="text-body-sm text-text-muted">
            Searches service names and domains. Notes and saved identifiers are never searched.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="asset-sort">Sort</Label>
          <select
            id="asset-sort"
            name="sort"
            defaultValue={query.sort}
            className="h-11 rounded-control border border-border-default bg-surface px-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {ASSET_SORT_ORDERS.map((order) => (
              <option key={order} value={order}>
                {SORT_LABELS[order] ?? order}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FilterSelect
          id="asset-category"
          name="category"
          label="Category"
          selected={query.category ?? []}
          options={ASSET_CATEGORIES.map((entry) => ({ value: entry.id, label: entry.label }))}
        />
        <FilterSelect
          id="asset-status"
          name="status"
          label="Status"
          selected={query.status ?? []}
          options={ASSET_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] ?? value }))}
        />
        <FilterSelect
          id="asset-source"
          name="source"
          label="Source"
          selected={query.source ?? []}
          options={ASSET_SOURCE_TYPES.map((value) => ({
            value,
            label: SOURCE_LABELS[value] ?? value,
          }))}
        />
      </div>

      {/*
        Risk is absent. Frontend §6 lists it, but it derives from findings, which
        do not exist until M6 — a control that changed nothing would be worse
        than its absence, because the user could not tell it apart from a filter
        that matched nothing.
      */}

      <div className="flex items-center gap-2">
        <Button type="submit">
          <SearchIcon aria-hidden="true" className="size-4" />
          Apply
        </Button>
        {/* A link, not a reset button: it returns to the canonical unfiltered URL. */}
        <Button variant="tertiary" asChild>
          <Link href="/assets">Clear all</Link>
        </Button>
      </div>
    </form>
  );
}
