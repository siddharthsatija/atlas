import "server-only";

import { createHash } from "node:crypto";
import type { EvidenceRefs } from "@/lib/findings/rules/types";

/**
 * Deduplication keys (ATL-101, architecture §11.1, ADR-001).
 *
 * > `dedup_key = hash(rule_id + sorted entity IDs in scope)`, unique per user. A
 * > rule fires once per condition.
 *
 * Lives in `server/` rather than `lib/` because it hashes with `node:crypto`,
 * which has no place in a module a client component might import. The rules
 * themselves stay pure and never see a key — they report which records they
 * read, and this turns that into an identity.
 *
 * ## Why the scope is entity IDs and not the rendered finding
 *
 * Hashing the title or the evidence summary would make the key change whenever
 * the copy changed, and a copy edit would silently orphan every open finding and
 * raise a duplicate beside it. Hashing the records the rule evaluated means the
 * key tracks the *condition*, which is what §11.1 says a rule fires once per.
 *
 * Sorting is what makes it stable: the same condition must hash identically
 * however the repository happened to order its rows.
 */

/** Separators that cannot appear in a UUID, so no two scopes can collide. */
const FIELD = "|";
const LIST = ",";

/**
 * The canonical string a key is derived from.
 *
 * Exported because a hash is unreadable when a test fails: asserting on the
 * scope tells you *what* the engine thought the condition was, where asserting
 * on the digest tells you only that two numbers differ.
 */
export function dedupScope(ruleId: string, evidence: EvidenceRefs): string {
  const group = (ids: readonly string[] | undefined): string => [...(ids ?? [])].sort().join(LIST);

  return [
    ruleId,
    group(evidence.assetIds),
    group(evidence.dataCategoryIds),
    group(evidence.permissionIds),
  ].join(FIELD);
}

/**
 * The stored `dedup_key`.
 *
 * SHA-256, hex, truncated to 64 characters — well inside the column's 200-character
 * limit, and not truncated so far that collisions become plausible across a
 * user's findings.
 *
 * Not an HMAC: unlike ADR-006's audit subject reference, this value identifies a
 * condition rather than a person, and it is only ever compared with other keys
 * belonging to the same user.
 */
export function dedupKey(ruleId: string, evidence: EvidenceRefs): string {
  return createHash("sha256").update(dedupScope(ruleId, evidence)).digest("hex");
}
