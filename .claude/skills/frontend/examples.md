# Frontend Examples

## 1. Server page, client leaf

```tsx
// app/(product)/assets/page.tsx — Server Component
export default async function AssetsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireSession();
  const filters = assetFiltersSchema.parse(searchParams); // URL state, validated
  const { assets, nextCursor } = await assetService.listAssets(session.userId, filters);

  if (assets.length === 0) {
    return hasFilters(filters) ? (
      <EmptyState title="No assets match these filters" action={<ClearFilters />} />
    ) : (
      <AssetsFirstRunEmptyState />
    ); // teaches the concept
  }

  return <AssetGrid assets={assets} nextCursor={nextCursor} />;
}
```

```tsx
// features/assets/components/asset-card-actions.tsx
"use client"; // boundary at the leaf

export function AssetCardActions({ assetId }: { assetId: string }) {
  const [isPending, start] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Asset actions" /> {/* touch/keyboard path */}
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => start(() => archiveAssetAction({ assetId }))}>
          {isPending ? "Archiving…" : "Archive"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

## 2. The four Atlas score card states

```tsx
export function PrivacyScoreCard({ state }: { state: ScoreCardState }) {
  switch (state.kind) {
    case "not_yet_scored":
      return (
        <Card emphasis="high">
          <CardLabel>Privacy score</CardLabel>
          <p>Not yet scored</p>
          <p className="text-secondary">Add your first service to see a score.</p>
          <Button href="/assets/new">Add an asset</Button>
        </Card>
      );

    case "demo":
      return (
        <Card emphasis="high">
          <CardLabel>Privacy score</CardLabel>
          <Badge>Demo score</Badge> {/* persistent label */}
          <ScoreArc value={state.score} />
          <ScoreInterpretation value={state.score} isDemo />
        </Card>
      );

    case "scored":
      return (
        <Card emphasis="high">
          <CardLabel>Privacy score</CardLabel>
          <ScoreArc
            value={state.score}
            aria-label={`Privacy score ${state.score} of 100, ${state.changeLabel}`}
          />
          <ScoreChange delta={state.delta} />
          {state.excludedFactors.length > 0 && (
            <p className="text-muted">
              Based on {state.includedFactors.length} of 6 factors. See how this is calculated.
            </p>
          )}
        </Card>
      );

    case "loading":
      return <ScoreCardSkeleton />; // matches final structure
  }
}
```

## 3. Form with shared schema and preserved input

```ts
// features/assets/schemas.ts — one schema, used by client form and server action
export const createAssetSchema = z.object({
  serviceName: z.string().min(1, "Enter the service name"),
  serviceDomain: z.string().url("Enter a valid URL").optional(),
  category: z.enum(ASSET_CATEGORIES),
  accountIdentifier: z.string().optional(), // encrypted at rest, masked on display
});
```

```tsx
"use client";
export function AddAssetForm() {
  const form = useForm<CreateAssetInput>({ resolver: zodResolver(createAssetSchema) });

  async function onSubmit(values: CreateAssetInput) {
    const result = await createAssetAction(values);
    if (result.error) {
      form.setError("root", { message: userMessage(result.error.code) }); // input preserved
      return;
    }
    router.push(`/assets/${result.data.id}`);
  }

  return (
    <Form {...form} onSubmit={form.handleSubmit(onSubmit)}>
      {form.formState.errors.root && <ErrorSummary />} {/* summary + field errors */}
      <FormField name="serviceName" label="Service name" /> {/* label always visible */}
      <FormField name="accountIdentifier" label="Account identifier" sensitive />
      <Button type="submit" loading={form.formState.isSubmitting}>
        Add asset
      </Button>
    </Form>
  );
}
```

## 4. Multi-step modal that cannot lose work

```tsx
"use client";
export function RequestModal({ assetId }: { assetId: string }) {
  const [state, dispatch] = useReducer(requestReducer, initialRequestState);
  useDraftAutosave(state.draft); // persists server-side; survives dismissal

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) confirmDiscardIfDirty(state);
      }}
    >
      {state.step === "review_fields" && <FieldReviewStep state={state} dispatch={dispatch} />}
      {state.step === "review_draft" && <DraftStep state={state} dispatch={dispatch} />}
      {state.step === "take_action" && <ActionStep state={state} />}
    </Dialog>
  );
}
```

Field review defaults (ADR-002): every personal field starts **unchecked** and **masked**.

```tsx
<Checkbox name="include_full_name" defaultChecked={false} />
<SensitiveValue value={field.masked} revealLabel="Reveal full name" />
```

## 5. Mailto length guard

```tsx
const mailto = buildMailto({ to, subject, body });

{
  mailto.length > MAILTO_SAFE_LENGTH ? (
    <>
      <Button disabled>Open email app</Button>
      <p className="text-secondary">
        This draft is too long for some email apps to open reliably. Copy it instead.
      </p>
      <Button onClick={copy}>Copy email</Button>
    </>
  ) : (
    <Button asChild>
      <a href={mailto}>Open email app</a>
    </Button>
  );
}
```

## 6. AI-unavailable fallback

```tsx
{
  aiState === "unavailable" ? (
    <Callout>
      <p>The assistant is temporarily unavailable. You can edit this standard template.</p>
      <DraftEditor initialValue={deterministicTemplate} />
    </Callout>
  ) : (
    <DraftEditor initialValue={aiDraft} label="AI-assisted draft" />
  );
}
```

## 7. Chart with a text alternative

```tsx
<ChartContainer summary={`Score moved from ${first} to ${last} over ${days} days, ${trendWord}.`}>
  <LineChart data={history}>
    <XAxis dataKey="date" label="Date" />
    <YAxis domain={[0, 100]} label="Score" />
    <Line dataKey="score" dot={{ r: 3 }} /> {/* markers, not color alone */}
  </LineChart>
</ChartContainer>
```

## 8. Reduced motion

```css
.panel {
  transition:
    transform 220ms ease-out,
    opacity 220ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .panel {
    transition: opacity 120ms linear;
    transform: none;
  }
}
```
