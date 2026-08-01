# ADR-001: Findings Generation Engine

**Status:** Accepted
**Date:** 2026-07-29
**Related:** `02-technical-architecture.md` §12, `01-product-requirements.md` FR-05, ADR-004

## Problem

The MVP has no mechanism that produces privacy findings. FindingService only lists, resolves, and dismisses. Without connectors or internet scanning (explicitly out of scope), a real user who enters assets manually would see an empty Insights page, an unexplainable score, and no recommended first action. The core product loop — see exposure, understand it, act on it — depends on findings existing.

## Options considered

1. **Demo-only findings.** Findings exist only in seeded demo data until Phase 2 connectors.
   Rejected: real users get no value from their own data; the score becomes meaningless; the MVP cannot validate whether guided privacy actions drive engagement.

2. **AI-generated findings.** Send user asset data to the model and ask it to identify risks.
   Rejected: violates the architecture principle that AI is never the source of truth, makes findings non-deterministic and non-auditable, increases data sent to the AI provider, and conflicts with NFR-06 (every finding traceable to a rule, source, or model output — with rules strongly preferred).

3. **Deterministic rule engine over user-entered data.** A versioned catalog of pure, server-side rules that evaluate the user's own asset, permission, category, and request records.
   **Accepted.**

## Decision

Implement a deterministic findings rule engine (spec in `02-technical-architecture.md` §12):

- A versioned rule catalog (`rules-v1`, eight launch rules) where each rule declares its inputs, predicate, severity mapping, confidence mapping, evidence template, and recommended action.
- Rules run server-side, triggered by relevant record mutations (via an enqueued recompute job) and by a nightly sweep for time-based predicates such as staleness.
- Deduplication by `dedup_key = hash(rule_id, entity scope)` so a rule fires once per condition per user.
- Auto-resolution: when a rule's predicate becomes false, the system resolves the finding with `resolved_by = system`.
- Confidence is derived from the freshness and source of inputs, never asserted by the rule alone.
- Evidence references concrete record IDs and rule version; evidence summaries contain no restricted values.
- Findings feed the Privacy Score through the deterministic factor model (ADR-004). AI may explain findings but cannot create, modify, or resolve them.

## Rationale

- Preserves explainability: every finding cites rule ID, rule version, and input records.
- Works with zero external integrations, so the MVP delivers value from manually entered data alone.
- Auditable and testable: rules are pure functions with table-driven tests.
- Extensible: Phase 2 connectors become new input sources for the same engine rather than a parallel system.

## Tradeoffs

- Findings are only as good as user-entered data; sparse data yields few findings. Mitigated by onboarding encouraging asset entry and by demo mode illustrating the experience.
- Rule-based findings can feel generic compared to "discovered" findings. Mitigated by evidence summaries grounded in the user's actual records and by AI explanation on demand.
- Nightly sweep introduces a background-job dependency earlier than otherwise needed. Accepted; jobs are already required for exports and follow-ups.

## Consequences

- `privacy_findings` gains `rule_id`, `rule_version`, `dedup_key`, `evidence_refs_json`, `resolved_by`.
- New tickets ATL-101 (rule engine) and ATL-102 (dedup and auto-resolution).
- The evaluation of rules is part of the score recalculation trigger set.
