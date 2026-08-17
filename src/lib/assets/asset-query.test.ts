import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSET_SORT,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeAssetCursor,
  encodeAssetCursor,
  parseAssetQuery,
  toAssetPage,
} from "./asset-query";

/**
 * ATL-030 — the list query contract.
 *
 * Everything here arrives from a URL (frontend §6: URL-driven filter state), so
 * the questions are the ones you ask of untrusted input: can a hand-edited value
 * break the list, and can anything sensitive travel in it.
 */

const at = (iso: string, id: string) => ({ createdAt: iso, id });

describe("cursors", () => {
  it("round trips", () => {
    const cursor = at("2026-08-01T10:00:00.000Z", "11111111-1111-4111-8111-111111111111");

    expect(decodeAssetCursor(encodeAssetCursor(cursor))).toEqual(cursor);
  });

  it("survives a URL round trip without escaping", () => {
    // base64url, so the cursor can sit in a query string untouched.
    const encoded = encodeAssetCursor(
      at("2026-08-01T10:00:00.000Z", "11111111-1111-4111-8111-111111111111"),
    );

    expect(encoded).toBe(encodeURIComponent(encoded));
  });

  it.each([
    ["not base64", "!!!!"],
    ["base64 of nonsense", Buffer.from("hello", "utf8").toString("base64url")],
    ["a bare id", Buffer.from(JSON.stringify({ id: "x" }), "utf8").toString("base64url")],
    [
      "a cursor missing its tiebreak",
      Buffer.from(JSON.stringify({ createdAt: "2026-08-01T10:00:00.000Z" }), "utf8").toString(
        "base64url",
      ),
    ],
    [
      "a non-uuid id",
      Buffer.from(
        JSON.stringify({ createdAt: "2026-08-01T10:00:00.000Z", id: "nope" }),
        "utf8",
      ).toString("base64url"),
    ],
    ["an empty string", ""],
  ])("returns null for %s rather than throwing", (_label, value) => {
    expect(decodeAssetCursor(value)).toBeNull();
  });

  it("carries nothing but a timestamp and a row id", () => {
    /**
     * Frontend §6: URL state contains no sensitive values. A cursor is the one
     * piece of list state that is opaque, so it is worth asserting that opacity
     * is not hiding anything.
     */
    const decoded = JSON.parse(
      Buffer.from(
        encodeAssetCursor(at("2026-08-01T10:00:00.000Z", "11111111-1111-4111-8111-111111111111")),
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;

    expect(Object.keys(decoded).sort()).toEqual(["createdAt", "id"]);
  });
});

describe("query parsing", () => {
  it("defaults an empty query", () => {
    const { success, query } = parseAssetQuery({});

    expect(success).toBe(true);
    expect(query.sort).toBe(DEFAULT_ASSET_SORT);
    expect(query.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(query.cursor).toBeNull();
  });

  it("accepts the documented filters", () => {
    const { query } = parseAssetQuery({
      category: ["social", "finance"],
      status: ["active"],
      source: ["manual", "demo"],
      reviewedBefore: "2026-01-01T00:00:00.000Z",
      sort: "oldest",
      limit: 10,
    });

    expect(query.category).toEqual(["social", "finance"]);
    expect(query.status).toEqual(["active"]);
    expect(query.source).toEqual(["manual", "demo"]);
    expect(query.reviewedBefore).toBe("2026-01-01T00:00:00.000Z");
    expect(query.sort).toBe("oldest");
    expect(query.limit).toBe(10);
  });

  it("treats an empty filter array as no filter", () => {
    /**
     * Clearing the last chip must restore the full list. An empty `in ()`
     * predicate would match nothing, so the user would see an empty page and
     * conclude they had no assets.
     */
    const { query } = parseAssetQuery({ category: [], status: [] });

    expect(query.category).toBeUndefined();
    expect(query.status).toBeUndefined();
  });

  it.each([
    ["an unknown category", { category: ["astrological"] }],
    ["an unknown status", { status: ["deleted"] }],
    ["an unknown source", { source: ["scraped"] }],
    ["a non-date reviewedBefore", { reviewedBefore: "last tuesday" }],
    ["an unknown sort", { sort: "alphabetical" }],
    ["a zero limit", { limit: 0 }],
    ["a fractional limit", { limit: 2.5 }],
  ])("falls back to defaults for %s rather than erroring", (_label, input) => {
    /**
     * A list view is a read. The useful answer to a filter value that is no
     * longer recognised — a category removed between releases, a hand-edited
     * URL — is the list, not an error page.
     */
    const { success, query } = parseAssetQuery(input);

    expect(success).toBe(false);
    expect(query.sort).toBe(DEFAULT_ASSET_SORT);
    expect(query.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it("caps the page size so one request cannot scan the table", () => {
    expect(parseAssetQuery({ limit: 5000 }).query.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parseAssetQuery({ limit: MAX_PAGE_SIZE }).query.limit).toBe(MAX_PAGE_SIZE);
  });

  it("reports a rejected cursor while still returning the first page", () => {
    // The one rejection worth telling the caller about: they asked for page
    // three and are getting page one.
    const { success, query } = parseAssetQuery({ cursor: "corrupt" });

    expect(success).toBe(false);
    expect(query.cursor).toBeNull();
  });

  it("accepts a valid cursor", () => {
    const cursor = at("2026-08-01T10:00:00.000Z", "11111111-1111-4111-8111-111111111111");
    const { success, query } = parseAssetQuery({ cursor: encodeAssetCursor(cursor) });

    expect(success).toBe(true);
    expect(query.cursor).toEqual(cursor);
  });

  it("survives null and undefined input", () => {
    expect(parseAssetQuery(undefined).query.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parseAssetQuery(null).query.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  it("does not accept a risk filter, which has no data behind it yet", () => {
    /**
     * Frontend §6 lists risk, but it derives from findings (M6). Accepting the
     * parameter and ignoring it would leave a caller unable to tell a filter
     * that does nothing from one that matched nothing.
     */
    const { query } = parseAssetQuery({ risk: ["high"] });

    expect(query).not.toHaveProperty("risk");
  });
});

describe("paging", () => {
  /** Real UUIDs: the cursor schema requires one, so fixtures must be honest. */
  const ID_A = "11111111-1111-4111-8111-111111111111";
  const ID_B = "22222222-2222-4222-8222-222222222222";
  const ID_C = "33333333-3333-4333-8333-333333333333";

  const row = (id: string, createdAt: string) => ({ id, createdAt });

  it("returns no cursor when the page is not full", () => {
    const page = toAssetPage([row(ID_A, "2026-08-01T10:00:00.000Z")], 10);

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("returns no cursor when the page is exactly full", () => {
    /**
     * Exactly `limit` rows means the extra row was not there, so there is no
     * next page. Emitting a cursor here would give the user an empty page to
     * click through to.
     */
    const rows = [row(ID_A, "2026-08-01T10:00:00.000Z"), row(ID_B, "2026-08-01T09:00:00.000Z")];

    expect(toAssetPage(rows, 2).nextCursor).toBeNull();
  });

  it("trims the extra row and points the cursor at the last kept one", () => {
    const rows = [
      row(ID_A, "2026-08-01T10:00:00.000Z"),
      row(ID_B, "2026-08-01T09:00:00.000Z"),
      row(ID_C, "2026-08-01T08:00:00.000Z"),
    ];

    const page = toAssetPage(rows, 2);

    expect(page.items.map((item) => item.id)).toEqual([ID_A, ID_B]);
    expect(decodeAssetCursor(page.nextCursor as string)).toEqual(
      at("2026-08-01T09:00:00.000Z", ID_B),
    );
  });

  it("handles an empty result", () => {
    expect(toAssetPage([], 10)).toEqual({ items: [], nextCursor: null });
  });
});

/**
 * ATL-036 — the default archived exclusion.
 *
 * The contract is small and the precedence is the whole of it: a surface opts
 * in, and an explicit status overrides the opt-in. Everything else about the
 * query is unchanged, which the cases below assert rather than assume.
 */
describe("excludeArchived", () => {
  it("is off unless a caller asks for it", () => {
    /**
     * The property that keeps ATL-036 out of other surfaces. `parseAssetQuery`
     * is shared with the Insights page's one-row probe, and a default of `true`
     * would have changed that page without anyone deciding to.
     */
    expect(parseAssetQuery({}).query.excludeArchived).toBe(false);
    expect(parseAssetQuery({ limit: 1 }).query.excludeArchived).toBe(false);
  });

  it("applies when a caller opts in and asks for no status", () => {
    const { query } = parseAssetQuery({ excludeArchived: true });

    expect(query.excludeArchived).toBe(true);
    /** Left undefined, so `isFiltered` still means "the user filtered". */
    expect(query.status).toBeUndefined();
  });

  it("yields to an explicit archived filter", () => {
    const { query } = parseAssetQuery({ excludeArchived: true, status: ["archived"] });

    /**
     * The durable path to a restore until ATL-071 exists: selecting `Archived`
     * has to keep working, so the explicit choice wins over the implicit rule.
     */
    expect(query.excludeArchived).toBe(false);
    expect(query.status).toEqual(["archived"]);
  });

  it("yields to any explicit status, not only archived", () => {
    const { query } = parseAssetQuery({ excludeArchived: true, status: ["active"] });

    /**
     * `active` already excludes archived, so the flag would be harmless here —
     * but leaving it on would mean two predicates expressing one intent, and the
     * next status added to the vocabulary would have to reason about both.
     */
    expect(query.excludeArchived).toBe(false);
    expect(query.status).toEqual(["active"]);
  });

  it("yields to a mixed explicit status", () => {
    const { query } = parseAssetQuery({
      excludeArchived: true,
      status: ["active", "inactive"],
    });

    expect(query.excludeArchived).toBe(false);
    expect(query.status).toEqual(["active", "inactive"]);
  });

  it("still applies when the status array is empty", () => {
    /**
     * An empty array is "no filter" everywhere else in this contract — clearing
     * the last chip restores the list rather than emptying it — so it must not
     * count as an explicit choice here either.
     */
    const { query } = parseAssetQuery({ excludeArchived: true, status: [] });

    expect(query.excludeArchived).toBe(true);
    expect(query.status).toBeUndefined();
  });

  it("leaves other filters untouched when it applies", () => {
    const { query } = parseAssetQuery({
      excludeArchived: true,
      category: ["finance"],
      source: ["manual"],
      search: "bank",
    });

    expect(query.excludeArchived).toBe(true);
    expect(query.category).toEqual(["finance"]);
    expect(query.source).toEqual(["manual"]);
    expect(query.search).toBe("bank");
  });

  it("falls back to including everything when the input is rejected", () => {
    /**
     * A malformed query already falls back to "all my assets". Excluding
     * archived on that path would let a bad input quietly hide records, which is
     * a worse failure than showing more than was asked for.
     */
    const { success, query } = parseAssetQuery({ limit: "not-a-number" });

    expect(success).toBe(false);
    expect(query.excludeArchived).toBe(false);
  });
});
