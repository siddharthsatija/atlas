import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type {
  FindingConfidence,
  FindingResolver,
  FindingSeverity,
  FindingSourceType,
  FindingStatus,
} from "@/lib/findings/findings";
import { OPEN_FINDING_STATUSES } from "@/lib/findings/findings";

/**
 * Data access for `privacy_findings` (ATL-038).
 *
 * Deliberately thin: this ticket owns the schema. **ATL-101** owns the rule
 * engine that generates findings, **ATL-102** owns dedup and auto-resolution,
 * and **ATL-040** owns `FindingService` — the authorization, activity emission
 * and score recalculation that surround a status change. What lives here is the
 * ownership predicate every query needs and the read shapes those tickets will
 * ask for.
 *
 * Nothing on this table is Restricted — security §3 classifies findings as
 * Confidential and §8's encrypted-column inventory names no column here — so
 * unlike `digital_assets` there is no encryption round trip. What keeps
 * restricted values out of `evidence_summary` is §11.1's evidence model, which
 * the engine applies when it renders the template.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to skip the first — and here they are unusually narrow:
 * `authenticated` may only `select`, so every write in Atlas reaches this table
 * through this file.
 */

export type PrivacyFindingRow = Database["public"]["Tables"]["privacy_findings"]["Row"];

export interface PrivacyFindingRecord {
  id: string;
  userId: string;
  /** Null when the finding is about the user's whole footprint, e.g. R-008. */
  assetId: string | null;
  findingType: string;
  /** Null for demo-seeded findings (§7.5); paired with `ruleVersion` in SQL. */
  ruleId: string | null;
  ruleVersion: string | null;
  dedupKey: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  sourceType: FindingSourceType;
  sourceReference: string | null;
  evidenceSummary: string;
  /** Record identifiers the rule evaluated — never the values themselves. */
  evidenceRefs: Record<string, unknown>;
  recommendedAction: string;
  /**
   * Hash of the material input values at the time the rule last fired (ATL-102).
   *
   * Null for findings written before ATL-102 and for demo-seeded findings — the
   * engine reads null as *unknown*, never as unchanged.
   */
  inputHash: string | null;
  status: FindingStatus;
  resolvedBy: FindingResolver | null;
  resolvedAt: string | null;
  /**
   * What the user did about it (ATL-042), or null.
   *
   * Null for open and dismissed findings, and for anything the engine
   * auto-resolved — in that last case nobody took an action to record.
   */
  resolutionAction: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: PrivacyFindingRow): PrivacyFindingRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    findingType: row.finding_type,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    dedupKey: row.dedup_key,
    title: row.title,
    description: row.description,
    severity: row.severity as FindingSeverity,
    confidence: row.confidence as FindingConfidence,
    sourceType: row.source_type as FindingSourceType,
    sourceReference: row.source_reference,
    evidenceSummary: row.evidence_summary,
    evidenceRefs: (row.evidence_refs_json ?? {}) as Record<string, unknown>,
    recommendedAction: row.recommended_action,
    inputHash: row.input_hash,
    status: row.status as FindingStatus,
    resolvedBy: row.resolved_by as FindingResolver | null,
    resolvedAt: row.resolved_at,
    resolutionAction: row.resolution_action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Raised for any finding storage failure. Carries no database detail. */
export class PrivacyFindingStoreError extends Error {
  constructor() {
    super("privacy finding store unavailable");
    this.name = "PrivacyFindingStoreError";
  }
}

export interface RecordFindingInput {
  userId: string;
  assetId?: string | null;
  findingType: string;
  ruleId?: string | null;
  ruleVersion?: string | null;
  dedupKey: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence?: FindingConfidence;
  sourceType?: FindingSourceType;
  sourceReference?: string | null;
  evidenceSummary: string;
  evidenceRefs?: Record<string, unknown>;
  recommendedAction: string;
  inputHash?: string | null;
}

export class PrivacyFindingRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Records one finding.
   *
   * A duplicate `(user_id, dedup_key)` is a **constraint violation, surfaced as
   * an error** rather than silently upserted. §11.1 says a rule fires once per
   * condition; if the engine tries twice, that is a fact ATL-102 needs to see
   * and act on, not one this layer should paper over by overwriting a finding
   * the user may already have dismissed.
   */
  async record(input: RecordFindingInput): Promise<PrivacyFindingRecord> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .insert({
        user_id: input.userId,
        asset_id: input.assetId ?? null,
        finding_type: input.findingType,
        rule_id: input.ruleId ?? null,
        rule_version: input.ruleVersion ?? null,
        dedup_key: input.dedupKey,
        title: input.title,
        description: input.description,
        severity: input.severity,
        ...(input.confidence ? { confidence: input.confidence } : {}),
        ...(input.sourceType ? { source_type: input.sourceType } : {}),
        source_reference: input.sourceReference ?? null,
        evidence_summary: input.evidenceSummary,
        evidence_refs_json: (input.evidenceRefs ?? {}) as never,
        recommended_action: input.recommendedAction,
        input_hash: input.inputHash ?? null,
      })
      .select("*")
      .single();

    if (error || !data) throw new PrivacyFindingStoreError();
    return toRecord(data);
  }

  /** One finding, scoped to its owner. Returns null rather than throwing on a miss. */
  async find(userId: string, findingId: string): Promise<PrivacyFindingRecord | null> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .select("*")
      .eq("id", findingId)
      // Ownership is a predicate, not an assumption. Without it, a caller
      // holding any finding id would read another user's row through
      // service-role.
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * The finding for one deduplication key, whatever its status.
   *
   * Whatever its status deliberately: ATL-102's suppression rule is that a
   * *dismissed* finding is not re-raised for the same key, so a lookup that
   * filtered to open findings would report "nothing here" and the engine would
   * raise a duplicate the constraint then rejects.
   */
  async findByDedupKey(userId: string, dedupKey: string): Promise<PrivacyFindingRecord | null> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .select("*")
      .eq("user_id", userId)
      .eq("dedup_key", dedupKey)
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Every finding a user has, newest first.
   *
   * Ordered on `(created_at desc, id desc)` — the total ordering ATL-027
   * established and `privacy_findings_created_idx` matches, so paginating later
   * needs no second ordering.
   */
  async listForUser(userId: string): Promise<PrivacyFindingRecord[]> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new PrivacyFindingStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Findings that still count as live exposure — ADR-004's deduction population.
   *
   * `open` and `in_progress`, not `open` alone: a finding someone has started
   * working on is still true, and ADR-004 stops deducting only when the
   * condition clears.
   */
  async listOpenForUser(userId: string): Promise<PrivacyFindingRecord[]> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .select("*")
      .eq("user_id", userId)
      .in("status", [...OPEN_FINDING_STATUSES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new PrivacyFindingStoreError();
    return (data ?? []).map(toRecord);
  }

  /** Open findings for one asset — the detail page's findings section (frontend §7). */
  async listOpenForAsset(userId: string, assetId: string): Promise<PrivacyFindingRecord[]> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .select("*")
      .eq("user_id", userId)
      .eq("asset_id", assetId)
      .in("status", [...OPEN_FINDING_STATUSES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new PrivacyFindingStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Moves a finding to `resolved` or `dismissed`.
   *
   * `resolvedBy` and `resolvedAt` are written together because the check
   * constraint requires it: a resolved finding with no timestamp cannot be
   * placed in the trailing 180-day window ADR-004's protective-actions factor
   * counts. `system` is how §11.1's auto-resolution identifies itself.
   *
   * Scoped by `user_id` as well as `id`: without it, a caller holding any row id
   * would rewrite another user's finding through service-role.
   */
  async close(
    userId: string,
    findingId: string,
    status: Extract<FindingStatus, "resolved" | "dismissed">,
    resolvedBy: FindingResolver,
    /**
     * What the user did (ATL-042). Only meaningful for a resolution: the
     * column's check constraint refuses one on any other status, and a
     * dismissal is not a resolution — ADR-004 keeps its deduction until the
     * condition clears.
     */
    resolutionAction?: string,
  ): Promise<PrivacyFindingRecord | null> {
    /**
     * No timestamps (ATL-113). `privacy_findings_set_resolution_time` stamps
     * `resolved_at` from the database clock on this very transition, and
     * `privacy_findings_set_updated_at` maintains `updated_at` — so the value
     * and the not-future constraint that judges it come from one clock.
     *
     * `resolved_by` is still the caller's, unchanged: §11.1 distinguishes a
     * user closing a finding from the engine auto-resolving one, and ADR-004
     * credits only the first.
     */
    const { data, error } = await this.db
      .from("privacy_findings")
      .update({
        status,
        resolved_by: resolvedBy,
        ...(resolutionAction === undefined ? {} : { resolution_action: resolutionAction }),
      })
      .eq("id", findingId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Undoes a dismissal, returning the finding to `open` (ATL-043).
   *
   * A sibling of `close`, and deliberately **not** `reopen`. That method belongs
   * to ATL-102, where the engine has just recomputed severity, confidence and an
   * input hash from records that changed; undo has none of those, because
   * nothing about the user's data moved — they simply changed their mind.
   *
   * `input_hash` in particular is left exactly as it was. §11.1 is explicit that
   * "a null hash means unknown, not unchanged", so writing one here would tell
   * ATL-102 something false about a finding nobody re-evaluated.
   *
   * `resolved_by` and `resolved_at` are cleared together because the
   * resolution-complete constraint refuses an open finding that still names a
   * resolver — the same pairing `reopen` observes.
   *
   * Scoped to `status = 'dismissed'`: a resolved finding is not undone, and
   * narrowing the write means a concurrent change cannot turn this into a
   * silent reopen of something the user actually finished.
   */
  async restore(userId: string, findingId: string): Promise<PrivacyFindingRecord | null> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .update({ status: "open", resolved_by: null, resolved_at: null })
      .eq("id", findingId)
      .eq("user_id", userId)
      .eq("status", "dismissed")
      .select("*")
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Returns a dismissed or resolved finding to `open` (ATL-102).
   *
   * The inverse of `close`, and it must clear `resolved_by` and `resolved_at`
   * together — ATL-038's check constraint refuses an open finding that still
   * names a resolver, which is what stops a reopened finding claiming an ending
   * it no longer has.
   *
   * There is deliberately no "insert a second finding" path: ATL-038's
   * `unique (user_id, dedup_key)` makes one impossible, so a condition that
   * returns reopens the row that already describes it rather than accumulating
   * duplicates in ADR-004's deduction population.
   */
  async reopen(
    userId: string,
    findingId: string,
    changes: { severity: FindingSeverity; confidence: FindingConfidence; inputHash: string },
  ): Promise<PrivacyFindingRecord | null> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .update({
        status: "open",
        resolved_by: null,
        resolved_at: null,
        severity: changes.severity,
        confidence: changes.confidence,
        input_hash: changes.inputHash,
      })
      .eq("id", findingId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Records the current input hash without changing anything else (ATL-102).
   *
   * Used once per finding written before this column existed: the engine cannot
   * compare against a hash nobody stored, so it records one and leaves the
   * finding's status untouched. The next evaluation has something to compare.
   */
  async setInputHash(
    userId: string,
    findingId: string,
    hash: string,
  ): Promise<PrivacyFindingRecord | null> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .update({ input_hash: hash })
      .eq("id", findingId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Moves a finding to `in_progress`.
   *
   * Separate from `close` because the constraint treats them as opposites: an
   * in-progress finding must have no resolver and no resolution time, and
   * folding both transitions into one method would mean a caller could ask for
   * a state the database refuses.
   */
  async markInProgress(userId: string, findingId: string): Promise<PrivacyFindingRecord | null> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .update({ status: "in_progress" })
      .eq("id", findingId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (error) throw new PrivacyFindingStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Deletes every demo finding for a user — ATL-083's one-action removal.
   *
   * Deletion rather than resolution, and only for demo rows: a demo finding is
   * an illustration, not a record of anything that happened, so resolving it
   * would leave ADR-004's protective-actions factor crediting the user for
   * fixing something fictional.
   */
  async removeDemoForUser(userId: string): Promise<number> {
    const { data, error } = await this.db
      .from("privacy_findings")
      .delete()
      .eq("user_id", userId)
      .eq("source_type", "demo")
      .select("id");

    if (error) throw new PrivacyFindingStoreError();
    return (data ?? []).length;
  }
}
