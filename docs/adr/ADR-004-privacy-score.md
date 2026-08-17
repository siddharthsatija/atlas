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
- Users who dismiss a finding they believe is wrong keep the penalty. The fairness mechanism was logged as OQ-04 rather than guessed at, and is now **resolved: correction, not compensation** (see below).
- Renormalization means two users' scores may cover different factors; mitigated by the coverage display.

## Amendment: disputed findings (OQ-04, signed off before ATL-043)

**A dismissal never improves the score by itself.** A disputed finding is answered by correcting the record it was computed from, not by discounting its deduction.

- `accepted_risk` and `not_relevant` are dismissals and **retain the full deduction**. Accepting a risk does not remove it.
- `incorrect` is **not a dismissal reason**. It is a correction path: the user edits the underlying record, the material input values change, ATL-102's input hash moves, and the engine re-evaluates. A correction that genuinely clears the predicate auto-resolves the finding with `resolved_by = system`, and the deduction clears because the underlying state changed.
- **Reduced-weight dismissals are rejected.** They contradict the integrity rule in this ADR's own rationale, and they would make undo score-affecting — dismiss/undo would become a lever a user could operate on their own score without touching their data.

**`score-v1` is unchanged by this amendment.** No new constant, no weight change, no version bump, and the worked example above (≈56) still stands as the golden test. The fairness mechanism lives in the correction flow and the input hash, deliberately outside the scoring model — which is why this is an amendment to the reasoning rather than to the model.

ATL-043 implements `not_relevant` and `accepted_risk`. The `incorrect` correction path is a separate ticket; until it lands, a disputed finding behaves as it does today.

## Amendment: factor edge cases (signed off before ATL-044)

The model above specifies the arithmetic for a populated account. These are the boundary cases it left open, resolved before implementation so `score-v1` has one reading rather than several. **No weight, deduction or threshold changes here** — this fixes the meaning of the inputs, not the constants, so the version does not move and the worked example (≈56) is unaffected.

### Populations

- **"Inactive assets addressed"** (hygiene, 40% sub-factor): numerator `archived + removed`; denominator `inactive + archived + removed`. Read literally the original wording was unsatisfiable — archiving an inactive asset moves it *out* of a denominator of `inactive` rather than into the numerator, so the sub-factor would be permanently 0 with no action able to move it. Addressing an asset must be able to improve the score, or the factor measures nothing.
- **Open-findings deduction population:** `open + in_progress + dismissed`. Resolved findings contribute no deduction — the condition is gone. Dismissed findings keep their full deduction, which is the OQ-04 rule expressed as a population rather than as a special case.
- **Protective actions credits user resolutions only:** findings with `resolved_by = 'user'` resolved within the trailing 180 days. "+10 per resolved finding" above is elliptical, not a statement that auto-resolution earns credit. The engine resolves a finding whenever its predicate stops holding, which happens through ordinary decay as well as through fixes — so crediting it would pay a user for doing nothing, and the `resolved_by` split exists precisely to keep the two apart. A condition that clears on its own still improves the score, through the open-findings factor; it simply earns no second, effort-based credit. Completed requests keep their +20 when M8 creates `data_requests`; nothing can supply one today.
- **Verification freshness denominator:** `active + inactive` assets only. Archived and removed assets are excluded — Atlas does not ask the user to keep reviewing a service they have finished with, so counting them would deduct for not doing something the product never requests.

### Zero-record behaviour, per factor

"A factor with no underlying records is excluded" is not the same statement for every factor, because for some of them zero records is a *finding* rather than an absence:

| Factor | Zero records | Why |
| --- | --- | --- |
| Open findings | **100**, not excluded | No findings means nothing is wrong, which is real information and the best possible outcome. Excluding it would hide a genuine result. |
| Data sensitivity footprint | **100**, not excluded | No high-sensitivity pairs means no sensitive exposure — again a result, not a gap. |
| Permission exposure | **excluded** | No permissions recorded means Atlas does not know what any service can do. That is missing information, and `permissionExposureScore()` already returns `null` here. |
| Protective actions | **always included, starting at 0** | Excluding it while empty and including it at 10 after one resolution would let a user's *first* resolution lower their total score, because the factor would enter the average below it. Always-included keeps the incentive pointing the right way. |
| Account hygiene | excluded only with no eligible assets | |
| Verification freshness | excluded only with no eligible assets | |

### Account hygiene: internal renormalisation

Hygiene is the one factor with two sub-factors, so it has a zero-record case *inside* it as well as at the top level. An absent sub-factor is **never treated as zero**; the surviving one carries the whole factor:

| Active-review population | Inactive/addressed population | Hygiene |
| --- | --- | --- |
| present | present | the documented 60/40 split |
| present | empty | active-review share carries 100% |
| empty | present | addressed share carries 100% |
| empty | empty | factor excluded at the top level, per the table above |

Scoring an absent sub-factor as 0 would deduct 40% of the factor from a user who simply has nothing to tidy up — the same defect the "inactive assets addressed" population fix removes one level down. This applies the renormalisation principle the model already uses between factors, one level in.

**The factor's weight of 25 is unchanged**, and so is the 60/40 split whenever both populations exist. This is `score-v1` as specified, not a variation of it.

### Precision, demo isolation, and cold start

- **Rounding:** full precision is carried through every factor and the weighted sum; the result is rounded **once**, at the final score. Two implementations that round at different points are two different `score-v1`s, so this is fixed rather than left to taste.
- **Demo isolation:** once any real asset exists, **all** demo records are excluded from every factor — including demo findings, which carry `source_type = 'demo'`. Demo and real calculations are completely isolated; no factor ever sees both.
- **Cold start** ends only when the user has at least one **active or inactive** non-demo asset. An archived or removed asset does not end it: a user who added a service and then removed it has no current footprint to score, and scoring an empty one would be a number about nothing.

## Consequences

- `privacy_score_snapshots` gains `score_version` and `is_demo`.
- ATL-044/045/046 rewritten with concrete criteria; snapshot compaction added to background jobs.
