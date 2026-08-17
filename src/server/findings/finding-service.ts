import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { ActivityWriter } from "@/server/activity/activity-writer";
import { AuditWriter } from "@/server/audit/audit-writer";
import {
  PrivacyFindingRepository,
  PrivacyFindingStoreError,
  type PrivacyFindingRecord,
} from "@/server/repositories/privacy-finding-repository";
import { DigitalAssetRepository } from "@/server/repositories/digital-asset-repository";
import { AssetDataCategoryRepository } from "@/server/repositories/asset-data-category-repository";
import { AssetPermissionRepository } from "@/server/repositories/asset-permission-repository";
import {
  NoopScoreRecalculationQueue,
  SnapshotScoreRecalculationQueue,
  type ScoreRecalculationQueue,
} from "@/server/score/recalculation-queue";
import { PrivacyScoreService } from "@/server/score/privacy-score-service";
import { isOpenFinding, type FindingSeverity, type FindingStatus } from "@/lib/findings/findings";
import { recommendedFindings, sortByRecommendation } from "@/lib/findings/recommendation";
import type { ResolutionAction } from "@/lib/findings/resolution-actions";
import type { DismissalReason } from "@/lib/findings/dismissal-reasons";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import { logger } from "@/lib/telemetry/logger";

/**
 * FindingService (ATL-039, architecture §9).
 *
 * The five operations §9 names — `listFindings`, `getFinding`, `resolveFinding`,
 * `dismissFinding`, `calculateRecommendations` — plus `getFindingDetail`
 * (ATL-041, a read) and `undismissFinding` (ATL-043).
 *
 * `undismissFinding` is the one addition that changes state, and it is not an
 * invention: ATL-043's acceptance criteria require undo explicitly, and §11.1's
 * lifecycle already has an `open` state to return to. §9's list is amended in
 * the architecture document rather than quietly exceeded here.
 *
 * ## What separates this from the engine
 *
 * `FindingsEngine` (ATL-101/102) is the system acting on its own conclusions: it
 * opens findings, reopens them, and auto-resolves them with
 * `resolved_by = 'system'`. This service is the *user* acting, and it writes
 * `resolved_by = 'user'` — never `'system'`. ADR-004's protective-actions factor
 * credits resolutions, so the two must stay distinguishable: crediting a user
 * for a condition that simply expired would pay them for doing nothing.
 *
 * Nothing here evaluates a rule, and nothing in the engine reads this file.
 *
 * ## Ownership, twice
 *
 * Architecture §10: every method takes the user id as its first argument,
 * supplied from a verified session and never from a payload, and the repository
 * filters on it in every query. RLS is the second gate — and unusually narrow
 * here, since `authenticated` may only `select` — but this layer runs as
 * service-role and bypasses it, so the predicate above is the one that counts.
 *
 * ## Missing and foreign look identical
 *
 * Every method answers `NOT_FOUND` for a finding that does not exist *and* for
 * one belonging to somebody else, the same non-oracle rule `AssetService`
 * follows: a `FORBIDDEN` on a record you do not own confirms it exists.
 */

/**
 * The label shown where a service name would be, for findings about the user's
 * whole footprint rather than one record (today, only R-008).
 *
 * Resolved in the service so every caller — list, detail, recommendations —
 * receives the same value and no surface has to special-case a null asset.
 * `asset_id` stays null in the database: this is presentation, not persistence.
 */
export const FOOTPRINT_WIDE_LABEL = "Entire digital footprint";

/**
 * A finding as a surface renders it: the stored record plus the one field that
 * cannot be stored on it.
 *
 * Read-only and derived. Nothing writes `impactedAsset`, and the mutation
 * methods deliberately keep returning the plain record — a resolve returns what
 * changed, not what to draw.
 */
export interface FindingView extends PrivacyFindingRecord {
  /** The impacted service's name, or `FOOTPRINT_WIDE_LABEL` when there is none. */
  impactedAsset: string;
}

/**
 * One record a rule read, resolved for display (ATL-041).
 *
 * ADR-001 requires a finding to cite its input records, and
 * `evidence_refs_json` stores their ids — identifiers only, never values. A
 * bare UUID tells a user nothing, so the service resolves each one to
 * something nameable and to the surface where it can actually be seen.
 */
export interface EvidenceRecord {
  id: string;
  kind: "asset" | "dataCategory" | "permission";
  /** What the record is, in the user's words. Never an identifier. */
  label: string;
  /** Where the record is visible, or null when it no longer exists. */
  href: string | null;
}

/** A finding with everything ATL-041's panel needs, all of it read-only. */
export interface FindingDetail extends FindingView {
  evidenceRecords: EvidenceRecord[];
}

export type FindingResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode };

const ok = <T>(data: T): FindingResult<T> => ({ ok: true, data });
const fail = <T>(code: ApiErrorCode): FindingResult<T> => ({ ok: false, code });

/**
 * Filters for `listFindings`. Both are optional and combine with AND.
 *
 * Applied in memory rather than in SQL: a user's findings are bounded by their
 * own records — a few dozen at most — and the recommended ordering has to be
 * applied to the whole filtered set anyway, since severity rank is not a
 * database sort. Pushing the filter down while sorting up here would split one
 * decision across two layers for no gain.
 */
export interface FindingQuery {
  status?: FindingStatus;
  severity?: FindingSeverity;
}

export class FindingService {
  private readonly findings: PrivacyFindingRepository;
  /**
   * Read-only, and only for the impacted-asset label.
   *
   * Reusing the existing repository rather than re-querying `digital_assets`
   * here: the name lookup already exists, and a second implementation would be
   * a second thing to keep in step with ATL-027's shape.
   */
  private readonly assets: DigitalAssetRepository;
  /** Read-only, and only to name the records a rule read (ATL-041). */
  private readonly categories: AssetDataCategoryRepository;
  private readonly permissions: AssetPermissionRepository;
  private readonly activity: ActivityWriter;
  /**
   * Security-side record of a user resolution (ATL-042, ADR-006).
   *
   * Distinct from `activity`: §12 reserves `audit_events` for security and
   * incident response, pseudonymises the subject, and allows no client access.
   * The two are written from one place so they cannot drift apart.
   */
  private readonly audit: AuditWriter;
  private readonly score: ScoreRecalculationQueue;

  constructor(
    db: SupabaseClient<Database>,
    activity?: ActivityWriter,
    score?: ScoreRecalculationQueue,
    audit?: AuditWriter,
  ) {
    this.findings = new PrivacyFindingRepository(db);
    this.assets = new DigitalAssetRepository(db);
    this.categories = new AssetDataCategoryRepository(db);
    this.permissions = new AssetPermissionRepository(db);
    this.activity = activity ?? new ActivityWriter(db);
    this.audit = audit ?? new AuditWriter(db);
    this.score = score ?? new NoopScoreRecalculationQueue();
  }

  static create(): FindingService {
    const db = createServiceRoleClient();
    // ATL-045: a resolution or dismissal now recalculates the score and records
    // a snapshot when it changed.
    return new FindingService(
      db,
      new ActivityWriter(db),
      new SnapshotScoreRecalculationQueue(new PrivacyScoreService(db)),
    );
  }

  /**
   * The user's findings, filtered and in recommended order.
   *
   * Ordered even when filtered to `resolved` or `dismissed`: frontend §8's other
   * views show the same cards, and a list that reordered itself depending on
   * which tab you were on would be harder to read, not easier.
   */
  async listFindings(
    userId: string,
    query: FindingQuery = {},
  ): Promise<FindingResult<FindingView[]>> {
    try {
      const all = await this.findings.listForUser(userId);

      const filtered = all.filter(
        (finding) =>
          (query.status === undefined || finding.status === query.status) &&
          (query.severity === undefined || finding.severity === query.severity),
      );

      return ok(await this.withImpactedAsset(userId, sortByRecommendation(filtered)));
    } catch (error) {
      return this.storeFailure("finding.list", error);
    }
  }

  /**
   * One asset's live findings, for the detail page's findings section (ATL-034).
   *
   * ## Why this is not `listFindings({ assetId })`
   *
   * Three artefacts written before this ticket already decided what this section
   * shows, and adding a query filter would have contradicted all three.
   * `listOpenForAsset` exists and says so in its own comment; the partial index
   * `privacy_findings_asset_open_idx` is restricted to `open` and `in_progress`
   * with the note that "a resolved finding does not belong in that section"; and
   * `OPEN_FINDING_STATUSES` names the pair.
   *
   * A `FindingQuery.assetId` would also have filtered in memory after fetching
   * every finding the user has — `listFindings` does that deliberately for
   * `status` and `severity`, because the Insights page needs the whole set
   * anyway. A detail page does not, and the partial index exists precisely so
   * this read does not have to.
   *
   * ## What it excludes, and why each exclusion is correct
   *
   *   - **`resolved` and `dismissed`** — the schema comment's own reasoning: a
   *     finished finding is not something this service currently has wrong.
   *   - **Footprint-wide findings** (`asset_id` null, today only R-008). They are
   *     about the user's whole footprint, so attributing one to a single service
   *     would misstate what the rule found. The equality predicate excludes them
   *     structurally — SQL equality never matches null — rather than by a check
   *     someone could later drop.
   *   - **Other users' findings** — `user_id` is an explicit predicate, which
   *     matters because this runs as `service_role` and RLS is bypassed.
   *
   * Because it is open-only, the empty state must say "no *open* findings for
   * this service". A bare "no findings" would tell a user with three resolved
   * ones that they never had any.
   *
   * Presentation matches `listFindings` exactly — the same `sortByRecommendation`
   * and the same `withImpactedAsset` — so a finding does not reorder or relabel
   * itself depending on which surface is showing it.
   */
  async listFindingsForAsset(
    userId: string,
    assetId: string,
  ): Promise<FindingResult<FindingView[]>> {
    try {
      const open = await this.findings.listOpenForAsset(userId, assetId);
      return ok(await this.withImpactedAsset(userId, sortByRecommendation(open)));
    } catch (error) {
      return this.storeFailure("finding.list_for_asset", error);
    }
  }

  /** One finding, or `NOT_FOUND` for both "no such finding" and "not yours". */
  async getFinding(userId: string, findingId: string): Promise<FindingResult<FindingView>> {
    try {
      const finding = await this.findings.find(userId, findingId);
      if (!finding) return fail("NOT_FOUND");

      const [view] = await this.withImpactedAsset(userId, [finding]);
      return view ? ok(view) : fail("NOT_FOUND");
    } catch (error) {
      return this.storeFailure("finding.get", error);
    }
  }

  /**
   * One finding with its evaluated records resolved (ATL-041).
   *
   * A superset of `getFinding`, not a replacement: the list views need no
   * evidence records and should not pay for three extra reads to get them.
   * Same ownership predicate, same non-oracle `NOT_FOUND`, and additive — it
   * writes nothing and changes no lifecycle.
   */
  async getFindingDetail(userId: string, findingId: string): Promise<FindingResult<FindingDetail>> {
    try {
      const finding = await this.findings.find(userId, findingId);
      if (!finding) return fail("NOT_FOUND");

      const [view] = await this.withImpactedAsset(userId, [finding]);
      if (!view) return fail("NOT_FOUND");

      return ok({ ...view, evidenceRecords: await this.resolveEvidence(userId, finding) });
    } catch (error) {
      return this.storeFailure("finding.get_detail", error);
    }
  }

  /**
   * Turns `evidence_refs_json`'s ids into records a user can read and reach.
   *
   * Every lookup is scoped to `userId`, so an id planted in the JSON cannot
   * resolve to another user's record — the same predicate the rest of this
   * service applies, restated here because the ids arrive as data rather than
   * as arguments.
   *
   * An id that resolves to nothing is kept with a `null` href rather than
   * dropped. The composite foreign keys cascade, so a dangling reference should
   * not survive a delete — but silently omitting evidence would make a finding
   * look better-founded than it is, and ADR-001's whole claim is explainability.
   */
  private async resolveEvidence(
    userId: string,
    finding: PrivacyFindingRecord,
  ): Promise<EvidenceRecord[]> {
    const refs = finding.evidenceRefs as {
      assetIds?: unknown;
      dataCategoryIds?: unknown;
      permissionIds?: unknown;
    };
    const ids = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

    const assetIds = ids(refs.assetIds);
    const categoryIds = ids(refs.dataCategoryIds);
    const permissionIds = ids(refs.permissionIds);

    if (assetIds.length + categoryIds.length + permissionIds.length === 0) return [];

    const [assets, categories, permissions] = await Promise.all([
      assetIds.length > 0 ? this.assets.listAllForUser(userId) : Promise.resolve([]),
      categoryIds.length > 0 ? this.categories.listForUser(userId) : Promise.resolve([]),
      permissionIds.length > 0 ? this.permissions.listForUser(userId) : Promise.resolve([]),
    ]);

    const assetName = new Map(assets.map((asset) => [asset.id, asset.serviceName]));

    const records: EvidenceRecord[] = [];

    for (const id of assetIds) {
      const name = assetName.get(id);
      records.push({
        id,
        kind: "asset",
        label: name ?? "A service that no longer exists",
        href: name ? `/assets/${id}` : null,
      });
    }

    for (const id of categoryIds) {
      const category = categories.find((entry) => entry.id === id);
      records.push({
        id,
        kind: "dataCategory",
        label: category
          ? `Information held: ${category.category}`
          : "A record that no longer exists",
        href: category ? `/assets/${category.assetId}/edit` : null,
      });
    }

    for (const id of permissionIds) {
      const permission = permissions.find((entry) => entry.id === id);
      records.push({
        id,
        kind: "permission",
        label: permission
          ? `Permission: ${permission.permissionType} (${permission.scope})`
          : "A record that no longer exists",
        href: permission ? `/assets/${permission.assetId}/edit` : null,
      });
    }

    return records;
  }

  /**
   * What the user should deal with next (§9, frontend §8's "Recommended" view).
   *
   * Delegates the ordering to `src/lib/findings/recommendation.ts` rather than
   * sorting here, so the Insights UI can render the same order without
   * reimplementing it — the duplication this ticket exists to avoid.
   */
  async calculateRecommendations(userId: string): Promise<FindingResult<FindingView[]>> {
    try {
      const open = recommendedFindings(await this.findings.listForUser(userId));
      return ok(await this.withImpactedAsset(userId, open));
    } catch (error) {
      return this.storeFailure("finding.recommendations", error);
    }
  }

  /**
   * The user resolves a finding: they say the underlying problem is dealt with.
   *
   * ADR-004 counts this in the protective-actions factor, which is why
   * `resolved_by` is `'user'` and never `'system'` — the engine's
   * auto-resolution is a different event with a different meaning.
   */
  async resolveFinding(
    userId: string,
    findingId: string,
    /**
     * What the user did (ATL-042: "resolution requires selecting or confirming
     * the action taken"). Required, because a resolution with no recorded
     * action is exactly what the criterion forbids.
     */
    action: ResolutionAction,
  ): Promise<FindingResult<PrivacyFindingRecord>> {
    return this.close(userId, findingId, "resolved", "finding.resolved", action);
  }

  /**
   * The user dismisses a finding: they have seen it and do not intend to act.
   *
   * **Dismissal does not improve the score.** ADR-004 keeps the deduction until
   * the underlying condition actually clears, so this records a decision rather
   * than a fix. Recalculation is still triggered — ADR-004 lists dismissal among
   * its triggers, and the calculation is idempotent, writing a snapshot only
   * when something actually changed.
   *
   * ATL-102 then suppresses re-firing for this condition until its inputs
   * materially change, so the decision sticks.
   */
  async dismissFinding(
    userId: string,
    findingId: string,
    /**
     * Why, if the user said (ATL-043). **Optional** — frontend §5.4 asks for an
     * optional reason, and a dismissal with none is a complete dismissal.
     *
     * Recorded on the timeline and nowhere else. Nothing reads it: ATL-102's
     * suppression turns on the input hash alone, and per the OQ-04 amendment no
     * reason moves the score. There is deliberately no column for it.
     */
    reason?: DismissalReason,
  ): Promise<FindingResult<PrivacyFindingRecord>> {
    return this.close(userId, findingId, "dismissed", "finding.dismissed", undefined, reason);
  }

  /**
   * Undoes a dismissal (ATL-043).
   *
   * Unbounded: any dismissed finding can be restored at any time, from the
   * Dismissed view or the detail panel. There is no window and no expiry job —
   * these are the user's own records, and a timer would make the affordance
   * timing-dependent to test and hostile to anyone who is slower than it.
   *
   * **Only a dismissal is undone.** A resolved finding answers
   * `INVALID_REQUEST`: resolution asserts the underlying problem was dealt with,
   * and ADR-004's protective-actions factor has already counted it, so undoing
   * one is a different act from changing your mind about ignoring something.
   *
   * The score is untouched by design. ADR-004 keeps a dismissed finding's full
   * deduction, so there was never anything to give back — which is what makes
   * undo free of score consequences in both directions (OQ-04).
   */
  async undismissFinding(
    userId: string,
    findingId: string,
  ): Promise<FindingResult<PrivacyFindingRecord>> {
    try {
      const current = await this.findings.find(userId, findingId);
      if (!current) return fail("NOT_FOUND");

      if (current.status !== "dismissed") return fail("INVALID_REQUEST");

      const restored = await this.findings.restore(userId, findingId);
      if (!restored) return fail("NOT_FOUND");

      await this.afterUserAction(restored, "finding.restored");
      return ok(restored);
    } catch (error) {
      return this.storeFailure("finding.restored", error);
    }
  }

  /**
   * The shared half of resolve and dismiss: validate, write, announce, rescore.
   *
   * §11.1's lifecycle is `open → in_progress → resolved or dismissed`, so a
   * finding that has already ended cannot end again. Rejecting rather than
   * treating it as a no-op is deliberate: a silent success would let a
   * double-submitted form rewrite `resolved_at`, move the finding inside
   * ADR-004's trailing 180-day window, and post a second entry on the timeline
   * for something that happened once.
   */
  private async close(
    userId: string,
    findingId: string,
    status: Extract<FindingStatus, "resolved" | "dismissed">,
    event: "finding.resolved" | "finding.dismissed",
    action?: ResolutionAction,
    reason?: DismissalReason,
  ): Promise<FindingResult<PrivacyFindingRecord>> {
    try {
      const current = await this.findings.find(userId, findingId);
      if (!current) return fail("NOT_FOUND");

      if (!isOpenFinding(current.status)) return fail("INVALID_REQUEST");

      const closed = await this.findings.close(userId, findingId, status, "user", action);
      if (!closed) return fail("NOT_FOUND");

      await this.afterUserAction(closed, event, reason);
      return ok(closed);
    } catch (error) {
      return this.storeFailure(event, error);
    }
  }

  /**
   * The two side-effects §11.1 and ADR-004 require of a user lifecycle action.
   *
   * Both are best effort and caught separately, the decision
   * `AssetService.afterMutation` already makes: the status change is the user's
   * and has succeeded, and neither a timeline write nor a queue call may undo
   * it. A dropped recalculation costs a stale score until the next trigger or
   * the nightly sweep, which §14 runs regardless.
   */
  private async afterUserAction(
    finding: PrivacyFindingRecord,
    event: "finding.resolved" | "finding.dismissed" | "finding.restored",
    /** Only a dismissal carries one, and only onto the timeline (ATL-043). */
    reason?: DismissalReason,
  ): Promise<void> {
    try {
      await this.activity.write({
        userId: finding.userId,
        type: event,
        params: { severity: finding.severity },
        entityType: "finding",
        entityId: finding.id,
        /**
         * `actor: "user"` is what makes the timeline honest about who acted —
         * the engine writes its own events without it. Every key is in ATL-069's
         * allowlist; no title, description or evidence goes near a timeline row.
         */
        metadata: {
          severity: finding.severity,
          status: finding.status,
          actor: "user",
          isDemo: finding.sourceType === "demo",
          /**
           * The dismissal reason lives here and nowhere else (ATL-043).
           *
           * `reason` is already in ATL-069's allowlist and the ids satisfy its
           * identifier pattern by construction, so no policy changed to admit
           * it. Undo writes its own event rather than editing this one, which
           * is what keeps the history truthful: the user did dismiss it, for
           * this reason, and then restored it.
           */
          ...(reason ? { reason } : {}),
        },
      });
    } catch {
      logger.error("activity.write_failed", { operation: event, count: 1 });
    }

    /**
     * The audit record (ATL-042, ADR-006), written **after** the status change
     * has committed so it describes a resolution that happened rather than one
     * that was attempted. `finding.dismissed` is not audited: ADR-006's
     * inventory covers resolution only, and ATL-043 owns dismissal.
     *
     * ## Post-commit audit failure policy
     *
     * The mutation and the audit write are not atomic — `audit_events` goes
     * through its own service-role writer with a hash-chain retry loop, in a
     * separate transaction. So by the time this runs the finding is already
     * resolved and durable.
     *
     * Telling the user their resolution failed would therefore be false, and
     * they could not retry it in any case: the finding is terminal. The
     * resolution stands, the failure is logged at error level, and nothing is
     * reverted — reverting a committed user action because a secondary write
     * failed would be a worse outcome than a gap in the trail.
     *
     * Never swallowed: this is the one place a missing audit record can be
     * noticed at all.
     */
    if (event === "finding.resolved") {
      try {
        await this.audit.write({
          userId: finding.userId,
          eventType: "finding.resolved",
          actorType: "user",
          entityType: "finding",
          entityId: finding.id,
          /**
           * Every key is already in `AUDIT_CONTEXT_POLICY`; nothing here is
           * free text, an identifier, or a personal value. `reason` carries the
           * resolution action, whose ids satisfy the allowlist pattern by
           * construction.
           */
          context: {
            toStatus: finding.status,
            ...(finding.resolutionAction ? { reason: finding.resolutionAction } : {}),
            ...(finding.ruleVersion ? { ruleVersion: finding.ruleVersion } : {}),
          },
        });
      } catch {
        logger.error("audit.write_failed", {
          operation: event,
          errorCode: "AUDIT_UNAVAILABLE",
          count: 1,
        });
      }
    }

    try {
      await this.score.enqueue({ userId: finding.userId, reason: "finding.changed" });
    } catch {
      logger.error("score.recalculation_enqueue_failed", { operation: event, count: 1 });
    }
  }

  /**
   * Attaches the impacted-asset label to a set of findings.
   *
   * One query for the whole page rather than one per finding, and only when
   * something actually names an asset — a footprint-wide-only page touches
   * `digital_assets` not at all.
   *
   * An asset that no longer exists cannot happen through the schema (the
   * composite foreign key cascades), but a projection that assumed it could not
   * would render `undefined` if it ever did; the label falls back rather than
   * showing a blank where a service name belongs.
   */
  private async withImpactedAsset(
    userId: string,
    findings: readonly PrivacyFindingRecord[],
  ): Promise<FindingView[]> {
    const needsName = findings.some((finding) => finding.assetId !== null);
    const names = needsName
      ? new Map(
          (await this.assets.listAllForUser(userId)).map((asset) => [asset.id, asset.serviceName]),
        )
      : new Map<string, string>();

    return findings.map((finding) => ({
      ...finding,
      impactedAsset:
        finding.assetId === null
          ? FOOTPRINT_WIDE_LABEL
          : (names.get(finding.assetId) ?? FOOTPRINT_WIDE_LABEL),
    }));
  }

  /** Store failures become `UNAVAILABLE`; anything else is a bug and rethrows. */
  private storeFailure<T>(operation: string, error: unknown): FindingResult<T> {
    if (!(error instanceof PrivacyFindingStoreError)) throw error;

    logger.error("finding.store_unavailable", {
      operation,
      provider: "database",
      providerAvailable: false,
    });
    return fail("UNAVAILABLE");
  }
}
