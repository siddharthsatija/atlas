import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { logger } from "@/lib/telemetry/logger";
import {
  AuditEventRepository,
  type StoredAuditEvent,
} from "@/server/repositories/audit-event-repository";
import { GENESIS_HASH, hashEvent, hashesEqual } from "./audit-event";

/**
 * Audit chain verification job (ATL-103, ADR-006).
 *
 * ADR-006 is deliberate about the threat model: hash chaining is **tamper
 * evidence, not tamper-proofing**. Someone with write access to the database can
 * rewrite history — but not without either breaking a hash or rebuilding every
 * subsequent event in the subject's chain. This job is what makes that
 * difference observable, and it is worth nothing unless it actually runs.
 *
 * What it detects:
 *
 *  - **Modification.** A changed field no longer hashes to the stored
 *    `event_hash`.
 *  - **Deletion.** A removed event breaks the `prev_hash` link of its successor.
 *  - **Insertion and reordering.** Both break the same link.
 *  - **Forks.** Two events claiming the same predecessor. The unique index makes
 *    this unreachable through the writer, so finding one means the database was
 *    modified directly.
 *
 * What it cannot detect: wholesale removal of a subject's *entire* chain. Time-
 * based external copies are the answer to that, which is why ADR-006 keeps
 * provider log streaming as a secondary copy rather than relying on this table
 * alone.
 */

export type ChainFaultKind =
  "hash_mismatch" | "broken_link" | "bad_genesis" | "duplicate_link" | "duplicate_hash";

export interface ChainFault {
  kind: ChainFaultKind;
  subjectRef: string;
  /** Position in the subject's chain, so an operator can find it. */
  index: number;
  eventId: string;
}

export interface ChainVerificationResult {
  subjectsChecked: number;
  eventsChecked: number;
  faults: ChainFault[];
  get ok(): boolean;
}

function result(
  subjectsChecked: number,
  eventsChecked: number,
  faults: ChainFault[],
): ChainVerificationResult {
  return {
    subjectsChecked,
    eventsChecked,
    faults,
    get ok() {
      return this.faults.length === 0;
    },
  };
}

/**
 * Verifies one subject's chain.
 *
 * Exported separately from the job so an incident responder can check a single
 * subject without walking the whole table, and so the algorithm is testable
 * against fixtures with no database at all.
 *
 * ## Order comes from the links, not from the timestamps
 *
 * The obvious implementation sorts by `occurred_at` and walks the result,
 * checking that each event's `prev_hash` matches the previous event's
 * `event_hash`. That version was written first and is wrong, in a way worth
 * recording because it looked correct and passed the tampering tests.
 *
 * `occurred_at` has millisecond resolution, so two events for one subject can
 * share a timestamp. The sort then falls back to `id`, which is a random UUID —
 * so the two events come back in arbitrary order, and verification reports
 * `bad_genesis` and `broken_link` **on a chain nobody touched**. A verification
 * job with false positives is worse than none: it gets muted, and a muted job
 * detects nothing.
 *
 * Walking the links instead makes the result independent of storage and sort
 * order entirely. The chain already encodes its own sequence — that is what a
 * chain is — so consulting anything else is both redundant and fragile.
 *
 * Verification continues past a fault rather than stopping at the first one. A
 * tamperer who changed several events should be fully visible in one pass; a
 * job that reported only the earliest problem would hide the blast radius.
 */
export function verifyChain(subjectRef: string, events: StoredAuditEvent[]): ChainFault[] {
  const faults: ChainFault[] = [];
  if (events.length === 0) return faults;

  /** Position in the supplied array, so an operator can locate a faulted row. */
  const indexOf = new Map<string, number>(events.map((event, index) => [event.id, index]));
  const fault = (kind: ChainFaultKind, event: StoredAuditEvent) =>
    faults.push({ kind, subjectRef, index: indexOf.get(event.id) ?? -1, eventId: event.id });

  // 1. Content integrity. Independent of position, so it is checked for every
  //    event whether or not the walk below reaches it.
  for (const event of events) {
    const recomputed = hashEvent({
      eventType: event.eventType,
      subjectRef: event.subjectRef,
      actorType: event.actorType,
      entityType: event.entityType,
      entityId: event.entityId,
      context: event.context,
      occurredAt: event.occurredAt,
      prevHash: event.prevHash,
    });
    if (!hashesEqual(recomputed, event.eventHash)) fault("hash_mismatch", event);
  }

  // 2. Structural uniqueness. The unique indexes make both unreachable through
  //    the writer, so either one implies the database was modified directly.
  const byPrev = new Map<string, StoredAuditEvent[]>();
  const byHash = new Map<string, StoredAuditEvent[]>();
  for (const event of events) {
    byPrev.set(event.prevHash, [...(byPrev.get(event.prevHash) ?? []), event]);
    byHash.set(event.eventHash, [...(byHash.get(event.eventHash) ?? []), event]);
  }
  for (const claimants of byPrev.values()) {
    if (claimants.length > 1) for (const event of claimants) fault("duplicate_link", event);
  }
  for (const duplicates of byHash.values()) {
    if (duplicates.length > 1) for (const event of duplicates) fault("duplicate_hash", event);
  }

  // 3. Walk from genesis, following links.
  const roots = byPrev.get(GENESIS_HASH) ?? [];
  if (roots.length === 0) {
    // Nothing anchors the chain: the head was removed, or every event was
    // rewritten to hide it.
    for (const event of events) fault("bad_genesis", event);
    return faults;
  }

  const reached = new Set<string>();
  let cursor: StoredAuditEvent | undefined = roots[0];
  while (cursor && !reached.has(cursor.id)) {
    reached.add(cursor.id);
    cursor = (byPrev.get(cursor.eventHash) ?? [])[0];
  }

  // 4. Anything the walk did not reach is detached — the signature of a deleted,
  //    inserted, or re-pointed event.
  for (const event of events) {
    if (!reached.has(event.id)) fault("broken_link", event);
  }

  return faults;
}

export class AuditChainVerifier {
  private readonly events: AuditEventRepository;

  constructor(db: SupabaseClient<Database>) {
    this.events = new AuditEventRepository(db);
  }

  static create(): AuditChainVerifier {
    return new AuditChainVerifier(createServiceRoleClient());
  }

  /** Verifies one subject. */
  async verifySubject(subjectRef: string): Promise<ChainFault[]> {
    return verifyChain(subjectRef, await this.events.listForSubject(subjectRef));
  }

  /**
   * The periodic job: verifies every subject's chain.
   *
   * Logs through the ATL-085 logger, which means the emitted record carries
   * counts and a fixed event label — never a `subject_ref`. A subject reference
   * is pseudonymous, not anonymous, and a log sink is a lower-trust destination
   * than the audit table it describes; the faults are returned to the caller for
   * anyone who needs the detail.
   */
  async verifyAll(): Promise<ChainVerificationResult> {
    const subjects = await this.events.listSubjects();
    const faults: ChainFault[] = [];
    let eventsChecked = 0;

    for (const subjectRef of subjects) {
      const events = await this.events.listForSubject(subjectRef);
      eventsChecked += events.length;
      faults.push(...verifyChain(subjectRef, events));
    }

    logger.info("audit.chain_verified", {
      jobName: "audit-chain-verify",
      jobStatus: faults.length === 0 ? "succeeded" : "failed",
      count: faults.length,
      recordCount: eventsChecked,
    });

    return result(subjects.length, eventsChecked, faults);
  }
}
