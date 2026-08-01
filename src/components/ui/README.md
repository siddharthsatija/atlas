# UI primitives

Domain-free building blocks. A primitive takes a `severity`, never a `finding`.

## What is here

Button, Input, Label, Card, Dialog, **Drawer**, Tabs, Badge, **StatusBadge**,
**SeverityBadge**, Tooltip, Toast, **DropdownMenu**, Skeleton, **EmptyState**,
Table, Avatar, Spinner, **SensitiveValue** — plus layout primitives in `../layout/`.

`Dialog` is the "Modal" referred to in the frontend specification; there is no
separate Modal component. `Drawer` is the edge-anchored panel used for contextual
inspection and, from ATL-007, for mobile navigation.

### SensitiveValue

The security-critical primitive (security §8). It never receives the unmasked value
up front: the caller passes a masked string plus an `onReveal` resolver, so the
value is absent from the DOM until the user acts. Reveal is temporary and
auto-re-masks. Every transition emits a `SensitiveValueAuditEvent` that carries the
field label and entity reference but **never the value** (ADR-006).

`onAuditEvent` is a seam only. Applying the component across surfaces is ATL-035;
persisting the events is ATL-103.

## Not here yet

The remaining required components from design system §16 are built with the tickets
that need them, because each carries product behavior:

| Component                                                                     | Ticket                      |
| ----------------------------------------------------------------------------- | --------------------------- |
| AppShell, Sidebar, TopBar                                                     | ATL-005, ATL-006, ATL-007   |
| SensitiveValue (masked reveal + audit hook)                                   | ATL-035                     |
| StatusBadge, SeverityBadge, SourceLabel, ConfidenceIndicator                  | ATL-009 / consuming tickets |
| MetricCard, PrivacyScore, AssetCard, InsightCard, AssistantCard, ActivityItem | M6–M9                       |
| CommandSearch                                                                 | ATL-073                     |
| Drawer, Sheet                                                                 | ATL-007                     |
| EmptyState, FilterBar, DataTable, Timeline, ChartContainer                    | consuming tickets           |

## Rules

- Semantic tokens only. No raw hex, no framework palette names.
- Every interactive primitive implements all nine states (frontend spec §18).
- Radix primitives provide ARIA behavior — do not reimplement focus traps or
  keyboard patterns by hand.
- Severity and status always carry text; color alone never conveys meaning.
- No barrel file: import directly (`@/components/ui/button`) so bundles stay tree-shakeable.
- Sensitive values are masked by default; masking is `SensitiveValue`'s job, not each input's.

Checklist before merging a primitive: `.claude/skills/design-system/checklists.md`
and `.claude/skills/accessibility/checklists.md`.
