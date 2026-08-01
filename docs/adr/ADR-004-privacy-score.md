# ADR-004: Privacy Score Model v1

**Status:** Accepted
**Date:** 2026-07-29
**Related:** `02-technical-architecture.md` §11, FR-06, `03-security-and-access.md` §13, ADR-001

## Problem

The score was specified only as "deterministic, versioned, 0–100" with example factor groups and no weights, no cold-start behavior, no demo-mode behavior, and no worked examples. ATL-044 could not be implemented without inventing the product's most visible number.

## Options considered

1. **Deduction-only model** (start at 100, subtract for issues).
   Cons: cannot express positive progress credit; a user with one asset and one finding looks identical to a user with fifty well-managed assets and one finding.

2. **Weighted multi-factor model** — each factor scores 0–100 from deterministic inputs, total is the weighted sum.
   **Accepted.**

3. **ML/heuristic scoring.** Rejected outright: violates determinism, auditability, and the rule that AI cannot set the score.

## Decision

Score version `score-v1`. Six factors, each 0–100, combined by fixed weights:

| Factor                     | Weight | Deterministic input                                                                                                                                                       |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account hygiene            | 25     | Share of active assets reviewed within 180 days (60%) and share of inactive assets addressed — archived or with a request started (40%)                                   |
| Open findings              | 25     | 100 minus severity deductions: critical −40, high −25, medium −10, low −4 (floor 0). Dismissed findings retain their full deduction until the underlying condition clears |
| Data sensitivity footprint | 20     | 100 − 10 per (active asset × high-sensitivity category: financial, health, biometric, location) pair, floor 40                                                            |
| Permission exposure        | 15     | 100 × (1 − broad-scope active permissions ÷ total recorded permissions)                                                                                                   |
| Protective actions         | 10     | +10 per resolved finding, +20 per completed request in the trailing 180 days, capped at 100                                                                               |
| Verification freshness     | 5      | Share of assets with `last_verified_at` within 365 days                                                                                                                   |

**Missing-data handling:** a factor with no underlying records (e.g., no permissions recorded) is excluded and remaining weights are renormalized. The score detail view shows which factors were included ("score coverage") so a high score from thin data is never mistaken for a complete assessment.

**Cold start:** no score is computed until the user has at least one non-demo asset. The score card shows a "Not yet scored" state with an explanation and the add-asset action. No snapshot is written.

**Demo mode:** when only demo records exist, the score is computed exclusively over demo records and always displayed with a persistent "Demo score" label. Demo snapshots are flagged `is_demo` and are deleted with demo data. Demo and real records are never mixed in one calculation; once a real asset exists, the real (or "Not yet scored") state takes over.

**Worked example:** 6 active assets, 4 reviewed within 180 days, 1 inactive unaddressed asset; findings: 1 high + 2 medium open; 2 sensitive category-asset pairs; 1 of 5 permissions broad; 1 resolved finding this period; 5 of 7 assets verified within 365 days.
Hygiene = 0.6·(4/6)·100 + 0.4·(0/1→0) = 40. Findings = 100 − 25 − 20 = 55. Sensitivity = 100 − 20 = 80. Permissions = 80. Protective = 10. Freshness = 71.
Score = 0.25·40 + 0.25·55 + 0.20·80 + 0.15·80 + 0.10·10 + 0.05·71 ≈ **56**.

**Versioning:** weights, deduction values, and thresholds live in a versioned configuration (`score-v1`). Every snapshot records the version and the factor-level inputs. Changing any constant requires a new version; historical snapshots are never recomputed.

**Recalculation triggers:** asset/permission/data-category mutations, finding open/resolve/dismiss/auto-resolve, request completion, demo-data changes, and the nightly rules sweep. Recalculation is idempotent; a snapshot is written only when the score or factor breakdown changes.

**Snapshot retention:** all snapshots kept 90 days; beyond that, compacted to the last snapshot per day.

## Rationale

- Every number traces to countable records; the explanation UI can show exact contributors.
- Renormalization plus a visible coverage indicator handles thin data honestly instead of fabricating precision.
- Keeping dismissed findings' deductions until conditions clear honors the existing integrity rules ("dismissal does not automatically improve the score"; "user actions cannot manipulate score without changing underlying state").

## Tradeoffs

- Initial weights are judgment, not data. Accepted; the open decision on tuning weights after user testing stands, and versioning makes changes safe.
- Users who dismiss a finding they believe is wrong keep the penalty. Fairness mechanism (e.g., "not applicable" resolution) is logged in `docs/open-questions.md` rather than guessed at.
- Renormalization means two users' scores may cover different factors; mitigated by the coverage display.

## Consequences

- `privacy_score_snapshots` gains `score_version` and `is_demo`.
- ATL-044/045/046 rewritten with concrete criteria; snapshot compaction added to background jobs.
