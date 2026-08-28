import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { PersonalFieldKey } from "@/lib/personal-fields";

/**
 * Data access for the discovery invocation lifecycle (ATL-206, ADR-008 §4).
 *
 * Owns the conditional writes that make the dispatch engine safe under
 * concurrency and idempotency:
 *
 * - `claimForDispatch`: atomically stamps `started_at` on an unclaimed
 *   invocation. Only one concurrent caller wins; the rest get null.
 * - `loadFieldMapping`: the snapshot field set from run creation. Not
 *   authoritative for eligibility — a live read is always required for check 7.
 * - `loadPersonalFieldMetadata`: one live read from `user_personal_fields` for
 *   the check-7 eligibility and type verification.
 * - `writeTerminal`: stamps `invocation_status` and `completed_at`,
 *   conditional on `completed_at IS NULL` so the first write wins.
 *
 * All methods are fail-closed: every database error surfaces as a thrown
 * `DiscoveryInvocationStoreError`. The dispatch engine maps a thrown error to
 * DB `error` + audit `invocationStatus: "blocked"`.
 *
 * Queries scope by `user_id` explicitly because the service-role client
 * bypasses RLS.
 */

/** A claimed invocation row, ready for the engine's binding checks. */
export interface InvocationRow {
  id: string;
  userId: string;
  runId: string;
  providerClass: string;
  consentProofIssuedAt: string | null;
  invocationStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * One row from `discovery_provider_invocation_fields`.
 *
 * `fieldType` is a snapshot written at run creation time and is NOT
 * authoritative for check 7 — `include_in_discovery` and the live field type
 * must be read from `user_personal_fields`.
 */
export interface FieldMappingRow {
  fieldId: string;
  /** Snapshot from run creation. Do NOT use for check-7 eligibility. */
  fieldType: string;
}

/** Live metadata for one personal field, from `user_personal_fields`. */
export interface LiveFieldMetadata {
  includeInDiscovery: boolean;
  fieldKey: PersonalFieldKey;
}

/** The four terminal values the `invocation_status` DB column accepts. */
export type InvocationTerminalStatus = "success" | "blocked" | "error" | "rate_limited";

/**
 * Raised for any discovery invocation storage failure.
 *
 * Carries no database detail: PostgREST error text can include row content, and
 * ADR-008 §16 forbids that reaching a log sink.
 */
export class DiscoveryInvocationStoreError extends Error {
  constructor(public readonly operation: string) {
    super(`discovery invocation store failed: ${operation}`);
    this.name = "DiscoveryInvocationStoreError";
  }
}

export class DiscoveryInvocationRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Atomically claims an invocation for dispatch by stamping `started_at`.
   *
   * The conditional UPDATE `WHERE started_at IS NULL` ensures only one
   * concurrent caller proceeds. The winning caller receives the full invocation
   * row (no second round trip needed for the binding checks). A caller that
   * arrives after the winner receives null.
   *
   * When null is returned, a second SELECT disambiguates "already claimed" from
   * "invocation not found":
   *
   * - Row exists, `started_at` is already set → return null (another caller
   *   claimed it first; the engine returns `already_dispatched`).
   * - Row not found → throw (the invocation ID is invalid; the engine re-throws
   *   so the caller sees a hard failure rather than a misleading result).
   *
   * The two-step approach (UPDATE then conditional SELECT) costs an extra round
   * trip only on the contended path, which is the minority case. On the
   * uncontended fast path a single UPDATE+SELECT suffices.
   */
  async claimForDispatch(userId: string, invocationId: string): Promise<InvocationRow | null> {
    const CLAIM_COLUMNS =
      "id, user_id, run_id, provider_class, consent_proof_issued_at, invocation_status, started_at, completed_at";

    const { data: claimed, error: claimError } = await this.db
      .from("discovery_provider_invocations")
      .update({ started_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("id", invocationId)
      .is("started_at", null)
      .select(CLAIM_COLUMNS)
      .maybeSingle();

    if (claimError) throw new DiscoveryInvocationStoreError("claim");
    if (claimed) return toInvocationRow(claimed);

    // Zero rows updated — either already claimed, or the invocation does not
    // exist. Distinguish by checking for the row itself.
    const { data: exists, error: existsError } = await this.db
      .from("discovery_provider_invocations")
      .select("id")
      .eq("user_id", userId)
      .eq("id", invocationId)
      .maybeSingle();

    if (existsError) throw new DiscoveryInvocationStoreError("claim: existence check");
    if (!exists) throw new DiscoveryInvocationStoreError("claim: invocation not found");

    // Row exists but started_at is already set — another caller claimed it.
    return null;
  }

  /**
   * Loads the field mapping rows for one invocation from
   * `discovery_provider_invocation_fields`.
   *
   * These rows are a snapshot written at run creation. `fieldType` reflects the
   * field type at that moment and must NOT be used for check-7 eligibility —
   * use `loadPersonalFieldMetadata` for the live read.
   *
   * Returns an empty array when no mapping rows exist; the engine blocks with
   * `mapping.empty`.
   */
  async loadFieldMapping(userId: string, invocationId: string): Promise<FieldMappingRow[]> {
    const { data, error } = await this.db
      .from("discovery_provider_invocation_fields")
      .select("field_id, field_type")
      .eq("user_id", userId)
      .eq("invocation_id", invocationId);

    if (error) throw new DiscoveryInvocationStoreError("load field mapping");
    return (data ?? []).map((row) => ({ fieldId: row.field_id, fieldType: row.field_type }));
  }

  /**
   * Reads live eligibility and type for one personal field.
   *
   * Check 7 must use a live read because:
   * - `include_in_discovery` may have been toggled since the run was created.
   * - The snapshot `field_type` in `discovery_provider_invocation_fields` may
   *   be stale (though the schema prevents changes to `field_key` today).
   *
   * Returns null when the row is absent or belongs to a different user, so the
   * engine can report `field.not_found` without creating an oracle for
   * cross-user field IDs (ATL-030).
   */
  async loadPersonalFieldMetadata(
    userId: string,
    fieldId: string,
  ): Promise<LiveFieldMetadata | null> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .select("include_in_discovery, field_key")
      .eq("user_id", userId)
      .eq("id", fieldId)
      .maybeSingle();

    if (error) throw new DiscoveryInvocationStoreError("load field metadata");
    if (!data) return null;

    return {
      includeInDiscovery: data.include_in_discovery,
      fieldKey: data.field_key as PersonalFieldKey,
    };
  }

  /**
   * Writes the terminal state for one invocation.
   *
   * Guarded on `completed_at IS NULL` to prevent double-terminal writes under
   * concurrency. When `completed_at` is already set, the row reached a terminal
   * state through another code path (or a previous call); the guard makes this
   * idempotent — the update affects zero rows and no error is raised.
   *
   * `error_code` is written only for `status = 'error'`; it is explicitly
   * set to null for all other statuses to avoid retaining a stale value from a
   * previous partial write.
   *
   * Throws on any database error. The dispatch engine must surface this failure:
   * an invocation that silently failed to reach a terminal state would appear
   * permanently in-progress and block field deletion (ATL-204 invariant).
   */
  async writeTerminal(
    userId: string,
    invocationId: string,
    status: InvocationTerminalStatus,
    errorCode?: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    const { error } = await this.db
      .from("discovery_provider_invocations")
      .update({
        invocation_status: status,
        completed_at: now,
        error_code: status === "error" ? (errorCode ?? "unknown_error") : null,
      })
      .eq("user_id", userId)
      .eq("id", invocationId)
      .is("completed_at", null);

    if (error) throw new DiscoveryInvocationStoreError("write terminal");
    // Zero rows affected means completed_at was already set — idempotent, not an error.
  }
}

// ── Row-to-record mapping ────────────────────────────────────────────────────

interface InvocationRowData {
  id: string;
  user_id: string;
  run_id: string;
  provider_class: string;
  consent_proof_issued_at: string | null;
  invocation_status: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function toInvocationRow(row: InvocationRowData): InvocationRow {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    providerClass: row.provider_class,
    consentProofIssuedAt: row.consent_proof_issued_at,
    invocationStatus: row.invocation_status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
