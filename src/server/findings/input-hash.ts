import "server-only";

import { createHash } from "node:crypto";
import type { EvidenceRefs, RuleInputs } from "@/lib/findings/rules/types";

/**
 * Input hashing for re-fire suppression (ATL-102, architecture §11.1).
 *
 * > A dismissed finding is not re-raised for the same `dedup_key` unless the
 * > rule inputs materially change (input hash changes).
 *
 * ## What "the inputs" means here
 *
 * The **material field values of the records the candidate cited**, projected by
 * the engine from the snapshot it already holds. §11.1 says inputs, not outputs,
 * so this hashes what the rule read rather than what it concluded — a broad
 * permission revoked and re-granted changes the inputs while leaving severity
 * identical, and hashing severity would stay silent about it forever.
 *
 * The rule contract is deliberately untouched. Rules keep reporting which
 * records they read (`evidence`), and this decides which of those records'
 * fields count as material. Asking each rule to declare its own signature would
 * put the definition next to the predicate, but it would also be a second thing
 * to get right in every future rule, where a uniform projection is right by
 * construction.
 *
 * ## What is *not* in the hash, and why it matters to a person
 *
 * Time. `now` is excluded, and so is any age derived from it. A user who
 * dismisses "Spotify has not been reviewed" and then leaves it another year does
 * not get the finding back — the passage of time is not a change to their
 * records. It returns when `lastVerifiedAt` actually moves, or the asset's
 * status or source changes. Dismissal is the one place Atlas overrides an
 * explicit "I have dealt with this", and it should take a real change to their
 * data to do so.
 *
 * Also excluded: `createdAt` (immutable, so it can never signal a change),
 * service names and category labels used only for rendering, and anything the
 * user typed. This never touches free text.
 */

/** Separators that cannot appear in the values below, so no two states collide. */
const FIELD = "|";
const RECORD = ";";
const GROUP = "#";

const value = (input: string | null | undefined): string => input ?? "~";

/**
 * The canonical string a hash is derived from.
 *
 * Exported because a digest is unreadable when a test fails: comparing scopes
 * tells you *which field moved*, where comparing hashes tells you only that two
 * numbers differ. The engine's own logs never carry it — it contains record
 * identifiers, and architecture §10 keeps those out of logs.
 */
export function inputScope(evidence: EvidenceRefs, inputs: RuleInputs): string {
  const assets = new Map(inputs.assets.map((asset) => [asset.id, asset]));
  const categories = new Map(inputs.dataCategories.map((entry) => [entry.id, entry]));
  const permissions = new Map(inputs.permissions.map((entry) => [entry.id, entry]));

  /**
   * Sorted by id, so the hash tracks the records' *state* rather than the order
   * a repository happened to return them in. A missing record contributes its id
   * and nothing else: it was cited and is now gone, which is itself a change.
   */
  const project = <T>(
    ids: readonly string[] | undefined,
    lookup: Map<string, T>,
    fields: (record: T) => (string | null)[],
  ): string =>
    [...(ids ?? [])]
      .sort()
      .map((id) => {
        const record = lookup.get(id);
        return record ? [id, ...fields(record).map(value)].join(FIELD) : id;
      })
      .join(RECORD);

  return [
    project(evidence.assetIds, assets, (asset) => [
      asset.status,
      asset.lastVerifiedAt,
      asset.sourceType,
    ]),
    project(evidence.dataCategoryIds, categories, (entry) => [entry.category, entry.sensitivity]),
    project(evidence.permissionIds, permissions, (entry) => [
      entry.scope,
      entry.status,
      entry.lastVerifiedAt,
    ]),
  ].join(GROUP);
}

/**
 * The stored `input_hash`.
 *
 * SHA-256 hex, matching the column's check constraint. Not an HMAC: like the
 * dedup key this identifies a state rather than a person, and it is only ever
 * compared with another hash belonging to the same finding.
 */
export function inputHash(evidence: EvidenceRefs, inputs: RuleInputs): string {
  return createHash("sha256").update(inputScope(evidence, inputs)).digest("hex");
}

/**
 * Whether a dismissed finding's inputs have materially changed since it was
 * dismissed.
 *
 * A **null stored hash means unknown, not unchanged**. Findings written before
 * ATL-102 have none, and treating absence as "nothing changed" would silently
 * suppress a finding that should return. Treating it as "everything changed"
 * would resurrect every dismissed finding the moment this shipped, overriding
 * dismissals the user made deliberately. Neither is defensible, so the engine
 * does the third thing: leaves the dismissal alone and records the hash, after
 * which the comparison is meaningful and the ambiguity is gone for good.
 */
export function inputsChanged(stored: string | null, current: string): boolean {
  if (stored === null) return false;
  return stored !== current;
}
