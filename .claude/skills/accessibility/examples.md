# Accessibility Examples

## 1. Hover action with keyboard and touch parity

```tsx
// Wrong: only discoverable and operable with a pointer
<div className="asset-card group">
  <div className="opacity-0 group-hover:opacity-100">
    <div onClick={archive}>Archive</div>
  </div>
</div>

// Right: hover enhances; overflow menu is the universal path
<div className="asset-card group">
  <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
    <Button variant="tertiary" onClick={archive}>Archive</Button>
  </div>
  <DropdownMenu>
    <DropdownMenuTrigger aria-label={`Actions for ${asset.serviceName}`} />
    <DropdownMenuContent>
      <DropdownMenuItem onSelect={archive}>Archive</DropdownMenuItem>
      <DropdownMenuItem onSelect={requestDeletion}>Request deletion</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

## 2. Focus on route transition

```tsx
"use client";
export function RouteFocusManager({ title }: { title: string }) {
  const pathname = usePathname();
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [pathname]);

  return (
    <>
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      <span role="status" aria-live="polite" className="sr-only">
        {title} loaded
      </span>
    </>
  );
}
```

## 3. Dialog that protects unsaved work

```tsx
<Dialog
  open={open}
  onOpenChange={(next) => {
    if (!next && isDirty) {
      setConfirmDiscard(true);
      return;
    } // scrim/Escape guarded
    setOpen(next);
  }}
>
  <DialogContent
    role="dialog"
    aria-modal="true"
    aria-labelledby="request-modal-title"
    onOpenAutoFocus={(e) => {
      e.preventDefault();
      headingRef.current?.focus();
    }}
  >
    <h2 id="request-modal-title" ref={headingRef} tabIndex={-1}>
      Request deletion — step {step} of 3
    </h2>
    <span role="status" aria-live="polite" className="sr-only">
      Step {step} of 3
    </span>
    {/* focus returns to the trigger automatically on close */}
  </DialogContent>
</Dialog>
```

## 4. Form field with label, help, and error wiring

```tsx
export function FormField({ name, label, help, error, sensitive }: FormFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label htmlFor={id}>
        {label}
        {required && <span> (required)</span>}
      </label>
      {help && (
        <p id={helpId} className="text-secondary">
          {help}
        </p>
      )}
      <input
        id={id}
        name={name}
        type={sensitive ? "password" : "text"}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={[help && helpId, error && errorId].filter(Boolean).join(" ") || undefined}
      />
      {error && (
        <p id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

Help precedes errors; the error text explains recovery ("Enter a valid email address, like name@example.com").

## 5. Error summary that receives focus

```tsx
{
  errors.length > 0 && (
    <div ref={summaryRef} tabIndex={-1} role="alert" aria-labelledby="error-summary-title">
      <h2 id="error-summary-title">There are {errors.length} problems with this form</h2>
      <ul>
        {errors.map((e) => (
          <li key={e.field}>
            <a href={`#${e.fieldId}`}>{e.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## 6. Fieldset for grouped personal-field checkboxes

```tsx
<fieldset>
  <legend>Which information should this request include?</legend>
  <p className="text-secondary">Nothing is included unless you select it.</p>
  {fields.map((f) => (
    <div key={f.key}>
      <input type="checkbox" id={`inc-${f.key}`} name="includedFields" value={f.key} />
      <label htmlFor={`inc-${f.key}`}>{f.label}</label>
      <SensitiveValue masked={f.masked} revealLabel={`Reveal ${f.label}`} />
    </div>
  ))}
</fieldset>
```

## 7. Masked value announcement

```tsx
// Wrong: screen reader hears the full identifier the UI is hiding
<span aria-label={fullIdentifier}>{masked}</span>

// Right: announce the masked state and the action
<span>
  <span aria-label={`Account identifier, hidden, ending ${last4}`}>{masked}</span>
  <button aria-label="Reveal account identifier" onClick={reveal} />
</span>
```

## 8. Live region for async status

```tsx
<span role="status" aria-live="polite" className="sr-only">
  {saveState === "saving" && "Saving draft"}
  {saveState === "saved" && "Draft saved"}
  {saveState === "error" && "Draft could not be saved. Your text is still here."}
</span>
```

## 9. Cancellable long AI operation

```tsx
<div aria-busy={isGenerating}>
  {isGenerating && (
    <>
      <span role="status" aria-live="polite">
        Generating draft…
      </span>
      <Button variant="secondary" onClick={cancel}>
        Cancel
      </Button>
    </>
  )}
</div>
```

## 10. Accessible score arc

```tsx
<div
  role="img"
  aria-label={`Privacy score ${score} out of 100. ${interpretation}. ${changeLabel}.`}
>
  <ScoreArcSvg value={score} aria-hidden="true" />
</div>
<p className="text-secondary">{interpretation}</p>   {/* also visible, not only in aria */}
```

## 11. Automated checks (ATL-091)

```ts
test("assets page has no axe violations", async ({ page }) => {
  await signIn(page);
  await page.goto("/assets");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("request flow completes with keyboard only", async ({ page }) => {
  await signIn(page);
  await page.goto("/assets/seeded-asset");
  await page.keyboard.press("Tab"); // no pointer used anywhere below
  // ... traverse to "Request deletion", complete all three steps, assert success state
  await expect(page.getByRole("status")).toContainText("Draft saved");
});
```
