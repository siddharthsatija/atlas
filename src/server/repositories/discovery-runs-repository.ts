import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { DiscoveryRunStatus, DiscoveryRunView } from "@/lib/discovery/types";

/**
 * Data access for `discovery_runs` (ATL-212).
 *
 * Read-only: this repository does not write runs. Run creation is owned by the
 * discovery dispatch engine, which writes directly via service-role access.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Thrown errors carry no database detail. PostgREST messages can include row
 * values; none must reach a log sink.
 */
export class DiscoveryRunsStoreError extends Error {
  constructor(public readonly operation: string) {
    super(`discovery runs store failed: ${operation}`);
    this.name = "DiscoveryRunsStoreError";
  }
}

/**
 * The persisted `run_status` values from the ATL-201 DB CHECK constraint:
 *   ('pending', 'running', 'completed', 'partial', 'blocked', 'failed')
 *
 * These are NOT the same as the UI `DiscoveryRunStatus` vocabulary.
 * Mapping to UI values is performed in `getLatestRunForUser`.
 */
const KNOWN_DB_RUN_STATUSES = new Set<string>([
  "pending",
  "running",
  "completed",
  "partial",
  "blocked",
  "failed",
]);

export class DiscoveryRunsRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Returns the most-recently-created discovery run for the given user, or
   * `null` when no run exists.
   *
   * "Most recent" is defined by `created_at DESC` — the run that was started
   * latest in wall-clock time. The Discover surface uses this to show the
   * current run status; only one run's status is displayed at a time.
   *
   * The query is scoped by `user_id` — the service-role client bypasses RLS
   * so the ownership filter is enforced here.
   *
   * ## DB → UI status mapping (ATL-212 repair)
   *
   * The persisted `run_status` vocabulary differs from the UI `DiscoveryRunStatus`
   * vocabulary. The mapping is:
   *
   *   DB `pending`   → UI `running`              (transient pre-dispatch state)
   *   DB `running`   → UI `running`
   *   DB `completed` → UI `completed_candidates`  (when ≥1 candidate exists for this run)
   *                  → UI `completed_zero`         (when 0 candidates exist for this run)
   *   DB `partial`   → UI `partial`
   *   DB `blocked`   → UI `blocked`
   *   DB `failed`    → UI `failed`
   *   unknown        → UI `failed`               (guard fallback)
   *
   * The `completed` → candidates/zero derivation requires a 3-hop join:
   *   discovery_runs → discovery_provider_invocations → discovery_evidence → discovery_candidates
   *
   * Throws `DiscoveryRunsStoreError` on any genuine database error.
   */
  async getLatestRunForUser(userId: string): Promise<DiscoveryRunView | null> {
    const { data, error } = await this.db
      .from("discovery_runs")
      .select("id, run_status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new DiscoveryRunsStoreError("getLatestRunForUser");
    if (!data) return null;

    const dbStatus = data.run_status;
    let status: DiscoveryRunStatus;

    if (!KNOWN_DB_RUN_STATUSES.has(dbStatus)) {
      // Guard against unexpected values from the database.
      status = "failed";
    } else if (dbStatus === "pending" || dbStatus === "running") {
      status = "running";
    } else if (dbStatus === "completed") {
      status = await this.deriveCompletedStatus(userId, data.id);
    } else if (dbStatus === "partial" || dbStatus === "blocked" || dbStatus === "failed") {
      status = dbStatus;
    } else {
      // Exhaustive fallback — TypeScript cannot narrow past the Set.has() guard.
      status = "failed";
    }

    return {
      id: data.id,
      status,
      createdAt: data.created_at,
    };
  }

  /**
   * Derives `"completed_candidates"` or `"completed_zero"` for a run whose
   * DB status is `"completed"`, by counting candidates reachable via the 3-hop
   * join:
   *
   *   discovery_runs.id
   *     → discovery_provider_invocations.run_id
   *     → discovery_evidence.invocation_id
   *     → discovery_candidates.evidence_id
   *
   * All queries are scoped by `user_id` (ADR-008 §10 composite FK pattern).
   *
   * Short-circuits to `"completed_zero"` on empty intermediate result sets —
   * these are legitimate data conditions, not errors.
   *
   * Throws `DiscoveryRunsStoreError` on any genuine database error — never
   * silently converts a query failure into `"completed_zero"`.
   */
  private async deriveCompletedStatus(
    userId: string,
    runId: string,
  ): Promise<"completed_candidates" | "completed_zero"> {
    // Hop 1: invocation IDs for this run.
    const { data: invocations, error: invErr } = await this.db
      .from("discovery_provider_invocations")
      .select("id")
      .eq("user_id", userId)
      .eq("run_id", runId);
    if (invErr) throw new DiscoveryRunsStoreError("getLatestRunForUser:completedDerivation");
    if (!invocations || invocations.length === 0) return "completed_zero";

    // Hop 2: evidence IDs from those invocations.
    const { data: evidences, error: evErr } = await this.db
      .from("discovery_evidence")
      .select("id")
      .eq("user_id", userId)
      .in(
        "invocation_id",
        invocations.map((r) => r.id),
      );
    if (evErr) throw new DiscoveryRunsStoreError("getLatestRunForUser:completedDerivation");
    if (!evidences || evidences.length === 0) return "completed_zero";

    // Hop 3: count candidates from that evidence.
    const { count, error: candErr } = await this.db
      .from("discovery_candidates")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in(
        "evidence_id",
        evidences.map((r) => r.id),
      );
    if (candErr) throw new DiscoveryRunsStoreError("getLatestRunForUser:completedDerivation");

    return (count ?? 0) > 0 ? "completed_candidates" : "completed_zero";
  }
}
