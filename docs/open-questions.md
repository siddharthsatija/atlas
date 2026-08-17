# Atlas Open Questions

Decisions that require a product owner call. Documentation deliberately does not assume answers where multiple valid approaches exist. Each entry lists impact and, where the engineering view is clear, a recommendation.

## OQ-01 · EU/EEA availability at launch — **launch-blocking**

Does the MVP launch to EU/EEA users?

- If yes: GDPR controller obligations, a lawful transfer mechanism for AI processing (the AI provider is a US processor), processor DPAs, and possibly regional data residency become launch work, not Phase 3 work.
- If no: geo-scoping must be honest in marketing and sign-up, and the privacy notice scoped accordingly.
- Engineering recommendation: decide before ATL-016 (onboarding consent copy depends on it).

## OQ-02 · Initial request jurisdictions and template variants

Which request-letter framing ships first: generic, GDPR-flavored, CCPA-flavored, or selectable?

- Affects ATL-059 draft templates and legal review scope. Drafts already avoid legal threats and unsupported claims regardless.
- Engineering recommendation: generic template plus optional GDPR/CCPA variants chosen by the user, clearly labeled as not legal advice. Needs legal review either way.

## OQ-03 · Demo mode before account creation — **resolved: post-signup only**

PRD open decision, now answered: demo mode is available **only after account creation**.

- Demo data is per-user, keyed to a profile, labelled `source_type = 'demo'`, and removable in one action (ATL-018 seeds it, ATL-083 removes it). `digital_assets.source_type` (ATL-027) is the column that carries the label, and `digital_assets_demo_idx` is the partial index the seed, the demo-only score, and the removal all use.
- No pre-authentication demo surface ships. A stateless variant would need a separate implementation with no user row behind it, and nothing in the MVP depends on it.
- Consequence for §11.2: every demo score is computed over demo records belonging to a signed-in user, so the "demo and real records never mix" rule stays a per-user query predicate rather than a separate code path.

## OQ-04 · Score fairness for disputed findings — **resolved: correction, not compensation**

`score-v1` keeps a dismissed finding's deduction until the condition clears (prevents score gaming). But a user who dismisses a finding as _incorrect_ stays penalized.

- Options: (a) status quo; (b) a distinct "not applicable" resolution that requires marking the underlying data wrong (thus changing state, which honestly clears the deduction); (c) reduced-weight dismissals.
- Engineering recommendation: (b) — it preserves score integrity because the user corrects the record rather than waving off the finding.

**Decision (product sign-off, before ATL-043): option (b).** A disputed finding is answered by correcting the record it was computed from, never by discounting the deduction.

The rule this establishes, which every later ticket inherits:

- **A dismissal never improves the score by itself.** `accepted_risk` and `not_relevant` are dismissals and keep the full deduction — accepting a risk does not remove it, and neither does declaring it uninteresting.
- **`incorrect` is not a dismissal reason at all.** It is a *correction* path: the user is taken to the underlying record, edits the data, and the existing engine re-evaluates. If the corrected data clears the predicate, ATL-102 auto-resolves the finding with `resolved_by = system` and the deduction clears — because the underlying state changed, which is the only thing permitted to move a score.
- **Option (c) is rejected**, not merely unchosen. Reduced-weight dismissals contradict ADR-004's own rationale ("user actions cannot manipulate score without changing underlying state") and would make undo score-affecting, turning dismiss/undo into a lever the user could operate on their own score without touching their data.

`score-v1` is unchanged by this decision: no new constant, no version bump, no change to the worked example. That is the point of (b) — the fairness mechanism lives in the correction flow and the input hash, not in the scoring model.

**Scope split.** ATL-043 implements `not_relevant` and `accepted_risk` only. The `incorrect` correction path is a dedicated follow-up ticket; until it lands, a disputed finding behaves as under option (a).

## OQ-05 · Direct email sending timing (existing open decision)

Whether Atlas sends request emails itself in a later phase. Unchanged from PRD; MVP remains copy/mailto only.

## OQ-06 · Audit retention window by jurisdiction

The 90-day audit retention is a configurable default. Some regimes or future enterprise obligations may require longer. Confirm with counsel before the public privacy notice is finalized.

## OQ-07 · Email delivery for notifications

In-app-only is decided for MVP (ADR-005). Open: how soon after launch email opt-in ships, since users who don't return won't see follow-up reminders. Recommendation: treat as the first post-launch fast-follow and design the redaction pass then.

## OQ-08 · Score weight tuning

`score-v1` weights (ADR-004) are launch values. Plan a post-launch review with real usage data; any change requires `score-v2` per the versioning rule.

## OQ-09 · Provider selections

Final choices for transactional email, analytics, error monitoring, and the rate-limit store (Vercel KV vs Upstash). Constraints are documented in architecture §3; selection is procurement, not architecture.

## OQ-10 · Pricing and monetization

The PRD defines no monetization. Not an MVP blocker for a validation launch, but the answer affects Phase 2 scope (connectors and the service directory are costly) and should exist before Phase 2 planning.

## OQ-11 · What makes a finding "verified"

Frontend §8 reserves critical styling for "genuinely critical, **verified** findings" and the design system reserves danger for "verified critical risk", but no document defines verification and `privacy_findings` has no column for it.

- Product decision (ATL-040): **do not overload `confidence` or `source_type` to mean verified.** Confidence is the minimum certainty across a rule's inputs (ADR-001, `confidence.ts`) and `source_type` distinguishes demo data; neither is a statement that a finding was checked.
- Until an explicit verification model exists, the finding card applies the existing `SeverityBadge` mapping only and adds no additional critical emphasis. The stricter rule ships with the model, not before it.
- Answering this means deciding what verification would mean — a user confirming the finding is true, a second corroborating source, or something else — and that answer determines whether it is a column, a derived rule, or an ADR.
