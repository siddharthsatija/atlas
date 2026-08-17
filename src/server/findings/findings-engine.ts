import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { ActivityWriter } from "@/server/activity/activity-writer";
import {
  PrivacyFindingRepository,
  PrivacyFindingStoreError,
  type PrivacyFindingRecord,
} from "@/server/repositories/privacy-finding-repository";
import { DigitalAssetRepository } from "@/server/repositories/digital-asset-repository";
import { AssetDataCategoryRepository } from "@/server/repositories/asset-data-category-repository";
import { AssetPermissionRepository } from "@/server/repositories/asset-permission-repository";
import { RULE_CATALOG, RULES_VERSION, sourceReferenceFor } from "@/lib/findings/rules/catalog";
import { deriveConfidence } from "@/lib/findings/confidence";
import type { EvaluatedCandidate, RuleInputs } from "@/lib/findings/rules/types";
import type { FindingSourceType } from "@/lib/findings/findings";
import { isOpenFinding } from "@/lib/findings/findings";
import { logger } from "@/lib/telemetry/logger";
import { dedupKey } from "./dedup";
import { inputHash, inputsChanged } from "./input-hash";
import {
  NoopScoreRecalculationQueue,
  SnapshotScoreRecalculationQueue,
  type ScoreRecalculationQueue,
} from "@/server/score/recalculation-queue";
import { PrivacyScoreService } from "@/server/score/privacy-score-service";

/**
 * The findings rule engine (ATL-101, architecture §11.1, ADR-001).
 *
 * The four operations architecture §9 names — `evaluateRules`,
 * `generateFindings`, `autoResolveFindings`, `runNightlySweep` — over the
 * catalog in `src/lib/findings/rules/`.
 *
 * ## The split, and why it is load-bearing
 *
 * Rules are pure and live in `lib/`. They receive a snapshot and return what
 * they concluded. Everything that requires knowing the world — loading records,
 * hashing dedup keys, deciding whether a conclusion is new, writing rows,
 * resolving findings whose condition cleared — lives here. A rule cannot reach a
 * database even by accident, which is what makes ADR-001's table-driven tests
 * possible and what stops rule logic drifting into query logic.
 *
 * ## Idempotency
 *
 * §14 requires jobs to be idempotent, and this one is by construction rather
 * than by convention. Every evaluation produces a set of dedup keys; a key that
 * already has a finding is left alone whatever its status, and an open finding
 * whose key is absent from this evaluation is auto-resolved. Running twice
 * changes nothing the first run did not.
 *
 * ## Demo isolation
 *
 * §11.1: rules run over demo records only in demo mode, and their findings carry
 * `source_type = demo`. §11.2 forbids demo and real records mixing in one
 * calculation. Both are enforced here by partitioning the snapshot before
 * evaluation, so a rule never sees a mixture and cannot produce a finding drawn
 * from both.
 */

/** What one evaluation did, for the caller and the log. */
export interface RecomputeOutcome {
  opened: number;
  autoResolved: number;
  unchanged: number;
  /** Dismissed or resolved findings whose inputs changed and which returned (ATL-102). */
  reopened: number;
}

export class FindingsEngine {
  private readonly findings: PrivacyFindingRepository;
  private readonly assets: DigitalAssetRepository;
  private readonly categories: AssetDataCategoryRepository;
  private readonly permissions: AssetPermissionRepository;
  private readonly activity: ActivityWriter;
  private readonly score: ScoreRecalculationQueue;

  constructor(
    db: SupabaseClient<Database>,
    activity?: ActivityWriter,
    score?: ScoreRecalculationQueue,
  ) {
    this.findings = new PrivacyFindingRepository(db);
    this.assets = new DigitalAssetRepository(db);
    this.categories = new AssetDataCategoryRepository(db);
    this.permissions = new AssetPermissionRepository(db);
    this.activity = activity ?? new ActivityWriter(db);
    this.score = score ?? new NoopScoreRecalculationQueue();
  }

  static create(): FindingsEngine {
    const db = createServiceRoleClient();
    // ATL-045: opening or auto-resolving a finding now moves the score.
    return new FindingsEngine(
      db,
      new ActivityWriter(db),
      new SnapshotScoreRecalculationQueue(new PrivacyScoreService(db)),
    );
  }

  /**
   * Runs the catalog over a snapshot and returns what fired.
   *
   * Pure apart from the confidence derivation it applies: no reads, no writes.
   * Exposed separately from `generateFindings` so the catalog can be exercised
   * against a hand-built snapshot, which is how the rule tests work.
   */
  evaluateRules(inputs: RuleInputs): EvaluatedCandidate[] {
    return RULE_CATALOG.flatMap((rule) =>
      rule.evaluate(inputs).map((candidate) => ({
        ...candidate,
        ruleId: rule.id,
        findingType: rule.type,
        recommendedAction: rule.recommendedAction,
        confidence: deriveConfidence(candidate.inputs, inputs.now),
      })),
    );
  }

  /**
   * Evaluates one user and reconciles the result with what is already stored.
   *
   * The whole of §11.1's lifecycle in one pass: open what is new, leave what is
   * unchanged, auto-resolve what no longer holds. Splitting open and resolve
   * into separate passes would let a mutation briefly show a user a finding that
   * had already stopped being true.
   */
  async generateFindings(userId: string, now: Date = new Date()): Promise<RecomputeOutcome> {
    const { inputs, sourceType } = await this.loadSnapshot(userId, now);

    const candidates = this.evaluateRules(inputs);
    const existing = await this.findings.listForUser(userId);
    const byKey = new Map(existing.map((finding) => [finding.dedupKey, finding]));

    const outcome: RecomputeOutcome = { opened: 0, autoResolved: 0, unchanged: 0, reopened: 0 };
    const firedKeys = new Set<string>();

    for (const candidate of candidates) {
      const key = dedupKey(candidate.ruleId, candidate.evidence);
      const hash = inputHash(candidate.evidence, inputs);
      firedKeys.add(key);

      const existing = byKey.get(key);
      if (!existing) {
        await this.open(userId, candidate, key, sourceType, hash);
        outcome.opened += 1;
        continue;
      }

      if (await this.reconcile(userId, existing, candidate, hash)) outcome.reopened += 1;
      else outcome.unchanged += 1;
    }

    outcome.autoResolved = await this.autoResolveFindings(userId, firedKeys, existing);

    if (outcome.opened > 0 || outcome.autoResolved > 0 || outcome.reopened > 0) {
      await this.enqueueScore(userId);
    }

    logger.debug("findings.recompute_completed", {
      operation: "findings.recompute",
      count: outcome.opened + outcome.autoResolved + outcome.reopened,
      provider: "findings",
      providerAvailable: true,
    });

    return outcome;
  }

  /**
   * Resolves open findings whose condition no longer holds.
   *
   * `resolved_by = 'system'` (§11.1), which is what distinguishes "it no longer
   * applies" from "you fixed it" — ADR-004's protective-actions factor counts
   * resolutions, so recording the wrong author would credit a user for something
   * that simply expired.
   *
   * Dismissed and already-resolved findings are untouched: their condition
   * clearing is not a second ending.
   */
  async autoResolveFindings(
    userId: string,
    firedKeys: ReadonlySet<string>,
    existing?: readonly PrivacyFindingRecord[],
  ): Promise<number> {
    const findings = existing ?? (await this.findings.listForUser(userId));
    let resolved = 0;

    for (const finding of findings) {
      if (!isOpenFinding(finding.status)) continue;
      if (firedKeys.has(finding.dedupKey)) continue;

      const closed = await this.findings.close(userId, finding.id, "resolved", "system");
      if (!closed) continue;

      resolved += 1;
      await this.writeActivity("finding.auto_resolved", finding);
    }

    return resolved;
  }

  /**
   * The nightly sweep (§11.1, §14).
   *
   * Time-based predicates — R-001's 180 days, R-005's 365 — become true with the
   * passage of time rather than with a mutation, so nothing would trigger them
   * without this. It is the same evaluation as a recompute, which is why it
   * needs no separate logic: the rules are pure functions of a snapshot *and a
   * time*, and the sweep simply supplies a later time.
   *
   * A **callable entry point, not a scheduler.** No cron, queue table, or job
   * runner is specified anywhere in the documentation, and inventing one is not
   * this ticket's to make. A scheduling ticket calls this.
   */
  async runNightlySweep(userIds: readonly string[], now: Date = new Date()): Promise<number> {
    let evaluated = 0;

    for (const userId of userIds) {
      try {
        await this.generateFindings(userId, now);
        evaluated += 1;
      } catch (error) {
        /**
         * One user's failure must not end the sweep. §14 requires jobs to be
         * observable; the count and the operation are logged, never the user id
         * (architecture §10 forbids internal record identifiers in logs).
         */
        if (!(error instanceof PrivacyFindingStoreError)) throw error;
        logger.error("findings.sweep_user_failed", {
          operation: "findings.sweep",
          count: 1,
          provider: "database",
          providerAvailable: false,
        });
      }
    }

    return evaluated;
  }

  /**
   * Loads the user's records and partitions them by demo mode.
   *
   * §11.1 and §11.2 both require demo and real records never to mix. Filtering
   * here rather than inside the rules means no rule can forget to, and a rule
   * never has to know demo mode exists.
   */
  private async loadSnapshot(
    userId: string,
    now: Date,
  ): Promise<{ inputs: RuleInputs; sourceType: FindingSourceType }> {
    const [assets, categories, permissions] = await Promise.all([
      this.assets.listAllForUser(userId),
      this.categories.listForUser(userId),
      this.permissions.listForUser(userId),
    ]);

    /**
     * Demo mode is a property of the records, not a flag read separately: if the
     * user has demo assets, those are what the rules run over. Reading
     * `profiles.demo_data_enabled` as well would introduce a second source of
     * truth that can disagree with the rows actually present.
     */
    const demoAssets = assets.filter((asset) => asset.sourceType === "demo");
    const inDemoMode = demoAssets.length > 0;
    const scopedAssets = inDemoMode ? demoAssets : assets.filter((a) => a.sourceType !== "demo");
    const assetIds = new Set(scopedAssets.map((asset) => asset.id));

    return {
      sourceType: inDemoMode ? "demo" : "manual",
      inputs: {
        now,
        assets: scopedAssets.map((asset) => ({
          id: asset.id,
          serviceName: asset.serviceName,
          category: asset.category,
          status: asset.status,
          sourceType: asset.sourceType,
          lastVerifiedAt: asset.lastVerifiedAt,
          createdAt: asset.createdAt,
        })),
        dataCategories: categories
          .filter((category) => assetIds.has(category.assetId))
          .map((category) => ({
            id: category.id,
            assetId: category.assetId,
            category: category.category,
            sensitivity: category.sensitivity,
            createdAt: category.createdAt,
          })),
        permissions: permissions
          .filter((permission) => assetIds.has(permission.assetId))
          .map((permission) => ({
            id: permission.id,
            assetId: permission.assetId,
            permissionType: permission.permissionType,
            scope: permission.scope,
            status: permission.status,
            lastVerifiedAt: permission.lastVerifiedAt,
            createdAt: permission.createdAt,
          })),
      },
    };
  }

  /**
   * Decides what to do with a condition that has fired again (ATL-102).
   *
   * §11.1: "a dismissed finding is not re-raised for the same `dedup_key` unless
   * the rule inputs materially change (input hash changes)". Four cases, and
   * only one of them reopens anything:
   *
   *  1. **Still open or in progress.** Nothing to do — the finding is already
   *     saying what the rule is saying. Its severity is left alone rather than
   *     rewritten on every sweep, so an escalation is a change the user can see
   *     rather than a silent overwrite.
   *  2. **Closed, inputs unchanged.** Left closed. This is the case that
   *     respects a dismissal: the user said they had dealt with it, and nothing
   *     about their records has changed since.
   *  3. **Closed, no stored hash.** The finding predates ATL-102, so there is
   *     nothing to compare. Recording the hash without touching the status
   *     resolves the ambiguity once, in the direction that never overrides a
   *     dismissal the user made deliberately.
   *  4. **Closed, inputs changed.** Reopened — the condition is true again *and*
   *     the records underneath it are different, which is exactly what §11.1
   *     means by materially changed.
   *
   * Returns whether the finding was reopened.
   */
  private async reconcile(
    userId: string,
    existing: PrivacyFindingRecord,
    candidate: EvaluatedCandidate,
    hash: string,
  ): Promise<boolean> {
    if (isOpenFinding(existing.status)) return false;

    if (!inputsChanged(existing.inputHash, hash)) {
      // Case 3: record the hash so the next evaluation has something to compare.
      // Case 2 writes nothing at all.
      if (existing.inputHash === null) await this.findings.setInputHash(userId, existing.id, hash);
      return false;
    }

    /**
     * Reopens the existing row rather than inserting a second.
     * ATL-038's `unique (user_id, dedup_key)` makes a duplicate impossible, and
     * that is the right shape: ADR-004 counts open findings, so a returning
     * condition should restore one deduction rather than accumulate two.
     *
     * Severity and confidence are refreshed because both are derived from the
     * inputs that just changed — a finding that returned at its old severity
     * would describe a state that no longer exists.
     */
    const reopened = await this.findings.reopen(userId, existing.id, {
      severity: candidate.severity,
      confidence: candidate.confidence,
      inputHash: hash,
    });
    if (!reopened) return false;

    await this.writeActivity("finding.opened", reopened);
    return true;
  }

  /** Writes one new finding and puts it on the user's timeline. */
  private async open(
    userId: string,
    candidate: EvaluatedCandidate,
    key: string,
    sourceType: FindingSourceType,
    hash: string,
  ): Promise<void> {
    const finding = await this.findings.record({
      userId,
      assetId: candidate.assetId,
      findingType: candidate.findingType,
      ruleId: candidate.ruleId,
      ruleVersion: RULES_VERSION,
      dedupKey: key,
      title: candidate.title,
      description: candidate.description,
      severity: candidate.severity,
      confidence: candidate.confidence,
      sourceType,
      sourceReference: sourceReferenceFor(candidate.ruleId),
      evidenceSummary: candidate.evidenceSummary,
      evidenceRefs: { ...candidate.evidence },
      recommendedAction: candidate.recommendedAction,
      inputHash: hash,
    });

    await this.writeActivity("finding.opened", finding);
  }

  /**
   * Timeline entries for findings opening and resolving themselves.
   *
   * Best effort, and caught: §11.1 asks for the event, but a timeline write that
   * failed must not undo a finding the rules correctly produced. The same
   * decision `AssetService.afterMutation` makes, for the same reason.
   */
  private async writeActivity(
    type: "finding.opened" | "finding.auto_resolved",
    finding: PrivacyFindingRecord,
  ): Promise<void> {
    try {
      await this.activity.write({
        userId: finding.userId,
        type,
        // `severity` and `service` are both in ATL-069's metadata allowlist. No
        // title, no description, no evidence — the timeline says what happened,
        // and the finding itself says what it was.
        params: { severity: finding.severity },
        entityType: "finding",
        entityId: finding.id,
        // Every key below is in ATL-069's allowlist. `ruleVersion` is what lets
        // someone reading an old timeline entry know which catalog produced it.
        metadata: {
          severity: finding.severity,
          status: finding.status,
          ...(finding.ruleVersion ? { ruleVersion: finding.ruleVersion } : {}),
          isDemo: finding.sourceType === "demo",
        },
      });
    } catch {
      logger.error("activity.write_failed", { operation: type, count: 1 });
    }
  }

  /** Score recalculation, caught for the same reason activity is (§11.2 triggers). */
  private async enqueueScore(userId: string): Promise<void> {
    try {
      await this.score.enqueue({ userId, reason: "finding.changed" });
    } catch {
      logger.error("score.recalculation_enqueue_failed", {
        operation: "finding.changed",
        count: 1,
      });
    }
  }
}
