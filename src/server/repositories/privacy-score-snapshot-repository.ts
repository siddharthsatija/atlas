import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `privacy_score_snapshots` (ATL-045).
 *
 * ## There is no update method, and that is enforced twice
 *
 * ADR-004: "historical snapshots are never recomputed." The migration withholds
 * the `update` privilege from `service_role`, so the database refuses one; this
 * class simply offers no way to ask. Either alone would be a rule someone could
 * work around — together they mean a snapshot cannot be rewritten by a mistake
 * at any layer.
 *
 * The three destructive paths are all deliberate and all deletes: retention
 * compaction (§14), the demo purge (ATL-083), and the `auth.users` cascade.
 *
 * ## No timestamps are ever sent
 *
 * `recorded_at` defaults to the database clock and the application never
 * supplies it (ATL-113). Backdating is still possible for fixtures, which is
 * what the compaction tests use, but no production path does it.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to skip the first — and here they are read-only, so every write
 * in Atlas reaches this table through this file.
 */

export type PrivacyScoreSnapshotRow =
  Database["public"]["Tables"]["privacy_score_snapshots"]["Row"];

export interface PrivacyScoreSnapshotRecord {
  id: string;
  userId: string;
  score: number;
  scoreVersion: string;
  isDemo: boolean;
  /** ATL-044's `ScoreResult` breakdown, stored and returned unchanged. */
  breakdown: unknown;
  reason: string;
  recordedAt: string;
}

function toRecord(row: PrivacyScoreSnapshotRow): PrivacyScoreSnapshotRecord {
  return {
    id: row.id,
    userId: row.user_id,
    score: row.score,
    scoreVersion: row.score_version,
    isDemo: row.is_demo,
    breakdown: row.factor_breakdown_json,
    reason: row.reason,
    recordedAt: row.recorded_at,
  };
}

/** Raised for any snapshot storage failure. Carries no database detail. */
export class PrivacyScoreSnapshotStoreError extends Error {
  constructor() {
    super("privacy score snapshot store unavailable");
    this.name = "PrivacyScoreSnapshotStoreError";
  }
}

export interface RecordSnapshotInput {
  userId: string;
  score: number;
  scoreVersion: string;
  isDemo: boolean;
  breakdown: unknown;
  reason: string;
}

/** One row's identity and age, for compaction. Deliberately not the whole row. */
export interface SnapshotAgeRow {
  id: string;
  userId: string;
  recordedAt: string;
}

export class PrivacyScoreSnapshotRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /** Appends one snapshot. No `recorded_at`: the database stamps it. */
  async record(input: RecordSnapshotInput): Promise<PrivacyScoreSnapshotRecord> {
    const { data, error } = await this.db
      .from("privacy_score_snapshots")
      .insert({
        user_id: input.userId,
        score: input.score,
        score_version: input.scoreVersion,
        is_demo: input.isDemo,
        factor_breakdown_json: input.breakdown as never,
        reason: input.reason,
      })
      .select("*")
      .single();

    if (error || !data) throw new PrivacyScoreSnapshotStoreError();
    return toRecord(data);
  }

  /**
   * The most recent snapshot, or null.
   *
   * What write-on-change compares against. Ordered on `(recorded_at desc, id
   * desc)` — the total ordering the index matches — so two snapshots recorded in
   * the same microsecond cannot swap places between requests and make "latest"
   * ambiguous.
   */
  async findLatest(userId: string): Promise<PrivacyScoreSnapshotRecord | null> {
    const { data, error } = await this.db
      .from("privacy_score_snapshots")
      .select("*")
      .eq("user_id", userId)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new PrivacyScoreSnapshotStoreError();
    return data ? toRecord(data) : null;
  }

  /** A user's history, newest first (ATL-046 reads this). */
  async listForUser(userId: string, limit = 100): Promise<PrivacyScoreSnapshotRecord[]> {
    const { data, error } = await this.db
      .from("privacy_score_snapshots")
      .select("*")
      .eq("user_id", userId)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (error) throw new PrivacyScoreSnapshotStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Snapshot ids and ages older than `before`, oldest first.
   *
   * Compaction's read half. Only three columns, because deciding which rows to
   * keep needs an id, an owner and a time — pulling whole breakdowns to throw
   * them away would move a lot of JSON for nothing.
   */
  async listOlderThan(before: string, limit: number): Promise<SnapshotAgeRow[]> {
    const { data, error } = await this.db
      .from("privacy_score_snapshots")
      .select("id, user_id, recorded_at")
      .lt("recorded_at", before)
      .order("recorded_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw new PrivacyScoreSnapshotStoreError();
    return (data ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      recordedAt: row.recorded_at,
    }));
  }

  /** Deletes the named snapshots. Compaction's write half. */
  async deleteByIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const { data, error } = await this.db
      .from("privacy_score_snapshots")
      .delete()
      .in("id", [...ids])
      .select("id");

    if (error) throw new PrivacyScoreSnapshotStoreError();
    return (data ?? []).length;
  }

  /**
   * Removes a user's demo snapshots — ATL-083's one-action demo removal.
   *
   * Scoped to `is_demo`, so a real history is untouched. A demo score surviving
   * demo removal would be a number about records that no longer exist.
   */
  async deleteDemoForUser(userId: string): Promise<number> {
    const { data, error } = await this.db
      .from("privacy_score_snapshots")
      .delete()
      .eq("user_id", userId)
      .eq("is_demo", true)
      .select("id");

    if (error) throw new PrivacyScoreSnapshotStoreError();
    return (data ?? []).length;
  }
}
