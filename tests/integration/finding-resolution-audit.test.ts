import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";
/**
 * Type-only, so it is erased and evaluates nothing — see the note below on why
 * the value imports cannot be at the top of the file.
 */
import type { FindingService } from "@/server/findings/finding-service";

/**
 * ATL-042 — the resolution audit event, through the real audit infrastructure.
 *
 * `finding-service.integration.test.ts` proves the service *asks* for the event,
 * against a fake writer. That is a different claim from the one ADR-006 makes,
 * which is that the record exists: pseudonymisation, the context allowlist, the
 * hash chain, the append-only grant and the `(subject_ref, prev_hash)` unique
 * index are all the database's and none of them can be shown by a double.
 *
 * So nothing here is mocked. The real `FindingService`, the real
 * `PrivacyFindingRepository`, the real `AuditWriter` and the real
 * `AuditEventRepository` run against Postgres, and the assertions read the row
 * back out of `audit_events`.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped audit test reads identically to a
 * passing one.
 *
 * ## Why the server modules are imported inside `beforeAll`
 *
 * `AuditWriter` reaches `@/config/env`, which validates the whole server
 * environment *at module load*. A static import would therefore throw during
 * collection — before any hook runs — and take the rest of the `database`
 * project down with it, reporting a wall of unrelated variables instead of the
 * one thing that is actually wrong. Imported after the guard below, a missing
 * environment produces the same message every other suite in this directory
 * gives, and no other file is affected.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let admin: SupabaseClient<Database>;
let service: FindingService;
/** Bound in `beforeAll`, from the same module the writer uses. */
let subjectRefFor: (userId: string) => string;
let userId: string;
let strangerId: string;
let assetId: string;
/** The pseudonymous chain this user's events live on. There is no `user_id`. */
let subjectRef: string;

/**
 * A finding is not user-authored, so every fixture is seeded as service_role.
 * Unique per call: `unique (user_id, dedup_key)` is what makes §11.1's
 * "fires once per condition" true.
 */
async function seedFinding(owner = userId): Promise<string> {
  const { data, error } = await admin
    .from("privacy_findings")
    .insert({
      user_id: owner,
      asset_id: owner === userId ? assetId : null,
      finding_type: "hygiene",
      rule_id: "R-001",
      rule_version: "rules-v1",
      dedup_key: `atl042-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: "A service has not been reviewed recently",
      description: "You have not confirmed what this service holds about you in over 180 days.",
      severity: "low",
      evidence_summary: "Last reviewed 2025-01-01.",
      recommended_action: "Review what this service holds.",
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`could not seed a finding: ${error?.message}`);
  return data.id;
}

/**
 * Every audit event on this user's chain, oldest first.
 *
 * Ordered on `created_at` rather than `occurred_at`: the latter is an
 * application timestamp with millisecond precision, and two events written in
 * the same millisecond would order arbitrarily. `created_at` is the database's
 * own `now()`, at microsecond precision, which is what makes "the one just
 * written" a well-defined thing to read back.
 */
async function auditEvents(ref = subjectRef) {
  const { data, error } = await admin
    .from("audit_events")
    .select(
      "event_type, actor_type, entity_type, entity_id, context_json, prev_hash, event_hash, created_at",
    )
    .eq("subject_ref", ref)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`could not read audit_events: ${error.message}`);
  return data ?? [];
}

const resolutionEvents = async (ref = subjectRef) =>
  (await auditEvents(ref)).filter((event) => event.event_type === "finding.resolved");

beforeAll(async () => {
  if (!SERVICE_ROLE_KEY || !process.env.AUDIT_HMAC_KEY) {
    throw new Error(
      "ATL-042 audit tests require SUPABASE_SERVICE_ROLE_KEY and AUDIT_HMAC_KEY — the " +
        "second because `subject_ref` is an HMAC of the user id, so without the key there " +
        "is no chain to read. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("audit_events").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.audit_events as service_role at ${SUPABASE_URL}: ` +
        `${reachable.error.message}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  for (const label of ["owner", "stranger"] as const) {
    const { data, error } = await admin.auth.admin.createUser({
      email: `atl042-audit-${label}-${Date.now()}@example.test`,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`could not create ${label}: ${error?.message}`);
    if (label === "owner") userId = data.user.id;
    else strangerId = data.user.id;
  }

  const [findings, activity, audit, score, auditEvent] = await Promise.all([
    import("@/server/findings/finding-service"),
    import("@/server/activity/activity-writer"),
    import("@/server/audit/audit-writer"),
    import("@/server/score/recalculation-queue"),
    import("@/server/audit/audit-event"),
  ]);

  subjectRefFor = auditEvent.subjectRefFor;
  subjectRef = subjectRefFor(userId);

  const { data: asset, error: assetError } = await admin
    .from("digital_assets")
    .insert({ user_id: userId, service_name: "ATL-042 Service", category: "entertainment" })
    .select("id")
    .single();
  if (assetError || !asset) throw new Error(`could not seed an asset: ${assetError?.message}`);
  assetId = asset.id;

  /**
   * The real collaborators, wired explicitly rather than via
   * `FindingService.create()`, so the same service-role client the assertions
   * read with is the one the service writes through. Score recalculation is the
   * no-op seam ADR-004's queue ticket owns; it writes nothing here.
   */
  service = new findings.FindingService(
    admin,
    new activity.ActivityWriter(admin),
    new score.NoopScoreRecalculationQueue(),
    new audit.AuditWriter(admin),
  );
});

afterAll(async () => {
  /**
   * Deleting the user cascades their findings and assets away. `audit_events`
   * deliberately does not cascade — it holds no `user_id`, only the
   * pseudonymous `subject_ref`, and ADR-006 makes the table append-only for
   * every role including this one. The rows are meant to outlive the record.
   */
  for (const id of [userId, strangerId]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

describe("a successful resolution is audited", () => {
  it("writes exactly one event, and it is finding.resolved", async () => {
    const before = (await resolutionEvents()).length;
    const findingId = await seedFinding();

    const result = await service.resolveFinding(userId, findingId, "account_closed");
    expect(result.ok).toBe(true);

    const after = await resolutionEvents();
    expect(after).toHaveLength(before + 1);
  });

  it("records the user as the actor", async () => {
    /**
     * ADR-004 credits a user for their own resolution and the engine's
     * auto-resolution for nothing. An event that could not tell them apart
     * would make the trail useless for exactly the question it exists to
     * answer.
     */
    const findingId = await seedFinding();

    await service.resolveFinding(userId, findingId, "reviewed");

    const event = (await resolutionEvents()).at(-1);
    expect(event?.actor_type).toBe("user");
  });

  it("names the finding it describes", async () => {
    const findingId = await seedFinding();

    await service.resolveFinding(userId, findingId, "data_removed");

    const event = (await resolutionEvents()).at(-1);
    expect(event?.entity_type).toBe("finding");
    expect(event?.entity_id).toBe(findingId);
  });

  it("carries the resolution action, the new status and the rule version", async () => {
    const findingId = await seedFinding();

    await service.resolveFinding(userId, findingId, "permission_revoked");

    const event = (await resolutionEvents()).at(-1);
    expect(event?.context_json).toEqual({
      toStatus: "resolved",
      reason: "permission_revoked",
      ruleVersion: "rules-v1",
    });
  });

  it("carries nothing beyond the allowlist", async () => {
    /**
     * ADR-006 permits versions, non-identifying identifiers, statuses and
     * counts. What must never appear is the finding's own words — a title or a
     * description is the user's data, and `audit_events` is not where it lives.
     */
    const findingId = await seedFinding();

    await service.resolveFinding(userId, findingId, "other");

    const event = (await resolutionEvents()).at(-1);
    const context = (event?.context_json ?? {}) as Record<string, unknown>;

    expect(Object.keys(context).sort()).toEqual(["reason", "ruleVersion", "toStatus"]);
    expect(JSON.stringify(context)).not.toContain("has not been reviewed");
    expect(JSON.stringify(context)).not.toContain(userId);
  });

  it("stores no user id anywhere on the row", async () => {
    // Pseudonymisation is the property, not a nicety: the chain is keyed on an
    // HMAC of the user id, and the id itself must not travel with it.
    const findingId = await seedFinding();

    await service.resolveFinding(userId, findingId, "reviewed");

    const event = (await resolutionEvents()).at(-1);
    expect(JSON.stringify(event)).not.toContain(userId);
    expect(subjectRef).not.toContain(userId);
  });

  it("links onto the subject's existing chain", async () => {
    /**
     * Not a re-test of ATL-103's chaining, which has its own suite — this
     * asserts that the ATL-042 event joins the same chain rather than starting
     * a parallel one, which is the failure a new writer would produce.
     */
    const first = await seedFinding();
    await service.resolveFinding(userId, first, "reviewed");
    const tail = (await auditEvents()).at(-1);

    const second = await seedFinding();
    await service.resolveFinding(userId, second, "reviewed");
    const latest = (await auditEvents()).at(-1);

    expect(latest?.prev_hash).toBe(tail?.event_hash);
    expect(latest?.prev_hash).not.toBe("0".repeat(64));
  });

  it("leaves the resolution recorded on the finding itself", async () => {
    // The audit row and the column must agree; an event describing something
    // the table does not show would be the worse of the two possible drifts.
    const findingId = await seedFinding();

    await service.resolveFinding(userId, findingId, "account_closed");

    const { data } = await admin
      .from("privacy_findings")
      .select("status, resolved_by, resolved_at, resolution_action")
      .eq("id", findingId)
      .single();

    expect(data).toMatchObject({
      status: "resolved",
      resolved_by: "user",
      resolution_action: "account_closed",
    });
    expect(data?.resolved_at).not.toBeNull();
  });
});

describe("a resolution that did not happen is not audited", () => {
  it("writes nothing when the finding is already closed", async () => {
    /**
     * §11.1's lifecycle is one-way. A second close is refused, and an audit
     * event for it would assert a resolution that never occurred — which is
     * precisely the claim the log exists to make trustworthy.
     */
    const findingId = await seedFinding();
    await service.resolveFinding(userId, findingId, "reviewed");

    const before = (await resolutionEvents()).length;
    const second = await service.resolveFinding(userId, findingId, "other");

    expect(second).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(await resolutionEvents()).toHaveLength(before);
  });

  it("writes nothing when the finding does not exist", async () => {
    const before = (await resolutionEvents()).length;

    const result = await service.resolveFinding(
      userId,
      "99999999-9999-4999-8999-999999999999",
      "reviewed",
    );

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await resolutionEvents()).toHaveLength(before);
  });

  it("writes nothing on either chain when the finding belongs to someone else", async () => {
    /**
     * The ownership predicate is what refuses this — service-role bypasses RLS,
     * so nothing else would. Neither the caller's chain nor the owner's may
     * gain an event: one would be a false record, the other a disclosure that
     * the finding exists.
     */
    const strangerRef = subjectRefFor(strangerId);
    const findingId = await seedFinding(strangerId);

    const mine = (await resolutionEvents()).length;
    const theirs = (await resolutionEvents(strangerRef)).length;

    const result = await service.resolveFinding(userId, findingId, "reviewed");

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await resolutionEvents()).toHaveLength(mine);
    expect(await resolutionEvents(strangerRef)).toHaveLength(theirs);
  });

  it("writes nothing for a dismissal", async () => {
    // ADR-006's amended inventory covers resolution only. ATL-043 owns
    // dismissal, and auditing it here would prejudge that ticket's decision.
    const findingId = await seedFinding();

    const before = (await auditEvents()).length;
    const result = await service.dismissFinding(userId, findingId);

    expect(result.ok).toBe(true);
    expect(await auditEvents()).toHaveLength(before);
  });
});
