import { z } from "zod";
import { isAssetCategory } from "./categories";
import { ASSET_SOURCE_TYPES, ASSET_STATUSES } from "./asset-fields";

/**
 * The asset list query contract (ATL-030, architecture §10 "Paginate
 * collections", frontend §6).
 *
 * Pure and schema-validated so the same definition serves the service, the
 * eventual route handler, and ATL-031's URL state. Frontend §6 requires filter
 * state to be URL-driven and free of sensitive values, which is straightforward
 * here because every filter is an id from a closed vocabulary — there is no
 * field a personal value could travel in.
 *
 * ## Keyset, not offset
 *
 * Pagination is cursor-based on `(created_at desc, id desc)`, the exact ordering
 * ATL-027's `digital_assets_status_idx` and `digital_assets_category_idx` carry.
 * Offset pagination re-scans everything it skips and, worse, repeats or drops a
 * row when the underlying set changes between pages — a user archiving an asset
 * on page one would silently shift page two. The `id` tiebreak is what makes the
 * ordering total: `created_at` alone can tie, and a tie makes a page boundary
 * ambiguous. That lesson is recorded in ATL-068's timeline index.
 *
 * ## What is deliberately absent
 *
 * **Risk.** Frontend §6 lists it as a filter, but risk derives from findings,
 * which do not exist until M6 (ATL-038, ATL-101). Accepting the parameter now
 * and ignoring it would be worse than not accepting it: a caller would have no
 * way to tell a filter that does nothing from one that matched nothing.
 *
 * **Notes and account identifiers, from search.** ATL-031 adds search over
 * `service_name` and `service_domain` only — both Confidential, never
 * Restricted. Security §8 makes encrypted columns non-searchable by design, so
 * an account identifier can never be found this way; `notes` is excluded
 * deliberately, because it is the one field a user may type anything into and a
 * search that surfaced it would make a private note discoverable from a URL.
 */

/** Sort orders the indexes can serve without a sort node. */
export const ASSET_SORT_ORDERS = ["newest", "oldest"] as const;

export type AssetSortOrder = (typeof ASSET_SORT_ORDERS)[number];

export const DEFAULT_ASSET_SORT: AssetSortOrder = "newest";

/** Page size bounds. Defaulted small enough for a card grid, capped so one request cannot scan a whole table. */
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

/**
 * A keyset cursor: the sort position of the last row on the previous page.
 *
 * Both halves are required. A cursor carrying only a timestamp cannot resolve a
 * tie, which is the failure this pagination model exists to avoid.
 */
export interface AssetCursor {
  createdAt: string;
  id: string;
}

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

/**
 * Cursors travel in the URL (frontend §6: URL-driven state), so they are
 * base64url-encoded JSON — opaque enough that nobody treats them as an API, and
 * carrying nothing but a timestamp and a row id, neither of which is sensitive.
 */
export function encodeAssetCursor(cursor: AssetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes a cursor, returning null for anything unreadable.
 *
 * Never throws. A cursor is user-controlled input arriving from a URL someone
 * may have edited or truncated; the right answer to a malformed one is the first
 * page, not an error page.
 */
export function decodeAssetCursor(value: string): AssetCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Filters, all optional and all multi-select.
 *
 * Arrays rather than single values because frontend §6's filters are chips a
 * user can combine — "show me social *and* finance". An empty array is treated
 * as "no filter" rather than "match nothing", so clearing the last chip restores
 * the full list instead of emptying it.
 */
export const assetQuerySchema = z.object({
  category: z.array(z.string().refine(isAssetCategory)).optional(),
  status: z.array(z.enum(ASSET_STATUSES)).optional(),
  source: z.array(z.enum(ASSET_SOURCE_TYPES)).optional(),
  /**
   * "Last reviewed" (frontend §6), expressed as a cutoff: return assets last
   * verified before this instant, including those never verified.
   *
   * Never-verified rows are included deliberately. They are at least as stale as
   * anything verified long ago, and a filter that hid them would conceal exactly
   * the assets most in need of review — the same reasoning R-005 applies to
   * permissions.
   */
  reviewedBefore: z.string().datetime({ offset: true }).optional(),
  /**
   * Free-text search over `service_name` and `service_domain` (ATL-031).
   *
   * Bounded so a pathological term cannot become an expensive pattern, and
   * trimmed so trailing whitespace from a paste does not silently match nothing.
   */
  search: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(ASSET_SORT_ORDERS).default(DEFAULT_ASSET_SORT),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

export type AssetQueryInput = z.input<typeof assetQuerySchema>;

/** A validated query, with the cursor already decoded. */
export interface AssetQuery {
  category?: string[];
  status?: string[];
  source?: string[];
  reviewedBefore?: string;
  search?: string;
  sort: AssetSortOrder;
  limit: number;
  cursor: AssetCursor | null;
}

export interface AssetQueryParseResult {
  success: boolean;
  query: AssetQuery;
}

/**
 * Validates a query, falling back to defaults rather than failing.
 *
 * A list view is a read: the useful response to a filter value that is no longer
 * recognised — a category removed between releases, a hand-edited URL — is the
 * list, not an error. `success` reports whether anything was rejected, so a
 * caller that wants to say "we ignored part of your filter" still can.
 *
 * Empty arrays are normalised away here rather than in the repository, so the
 * query the database sees never contains a predicate that matches nothing.
 */
export function parseAssetQuery(input: unknown): AssetQueryParseResult {
  const result = assetQuerySchema.safeParse(input ?? {});

  if (!result.success) {
    return {
      success: false,
      query: { sort: DEFAULT_ASSET_SORT, limit: DEFAULT_PAGE_SIZE, cursor: null },
    };
  }

  const { category, status, source, reviewedBefore, search, sort, limit, cursor } = result.data;
  const decoded = cursor ? decodeAssetCursor(cursor) : null;

  return {
    // A cursor that failed to decode is the one rejection worth reporting: the
    // caller asked for page three and is getting page one.
    success: cursor ? decoded !== null : true,
    query: {
      ...(category?.length ? { category } : {}),
      ...(status?.length ? { status } : {}),
      ...(source?.length ? { source } : {}),
      ...(reviewedBefore ? { reviewedBefore } : {}),
      ...(search ? { search } : {}),
      sort,
      limit,
      cursor: decoded,
    },
  };
}

/** One page of assets, plus the cursor for the next. */
export interface AssetPage<T> {
  items: T[];
  /** Null when this is the last page. */
  nextCursor: string | null;
}

/**
 * Builds a page from one extra row.
 *
 * The repository fetches `limit + 1`; the presence of that extra row is how
 * "there is more" is known without a second count query. Counting instead would
 * cost a full scan on every page to answer a question the extra row already
 * answers.
 */
export function toAssetPage<T extends { id: string; createdAt: string }>(
  rows: T[],
  limit: number,
): AssetPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last ? encodeAssetCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
