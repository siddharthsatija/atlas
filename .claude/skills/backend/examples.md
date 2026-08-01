# Backend Examples

## 1. Server action: thin by design

```ts
"use server";

export async function transitionRequestAction(input: unknown) {
  const session = await requireSession(); // 1. authenticate
  const parsed = transitionRequestSchema.strict().parse(input); // 2. validate, reject extras

  try {
    const result = await requestService.transitionStatus(
      // 3. delegate
      session.userId,
      parsed.requestId,
      parsed.toStatus,
      { idempotencyKey: parsed.idempotencyKey },
    );
    return ok(result);
  } catch (e) {
    return mapDomainError(e); // 4. typed code out
  }
}
```

Input DTO never contains identity:

```ts
export const transitionRequestSchema = z.object({
  requestId: z.string().uuid(),
  toStatus: z.enum(REQUEST_STATUSES),
  idempotencyKey: z.string().uuid(),
  // no userId — the server supplies it
});
```

## 2. Service with ownership check, pure validation, and events

```ts
async function transitionStatus(
  userId: string,
  requestId: string,
  toStatus: RequestStatus,
  opts: { idempotencyKey: string },
) {
  return withIdempotency(userId, "request_transition", opts.idempotencyKey, async () => {
    const request = await requestRepository.findById(userId, requestId);
    if (!request) throw new DomainError("REQUEST_NOT_FOUND", "Request not found."); // 404, not 403

    assertTransitionAllowed(request.status, toStatus); // pure, table-driven, unit-tested

    const updated = await requestRepository.updateStatus(userId, requestId, toStatus, {
      expectedFrom: request.status, // optimistic guard against races
    });
    if (!updated)
      throw new DomainError(
        "REQUEST_INVALID_TRANSITION",
        "This request changed. Reload and try again.",
      );

    await emitEvent({
      userId,
      activity: {
        type: "request_transitioned",
        entityType: "data_request",
        entityId: requestId,
        summary: `Request to ${request.serviceName} moved to ${toStatus}`,
      },
      audit: {
        eventType: "request_transition",
        entityType: "data_request",
        entityId: requestId,
        context: { fromStatus: request.status, toStatus, actorType: "user" },
      },
    });

    await enqueueScoreRecalculation(userId);
    return toRequestView(updated); // view DTO, masked recipient
  });
}
```

## 3. Pure state machine (architecture §13)

```ts
const ALLOWED: Record<RequestStatus, RequestStatus[]> = {
  draft: ["ready", "canceled"],
  ready: ["sent", "canceled"],
  sent: ["awaiting_response", "completed", "rejected", "canceled"],
  awaiting_response: ["follow_up_due", "completed", "rejected", "canceled"],
  follow_up_due: ["sent", "completed", "rejected", "canceled"],
  rejected: ["completed", "canceled"], // nonterminal by spec
  completed: [], // terminal
  canceled: [], // terminal
};

export function assertTransitionAllowed(from: RequestStatus, to: RequestStatus) {
  if (!ALLOWED[from].includes(to)) {
    throw new DomainError(
      "REQUEST_INVALID_TRANSITION",
      `This request cannot move from ${from} to ${to}.`,
    );
  }
}
```

## 4. View DTO masks restricted values

```ts
// Domain type may hold decrypted values internally
type DataRequest = { id: string; recipient: string; subject: string; body: string /* … */ };

// View DTO is what leaves the server
export function toRequestView(r: DataRequest): DataRequestView {
  return {
    id: r.id,
    status: r.status,
    requestType: r.requestType,
    serviceName: r.serviceName,
    maskedRecipient: maskEmail(r.recipient), // never the raw address in a list
    subject: r.subject, // shown in detail view only
    includedFieldKeys: r.includedFieldKeys, // keys, never values
    followUpAt: r.followUpAt,
    // deliberately absent: body (fetched separately for the editor), dedup/internal fields
  };
}
```

## 5. Idempotency helper

```ts
export async function withIdempotency<T>(
  userId: string,
  scope: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = await idempotencyRepository.find(userId, scope, key);
  if (existing) return existing.result as T; // replay, do not re-execute

  const result = await fn();
  await idempotencyRepository.save(userId, scope, key, result, { ttlHours: 24 });
  return result;
}
```

## 6. Idempotent, bounded, observable job

```ts
export async function runFollowUpDueJob(now = new Date()) {
  return withJobTelemetry("follow_up_due", async (report) => {
    let processed = 0;

    for await (const batch of requestRepository.iterateDueForFollowUp(now, { batchSize: 200 })) {
      for (const request of batch) {
        // Predicate-based update: safe to run twice
        const moved = await requestRepository.updateStatus(
          request.userId,
          request.id,
          "follow_up_due",
          {
            expectedFrom: "awaiting_response",
          },
        );
        if (!moved) continue;

        await notificationService.createNotification({
          userId: request.userId,
          type: "follow_up_due",
          title: "Follow-up due",
          body: `Your deletion request to ${request.serviceName} is due for follow-up.`, // no personal values
          entityType: "data_request",
          entityId: request.id,
        });

        await emitEvent({
          userId: request.userId,
          activity: { type: "follow_up_due", entityType: "data_request", entityId: request.id },
          audit: {
            eventType: "request_transition",
            entityType: "data_request",
            entityId: request.id,
            context: {
              fromStatus: "awaiting_response",
              toStatus: "follow_up_due",
              actorType: "system",
            },
          },
        });
        processed++;
      }
    }

    report({ processed }); // duration, success, failure recorded by the wrapper
  });
}
```

Timezone correctness when scheduling:

```ts
// Wrong: server local time
const followUpAt = addDays(new Date(), 30);

// Right: user's profile timezone, normalized to a sensible local hour
const followUpAt = zonedStartOfDay(addDays(nowInZone(profile.timezone), 30), profile.timezone);
```

## 7. Rate limiting on a shared store

```ts
// Wrong: per-instance memory; useless on serverless
const hits = new Map<string, number>();

// Right: shared durable store, distinct keys per surface
export async function enforceRateLimit(surface: Surface, keys: { userId?: string; ip: string }) {
  const limit = LIMITS[surface]; // e.g. { window: "1m", max: 5 }
  const key = keys.userId ? `${surface}:u:${keys.userId}` : `${surface}:ip:${keys.ip}`;

  const { allowed, retryAfterSeconds } = await rateLimitStore.consume(key, limit);
  if (!allowed) throw new DomainError("RATE_LIMITED", "Too many attempts. Try again shortly.");
  return { retryAfterSeconds };
}
```

## 8. Validating things people forget

```ts
// Job payload
const payload = findingsRecomputePayloadSchema.parse(rawPayload);

// JSON column read back from the database
const breakdown = factorBreakdownSchema.parse(row.factor_breakdown_json);

// AI response
const parsed = explanationSchema.safeParse(providerJson);
if (!parsed.success) {
  logger.warn("ai_schema_invalid", { promptVersion, code: "AI_SCHEMA_INVALID" });
  return deterministicExplanation(finding); // fallback, never provider text
}

// Environment variables at boot
export const env = envSchema.parse(process.env);
```

## 9. Error mapping and safe messages

```ts
const USER_MESSAGES: Record<ErrorCode, string> = {
  ASSET_NOT_FOUND: "We couldn't find that asset.",
  REQUEST_INVALID_TRANSITION: "This request can't move to that status.",
  AI_UNAVAILABLE: "The assistant is temporarily unavailable. Your text is safe.",
  RATE_LIMITED: "Too many attempts. Try again shortly.",
  CONSENT_REQUIRED: "This feature needs your permission first.",
  REAUTH_REQUIRED: "Please confirm your identity to continue.",
  INTERNAL: "Something went wrong. Your changes were not lost.",
};

function mapDomainError(e: unknown) {
  if (e instanceof DomainError) return fail(e.code, USER_MESSAGES[e.code]);
  logger.error("unhandled_error", { code: "INTERNAL" }); // no payload, no PII
  return fail("INTERNAL", USER_MESSAGES.INTERNAL);
}
```

## 10. Logging: wrong and right

```ts
// Wrong: error object and payload carry restricted values
logger.error("export failed", { err, user: profile, path: storagePath });

// Right: allowlisted, non-restricted fields
logger.error("export_generation_failed", {
  requestId,
  jobId,
  code: "EXPORT_FAILED",
  attempt,
  durationMs,
});
```
