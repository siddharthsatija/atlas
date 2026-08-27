# ADR-007: Discovery Model

**Status:** Accepted
**Date:** 2026-08-23
**Supersedes:** Manual-first assumptions in PRD §2, §8.2, §15
**Related:** ADR-001 (confidence), ADR-003 (envelope encryption), ADR-004 (score-v1), ADR-005 (notifications), ADR-008 (outbound data disclosure)

---

## Context

The Atlas PRD defines a manual-first user journey: users identify and add their digital relationships by hand. The founding assumption is that users know which services hold their data and will supply that information. Phase 0 analysis confirms that the implemented code faithfully reflects this model.

Atlas is being redirected toward a discovery-first model: Atlas proposes candidate digital relationships with evidence; users adjudicate those candidates rather than originating them. This ADR establishes the canonical discovery model. It does not replace the existing schema — zero tables are dropped; fifteen are kept unchanged; four are adapted with constraint and enum changes only. Approximately 85–90% of implemented code survives. The security foundation survives entirely.

The manual-first pathway (users manually adding assets) remains valid alongside discovery. Discovery is an additional origin, not a replacement.

This ADR governs the discovery model. PRD corrections, and the correction of any document that still reflects manual-first assumptions, follow after this document is approved. No code, migrations, or ticket changes are authorised before approval.

---

## Decision

### 1. Core Invariant

**No claim without evidence.** Every candidate, finding, and score signal produced through the discovery pipeline must be traceable to a stored `discovery_evidence` record at the time it was generated. Evidence records are immutable after creation.

### 2. Canonical Discovery Flow

```
provider run
  → discovery_evidence  (one record per provider result, immutable)
    → discovery_candidates  (proposed relationship awaiting adjudication)
    → privacy_findings  (only after the underlying candidate is confirmed)
      → score pipeline
```

No step may be skipped. Discovery evidence alone does not create a confirmed asset. The data-request pipeline requires a confirmed `digital_assets` row; it must not be reachable from an unconfirmed candidate.

### 3. Evidence Substrate

One `discovery_evidence` record is created per provider result. Findings and candidates are consumers of this substrate; they do not modify it. "Dual-output provider" is a prohibited framing — a provider produces evidence, and downstream consumers derive what they need from it.

**`evidence_refs_json` reference format.** `privacy_findings.evidence_refs_json` carries references using a closed typed vocabulary. Each entry is:

```json
{ "type": "<ref_type>", "id": "<uuid>" }
```

where `ref_type` is one of:

- `discovery_evidence`
- `digital_asset`

No other reference type may be added without a new or amended ADR. Implicit routing by finding type or source class is prohibited.

**Evidence retention.** Evidence referenced by a finding against a confirmed asset is retained for as long as that finding/confirmed relationship exists. Resolution of a finding does not by itself trigger evidence purge; provenance and historical explainability persist beyond resolution. The 7-day purge window applies only to evidence for rejected candidates that carries no confirmed reference.

### 4. Provider Abstraction and Consent Gate

Every discovery provider implements a common interface that requires a `ConsentProof` typed parameter. `ConsentProof`:

- can only be constructed by the consent gate service (its constructor is unexported from that module);
- carries the minimum authorization facts the provider needs: user ID, consent type, provider class,
  authorized field IDs, issued-at timestamp, discovery run ID, and invocation ID;
- carries no general-purpose user or consent metadata beyond what the provider needs to execute.

The enforcement is two-layer. First, the module boundary: `ConsentProof`'s constructor is unexported, so within the normal module system it cannot be instantiated outside the consent gate service. This prevents accidental construction at call sites and makes every code path that produces a proof auditable. Second, runtime validation: the runner verifies the proof's issued-at timestamp and authorized field IDs at dispatch time before invoking the provider. Neither layer alone is sufficient — the module boundary addresses construction; runtime validation addresses presentation of an outdated or out-of-scope proof. Tests that require a `ConsentProof` must obtain one through the consent gate service's test interface, not by constructing the type directly; the unexported constructor is what enforces this at compile time.

**Full dispatch contract.** The eight ordered dispatch checks, live consent lookup requirement, `invocation_id` binding, and fail-closed semantics are specified in ADR-008 §4. ADR-007 establishes the pattern and properties; ADR-008 §4 is the normative dispatch contract.

**Fail-closed rule.** If the relevant consent is absent or the consent service is unavailable, the provider does not run. The `discovery_runs` record must distinguish a blocked provider from one that ran and returned zero results. A blocked provider is a hard error, not a clean zero-result execution.

**Mid-run revocation.** Consent is evaluated at dispatch. A revocation takes effect for the next provider invocation or run; the already-dispatched invocation completes. This authorization window must be disclosed in user-facing privacy communications.

### 5. Consent Model

Three discovery consent types are defined (closed enum; stored as rows in the consent table; each row records `policy_version` and the current state is the latest row per `(user_id, consent_type)`):

| Type | What leaves Atlas | Example provider |
|---|---|---|
| `discovery_hashed_query` ¹ | Partial SHA-1 hash prefix (first 6 hexadecimal characters of SHA-1(email)); plaintext email does not leave Atlas | HIBP k-anonymity |
| `discovery_identifying` | A handle or name transmitted to a third-party API | Username enumeration |
| `discovery_connected_sources` | Per-connection OAuth inward access grant | Connected email (deferred) |

¹ Renamed from `discovery_nonidentifying` by ADR-008 §12 consequential amendment. "Nonidentifying" overstated the guarantee: a partial hash is transmitted and k-anonymity reduces but does not eliminate disclosure. The full outbound disclosure specification for this consent type — including the two-step HIBP flow, prefix construction, and evidence storage rules — is in ADR-008 §1 and §6.

`discovery_brokers` is **not** a consent type. Broker searches are per-query user-initiated actions following the destructive-action confirmation pattern. A standing consent row for broker search is prohibited because standing consent would mean "search brokers on my behalf," which is not the permitted model (§13).

**Per-field prerequisite.** Before a provider may use a specific `user_personal_fields` record, three independent checks must all pass:

1. The relevant discovery consent record is active for this user.
2. The field type is eligible for the provider (system-managed; determined by provider configuration, not stored on the field).
3. `include_in_discovery = true` on that specific field (user-controlled scoping preference).

`include_in_discovery` is a preference, not consent and not eligibility. It does not substitute for check (1). A user may store multiple handles or email addresses and exclude some from discovery without revoking discovery consent entirely. A user-supplied handle is not automatically included in discovery merely because it was supplied; the per-field preference applies.

### 6. Candidate Lifecycle

Discovery candidates have five statuses:

| Status | Terminal | Meaning |
|---|---|---|
| `pending` | No | No user action yet |
| `confirmed` | Yes | User confirmed; asset promoted to `digital_assets` |
| `rejected` | Yes | User denied; rejection fingerprint stored |
| `dismissed` | No | User deliberately deferred action |
| `not_sure` | No | User genuinely cannot determine ownership |

`dismissed` and `not_sure` are persisted as distinct states because their re-engagement semantics differ:

- Dismissed candidates may be resurfaced with lower urgency; the user made a deliberate deferral choice.
- Not-sure candidates are eligible for additional evidence or guidance.
- Elevated not-sure rates for a specific provider are a provider-quality signal.

### 7. Confirmed Asset and the Findings Pipeline

**Confirmation-first.** `privacy_findings.asset_id` is NOT NULL. No finding is generated from discovery evidence until the user confirms the underlying candidate. `asset_id` must not be made nullable; finding-subject polymorphism for pre-confirmation evidence is not introduced.

**Pre-confirmation surface.** Before a candidate is confirmed, discovery evidence is surfaced to the user through the candidate card. The candidate card derives its content directly from `discovery_evidence` records — not from `privacy_findings` rows. No `privacy_findings` row exists for a candidate in `pending`, `dismissed`, or `not_sure` status. Statements such as "your email appeared in this breach corpus" are evidence-surface statements on the candidate card, not findings.

**Post-confirmation pipeline.** After the user confirms a candidate, the findings engine may create `privacy_findings` rows against the confirmed `digital_assets` row, referencing the original `discovery_evidence` via `evidence_refs_json`. The candidate card surface is superseded; the findings and score pipeline then applies normally.

The candidate card must be rich enough to support adjudication without a finding: breach date, source name, exposed data categories where available, confidence, and the reason Atlas surfaced the candidate.

**Conditional pairing constraint on `digital_assets`:**

```sql
CHECK ((source_type = 'discovery') = (candidate_id IS NOT NULL))
```

Discovery assets carry `candidate_id`; all other source types carry `candidate_id = NULL`. This follows the existing pattern established by `privacy_findings_resolution_complete` and `data_requests_completed_at_pairing`.

**No bypass of user confirmation.** Discovery evidence alone must not silently create a confirmed `digital_assets` row, and the data-request pipeline must not be reachable from an unconfirmed candidate. This invariant must be enforced at the service layer, not only by database constraints.

### 8. Rejection and Fingerprint Model

A rejection fingerprint is stored in `discovery_rejections` when a user rejects a candidate or de-confirms a previously confirmed discovery asset.

**Required security properties.** The fingerprint must be:

- *Durable* — permanent until account deletion; not subject to the evidence purge schedule.
- *User-scoped* — a rejection by one user does not suppress discovery for any other user.
- *Non-reversible* — the fingerprint must not allow recovery of the underlying identifier (email address, handle, or other signal) by a party with database read access. Plain hashing of low-entropy identifiers such as email addresses is insufficient; the construction must be resistant to offline dictionary attack.
- *Collision-resistant* — distinct (user, provider, matched-signal) tuples must not produce the same fingerprint.
- *Independent of the evidence record* — it cannot be a foreign key to `discovery_evidence`, because evidence may be purged before the fingerprint is evaluated in a future run.

The exact cryptographic construction satisfying these properties is deferred to ADR-008 (outbound data disclosure) or to the security design associated with the implementing ticket. If an existing ADR already establishes a keyed-hash pattern (e.g., HMAC-SHA256 under a per-environment key), that pattern should be followed unless it can be shown to be insufficient here.

The fingerprint suppresses re-surfacing from all subsequent discovery runs for this user.

**Dismissed ≠ Rejected.** Dismissal does not store a fingerprint and does not purge evidence. A dismissed candidate may resurface in future runs and is available for re-adjudication.

### 9. De-confirmation

A user may explicitly de-confirm a previously confirmed discovery asset, declaring it is not theirs. De-confirmation is not available on manually-added assets (they have no `candidate_id` to reject).

De-confirmation executes atomically. The steps must be ordered as follows:

1. Resolve all `privacy_findings` against the asset: set the resolution status and record the system resolution reason `asset_deconfirmed`. Findings retain their rows; the historical record remains auditable.
2. Mark the `digital_assets` row as removed. This step must follow step 1. Two FK relationships constrain hard-deletion of the asset row: `privacy_findings.asset_id NOT NULL` (this ADR) and, in all likelihood, a `data_requests` → `digital_assets` FK that must remain valid while open requests continue their lifecycle per C6-D. **Hard-deletion is prohibited** while any referencing row exists under a RESTRICT or NO ACTION policy. **Cascade-delete is prohibited** — it would delete findings and requests, destroying the audit trail and violating C6-D. The required approach is soft-deletion: a `deleted_at` timestamp or equivalent lifecycle field on `digital_assets`. This is a schema column addition, not a constraint-only change; see Consequences. Score computation, asset listing, and the request-origination flow must exclude soft-deleted rows. The implementing ticket must confirm the actual FK policy by inspecting the migration; if the policy differs from this assumption, this step and the Consequences section must be updated accordingly.
3. Move the originating `discovery_candidates` row to `rejected`.
4. Write a rejection fingerprint to `discovery_rejections`.

Steps 3 and 4 have no FK dependency on `digital_assets` and may be reordered relative to each other within the transaction, but must occur within the same atomic operation as steps 1 and 2.

Open `data_requests` against the de-confirmed asset continue independently. A data request was a deliberate user action and retains its own lifecycle; de-confirmation does not cancel it.

### 10. Verification Model

Verification is a property of **claims** (findings), not objects (assets or users).

A finding is verified when every subject referenced in `evidence_refs_json` is either:

- a `discovery_evidence` record, or
- a confirmed `digital_asset`.

Verification is computed at read time from the reference graph; it is not stored. Storing it would introduce staleness: verification changes when a user confirms an asset after finding generation, and a stored flag would then be incorrect until backfilled.

**The overclaiming rule.** A finding that asserts account existence must reference a confirmed `digital_asset`. A finding that only asserts data-corpus exposure must reference a `discovery_evidence` record. A finding cannot assert more than its evidence supports; the verification status at read time exposes rules that overclaim.

**Lifecycle note.** The verification model applies only to `privacy_findings` rows, which exist only after confirmation (§7). Before confirmation, discovery evidence is surfaced through the candidate card as evidence-surface statements derived directly from `discovery_evidence`, not as claims in the `privacy_findings` sense. The verification traversal does not apply to candidate-card content.

Worked example. After a candidate is confirmed and the findings engine runs against the confirmed `digital_assets` row, using the same HIBP `discovery_evidence` record:

- A finding *"Your email appeared in the LinkedIn breach corpus"* places a `discovery_evidence` reference in `evidence_refs_json`. This claim is about corpus presence only; it does not assert account existence. It is verified because the `discovery_evidence` record directly backs the claim.
- A finding *"Your LinkedIn account was exposed"* places a `digital_asset` reference in `evidence_refs_json`. This claim asserts account existence. It is verified because the confirmed `digital_asset` provides that backing.
- A finding *"Your LinkedIn account was exposed"* that references only `discovery_evidence` (not the `digital_asset`) is **not verified** — the evidence does not directly support the account-existence claim. This is how the verification model exposes overclaiming rules: the gap between what a rule asserts and what it references becomes visible at read time.

The distinction is at the rule level. The same evidence record may back different finding types with different verification outcomes depending on what the rule claims.

### 11. Source-Class Aware Threshold

Candidates from non-breach providers (e.g., username enumeration) surface only at confidence ≥ medium. Breach-corpus candidates from non-aggregator providers (HIBP where `IsAggregator = false`) surface regardless of confidence, because the evidence is a direct corpus hit, not an inference.

Confidence is derived at generation time and pinned to the rule version that computed it, following ADR-001. The surface threshold is a versioned constant in code, not a stored column. `source_class` is immutable on the evidence record; it may be denormalized onto the candidate row for query performance, since immutability makes denormalization safe.

### 12. MVP Provider Scope

**HIBP (breach corpus lookup)**

- Consent type: `discovery_hashed_query` (renamed from `discovery_nonidentifying` per ADR-008 §12 consequential amendment).
- Uses k-anonymity: Atlas transmits the first 6 hexadecimal characters of SHA-1(email) to the breached-account range endpoint (`GET /breachedaccount/range/{prefix}`), verified against HIBP API v3 documentation. This is distinct from the Pwned Passwords API (api.pwnedpasswords.com), which uses a 5-character prefix and a different hash function application. The full outbound disclosure specification — two-step flow, hash prefix handling, evidence storage, and logging rules — is in ADR-008 §1 and §6.
- k-anonymity bypass is structurally impossible: the provider module has no code path capable of constructing a direct-search request. This is a type-level guarantee, following the templates-not-strings discipline.
- Requires HIBP Pro tier.
- IsAggregator gate: where `IsAggregator = true` on the breach metadata, the result stores a `discovery_evidence` record but generates neither an account candidate nor a `privacy_findings` row. An aggregator breach implies corpus exposure without implying an account at any specific service; there is no account relationship to adjudicate. The evidence is surfaced through the discovery experience independently of the candidate adjudication flow. The confirmation-first restriction from §7 is not relaxed; finding-subject polymorphism is not introduced.

**Username enumeration**

- Consent type: `discovery_identifying`.
- Two platforms at MVP: GitHub and one non-developer platform (final selection to be confirmed before implementation begins).
- Operates exclusively on user-supplied handles. Atlas must never derive or guess handles from names, email local-parts, phone numbers, or any other identity signal.
- `include_in_discovery = true` is required for a handle field to participate, even when the user explicitly supplied the handle.
- Candidates surface at confidence ≥ medium.

**Connected email**

- Deferred. Requires a go/no-go decision on CASA compliance cost (annual recurring assessment with mandatory recertification). This decision has not been made and is a prerequisite to implementation.
- HIBP plus username enumeration constitutes the MVP discovery surface. This is settled and not subject to reopening.

**Broker search**

- Not Atlas-originated discovery.
- A user may ask Atlas to check a named broker, having been told that the query is itself a disclosure to that broker. This is a per-query user-initiated action, not a background or scheduled Atlas task.
- No standing `discovery_brokers` consent row; per-query confirmation follows the destructive-action pattern.

### 13. Explicit Exclusions

The following must never be built:

1. **Account enumeration probing** — determining whether an email address has an account at a service by probing the service's authentication surface or any other endpoint.
2. **Handle inference** — deriving or guessing handles from names, email local-parts, phone numbers, or any other identity signal. Users supply handles; Atlas does not generate them.
3. **Background broker search** — Atlas originating broker queries on a schedule or without an explicit per-query user action in the current session.

Atlas must not communicate that its discovery view is comprehensive. Discovery coverage is bounded by available evidence and the set of enrolled providers. All user-facing copy must reflect that the view is incomplete.

---

## Consequences

### Schema additions (new tables; no existing table replaced)

| Table | Purpose |
|---|---|
| `discovery_runs` | Umbrella per-user discovery operation; `run_status` aggregated from child invocation states |
| `discovery_provider_invocations` | One row per provider execution within a run; carries ConsentProof binding and per-invocation status; consequential refinement introduced by ADR-008 §10 |
| `discovery_evidence` | Immutable evidence records, one per provider result |
| `discovery_candidates` | Proposed relationships pending user adjudication |
| `discovery_rejections` | Permanent rejection fingerprints |

### Schema adaptations (constraint and enum changes to existing tables)

| Table | Change |
|---|---|
| `digital_assets` | Add nullable `candidate_id` FK; add `'discovery'` to `source_type` enum; add conditional pairing constraint; add `deleted_at` timestamp (or equivalent soft-delete field) required by de-confirmation FK semantics — this is a column addition, not a constraint-only change |
| `privacy_findings` | Adopt typed-entry format for `evidence_refs_json` (closed vocabulary); `asset_id NOT NULL` unchanged |
| `user_personal_fields` | Rename `use_for_discovery` → `include_in_discovery`; update column comment to reflect preference semantics |
| consent table | Add `discovery_hashed_query` (renamed from `discovery_nonidentifying` per ADR-008 §12), `discovery_identifying`, `discovery_connected_sources` to `consent_type` enum |

### Code additions required

- Provider interface and `ConsentProof` type (unexported constructor in consent gate module)
- Consent gate service (issues `ConsentProof` after all three prerequisite checks)
- Candidate adjudication service (Confirm / Reject / Dismiss / Not sure actions)
- Candidate card component (pre-confirmation surface; must surface evidence without generating a finding)
- Evidence purge job (must check for confirmed references before purging)
- De-confirmation action (atomic: finding resolution with `asset_deconfirmed`, asset soft-deletion, candidate rejection, fingerprint write — in that order per §9 FK constraint)
- Verification computation (read-time traversal of `evidence_refs_json` reference graph)

### Open questions resolved by this ADR

- OQ-11: Verification model — claim-level, computed at read time, not stored.
- OQ-12: Broker search model — per-query user-initiated only; no standing consent.
- OQ-13: Evidence retention and rejection fingerprint semantics.
- OQ-15: Source-class aware surface threshold.

### Open questions not resolved by this ADR

- **OQ-01 (EU/EEA availability):** Reclassified from launch-blocking to EU-expansion-blocking. US-only launch proceeds; EU work deferred to a named expansion phase.
- **OQ-17 (score with empty confirmed-asset set):** Tracked as a post-ADR documentation item; does not block implementation.
- **Connected email go/no-go (CASA compliance cost):** Blocks connected-email provider implementation only. Does not gate HIBP or username-enumeration implementation. MVP discovery (HIBP + username enumeration) proceeds independently of this decision.
- **Second username-enumeration platform:** Final selection required before that provider's implementation. Does not gate ADR-007 approval or HIBP implementation.
- **HIBP k-anonymity hash prefix length:** Resolved by ADR-008 §1: 6 hexadecimal characters for the breached-account range endpoint (HIBP API v3); distinct from the Pwned Passwords API which uses 5 characters. See ADR-008 §1 for the full two-step flow and disclosure specification.

---

*This ADR was produced after Phase 0 decision-making (D1–D8, OQ-13) and pre-ADR conflict resolution (C1–C6). It supersedes no prior ADR in full; it introduces the discovery model as additive to the existing manual-first foundation.*
