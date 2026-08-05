import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { logger } from "@/lib/telemetry/logger";
import {
  buildActivitySummary,
  isActivityEventType,
  type ActivityEventType,
  type ActivityParams,
} from "@/lib/activity/activity-events";
import { redactActivityMetadata, type ActivityMetadata } from "@/lib/activity/activity-metadata";
import {
  ActivityEventRepository,
  type ActivityEventRecord,
} from "@/server/repositories/activity-event-repository";
import { scrubString } from "@/lib/telemetry/redaction";
import { MASK_CHAR } from "@/lib/formatting/mask";

/**
 * The activity writer (ATL-069).
 *
 * The **only** module that writes `activity_events`. Everything that makes a
 * timeline row safe happens here — summary composition, metadata filtering, and
 * a final restricted-pattern check — so no caller can skip a step by building a
 * row itself. The table grants INSERT to `service_role` alone and the repository
 * exposes no update or delete, so this is the whole write surface.
 *
 * ## Summaries are composed, never accepted
 *
 * `write` takes an event type and typed parameters, and the template produces
 * the sentence. There is no parameter that accepts free text. A service holding
 * a recipient address therefore cannot put it in a summary by accident; the most
 * it can do is pass it as `maskedIdentifier`, having masked it first.
 *
 * ## Three independent guards
 *
 * 1. **Unknown event types are rejected.** An unrecognised type renders as a
 *    blank timeline row and is invisible to filters, so it fails here.
 * 2. **Metadata passes the ATL-068 allowlist**, which drops anything unnamed.
 * 3. **The composed summary is scanned** for emails, phones, and credentials
 *    (ATL-085) and refused if any survive.
 *
 * The third is defence in depth and should never fire: templates only
 * interpolate allowlisted params. It exists because the one that catches a
 * mistake is the one nobody expected to be needed — if a future template
 * interpolates something unmasked, this is what stops it reaching a user.
 */

/**
 * Stands in for the masked identifier while the summary is safety-scanned.
 *
 * Contains no character the restricted-pattern scan reacts to, so whatever the
 * control sentence trips on came from somewhere else.
 */
const MASKED_PLACEHOLDER = "redacted";

/** Raised when a summary would carry a restricted value. Fail closed. */
export class UnsafeActivitySummaryError extends Error {
  constructor() {
    super("composed activity summary contained a restricted value");
    this.name = "UnsafeActivitySummaryError";
  }
}

/** Raised when an event type is not in the vocabulary. */
export class UnknownActivityEventTypeError extends Error {
  readonly eventType: string;

  constructor(eventType: string) {
    super("unknown activity event type");
    this.name = "UnknownActivityEventTypeError";
    this.eventType = eventType;
  }
}

export interface ActivityInput {
  userId: string;
  type: ActivityEventType;
  /** Typed template parameters. No free-text field exists. */
  params?: ActivityParams;
  /** Both or neither, matching the table's constraint. */
  entityType?: string;
  entityId?: string;
  metadata?: ActivityMetadata;
  occurredAt?: Date;
}

export class ActivityWriter {
  private readonly events: ActivityEventRepository;

  constructor(db: SupabaseClient<Database>) {
    this.events = new ActivityEventRepository(db);
  }

  /** Uses the service-role client — the only role that may insert. */
  static create(): ActivityWriter {
    return new ActivityWriter(createServiceRoleClient());
  }

  async write(input: ActivityInput): Promise<ActivityEventRecord> {
    if (!isActivityEventType(input.type)) {
      // Thrown rather than defaulted: a timeline row nobody can read or filter
      // is worse than a loud failure at the call site that introduced it.
      throw new UnknownActivityEventTypeError(String(input.type));
    }

    const params = input.params ?? {};

    /**
     * A masked identifier must actually be masked.
     *
     * `maskedIdentifier` is the one parameter permitted to carry an identifier,
     * and its name is the entire contract. Checking for the mask character is
     * how that contract is enforced rather than trusted — a caller that passed
     * a raw address here would otherwise publish it to the timeline, and the
     * parameter name would have made that look deliberate.
     */
    if (params.maskedIdentifier && !params.maskedIdentifier.includes(MASK_CHAR)) {
      throw new UnsafeActivitySummaryError();
    }

    const summary = buildActivitySummary(input.type, params);

    /**
     * The composed sentence is scanned, not the parameters.
     *
     * Scanning inputs would miss a template that concatenated two safe values
     * into an unsafe one. Checking the finished string is the only version of
     * this that covers what the user actually sees.
     *
     * The scan runs against a **control** sentence in which the masked
     * identifier is replaced by an inert placeholder. Without that, this guard
     * would reject every legitimately masked address: `p••••y@acme.example`
     * still matches an email pattern, because masking preserves the domain by
     * design. Substituting the placeholder asks the precise question — *is
     * anything restricted here other than the value we already masked* — rather
     * than the blunt one, which would refuse exactly the case ATL-069 permits.
     */
    const control = buildActivitySummary(input.type, {
      ...params,
      ...(params.maskedIdentifier ? { maskedIdentifier: MASKED_PLACEHOLDER } : {}),
    });

    if (scrubString(control).scrubbed) throw new UnsafeActivitySummaryError();

    const { value: metadata, droppedKeys, redactedKeys } = redactActivityMetadata(input.metadata);

    if (droppedKeys.length > 0 || redactedKeys.length > 0) {
      // Counted, never echoed: a dropped value is dropped because it was not
      // safe to keep, so naming it here would undo the filtering.
      logger.warn("activity.metadata_filtered", {
        operation: "activity.write",
        count: droppedKeys.length + redactedKeys.length,
      });
    }

    return this.events.append({
      userId: input.userId,
      eventType: input.type,
      summary,
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      metadata,
      ...(input.occurredAt ? { occurredAt: input.occurredAt.toISOString() } : {}),
    });
  }
}
