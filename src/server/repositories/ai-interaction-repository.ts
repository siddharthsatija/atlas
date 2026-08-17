import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type {
  AiFeedbackCategory,
  AiInteractionStatus,
  InputClassification,
} from "@/lib/ai/interaction-vocabulary";

/**
 * `ai_interactions` persistence (task #95, architecture §7.11).
 *
 * Data access only — no business rules, no vocabulary decisions, no redaction.
 * The repository's whole job is to move a metadata row in and out.
 *
 * ## The metadata-only rule is enforced by the input type
 *
 * `RecordInteractionInput` has no field capable of holding a prompt, a
 * completion, user text or a provider message, and neither does the table. A
 * caller with a completion in hand cannot pass it here even by mistake, because
 * there is no parameter to put it in. That is a stronger guarantee than a
 * comment asking people not to.
 *
 * ## Identifiers are permitted in `recordsReferenced`
 *
 * The one place in Atlas where they are. §7.11: this is "an authorized,
 * RLS-protected database table used for user-visible disclosure and audit — not
 * a log", and the §16 identifier rule governs telemetry sinks rather than this
 * table.
 */

type AiInteractionRow = Database["public"]["Tables"]["ai_interactions"]["Row"];

export interface AiInteractionRecord {
  id: string;
  userId: string;
  purpose: string;
  model: string;
  promptVersion: number;
  policyVersion: number;
  inputClassification: string | null;
  recordsReferenced: string[];
  outputSchemaVersion: number;
  status: string;
  latencyMs: number;
  helpful: boolean | null;
  feedbackCategory: string | null;
  createdAt: string;
}

/**
 * `records_referenced` is `Json` in the generated types, because the column is
 * `jsonb`. Narrowing to strings here rather than casting keeps a malformed row —
 * one written before this shape settled, or by hand — from becoming a runtime
 * surprise in whatever renders it.
 */
function toIdentifiers(value: AiInteractionRow["records_referenced"]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function toRecord(row: AiInteractionRow): AiInteractionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    model: row.model,
    promptVersion: row.prompt_version,
    policyVersion: row.policy_version,
    inputClassification: row.input_classification,
    recordsReferenced: toIdentifiers(row.records_referenced),
    outputSchemaVersion: row.output_schema_version,
    status: row.status,
    latencyMs: row.latency_ms,
    helpful: row.helpful,
    feedbackCategory: row.feedback_category,
    createdAt: row.created_at,
  };
}

/** Raised for any interaction storage failure. Carries no database detail. */
export class AiInteractionStoreError extends Error {
  constructor() {
    super("ai interaction store unavailable");
    this.name = "AiInteractionStoreError";
  }
}

export interface RecordInteractionInput {
  userId: string;
  purpose: string;
  model: string;
  promptVersion: number;
  policyVersion: number;
  /**
   * Sensitivity of the context that was sent (ATL-049).
   *
   * Optional so a caller with no policy layer — a test double, or any future
   * path that does not build context — records null rather than a guess. The
   * policy layer always supplies it.
   */
  inputClassification?: InputClassification | undefined;
  /** Entity IDs that were included in the AI context. */
  recordsReferenced: string[];
  outputSchemaVersion: number;
  status: AiInteractionStatus;
  latencyMs: number;
}

export interface RecordFeedbackInput {
  interactionId: string;
  /** Scoping the update to the owner: `service_role` bypasses RLS. */
  userId: string;
  helpful: boolean;
  category?: AiFeedbackCategory | undefined;
}

export class AiInteractionRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Appends one interaction.
   *
   * No `created_at`: the database stamps it (ATL-113). `input_classification` is
   * written when the caller supplies one — ATL-049 always does — and left null
   * otherwise, which is what the column meant before a vocabulary existed.
   */
  async record(input: RecordInteractionInput): Promise<AiInteractionRecord> {
    const { data, error } = await this.db
      .from("ai_interactions")
      .insert({
        user_id: input.userId,
        purpose: input.purpose,
        model: input.model,
        prompt_version: input.promptVersion,
        policy_version: input.policyVersion,
        input_classification: input.inputClassification ?? null,
        records_referenced: input.recordsReferenced,
        output_schema_version: input.outputSchemaVersion,
        status: input.status,
        latency_ms: input.latencyMs,
      })
      .select("*")
      .single();

    if (error || !data) throw new AiInteractionStoreError();
    return toRecord(data);
  }

  /**
   * Records user feedback on an existing interaction.
   *
   * The only update this table permits. The database trigger refuses any update
   * that touches another column, so a bug here fails loudly rather than
   * rewriting history.
   *
   * **`user_id` is an explicit predicate.** This runs as `service_role`, which
   * bypasses RLS, so ownership has to be part of the query rather than assumed
   * from the policy — the rule that applies to every service-role write in this
   * codebase.
   */
  async recordFeedback(input: RecordFeedbackInput): Promise<AiInteractionRecord | null> {
    const { data, error } = await this.db
      .from("ai_interactions")
      .update({
        helpful: input.helpful,
        feedback_category: input.category ?? null,
      })
      .eq("id", input.interactionId)
      .eq("user_id", input.userId)
      .select("*")
      .maybeSingle();

    if (error) throw new AiInteractionStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * A user's recent interactions, newest first.
   *
   * The disclosure read (ATL-053, ATL-076). Ordered on `(created_at desc, id
   * desc)` — the total ordering the index matches — so two interactions recorded
   * in the same microsecond cannot swap places between requests.
   */
  async listForUser(userId: string, limit = 50): Promise<AiInteractionRecord[]> {
    const { data, error } = await this.db
      .from("ai_interactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (error) throw new AiInteractionStoreError();
    return (data ?? []).map(toRecord);
  }
}
