import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { DigitalAssetRepository } from "@/server/repositories/digital-asset-repository";
import { AssetDataCategoryRepository } from "@/server/repositories/asset-data-category-repository";
import { AssetPermissionRepository } from "@/server/repositories/asset-permission-repository";
import {
  PrivacyFindingRepository,
  PrivacyFindingStoreError,
} from "@/server/repositories/privacy-finding-repository";
import {
  accountHygieneFactor,
  dataSensitivityFactor,
  openFindingsFactor,
  permissionExposureFactor,
  protectiveActionsFactor,
  verificationFreshnessFactor,
  type ScoreAsset,
  type ScoreDataCategory,
  type ScoreFinding,
} from "@/lib/score/factors";
import {
  combineScore,
  notYetScored,
  type FactorOutcomes,
  type ScoreResult,
} from "@/lib/score/score";
import { REVIEW_WINDOW_DAYS, VERIFICATION_WINDOW_DAYS } from "@/lib/score/score-config";
import { fingerprintOfStored, scoreFingerprint } from "@/lib/score/fingerprint";
import {
  HISTORY_LIMIT,
  latestScoreChange,
  type ScoreDelta,
  type ScoreHistoryEntry,
} from "@/lib/score/score-history";
import {
  PrivacyScoreSnapshotRepository,
  PrivacyScoreSnapshotStoreError,
  type PrivacyScoreSnapshotRecord,
} from "@/server/repositories/privacy-score-snapshot-repository";
import { isHighSensitivity } from "@/lib/assets/data-categories";
import { isBroadExposure } from "@/lib/assets/permissions";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import { logger } from "@/lib/telemetry/logger";

/**
 * PrivacyScoreService — `calculateScore` and `createSnapshot` (ATL-044,
 * ATL-045, ADR-004, architecture §9).
 *
 * `explainScore` and `compareSnapshots` remain ATL-046's; adding empty versions
 * would be placeholders that lie about what exists.
 *
 * ## Write-on-change
 *
 * ADR-004: "recalculation is idempotent; a snapshot is written only when the
 * score or factor breakdown changes". `createSnapshot` calculates, compares
 * against the latest stored snapshot by fingerprint, and writes only on a
 * difference. That is what makes recalculating after an unrelated mutation free
 * rather than a row.
 *
 * **ATL-104's idempotency helper is deliberately not used here**, and the
 * dependency was considered rather than forgotten. `runIdempotent` needs a key
 * that is stable across retries of one invocation and distinct between separate
 * ones. The score fingerprint fails the second test — it would suppress a
 * legitimate return to a previous score (56 → 60 → 56) inside the 24-hour TTL —
 * and nothing at these call sites carries a request or mutation id to key on
 * instead. There is also no retry path to protect: every caller invokes the
 * seam once, logs a failure, and moves on. Write-on-change *is* the idempotency
 * mechanism, and it satisfies the criterion directly.
 *
 * ## Ownership
 *
 * Architecture §10: the user id is the first argument, supplied from a verified
 * session and never from a payload, and every repository read filters on it.
 * This layer runs as service-role and bypasses RLS, so that predicate is the one
 * that counts.
 *
 * ## Demo isolation happens here, not in the factors
 *
 * The snapshot is partitioned before any factor sees it, the same shape ATL-101
 * used for the rule engine: if a real asset exists, demo records are removed
 * entirely — including demo findings — and if only demo records exist, the score
 * is computed over those alone and flagged. A factor therefore cannot mix the
 * two even by accident, and never has to know demo mode exists.
 */

export type ScoreCalculationResult =
  { ok: true; data: ScoreResult } | { ok: false; code: ApiErrorCode };

/** Every record the six factors read, already partitioned by demo status. */
interface ScoreSnapshot {
  assets: ScoreAsset[];
  categories: ScoreDataCategory[];
  permissions: { scope: string; status: string }[];
  findings: ScoreFinding[];
  isDemo: boolean;
}

/** What `createSnapshot` did, so a caller can tell "no change" from "recorded". */
export type SnapshotOutcome =
  | { status: "written"; snapshot: PrivacyScoreSnapshotRecord }
  | { status: "unchanged" }
  /** Cold start, or a calculation that could not run. Nothing is ever written. */
  | { status: "not_scored" };

export type SnapshotResult =
  { ok: true; data: SnapshotOutcome } | { ok: false; code: ApiErrorCode };

/** Retention: full history for this long, then one snapshot per day (§14). */
export const SNAPSHOT_RETENTION_DAYS = 90;

/**
 * What the score detail view needs, in one read (ATL-046).
 *
 * `current` is computed now; `history` is what was recorded. Keeping them
 * separate in the type is what stops a surface treating the newest snapshot as
 * the current score — the distinction ATL-045's cold-start behaviour makes
 * necessary.
 */
export interface ScoreExplanation {
  current: ScoreResult;
  history: ScoreHistoryEntry[];
  /** The most recent recorded change, or null when there is not one to show. */
  delta: ScoreDelta | null;
}

export class PrivacyScoreService {
  private readonly assets: DigitalAssetRepository;
  private readonly categories: AssetDataCategoryRepository;
  private readonly permissions: AssetPermissionRepository;
  private readonly findings: PrivacyFindingRepository;
  private readonly snapshots: PrivacyScoreSnapshotRepository;

  constructor(db: SupabaseClient<Database>) {
    this.assets = new DigitalAssetRepository(db);
    this.categories = new AssetDataCategoryRepository(db);
    this.permissions = new AssetPermissionRepository(db);
    this.findings = new PrivacyFindingRepository(db);
    this.snapshots = new PrivacyScoreSnapshotRepository(db);
  }

  static create(): PrivacyScoreService {
    return new PrivacyScoreService(createServiceRoleClient());
  }

  /**
   * The user's privacy score, or the cold-start state.
   *
   * `now` is injected rather than read: three factors are time-windowed, and a
   * score that could not be computed at a fixed instant could not be tested
   * against ADR-004's worked example.
   */
  async calculateScore(userId: string, now: Date = new Date()): Promise<ScoreCalculationResult> {
    try {
      const snapshot = await this.loadSnapshot(userId);

      /**
       * Cold start (ADR-004, and its edge-case amendment): the score exists only
       * once the user has an **active or inactive** non-demo asset. An archived
       * or removed one does not end it — someone who added a service and then
       * removed it has no current footprint, and scoring an empty one would be
       * a number about nothing.
       */
      if (snapshot === null) return { ok: true, data: notYetScored() };

      return { ok: true, data: combineScore(this.factorOutcomes(snapshot, now), snapshot.isDemo) };
    } catch (error) {
      return this.storeFailure("score.calculate", error);
    }
  }

  /**
   * Calculates and records a snapshot, but only if something changed.
   *
   * ADR-004's write-on-change rule. The comparison is by fingerprint — score,
   * version, demo flag, and each factor's id, exclusion and integer inputs —
   * with no float and no tolerance (see `lib/score/fingerprint.ts`).
   *
   * **Cold start writes nothing**, which ADR-004 states outright, and neither
   * does a failed calculation: a snapshot records a score that was computed, and
   * in both cases there is none. An existing history is left alone rather than
   * being closed off with a synthetic marker — nothing in the documentation
   * describes one, so consumers read current state rather than assuming the
   * latest snapshot is current.
   */
  async createSnapshot(
    userId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<SnapshotResult> {
    const calculated = await this.calculateScore(userId, now);
    if (!calculated.ok) return { ok: false, code: calculated.code };

    const result = calculated.data;
    if (result.status !== "scored") return { ok: true, data: { status: "not_scored" } };

    try {
      const latest = await this.snapshots.findLatest(userId);

      const current = scoreFingerprint({
        score: result.score,
        scoreVersion: result.scoreVersion,
        isDemo: result.isDemo,
        factors: result.factors,
      });

      const previous = latest
        ? fingerprintOfStored({
            score: latest.score,
            scoreVersion: latest.scoreVersion,
            isDemo: latest.isDemo,
            breakdown: latest.breakdown,
          })
        : null;

      if (previous !== null && previous === current)
        return { ok: true, data: { status: "unchanged" } };

      const snapshot = await this.snapshots.record({
        userId,
        score: result.score,
        scoreVersion: result.scoreVersion,
        isDemo: result.isDemo,
        // Stored exactly as calculated: ATL-046 renders this, and a projection
        // here would be a second shape to keep in step with the first.
        breakdown: { factors: result.factors, coverage: result.coverage },
        reason,
      });

      return { ok: true, data: { status: "written", snapshot } };
    } catch (error) {
      return this.storeFailure("score.snapshot", error);
    }
  }

  /**
   * Everything the score detail view renders (ATL-046, §9's `explainScore`).
   *
   * Read-only, and deliberately two reads rather than one:
   *
   *  - **The current score is calculated, never read from a snapshot.** ATL-045
   *    writes no marker when a scored user returns to cold start, so the latest
   *    snapshot can outlive the records it described. Rendering it as "your
   *    score" would be a number about services that no longer exist.
   *  - **History comes from the snapshots**, which is the only place past scores
   *    exist — nothing recomputes them, and ADR-004 forbids it.
   *
   * The two are returned together so the route makes no decision about which is
   * which, and the delta is computed in `lib/` where it can be tested without a
   * database.
   */
  async explainScore(
    userId: string,
    now: Date = new Date(),
  ): Promise<{ ok: true; data: ScoreExplanation } | { ok: false; code: ApiErrorCode }> {
    const calculated = await this.calculateScore(userId, now);
    if (!calculated.ok) return { ok: false, code: calculated.code };

    try {
      const stored = await this.snapshots.listForUser(userId, HISTORY_LIMIT);

      const history: ScoreHistoryEntry[] = stored.map((snapshot) => ({
        id: snapshot.id,
        score: snapshot.score,
        scoreVersion: snapshot.scoreVersion,
        isDemo: snapshot.isDemo,
        reason: snapshot.reason,
        recordedAt: snapshot.recordedAt,
      }));

      return {
        ok: true,
        data: { current: calculated.data, history, delta: latestScoreChange(history) },
      };
    } catch (error) {
      return this.storeFailure("score.explain", error);
    }
  }

  /**
   * Retention compaction (§14, ADR-004): full history for 90 days, then one
   * snapshot per day.
   *
   * Application-side rather than a SQL function. "Keep the last per day" needs a
   * window function, which PostgREST cannot express — but doing it here keeps
   * the retention rule in one testable place instead of splitting it between
   * TypeScript and a database function that only real Postgres can exercise.
   *
   * Batched and resumable: it reads a bounded page of old snapshots, decides
   * which to drop, deletes them, and returns the count. Calling it repeatedly
   * until it returns 0 compacts everything, and calling it twice over the same
   * rows is harmless — the second pass finds nothing left to drop.
   *
   * A day is a UTC calendar day. The **latest** snapshot in each day survives,
   * because that is the state the user ended the day in.
   */
  async compactSnapshots(
    now: Date = new Date(),
    batchSize = 1000,
  ): Promise<{ ok: true; data: number } | { ok: false; code: ApiErrorCode }> {
    const cutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString();

    try {
      const rows = await this.snapshots.listOlderThan(cutoff, batchSize);

      /**
       * The keeper for each `(user, day)` is the newest row in it. Rows arrive
       * oldest first, so each later row for the same day displaces the previous
       * keeper — and the displaced one becomes doomed.
       */
      const keeper = new Map<string, string>();
      const doomed: string[] = [];

      for (const row of rows) {
        const day = `${row.userId}:${row.recordedAt.slice(0, 10)}`;
        const previous = keeper.get(day);
        if (previous !== undefined) doomed.push(previous);
        keeper.set(day, row.id);
      }

      return { ok: true, data: await this.snapshots.deleteByIds(doomed) };
    } catch (error) {
      return this.storeFailure("score.compact", error);
    }
  }

  /**
   * Removes a user's demo snapshots (ATL-083's capability, owned here).
   *
   * ATL-045 supplies it; ATL-083 wires it into the Settings action alongside the
   * other demo rows. A demo score surviving demo removal would be a number about
   * records that no longer exist.
   */
  async deleteDemoSnapshots(
    userId: string,
  ): Promise<{ ok: true; data: number } | { ok: false; code: ApiErrorCode }> {
    try {
      return { ok: true, data: await this.snapshots.deleteDemoForUser(userId) };
    } catch (error) {
      return this.storeFailure("score.demo_purge", error);
    }
  }

  /** Store failures become `UNAVAILABLE`; anything else is a bug and rethrows. */
  private storeFailure(operation: string, error: unknown): { ok: false; code: ApiErrorCode } {
    if (
      !(error instanceof PrivacyScoreSnapshotStoreError) &&
      !(error instanceof PrivacyFindingStoreError)
    ) {
      throw error;
    }

    logger.error("score.store_unavailable", {
      operation,
      provider: "database",
      providerAvailable: false,
    });
    return { ok: false, code: "UNAVAILABLE" };
  }

  /**
   * Reads every record the factors need and partitions it by demo status.
   *
   * Returns `null` for cold start, so the caller has one branch rather than a
   * flag to interpret.
   */
  private async loadSnapshot(userId: string): Promise<ScoreSnapshot | null> {
    const [assets, categories, permissions, findings] = await Promise.all([
      this.assets.listAllForUser(userId),
      this.categories.listForUser(userId),
      this.permissions.listForUser(userId),
      this.findings.listForUser(userId),
    ]);

    /**
     * "Once a real asset exists, the real state takes over" — and cold start
     * counts only active and inactive assets, so the two questions have the
     * same answer and are asked once.
     */
    const realScorable = assets.filter(
      (asset) =>
        asset.sourceType !== "demo" && (asset.status === "active" || asset.status === "inactive"),
    );

    const isDemo = realScorable.length === 0;

    if (isDemo) {
      const demoAssets = assets.filter((asset) => asset.sourceType === "demo");
      // Neither a real footprint nor a demo one: nothing to score at all.
      if (demoAssets.length === 0) return null;

      return this.partition(demoAssets, categories, permissions, findings, true);
    }

    return this.partition(
      assets.filter((asset) => asset.sourceType !== "demo"),
      categories,
      permissions,
      findings,
      false,
    );
  }

  /**
   * Narrows the child records to the assets that survived the demo split.
   *
   * Categories and permissions are scoped by their asset, so partitioning the
   * assets partitions them. Findings carry their own `source_type`, which is
   * what the engine stamps, so they are filtered on it directly — a demo
   * finding must never deduct from a real score.
   */
  private partition(
    assets: readonly { id: string; status: string; lastVerifiedAt: string | null }[],
    categories: readonly { assetId: string; category: string }[],
    permissions: readonly { assetId: string; scope: string; status: string }[],
    findings: readonly {
      severity: string;
      status: string;
      sourceType: string;
      resolvedBy: string | null;
      resolvedAt: string | null;
    }[],
    isDemo: boolean,
  ): ScoreSnapshot {
    const ids = new Set(assets.map((asset) => asset.id));

    return {
      assets: assets.map((asset) => ({
        id: asset.id,
        status: asset.status as ScoreAsset["status"],
        lastVerifiedAt: asset.lastVerifiedAt,
      })),
      categories: categories.filter((entry) => ids.has(entry.assetId)),
      permissions: permissions.filter((entry) => ids.has(entry.assetId)),
      findings: findings
        .filter((finding) =>
          isDemo ? finding.sourceType === "demo" : finding.sourceType !== "demo",
        )
        .map((finding) => ({
          severity: finding.severity as ScoreFinding["severity"],
          status: finding.status as ScoreFinding["status"],
          resolvedBy: finding.resolvedBy as ScoreFinding["resolvedBy"],
          resolvedAt: finding.resolvedAt,
        })),
      isDemo,
    };
  }

  /**
   * Runs the six factors and records the countable inputs behind each.
   *
   * The inputs are ADR-004's "factor-level inputs" requirement and ATL-046's
   * "exact contributors". They are counted here rather than inside the factors
   * so the factors stay single-purpose — a function that both scores and
   * explains is one that eventually disagrees with itself.
   */
  private factorOutcomes(snapshot: ScoreSnapshot, now: Date): FactorOutcomes {
    const { assets, categories, permissions, findings } = snapshot;

    const active = assets.filter((asset) => asset.status === "active");
    const addressable = assets.filter(
      (asset) =>
        asset.status === "inactive" || asset.status === "archived" || asset.status === "removed",
    );
    const verifiable = assets.filter(
      (asset) => asset.status === "active" || asset.status === "inactive",
    );
    const activeIds = new Set(active.map((asset) => asset.id));

    const within = (timestamp: string | null, days: number): boolean => {
      if (!timestamp) return false;
      const value = Date.parse(timestamp);
      return !Number.isNaN(value) && now.getTime() - value <= days * 86_400_000;
    };

    return {
      account_hygiene: {
        value: accountHygieneFactor(assets, now),
        inputs: {
          activeAssets: active.length,
          activeReviewed: active.filter((a) => within(a.lastVerifiedAt, REVIEW_WINDOW_DAYS)).length,
          addressableAssets: addressable.length,
          addressed: addressable.filter((a) => a.status === "archived" || a.status === "removed")
            .length,
        },
      },
      open_findings: {
        value: openFindingsFactor(findings),
        inputs: {
          deductingFindings: findings.filter(
            (f) => f.status === "open" || f.status === "in_progress" || f.status === "dismissed",
          ).length,
        },
      },
      data_sensitivity: {
        value: dataSensitivityFactor(assets, categories),
        inputs: {
          sensitivePairs: categories.filter(
            (c) => activeIds.has(c.assetId) && isHighSensitivity(c.category),
          ).length,
        },
      },
      permission_exposure: {
        value: permissionExposureFactor(permissions),
        inputs: {
          recordedPermissions: permissions.length,
          broadActive: permissions.filter(isBroadExposure).length,
        },
      },
      protective_actions: {
        value: protectiveActionsFactor(findings, now),
        inputs: {
          resolvedByUser: findings.filter(
            (f) => f.status === "resolved" && f.resolvedBy === "user" && within(f.resolvedAt, 180),
          ).length,
          /** M8 has no `data_requests` table, so nothing can supply one. */
          completedRequests: 0,
        },
      },
      verification_freshness: {
        value: verificationFreshnessFactor(assets, now),
        inputs: {
          verifiableAssets: verifiable.length,
          verifiedRecently: verifiable.filter((a) =>
            within(a.lastVerifiedAt, VERIFICATION_WINDOW_DAYS),
          ).length,
        },
      },
    };
  }
}
