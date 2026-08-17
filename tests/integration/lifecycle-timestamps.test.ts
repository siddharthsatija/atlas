import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-113 — lifecycle timestamps come from the database clock.
 *
 * Against real Postgres, because the defect *was* a disagreement between two
 * real clocks and no double can reproduce that. What is asserted here is the
 * property that makes the race impossible rather than unlikely: the value and
 * the constraint judging it are produced by the same `now()`, in the same
 * transaction.
 *
 * The failure this replaces, from a local E2E run:
 *
 *   ERROR: new row for relation "digital_assets" violates check constraint
 *          "digital_assets_last_verified_not_future"
 *   DETAIL: Failing row contains (..., 2026-08-09 10:12:18.117+00, ...)
 *
 * Eleven of those across two runs, in both tables.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let admin: SupabaseClient<Database>;
let userId: string;
let assetId: string;

/** Far enough ahead that no plausible skew could make it legitimate. */
const CLEARLY_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

beforeAll(async () => {
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-113 requires SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: user, error } = await admin.auth.admin.createUser({
    email: `atl113-${Date.now()}@example.test`,
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`could not create the test user: ${error?.message}`);
  userId = user.user.id;

  const { data: asset, error: assetError } = await admin
    .from("digital_assets")
    .insert({ user_id: userId, service_name: "ATL-113 Service", category: "entertainment" })
    .select("id")
    .single();
  if (assetError || !asset) throw new Error(`could not seed an asset: ${assetError?.message}`);
  assetId = asset.id;
});

afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

describe("marking an asset reviewed", () => {
  it("succeeds without the application supplying a timestamp", async () => {
    // The regression, stated plainly. This is the write that was rejected.
    const { data, error } = await admin
      .from("digital_assets")
      .update({ last_verified_at: "infinity" })
      .eq("id", assetId)
      .select("last_verified_at, updated_at")
      .single();

    expect(error).toBeNull();
    expect(data?.last_verified_at).not.toBe("infinity");
    expect(Number.isNaN(Date.parse(data?.last_verified_at ?? ""))).toBe(false);
  });

  it("writes a time the not-future constraint accepts, by construction", async () => {
    const { data } = await admin
      .from("digital_assets")
      .update({ last_verified_at: "infinity" })
      .eq("id", assetId)
      .select("last_verified_at")
      .single();

    const written = Date.parse(data?.last_verified_at ?? "");

    // Weaker than the constraint itself, which has already passed by getting
    // here — this only guards against a trigger that wrote something absurd.
    expect(written).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(written).toBeGreaterThan(Date.now() - 60_000);
  });

  it("survives repetition, which is where the race used to appear", async () => {
    /**
     * The old failure was timing-dependent: it fired when the round trip was
     * short enough for the transaction to begin before the client's truncated
     * millisecond. Twenty back-to-back reviews is the cheapest way to make a
     * surviving race show itself.
     */
    for (let attempt = 0; attempt < 20; attempt++) {
      const { error } = await admin
        .from("digital_assets")
        .update({ last_verified_at: "infinity" })
        .eq("id", assetId)
        .select("id")
        .single();

      expect(error).toBeNull();
    }
  });

  it("still refuses a genuinely future date from a caller", async () => {
    // The constraint is intact. This is the case it exists for, and the fix
    // must not have widened it into a tolerance.
    const { error } = await admin
      .from("digital_assets")
      .update({ last_verified_at: CLEARLY_FUTURE })
      .eq("id", assetId)
      .select("id");

    expect(error?.code).toBe("23514");
  });

  it("leaves a caller-supplied past date alone", async () => {
    /**
     * Only the sentinel is resolved. Backdating still works, which is what demo
     * seeding and the rule-engine fixtures depend on to produce an aged asset.
     */
    const past = "2020-01-01T00:00:00.000Z";
    const { data, error } = await admin
      .from("digital_assets")
      .update({ last_verified_at: past })
      .eq("id", assetId)
      .select("last_verified_at")
      .single();

    expect(error).toBeNull();
    expect(Date.parse(data?.last_verified_at ?? "")).toBe(Date.parse(past));
  });

  it("maintains updated_at without being asked", async () => {
    const { data: before } = await admin
      .from("digital_assets")
      .select("updated_at")
      .eq("id", assetId)
      .single();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const { data: after } = await admin
      .from("digital_assets")
      .update({ notes: `touched ${Date.now()}` })
      .eq("id", assetId)
      .select("updated_at")
      .single();

    expect(Date.parse(after?.updated_at ?? "")).toBeGreaterThan(
      Date.parse(before?.updated_at ?? ""),
    );
  });
});

describe("closing a finding", () => {
  const seedFinding = async () => {
    const { data, error } = await admin
      .from("privacy_findings")
      .insert({
        user_id: userId,
        asset_id: assetId,
        finding_type: "hygiene",
        dedup_key: `atl113-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title: "ATL-113",
        description: "d",
        severity: "low",
        evidence_summary: "e",
        recommended_action: "a",
        rule_id: "R-001",
        rule_version: "rules-v1",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`could not seed a finding: ${error?.message}`);
    return data.id;
  };

  it.each(["resolved", "dismissed"] as const)(
    "stamps resolved_at on the transition to %s, with no timestamp from the caller",
    async (status) => {
      const findingId = await seedFinding();

      const { data, error } = await admin
        .from("privacy_findings")
        .update({ status, resolved_by: "user" })
        .eq("id", findingId)
        .select("resolved_at, resolved_by, status")
        .single();

      expect(error).toBeNull();
      expect(data?.resolved_at).not.toBeNull();
      expect(data?.status).toBe(status);
      // resolved_by is the caller's, untouched: ADR-004 credits the user only
      // for their own action, and the trigger sets a clock and nothing else.
      expect(data?.resolved_by).toBe("user");
    },
  );

  it("preserves resolved_by = system for the engine's auto-resolution", async () => {
    const findingId = await seedFinding();

    const { data, error } = await admin
      .from("privacy_findings")
      .update({ status: "resolved", resolved_by: "system" })
      .eq("id", findingId)
      .select("resolved_at, resolved_by")
      .single();

    expect(error).toBeNull();
    expect(data?.resolved_by).toBe("system");
    expect(data?.resolved_at).not.toBeNull();
  });

  it("satisfies the resolution-complete constraint without a caller timestamp", async () => {
    // `privacy_findings_resolution_complete` demands resolved_at and
    // resolved_by together. The trigger runs before the check, so supplying
    // only the resolver is now sufficient — and previously was not.
    const findingId = await seedFinding();

    const { error } = await admin
      .from("privacy_findings")
      .update({ status: "resolved", resolved_by: "user" })
      .eq("id", findingId)
      .select("id")
      .single();

    expect(error).toBeNull();
  });

  it("does not stamp a status change that is not a closure", async () => {
    const findingId = await seedFinding();

    const { data } = await admin
      .from("privacy_findings")
      .update({ status: "in_progress" })
      .eq("id", findingId)
      .select("resolved_at")
      .single();

    expect(data?.resolved_at).toBeNull();
  });

  it("leaves a reopened finding with no resolution time", async () => {
    /**
     * ATL-102 reopens a closed finding and must clear both columns together —
     * the resolution-complete constraint refuses an open finding that still
     * names a resolver. Reopening is not a transition *into* a closed status,
     * so the trigger must stay out of the way.
     */
    const findingId = await seedFinding();
    await admin
      .from("privacy_findings")
      .update({ status: "resolved", resolved_by: "system" })
      .eq("id", findingId);

    const { data, error } = await admin
      .from("privacy_findings")
      .update({ status: "open", resolved_by: null, resolved_at: null })
      .eq("id", findingId)
      .select("status, resolved_at, resolved_by")
      .single();

    expect(error).toBeNull();
    expect(data?.status).toBe("open");
    expect(data?.resolved_at).toBeNull();
    expect(data?.resolved_by).toBeNull();
  });

  it("still refuses a future resolved_at supplied on insert", async () => {
    // The not-future constraint is untouched; inserts never reach the trigger.
    const { error } = await admin
      .from("privacy_findings")
      .insert({
        user_id: userId,
        finding_type: "hygiene",
        dedup_key: `atl113-future-${Date.now()}`,
        title: "t",
        description: "d",
        severity: "low",
        evidence_summary: "e",
        recommended_action: "a",
        status: "resolved",
        resolved_by: "user",
        resolved_at: CLEARLY_FUTURE,
      })
      .select("id");

    expect(error?.code).toBe("23514");
  });
});
