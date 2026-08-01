# Architecture Examples

Illustrative patterns. Types are indicative, not final API contracts.

## 1. The four layers for one operation: archive an asset

**Server action** (`features/assets/actions.ts`) — thin: authenticate, validate, delegate, map errors.

```ts
"use server";

export async function archiveAssetAction(input: unknown) {
  const session = await requireSession(); // authenticate before reading input
  const { assetId } = archiveAssetSchema.parse(input); // validate with Zod

  try {
    await assetService.archiveAsset(session.userId, assetId);
    return ok(null);
  } catch (e) {
    return mapDomainError(e); // typed code, user-safe message
  }
}
```

**Service** (`server/services/asset-service.ts`) — authorization, rules, events.

```ts
async function archiveAsset(userId: string, assetId: string) {
  const asset = await assetRepository.findById(userId, assetId);
  if (!asset) throw new NotFoundError("ASSET_NOT_FOUND"); // fail closed, no cross-user leak
  if (asset.status === "archived") return; // idempotent

  await assetRepository.updateStatus(userId, assetId, "archived");

  await emitEvent({
    // activity + audit, one call site
    userId,
    activity: { type: "asset_archived", entityType: "asset", entityId: assetId },
    audit: { eventType: "asset_archived", entityType: "asset", entityId: assetId },
  });

  await enqueueFindingsRecompute(userId); // R-006 may now apply
  await enqueueScoreRecalculation(userId);
}
```

**Repository** (`server/repositories/asset-repository.ts`) — data access and crypto only.

```ts
async function findById(userId: string, assetId: string): Promise<Asset | null> {
  const row = await db
    .from("digital_assets")
    .select("*")
    .eq("user_id", userId) // always scope by owner, even with RLS active
    .eq("id", assetId)
    .maybeSingle();

  return row ? toDomainAsset(row) : null; // decrypts identifier, returns domain type
}
```

**Component** — renders, no data access.

```tsx
export function AssetCard({ asset }: { asset: AssetSummary }) {
  return (
    <Card>
      <h3>{asset.serviceName}</h3>
      <SensitiveValue value={asset.maskedIdentifier} />
      <AssetCardActions assetId={asset.id} /> {/* "use client" lives here, not on the page */}
    </Card>
  );
}
```

## 2. Client boundary placement

**Wrong** — whole page becomes client, loses server data access and streaming:

```tsx
"use client";
export default async function AssetsPage() {
  /* cannot await protected data safely */
}
```

**Right** — server page, client leaf:

```tsx
// page.tsx  (Server Component)
export default async function AssetsPage({ searchParams }) {
  const session = await requireSession();
  const assets = await assetService.listAssets(session.userId, parseFilters(searchParams));
  return <AssetGrid assets={assets} />; // AssetGrid renders AssetCardActions (client)
}
```

## 3. Cross-service call, not cross-repository

**Wrong:**

```ts
// inside RequestService
const fields = await personalFieldsRepository.listApproved(userId, keys); // reaches into another domain
```

**Right:**

```ts
// inside RequestService
const fields = await personalFieldsService.getApprovedFieldsForDraft(userId, approvedKeys);
// PersonalFieldsService enforces consent, decryption, and last_used_at bookkeeping
```

## 4. Typed errors at the boundary

```ts
// lib/errors.ts
export class DomainError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// mapping (server action)
function mapDomainError(e: unknown) {
  if (e instanceof DomainError) {
    return fail(e.code, userSafeMessage(e.code)); // never e.message from a provider
  }
  logger.error("unhandled_action_error", { code: "INTERNAL" }); // no payload, no PII
  return fail("INTERNAL", "Something went wrong. Your changes were not lost.");
}
```

Example envelope returned to the client:

```json
{
  "data": null,
  "error": {
    "code": "REQUEST_INVALID_TRANSITION",
    "message": "This request cannot move from completed to sent."
  },
  "requestId": "uuid"
}
```

## 5. Pure rule function (findings engine)

Rules must be testable without a database (ADR-001):

```ts
// server/services/findings/rules/r001-stale-review.ts
export const r001: Rule = {
  id: "R-001",
  category: "hygiene",
  evaluate({ asset, now }) {
    const days = daysBetween(asset.lastVerifiedAt, now);
    if (asset.status !== "active" || days < 180) return null;

    return {
      severity: days >= 365 ? "medium" : "low",
      dedupScope: [asset.id],
      evidenceRefs: [{ type: "asset", id: asset.id }],
      evidence: { serviceName: asset.serviceName, days }, // no restricted values
      recommendedAction: "review_asset",
    };
  },
};
```

## 6. Server-only enforcement

```ts
// server/crypto/index.ts
import "server-only"; // importing this from a Client Component fails the build
```

## 7. Import boundary lint rule (concept)

```js
// eslint.config.js
"no-restricted-imports": ["error", { patterns: [
  { group: ["**/server/repositories/*"], message: "Features must call services, not repositories." },
  { group: ["**/features/*/!(index)"],   message: "Do not import another feature's internals." },
]}]
```
