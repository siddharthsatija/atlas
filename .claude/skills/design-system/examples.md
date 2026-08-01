# Design System Examples

## 1. Token definition (light and dark at the variable layer)

```css
:root {
  --background: #f8f9fb;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-subtle: #f1f3f6;
  --text-primary: #16181d;
  --text-secondary: #4a5160;
  --text-muted: #6e7688;
  --border-default: #e3e6ec;
  --border-strong: #c9ceda;
  --accent: #4f5bd5;
  --accent-subtle: #eef0fc;
  --success: #1f7a4d;
  --warning: #b0680f;
  --danger: #b3352e;
  --info: #2563a8;

  --radius-control: 8px;
  --radius-input: 10px;
  --radius-card: 14px;
  --radius-panel: 18px;
  --radius-modal: 20px;

  --motion-standard: 180ms;
  --motion-panel: 260ms;
}

[data-theme="dark"] {
  --background: #101216;
  --surface: #171a20;
  --surface-raised: #1e222a;
  --surface-subtle: #14171c;
  --text-primary: #f2f4f8;
  --text-secondary: #b4bac7;
  --text-muted: #838b9b;
  --border-default: #262b34;
  --border-strong: #3a4150;
  --accent: #7b86e8;
  --accent-subtle: #232848;
  --success: #3da972;
  --warning: #d08c2e;
  --danger: #e06a5f;
  --info: #5b9bd8;
}
```

Dark mode is handled here only — never with per-component overrides.

## 2. Token use: right and wrong

```tsx
// Wrong: raw values and palette names leak into components
<div className="bg-white text-slate-500 rounded-[14px] shadow-md" />
<span style={{ color: "#B3352E" }}>High</span>

// Right: semantic tokens, hierarchy-appropriate radius, restrained elevation
<div className="bg-surface text-secondary rounded-card border border-default" />
<SeverityBadge severity="high" />
```

## 3. Severity never by color alone

```tsx
const SEVERITY = {
  low: { label: "Low", token: "info", Icon: InfoIcon },
  medium: { label: "Medium", token: "warning", Icon: AlertTriangleIcon },
  high: { label: "High", token: "warning", Icon: AlertOctagonIcon },
  critical: { label: "Critical", token: "danger", Icon: ShieldAlertIcon },
} as const;

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { label, token, Icon } = SEVERITY[severity];
  return (
    <span className={`badge badge--${token}`}>
      <Icon aria-hidden="true" />
      {label} {/* text is always present */}
    </span>
  );
}
```

## 4. Card hierarchy on the dashboard

```tsx
// Score card: prominent padding, panel radius, arc — the heaviest element
<Card padding="prominent" radius="panel" className="md:col-span-2">
  <PrivacyScore state={score} />
</Card>;

// Supporting metrics: uniform, lighter. Exactly three alongside the score.
{
  metrics.map((m) => (
    <Card key={m.key} padding="standard" radius="card">
      <MetricCard {...m} />
    </Card>
  ));
}

// Assistant: after primary content, deliberately quieter
<Card padding="compact" radius="card" tone="subtle">
  <AssistantCard suggestions={suggestions} />
</Card>;
```

## 5. SensitiveValue as a security primitive

```tsx
"use client";
export function SensitiveValue({ masked, revealLabel, onReveal }: SensitiveValueProps) {
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(null), 15_000); // temporary by design
    return () => clearTimeout(t);
  }, [revealed]);

  return (
    <span className="font-mono tabular-nums">
      {revealed ?? masked}
      <Button
        variant="icon"
        size="sm"
        aria-label={revealed ? "Hide value" : revealLabel}
        onClick={async () => setRevealed(revealed ? null : await onReveal())} // audited server-side
      >
        {revealed ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
      </Button>
    </span>
  );
}
```

## 6. Tabular numerals for values that change

```tsx
// Score, metrics, and timestamps must not jitter as digits change
<span className="text-display tabular-nums">{score}</span>
```

```css
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
```

## 7. Source and confidence accompany every claim

```tsx
<InsightCard>
  <SeverityBadge severity={finding.severity} />
  <h3>{finding.title}</h3>
  <p>{finding.description}</p>
  <p className="text-secondary">{finding.evidenceSummary}</p>
  <footer>
    <SourceLabel source={finding.sourceReference} lastVerified={finding.lastVerifiedAt} />
    <ConfidenceIndicator level={finding.confidence} />
  </footer>
</InsightCard>
```

## 8. Elevation preference

```css
/* Preferred: border + tonal contrast */
.card {
  background: var(--surface);
  border: 1px solid var(--border-default);
}

/* Only for genuinely floating surfaces */
.dropdown {
  background: var(--surface-raised);
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
}
.modal {
  background: var(--surface-raised);
  box-shadow: 0 16px 48px rgb(0 0 0 / 0.16);
}
```

## 9. Contrast verification in CI (concept)

```ts
// Every foreground/background pairing in the token matrix must pass AA
for (const [fg, bg] of TOKEN_PAIRINGS) {
  for (const mode of ["light", "dark"] as const) {
    expect(contrastRatio(token(fg, mode), token(bg, mode))).toBeGreaterThanOrEqual(
      pairingMinimum(fg),
    ); // 4.5 body, 3.0 large/UI
  }
}
```
