# Testing Examples

## 1. Score golden test (locks ADR-004)

```ts
// The worked example from ADR-004. If a weight changes, this must fail.
it("computes the ADR-004 worked example", () => {
  const result = calculateScore(ADR_004_FIXTURE, SCORE_V1_CONFIG);

  expect(result.version).toBe("score-v1");
  expect(result.score).toBe(56);
  expect(result.factors).toMatchObject({
    accountHygiene: { score: 40, weight: 25 },
    openFindings: { score: 55, weight: 25 },
    dataSensitivity: { score: 80, weight: 20 },
    permissionExposure: { score: 80, weight: 15 },
    protectiveActions: { score: 10, weight: 10 },
    verificationFreshness: { score: 71, weight: 5 },
  });
});

it("renormalizes weights when a factor has no data", () => {
  const noPermissions = { ...ADR_004_FIXTURE, permissions: [] };
  const r = calculateScore(noPermissions, SCORE_V1_CONFIG);

  expect(r.excludedFactors).toContain("permissionExposure");
  expect(sumOf(r.factors, "effectiveWeight")).toBeCloseTo(100); // renormalized
});

it("returns not-yet-scored with no non-demo asset", () => {
  expect(calculateScore(emptyFixture, SCORE_V1_CONFIG)).toMatchObject({ kind: "not_yet_scored" });
});

it("never mixes demo and real records", () => {
  const r = calculateScore(mixedDemoAndRealFixture, SCORE_V1_CONFIG);
  expect(r.isDemo).toBe(false);
  expect(r.inputRecordIds).not.toContain(DEMO_ASSET_ID);
});

it("keeps a dismissed finding's deduction until the condition clears", () => {
  const withOpen = calculateScore(oneHighFindingFixture, SCORE_V1_CONFIG);
  const withDismissed = calculateScore(dismissHighFinding(oneHighFindingFixture), SCORE_V1_CONFIG);
  expect(withDismissed.score).toBe(withOpen.score); // dismissal alone changes nothing
});
```

## 2. Table-driven rule tests with boundaries

```ts
describe("R-001 stale_review", () => {
  const cases = [
    { days: 179, status: "active", fires: false, severity: null },
    { days: 180, status: "active", fires: true, severity: "low" }, // boundary
    { days: 364, status: "active", fires: true, severity: "low" },
    { days: 365, status: "active", fires: true, severity: "medium" }, // escalation boundary
    { days: 400, status: "inactive", fires: false, severity: null }, // rule is active-only
  ] as const;

  it.each(cases)(
    "days=$days status=$status -> fires=$fires",
    ({ days, status, fires, severity }) => {
      const result = r001.evaluate({
        asset: asset({ status, lastVerifiedAt: daysAgo(days) }),
        now: FIXED_NOW, // injected clock, never Date.now()
      });

      if (!fires) return expect(result).toBeNull();
      expect(result?.severity).toBe(severity);
    },
  );

  it("produces a stable dedup key for the same condition", () => {
    const a = r001.evaluate({ asset: asset({ id: "a1" }), now: FIXED_NOW });
    const b = r001.evaluate({ asset: asset({ id: "a1" }), now: addHours(FIXED_NOW, 6) });
    expect(dedupKey(a!)).toBe(dedupKey(b!)); // no duplicate findings
  });

  it("caps confidence for stale inputs", () => {
    const r = r001.evaluate({ asset: asset({ lastVerifiedAt: daysAgo(400) }), now: FIXED_NOW });
    expect(r?.confidence).toBe("low");
  });
});
```

## 3. Exhaustive state-machine matrix

```ts
const ALL: RequestStatus[] = [...REQUEST_STATUSES];

describe("request transition matrix", () => {
  it.each(ALL.flatMap((from) => ALL.map((to) => ({ from, to }))))(
    "%s -> %s matches the specification",
    ({ from, to }) => {
      const shouldAllow = SPEC_ALLOWED[from].includes(to); // transcribed from architecture §13
      const attempt = () => assertTransitionAllowed(from, to);
      shouldAllow
        ? expect(attempt).not.toThrow()
        : expect(attempt).toThrow("REQUEST_INVALID_TRANSITION");
    },
  );

  it("treats rejected as nonterminal and completed as terminal", () => {
    expect(() => assertTransitionAllowed("rejected", "completed")).not.toThrow();
    expect(() => assertTransitionAllowed("completed", "sent")).toThrow();
  });
});
```

## 4. Two-user RLS matrix, generated from the schema

```ts
const USER_OWNED_TABLES = [
  "profiles",
  "digital_assets",
  "asset_data_categories",
  "asset_permissions",
  "privacy_findings",
  "privacy_score_snapshots",
  "data_requests",
  "request_events",
  "activity_events",
  "consents",
  "ai_interactions",
  "export_jobs",
  "user_personal_fields",
  "notifications",
  "idempotency_keys",
] as const;

describe.each(USER_OWNED_TABLES)("%s RLS", (table) => {
  it("denies select, update, insert-as-other, and delete across users", async () => {
    const [a, b] = await createTestUsers(2);
    const row = await asUser(a).insertFixture(table);

    expect(await asUser(b).select(table, row.id)).toBeNull();
    await expect(asUser(b).update(table, row.id, mutation(table))).rejects.toThrow();
    await expect(asUser(b).delete(table, row.id)).rejects.toThrow();
    await expect(asUser(b).insertRaw(table, { user_id: a.id })).rejects.toThrow();
  });
});

// Completeness guard: a new table with no tests fails CI
it("covers every user-owned table in the schema", async () => {
  expect(new Set(USER_OWNED_TABLES)).toEqual(new Set(await listUserOwnedTablesFromSchema()));
});

describe.each(["audit_events", "user_encryption_keys"] as const)(
  "%s is client-inaccessible",
  (table) => {
    it("denies all client access", async () => {
      const a = await createTestUser();
      expect(await asUser(a).selectAny(table)).toEqual([]);
      await expect(asUser(a).insertRaw(table, {})).rejects.toThrow();
    });
  },
);
```

## 5. Crypto and crypto-shredding

```ts
it("round-trips and rejects relocated ciphertext", async () => {
  const ct = await encryptField(u.id, "data_requests", "body_encrypted", reqA.id, "hello");
  expect(await decryptField(u.id, "data_requests", "body_encrypted", reqA.id, ct)).toBe("hello");

  await expect(
    decryptField(u.id, "data_requests", "body_encrypted", reqB.id, ct),
  ).rejects.toThrow();
  await expect(
    decryptField(u.id, "data_requests", "subject_encrypted", reqA.id, ct),
  ).rejects.toThrow();
});

it("makes values unrecoverable after DEK destruction", async () => {
  const ct = await encryptField(
    u.id,
    "user_personal_fields",
    "value_encrypted",
    f.id,
    "Ada Lovelace",
  );
  await cryptoService.destroyUserDek(u.id);
  await expect(
    decryptField(u.id, "user_personal_fields", "value_encrypted", f.id, ct),
  ).rejects.toThrow();
});
```

## 6. Findings lifecycle (integration)

```ts
it("auto-resolves when the condition clears", async () => {
  const asset = await createAsset(u.id, { lastVerifiedAt: daysAgo(200), status: "active" });
  await findingsEngine.runForUser(u.id, { now: FIXED_NOW });

  const finding = await getOpenFinding(u.id, "R-001");
  expect(finding).toBeTruthy();

  await assetService.markReviewed(u.id, asset.id); // condition cleared
  await findingsEngine.runForUser(u.id, { now: FIXED_NOW });

  const after = await getFinding(u.id, finding!.id);
  expect(after.status).toBe("resolved");
  expect(after.resolvedBy).toBe("system");
});

it("does not re-raise a dismissed finding until inputs change", async () => {
  await findingsEngine.runForUser(u.id, { now: FIXED_NOW });
  const f = await getOpenFinding(u.id, "R-003");
  await findingService.dismissFinding(u.id, f!.id, { reason: "accepted_risk" });

  await findingsEngine.runForUser(u.id, { now: addDays(FIXED_NOW, 1) });
  expect(await getOpenFinding(u.id, "R-003")).toBeNull(); // suppressed

  await assetService.addDataCategory(u.id, assetId, { category: "financial" }); // inputs changed
  await findingsEngine.runForUser(u.id, { now: addDays(FIXED_NOW, 2) });
  expect(await getOpenFinding(u.id, "R-003")).toBeTruthy();
});
```

## 7. Idempotency and double-submit

```ts
it("applies a transition once for a repeated idempotency key", async () => {
  const key = randomUUID();
  const a = await requestService.transitionStatus(u.id, r.id, "sent", { idempotencyKey: key });
  const b = await requestService.transitionStatus(u.id, r.id, "sent", { idempotencyKey: key });

  expect(b).toEqual(a);
  expect(await countRequestEvents(r.id, { toStatus: "sent" })).toBe(1);
});

it("survives concurrent double submission", async () => {
  const results = await Promise.allSettled([
    requestService.transitionStatus(u.id, r.id, "sent", { idempotencyKey: randomUUID() }),
    requestService.transitionStatus(u.id, r.id, "sent", { idempotencyKey: randomUUID() }),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1); // expected-from guard
});
```

## 8. Account deletion end-to-end

```ts
it("removes all user data and leaves only pseudonymous evidence", async () => {
  const u = await createFullyPopulatedUser(); // assets, findings, requests, fields, notifications

  await privacyService.deleteAccount(u.id, await reauthToken(u));

  for (const table of USER_OWNED_TABLES) {
    expect(await adminCountRows(table, { user_id: u.id })).toBe(0);
  }
  expect(await adminGetDek(u.id)).toMatchObject({ status: "destroyed" });
  expect(await adminListStorageObjects(u.id)).toEqual([]);

  const audit = await adminFindAuditBySubject(hmacSubject(u.id));
  expect(audit.map((e) => e.event_type)).toEqual(
    expect.arrayContaining(["account_deletion_initiated", "account_deletion_completed"]),
  );
  expect(audit.every((e) => !containsPersonalData(e.context_json))).toBe(true);
});

it("does not resurrect data when the same email registers again", async () => {
  const email = uniqueTestEmail();
  const first = await createUserWithAssets(email);
  await privacyService.deleteAccount(first.id, await reauthToken(first));

  const second = await signUp(email);
  expect(await assetService.listAssets(second.id, {})).toEqual({ assets: [], nextCursor: null });
});
```

## 9. Redaction with a poisoned payload

```ts
it("strips restricted values from telemetry", () => {
  const out = redact({
    requestId: "req_1",
    code: "EXPORT_FAILED",
    email: "ada@example.test", // restricted key
    nested: { body: "Dear ExampleShop, my address is 1 Test Way" },
    note: "contact me at ada@example.test", // restricted pattern in a permitted key
  });

  expect(out).toEqual({
    requestId: "req_1",
    code: "EXPORT_FAILED",
    note: "contact me at [redacted]",
  });
  expect(JSON.stringify(out)).not.toContain("ada@example.test");
  expect(JSON.stringify(out)).not.toContain("1 Test Way");
});
```

## 10. Security: stored XSS and secret exposure

```ts
it("does not execute script from an asset name", async ({ page }) => {
  await createAsset(u.id, { serviceName: `<img src=x onerror="window.__x=1">` });
  await signIn(page, u);
  await page.goto("/assets");

  await expect(page.getByText("<img src=x", { exact: false })).toBeVisible(); // escaped, rendered as text
  expect(await page.evaluate(() => (window as any).__x)).toBeUndefined();
});

it("ships no server secrets in the client bundle", async () => {
  const bundle = await readClientBundle();
  for (const name of [
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY",
    "ATLAS_KEK",
    "AUDIT_HMAC_KEY",
  ]) {
    expect(bundle).not.toContain(process.env[name]!);
    expect(bundle).not.toContain(name);
  }
});
```

## 11. E2E with the AI-unavailable variant

```ts
test("drafts a deletion request end to end", async ({ page }) => {
  await signIn(page, await seededUser());
  await page.goto("/assets/seeded-asset");
  await page.getByRole("button", { name: "Request deletion" }).click();

  await expect(page.getByRole("checkbox", { name: /full name/i })).not.toBeChecked(); // unchecked default
  await page.getByRole("checkbox", { name: /full name/i }).check();
  await page.getByLabel("Recipient").fill("privacy@example.test");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("AI-assisted draft")).toBeVisible();
  await page.getByRole("button", { name: "Copy email" }).click();
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText("Awaiting response").or(page.getByText("Sent"))).toBeVisible();
});

test("drafting still works when AI is unavailable", async ({ page }) => {
  await withAiProviderDown(async () => {
    await signIn(page, await seededUser());
    await startRequestFlow(page);

    await expect(page.getByText(/assistant is temporarily unavailable/i)).toBeVisible();
    await expect(page.getByRole("textbox", { name: /body/i })).not.toBeEmpty(); // template present
    await page.getByRole("button", { name: "Copy email" }).click();
    await expect(page.getByRole("status")).toContainText(/copied/i);
  });
});
```

## 12. Injected clock, never sleep

```ts
// Wrong: flaky and slow
await new Promise((r) => setTimeout(r, 2000));
await runFollowUpDueJob();

// Right: control time explicitly
const now = new Date("2026-07-29T12:00:00Z");
await createRequest({ status: "awaiting_response", followUpAt: subDays(now, 1) });
await runFollowUpDueJob(now);

expect(await getRequestStatus(r.id)).toBe("follow_up_due");
expect(await countNotifications(u.id, { type: "follow_up_due" })).toBe(1);

await runFollowUpDueJob(now); // idempotency
expect(await countNotifications(u.id, { type: "follow_up_due" })).toBe(1);
```
