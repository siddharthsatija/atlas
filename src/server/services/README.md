# Application services

One service per domain concept (architecture §9): `AssetService`, `FindingService`,
`FindingsEngine`, `PrivacyScoreService`, `RequestService`, `PersonalFieldService`,
`NotificationService`, `AssistantService`.

## Shape

```
async function doThing(userId: string, ...validatedArgs) {
  const entity = await repository.findById(userId, id);   // ownership check
  if (!entity) throw new DomainError("X_NOT_FOUND", "…");  // 404, never 403

  assertRuleHolds(entity);                                 // pure, unit-tested

  const updated = await repository.update(...);             // expected-from guard

  await emitEvent({ userId, activity: {...}, audit: {...} }); // one call site
  await enqueueFollowUpWork(userId);                         // after commit

  return toView(updated);                                    // masked view DTO
}
```

`userId` always comes from a verified session, never from client input.

First services arrive in M5 (`ATL-030`). Pure rule and score modules land in M6
(`ATL-101`, `ATL-044`).
