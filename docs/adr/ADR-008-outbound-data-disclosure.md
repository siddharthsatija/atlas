# ADR-008: Outbound Data Disclosure

**Status:** Accepted
**Date:** 2026-08-24
**Related:** ADR-003 (envelope encryption), ADR-006 (audit events), ADR-007 (discovery model)
**Consequential amendments required in:** ADR-007 (see §12)

---

## Context

ADR-007 established the discovery model: the provider abstraction, consent gate,
ConsentProof pattern, evidence substrate, candidate lifecycle, and rejection fingerprint
properties. It explicitly deferred three concerns to this ADR:

- The exact outbound data leaving Atlas per provider class (ADR-007 §12 — "must be verified from
  current HIBP API documentation before implementation")
- The rejection fingerprint cryptographic construction (ADR-007 §8 — "deferred to ADR-008")
- The ConsentProof runtime validation contract (ADR-007 §4 — "issued-at timestamp and authorized
  field IDs checked at dispatch"; specifics deferred)

ADR-008 also introduces `discovery_provider_invocations`, a table not named in ADR-007 but required
by the ConsentProof design (one proof per provider invocation within a run) and by the fail-closed
rule (blocking a specific provider must be recorded at invocation granularity, not run granularity).
See §10.

This ADR does not modify any existing table beyond what ADR-007 already authorized. It does not
authorize connected-source implementation (§11). It does not authorize any production code,
migrations, or ATL tickets — those follow after approval.

---

## Decisions

### 1. Disclosure Scope per Provider Class

The following table is the authoritative disclosure specification. Anything not listed is not
permitted.

| Provider class | Consent type | What leaves Atlas | What Atlas receives |
|---|---|---|---|
| HIBP breach corpus — range lookup | `discovery_hashed_query` | First 6 hexadecimal characters of SHA-1(`email`) only | Array of `{ hashSuffix, websites }` for that prefix; local matching only |
| HIBP breach corpus — catalogue enrichment | None (public read; no user data) | Breach name(s) matching the local result — no email, no hash, no field ID | Public breach metadata (date, data classes, flags) for that named breach |
| Username enumeration | `discovery_identifying` | The exact stored handle/username value | Profile existence and metadata per the provider's public API contract |
| Broker search | Per-query confirmation (no standing consent) | User's name + minimum location required by that broker's lookup contract | Broker-specific listing data |
| Connected sources | `discovery_connected_sources` | **Deferred — see §11** | **Deferred** |

**HIBP prefix length.** The breached-account k-anonymity endpoint is
`GET /breachedaccount/range/{first 6 hex chars of SHA-1(email)}`, verified against the current
official HIBP API v3 documentation (haveibeenpwned.com/API/v3). This is distinct from the
Pwned Passwords range API (api.pwnedpasswords.com), which uses a 5-character prefix and a
different hash function application. No value from prior design discussions is carried forward
without independent verification. The provider module must assert exactly 6 hex characters at
the type level; any code path producing a different prefix length is a compilation error,
following the templates-not-strings discipline.

**HIBP two-step flow and disclosure boundary.** The HIBP provider executes as two distinct
operations with different disclosure properties:

Step 1 — Privacy-sensitive range lookup (disclosure event). Atlas sends the 6-character
SHA-1 prefix to the breached-account range endpoint. This is the privacy-sensitive outbound
disclosure: Atlas transmits partial hash material derived from the user's email (the first 6
hexadecimal characters of its SHA-1 hash). The prefix is not plaintext identifying data; it
cannot be reversed to recover the email address. The response contains an array of
`{ hashSuffix, websites }` entries for all hashes sharing that prefix. Atlas performs local matching to identify which suffix completes the
user's full SHA-1 hash. All non-matching range results are immediately discarded and must
not be persisted. After local matching, the matched `hashSuffix` itself is also discarded;
only the matched breach names (`websites`) are carried forward. This step triggers the
`discovery.provider.invoked` audit event with `disclosure_class = 'hashed_query'`.

Step 2 — Public metadata enrichment (not a disclosure event). For each matched breach name
only, Atlas may retrieve public breach metadata from the HIBP breach catalogue endpoint.
No user-specific authorization or disclosure material may be present in this request: no
email address, no hash prefix, no hash suffix, no `field_id`, no `user_id`, no
`discovery_run_id`. Provider-required protocol headers (such as `User-Agent`) may be sent
where the endpoint requires them; these are not user-specific identity signals. The breach
catalogue endpoint returns public metadata for a named breach (date, data classes,
verification status, and similar flags) that is available to any caller without user context.
This step is not recorded as a personal-data disclosure audit event. Operational logging
rules from §8 apply to both calls.

**Scope is closed.** A provider may not send any field not listed in its row above. If a broker
lookup requires additional identifying information beyond name and minimum location, that broker is
ineligible for MVP without a new decision and a new disclosure-scope row in this table.

**Broker-search authorization.** `include_in_discovery = true` on a field does not authorize
disclosure of that field in a broker-search query. The `include_in_discovery` flag governs
standing discovery-provider use. Broker-search queries are governed by per-query confirmation
only (D1.1).

### 2. Prohibition on Inferred Identifiers

Atlas may use a value as a discovery input only when all of the following are true:

1. The value exists as an explicit `user_personal_fields` row belonging to the user.
2. `include_in_discovery = true` on that specific row.
3. The relevant discovery consent is currently active.

Discovery evidence — including high-confidence or confirmed evidence — must never silently become
a new discovery input. A newly discovered identifier (email address, handle, phone number, or
other value) surfaced through evidence becomes eligible for discovery only after the user
explicitly: (1) reviews the discovered value; (2) adds or accepts it into their identity profile
as a `user_personal_fields` row; (3) sets `include_in_discovery = true` on that row. Until those
three steps are complete, the value appears only as evidence or context.

This prohibition applies even when the identifier comes from confirmed evidence. Surfacing a
newly discovered identifier as a suggested addition to the user's profile is a separate product
capability not governed by this ADR; the suggestion itself does not authorize use as a discovery
input.

This prohibition is an extension of the explicit account-enumeration exclusion in ADR-007 §13
and the handle-inference exclusion in ADR-007 §13.

### 3. Pre-Disclosure Notice for Identifying Disclosure (D1.3)

Before Atlas transmits an identifying value (`discovery_identifying` provider class) to a third
party for the first time for a given `(provider_class, field_id, disclosure_contract_version)`
tuple, Atlas must present a disclosure notice to the user. HIBP (`discovery_hashed_query`) is out
of scope for this requirement.

**Required notice content.** The notice must display:
- The exact handle or value that will be transmitted (derived from the `user_personal_fields` row
  identified by `field_id` at display time).
- The specific provider receiving it (not a category — the named service).
- The purpose of the lookup.
- An explicit statement that this request will leave Atlas.
- An option to cancel the disclosure.

**Acknowledgment record.** The durable acknowledgment is keyed on
`(provider_class, field_id, disclosure_contract_version)` and stored as a distinct record,
separate from the `include_in_discovery` flag and the standing consent row. The exact value
transmitted (the handle) is not stored in the acknowledgment record — only the internal field
reference (`field_id`) and the disclosure contract version.

**Subsequent runs.** After the user acknowledges for a given
`(provider_class, field_id, disclosure_contract_version)` tuple, subsequent invocations of that
provider against that field execute automatically while:
- The relevant `discovery_identifying` consent remains active.
- `include_in_discovery = true` on that field.
- The provider remains eligible.
- The `disclosure_contract_version` in the acknowledgment matches the current disclosure contract
  for that provider.

**Cancellation.** Cancelling the notice blocks that invocation only. `include_in_discovery` is
not modified by a cancellation. The acknowledgment record is not written.

**Material policy change.** If the provider's disclosure scope or relevant policy version changes
materially, a new `disclosure_contract_version` is issued. The prior acknowledgment for the old
version is no longer sufficient; a new notice is required before the next transmission.

**Dispatch check.** The validity of the acknowledgment is verified at dispatch time as check 7 of
the ConsentProof validation sequence (§4).

### 4. ConsentProof Runtime Validation Contract (D3.1)

This section refines ADR-007 §4. The module boundary (unexported constructor) and the runtime
validation requirement are unchanged. This section specifies the proof contents and the exact
dispatch validation sequence.

**ConsentProof contents.** A valid proof carries exactly:
- `user_id`
- `consent_type`
- `provider_class`
- `authorized_field_ids` (array of `user_personal_fields` UUIDs)
- `issued_at` (timestamp — audit and replay metadata only; not a validity window)
- `discovery_run_id`
- `invocation_id`

The proof is bound to a specific provider invocation within a specific run. A proof issued for
one `(discovery_run_id, invocation_id)` pair cannot be replayed against any other invocation.

**Dispatch validation sequence.** Before the provider is invoked, the runner verifies all of the
following checks in order. If any check fails or cannot be completed, the invocation fails closed:
the provider does not execute, and the `discovery_provider_invocations` row records
`invocation_status = 'blocked'` with the applicable closed error code.

1. The proof's `discovery_run_id` matches the current run.
2. The proof's `invocation_id` matches the current invocation.
3. The proof's `provider_class` matches the provider being invoked.
4. The proof's `consent_type` matches the consent type required by that provider.
5. A live query to the `consents` table (append-only; DB trigger rejects UPDATE per existing
   constraint) confirms the `consent_type` is currently active for `user_id`. Revocation is
   effective for any dispatch that occurs after the revocation row is committed.
6. Load all `field_id` values from `discovery_provider_invocation_fields` where
   `(user_id, invocation_id)` matches this invocation, then execute in order:
   (a) **BLOCK** if zero mapping rows exist. An invocation with no mapped fields must never
       reach the provider. The dispatcher is the normative enforcement point for this check
       (see §10 empty-mapping invariant); it must not rely solely on runner or service-layer
       construction to prevent an empty field set.
   (b) Assert every mapped `field_id` is contained in `authorized_field_ids`.
   (c) **BLOCK** if any mapped field is absent from `authorized_field_ids`.
7. For each `field_id` loaded in check 6, read the current `user_personal_fields` row for
   `(user_id, field_id)` at dispatch time. **BLOCK** if, for any mapped field: (a) the field
   type is not eligible for the `provider_class`; or (b) `include_in_discovery` is not `true`.
8. The required per-`(provider_class, field_id, disclosure_contract_version)` disclosure
   acknowledgment from §3 is present and valid for each identifying field being queried.
   (Not applicable to `discovery_hashed_query` providers.)

**`issued_at` semantics.** `issued_at` is audit and replay metadata. It is not a validity
window. A proof is not accepted or rejected based on how old it is; it is accepted or rejected
based on the live consent lookup (check 5) and the `invocation_id` binding (check 2).

### 5. Rejection Fingerprint Construction (D4.1)

This section fulfils the deferral in ADR-007 §8.

**Construction.**

```
fingerprint = HMAC-SHA256(user_rejection_key, canonical(provider_class, source_identifier))
```

where `user_rejection_key` is a dedicated, stable, per-user secret as described below.

**Canonicalization.** Canonicalization is provider-class-specific and versioned. A global
lowercase-all rule is prohibited: email local-parts, email domains, and usernames carry
provider-specific normalization semantics. The canonical form for each provider class must be
specified in that provider's implementation annex. The fingerprint value includes a
`fingerprint_version` field so future canonicalization changes do not silently alter suppression
behavior for existing fingerprints.

**Stored fingerprint format.**

```json
{ "v": 1, "alg": "hmac-sha256", "value": "<base64url>" }
```

The `v` field identifies the fingerprint version; the `alg` field makes the construction auditable
without inspecting code.

**Per-user rejection key.**

- Generated cryptographically at random per user (at least 256 bits of entropy).
- Used exclusively for rejection/suppression fingerprints — not derived from the DEK, not shared
  with any other cryptographic purpose.
- Wrapped under the existing Atlas key-management infrastructure. The wrapping follows the same
  pattern as the DEK in `user_encryption_keys` (per ADR-003 and the existing key-hierarchy), so
  the system gains one key material entry per user rather than a parallel key-management system.
  The implementing ticket must inspect `user_encryption_keys` and reuse its wrapping pattern
  exactly.
- On ordinary DEK/key rotation: the per-user rejection key is **re-wrapped** under the new KEK,
  not changed. Existing fingerprints remain valid across rotations.
- On account deletion: the per-user rejection key is destroyed (crypto-shredding). This is
  consistent with the existing DEK-destruction path; the implementing ticket must verify that the
  new rejection key is covered by the account-deletion flow.
- The plaintext rejection key is never stored, never logged, and never appears in any
  `user_personal_fields`, `discovery_evidence`, or other persistent column.

**Why not DEK-derived.** ADR-007 §8 (OQ-13) establishes that rejected-candidate evidence is
purged after 7 days. After evidence purge, Atlas may no longer possess the `source_identifier`.
A fingerprint construction that depends on re-derivation during key rotation would require
retaining the `source_identifier` until rotation completes — violating the evidence purge rule.
The dedicated stable rejection key avoids this: re-wrapping the key changes the wrapping, not
the key material, so no identifier retention is required.

**Equality lookup.** The fingerprint is stored as a deterministic fixed-length value to support
efficient equality lookup (`WHERE fingerprint = ?`). The `discovery_rejections` table is queried
at run time to suppress re-surfacing of rejected candidates. This lookup is the primary purpose of
the fingerprint; constructions that destroy equality semantics (such as randomized AES-GCM
ciphertext) are prohibited for this column. Security is provided by the keyed-HMAC construction
and the per-user key, not by indirection or encryption-at-rest of the fingerprint column itself.

**Classification.** The fingerprint is classified as sensitive pseudonymous metadata. It is not
plaintext personal data and is not a data record that can be returned to a user; it is an opaque
suppression token. Protection is provided by the keyed-HMAC construction, per-user key scoping,
RLS, and the wrapped key infrastructure.

### 6. Evidence Storage (D5.1)

Evidence records are governed by the data-minimization principle. The encrypted `provider_evidence_json`
column stores only the normalized fields required for candidate presentation, adjudication,
downstream findings, and provenance.

**General rule.** A provider response field is stored only if Atlas's product behavior or
historical explainability requires it after ingestion. Provider response fields may be inspected
transiently by the adapter to make ingestion or classification decisions (for example: using
`is_fabricated` or `IsSpamList` flags to decide whether to create a candidate)
without being persisted. Encryption is not justification for retaining unnecessary data.

**HIBP evidence fields — two-source model.** HIBP evidence is assembled from two calls (§1).
The table below identifies which call produces each field and what Atlas does with it.

*From the range response (`{ hashSuffix, websites }` per matched entry):*

| Field | Action | Reason |
|---|---|---|
| `hashSuffix` | **Discard after local matching** | Used only to identify the full-hash match; combined with the sent prefix it reconstructs SHA-1(email); must not be persisted |
| `websites` (matched breach names) | **Carry forward to Step 2; store as `breach_name`** | Breach name is the stable unique identifier for deduplication and catalogue lookup |
| Non-matching range entries | **Discard immediately** | HIBP terms and data-minimization require discarding all results except the local match |

*From the breach catalogue response (keyed by breach name; public, unauthenticated lookup):*

| Field | Action | Reason |
|---|---|---|
| `BreachDate` | **Store** as `breach_date` | Required for candidate card and finding |
| `DataClasses` | **Store** as `data_classes` (array) | Required for candidate card and finding type |
| `IsVerified` | **Store** as `is_verified` | Affects evidence quality displayed to user |
| `PwnCount` | **Store** as `pwn_count` | Population context; store only if Atlas surfaces or uses it |
| `IsSpamList` | **Inspect transiently; discard** | Drives non-service-corpus gate (ADR-007 §12); not stored in evidence JSON |
| `IsFabricated`, `IsRetired`, `IsSensitive` | **Inspect transiently; discard** | Not required for explainability |
| `Description` | **Discard** | Verbose text; reconstructable from public breach name if needed for display; not stored |

**Deduplication key.** Evidence deduplication uses `(provider_class, field_id, breach_name)`.
The breach name is a stable unique identifier within HIBP's catalogue. The `hashSuffix` is
discarded after matching and must not be used for deduplication.

**Username-provider evidence.** The same data-minimization rule applies. Provider-specific
persisted fields are defined in implementation annexes. The general principle: store the normalized
evidence required for the candidate card (service name, association signal, confidence basis) and
discard operational provider internals.

### 7. Encrypted-Column Inventory (D5.2)

This section records the discovery-related additions to the ADR-003 encrypted-column inventory.
The existing seven columns are unchanged.

| Table | Column | Classification | Action |
|---|---|---|---|
| `discovery_evidence` | `provider_evidence_json` | Restricted | Encrypt under ADR-003 (AES-256-GCM, per-user DEK, AAD = `discovery_evidence.provider_evidence_json:<record_uuid>`) |

All other columns in the discovery tables (`discovery_runs`, `discovery_evidence`,
`discovery_candidates`, `discovery_provider_invocations`, `discovery_provider_invocation_fields`,
`discovery_rejections`) are Internal metadata — relational identifiers, enums, timestamps, status
fields — and are not added to the ADR-003 inventory. These columns are protected by RLS and application-level owner scoping,
consistent with the existing architecture.

**`discovery_rejections.fingerprint`.** This column is not envelope-encrypted. Randomized
AES-GCM encryption would destroy equality-lookup semantics (see §5). Protection is provided by
the keyed-HMAC construction, per-user rejection key, RLS, and the wrapped key infrastructure.
This column is classified as sensitive pseudonymous metadata, not as an ADR-003 Restricted column.

**`discovery_candidates`.** Before committing to a persistent encrypted payload column on this
table, the implementing ticket must determine whether candidate-card content can be derived at
read time from `discovery_evidence` rows. A derived-at-read-time approach avoids duplicating
Restricted content into a second encrypted payload. A persistent payload column is justified only
if there is a concrete non-presentational datum that cannot be reconstructed from the evidence
substrate. If a column is added, it must be added to this inventory.

**ADR-003 AAD discipline.** The UUID for any new encrypted row must be generated by the
application before the row is inserted (using `randomUUID()` or equivalent), following the
existing pattern: the row id must exist before sealing so the AAD can be bound correctly.

### 8. Provider Boundary Logging (D6.1)

The existing `LOG_FIELD_POLICY` and `scrubString` rules (ATL-085) apply in full to the discovery
provider layer. Discovery adds a new and structurally distinct leak vector: provider request
payloads (SHA-1 prefix, handle) and response payloads (breach names, profile data) both contain
personal-data-derived content.

**Permitted application log fields per provider invocation:**

- `discovery_run_id`
- `invocation_id`
- `provider_class`
- `invocation_status`
- `duration_ms`
- HTTP status code (where operationally useful)
- A closed Atlas-owned `error_code` from a fixed vocabulary

**Prohibited from application logs:**

- Plaintext personal fields of any kind
- HIBP hash prefixes (any length)
- Handles, usernames, or any user-supplied identifier values
- Personal field UUIDs that could be correlated with a specific field value
- `user_id` (use `discovery_run_id` as the pseudonymous correlation key; resolving to a user
  requires a privileged database or audit lookup)
- Request query parameters, request bodies, or request URLs if they can embed identifying values
- Provider response payloads
- Breach names, data classes, profile evidence, or any content associated with the user's results
- Raw provider error bodies or messages

**Provider error handling.** Provider error bodies may be inspected transiently by the adapter to
classify the error and map it to an Atlas closed error code. Only the Atlas error code and HTTP
status enter the log. Provider error body content must not appear in logs. `scrubString` is
defense-in-depth for unexpected leaks; it is not the primary disclosure control.

**SDK and HTTP client configuration.** Any HTTP client or SDK used in the discovery provider layer
must have request/response body logging, header logging, and URL/query-parameter logging
disabled by construction (configuration, not runtime flags). This requirement must be verified by
the implementing ticket; a test must assert that the provider HTTP client does not emit structured
log output for request or response content.

**Scope — both HIBP calls.** For the HIBP provider specifically, the logging prohibition applies
to both the range lookup (Step 1, §1) and the breach catalogue enrichment (Step 2, §1). Although
Step 2 carries no user-identifying data, the URL path of a catalogue request contains the breach
name matched against the user's hash — a fact that could reveal which breach affected the user.
URL logging must be disabled for both calls.

**`discovery_run_id` as pseudonymous key.** The run ID is the pseudonymous operational correlation
key in logs. `invocation_id` provides finer correlation within a run. Resolving either to a user
identity requires a separate, privileged database lookup. This is consistent with ADR-006's
pseudonymous audit design.

### 9. Audit Events for Discovery Operations (D6.2)

The existing `audit_events` table (ADR-006 — hash-chained, pseudonymous) is extended with the
following closed event types. No other discovery events may be written to `audit_events`; run
orchestration lifecycle is owned by `discovery_runs` and `discovery_provider_invocations`.

**Required event types:**

| Event type | Trigger | Required payload fields |
|---|---|---|
| `discovery.consent.granted` | User grants a discovery consent type | `consent_type` |
| `discovery.consent.revoked` | User revokes a discovery consent type | `consent_type` |
| `discovery.disclosure.acknowledged` | User acknowledges first-run notice per `(provider_class, field_id, disclosure_contract_version)` | `provider_class`, `field_id`, `disclosure_contract_version` |
| `discovery.provider.invoked` | An invocation attempt that has reached the disclosure boundary — either dispatched to the provider after all ConsentProof checks pass, or blocked at the boundary when any check fails. Covers both outcomes; `invocation_status` distinguishes them. For HIBP: applies to the range lookup (Step 1) only; the breach catalogue enrichment (Step 2) is a public read and does not produce this event. | `discovery_run_id`, `invocation_id`, `provider_class`, `consent_type`, `disclosure_class`, `invocation_status` (`dispatched` or `blocked`) |
| `discovery.candidate.adjudicated` | User takes an adjudication action | `candidate_id`, `provider_class`, `adjudication` (`confirmed`, `rejected`, `dismissed`, `not_sure`) |
| `discovery.candidate.deconfirmed` | User de-confirms a previously confirmed discovery asset | `candidate_id`, `provider_class`, system reason `asset_deconfirmed` |

**`disclosure_class` vocabulary** (closed; used in `discovery.provider.invoked`):
- `hashed_query` — `discovery_hashed_query` provider range lookup (e.g. HIBP Step 1); covers only the privacy-sensitive call that sends the user's SHA-1 prefix. The HIBP breach catalogue enrichment (Step 2) is a public read and does not produce this event.
- `identifying_lookup` — `discovery_identifying` provider (e.g. username enumeration)
- `broker_query` — broker search

**`discovery.provider.invoked` must distinguish:**
- Authorization from execution: a blocked invocation (ConsentProof check failure) records
  `invocation_status = 'blocked'`; a successfully dispatched invocation records `'dispatched'`.
- Disclosure class: as above.

**HIBP breach catalogue enrichment (Step 2) is not an outbound-disclosure audit event.**
It is a public, unauthenticated metadata read keyed on a breach name. No user identity signal
is present in the request. The operational logging rules from §8 apply (log only `invocation_id`,
`provider_class`, status, duration; no content). A separate Atlas-internal event type for
catalogue enrichment may be introduced for operational observability, but it is not a disclosure
event and must not carry user-identifying payload.

**Prohibited audit payload content.** Audit event payloads must contain only closed/pseudonymous
metadata. The following are prohibited from any `audit_events` row for discovery events: plaintext
identifiers, HIBP hash prefixes, handles or usernames, provider request URLs or bodies, provider
response payloads, breach names associated with the user, and fingerprint values.

**Consent changes — dual record.** Discovery consent grants and revocations are recorded in both:
- The append-only `consents` table (authoritative consent history; DB trigger protects integrity).
- `audit_events` (tamper-evident cross-system trail; hash chain provides an independent record).

These serve different guarantees and both are required.

**Rejection fingerprint.** A separate `discovery.rejection.created` event is not required.
Fingerprint creation is an internal side effect of `candidate.adjudicated` (with `rejected`) and
`candidate.deconfirmed`; its existence is already accounted for by those audited events.

**Event type naming convention.** Event type strings follow the existing Atlas pattern
(`<domain>.<entity>.<verb>`, all lowercase, dot-separated, no underscores). This is consistent
with the `LOG_FIELD_POLICY` operation-name convention (`/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/`).

### 10. Discovery Run Schema and Retention (D7.1)

ADR-007 named `discovery_runs` as a single table. Analysis of the ConsentProof design (one proof
per provider invocation, each carrying a specific `provider_class`) and the fail-closed rule
("blocked provider must be distinguished from clean-zero execution") reveals that a single table
cannot satisfy both requirements. This section introduces `discovery_provider_invocations` as a
consequential refinement.

**`discovery_runs` — one row per user-triggered discovery operation.**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK; application generates before insert |
| `user_id` | `uuid` | FK → `profiles`; composite unique `(user_id, id)` for downstream FKs |
| `run_status` | enum | `pending`, `running`, `completed`, `partial`, `blocked`, `failed` |
| `started_at` | `timestamptz` | |
| `completed_at` | `timestamptz` | Nullable |

`run_status` is a deterministic aggregation of child `discovery_provider_invocations.invocation_status`
values under a versioned rule. The rule version is a code constant; changes to the rule require a
code version bump. `run_status` must not be independently or arbitrarily written by services; it is
computed from child state only.

| Child invocation state | Resulting `run_status` |
|---|---|
| No child invocation rows exist | `pending` |
| Any child invocation is non-terminal (`invocation_status IS NULL`) | `running` |
| All terminal; all are `success` | `completed` |
| All terminal; at least one `success` and at least one non-`success` | `partial` |
| All terminal; all are `blocked` | `blocked` |
| All terminal; none succeeded; at least one is `error` or `rate_limited` | `failed` |

The `pending` → `running` transition occurs when the first child invocation row is inserted. The
aggregation rule is exhaustive and mutually exclusive across those six input states. The specific
`provider_class` of any blocked or failed invocation is available from
`discovery_provider_invocations` rather than denormalized onto the run.

No provider-specific columns, consent metadata, error codes, or query payload fields belong on
this table.

**`discovery_provider_invocations` — one row per provider execution within a run.**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK; application generates before insert |
| `run_id` | `uuid` | Part of cross-user composite FK to `discovery_runs`; see ownership constraint below |
| `user_id` | `uuid` | Owner identity; composite `(user_id, run_id)` forms the cross-user parent FK; composite `(user_id, id)` unique for downstream FKs |
| `provider_class` | enum | Closed vocabulary; matches provider registry |
| `invocation_status` | enum | Nullable while non-terminal. Terminal values: `success`, `blocked`, `error`, `rate_limited`. See invocation lifecycle below. |
| `consent_proof_issued_at` | `timestamptz` | From the ConsentProof for this invocation |
| `started_at` | `timestamptz` | |
| `completed_at` | `timestamptz` | Nullable |
| `error_code` | `text` | Nullable; closed Atlas-owned vocabulary |

No query payloads, source identifiers, provider request URLs, or provider response content belong
in this table.

**Cross-user ownership constraint.** A simple `run_id → discovery_runs(id)` FK is not sufficient:
it would allow the database to represent a cross-user parent/child association that RLS alone
cannot prevent at the schema level. Following the established Atlas cross-user composite FK
pattern, the parent relationship must be declared as:

```
FOREIGN KEY (user_id, run_id) REFERENCES discovery_runs (user_id, id)
```

This requires `UNIQUE (user_id, id)` on `discovery_runs`, which is already specified in the
`discovery_runs` table above. The implementing ticket must use the exact FK declaration convention
from the existing migrations rather than the simplified single-column form. The cross-user
composite FK is the normative requirement; any migration that omits it in favour of a plain
`run_id` FK is incorrect.

**`discovery_provider_invocation_fields` — one row per field queried in a provider invocation.**

This table is a consequential refinement of ADR-008 §10, introduced to preserve the
one-invocation-per-disclosure-attempt invariant. A direct `field_id` column on
`discovery_provider_invocations` would require one invocation row per field queried. For a
provider that covers N fields in a single network call, that would produce N rows for a single
disclosure event, violating the invariant. The mapping table decouples the invocation record
(one row per HTTP call) from the field count (one mapping row per field).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK; application generates before insert |
| `user_id` | `uuid` | Owner identity |
| `invocation_id` | `uuid` | Part of cross-user composite FK to `discovery_provider_invocations` |
| `field_id` | `uuid` | Part of cross-user composite FK to `user_personal_fields` |

**Cross-user ownership constraints.**

```sql
FOREIGN KEY (user_id, invocation_id)
  REFERENCES discovery_provider_invocations (user_id, id)

FOREIGN KEY (user_id, field_id)
  REFERENCES user_personal_fields (user_id, id)
```

The `user_personal_fields` FK requires `UNIQUE (user_id, id)` on `user_personal_fields`. The
implementing ticket must inspect the existing `user_personal_fields` migration to determine
whether this constraint already exists before adding it.

**Field set uniqueness.** The same field may not appear twice on the same invocation:

```sql
UNIQUE (user_id, invocation_id, field_id)
```

**Empty-mapping invariant.** An invocation that reaches the dispatch boundary must have at least
one row in this table. Dispatch check 6 (§4) is the normative enforcement point: the dispatcher
reads the mapping rows and blocks immediately if zero rows exist. This is a fail-closed
requirement on the dispatcher; it does not depend solely on runner or service-layer construction.
The runner must not create an invocation row intending to leave the mapping table empty.

No query payload values, source identifier values, provider response content, or personal data
values belong in this table.

**Invocation lifecycle.** `invocation_status` is nullable while an invocation is non-terminal.
Lifecycle state is carried by timestamps rather than a separate in-progress status value:

| State | `started_at` | `completed_at` | `invocation_status` |
|---|---|---|---|
| Created | `NULL` | `NULL` | `NULL` — row exists; dispatch has not begun |
| Dispatching | `NOT NULL` | `NULL` | `NULL` — invocation has entered Atlas's dispatch-processing boundary; ConsentProof checks in progress |
| Terminal | `NOT NULL` | `NOT NULL` | `NOT NULL` — one of `success`, `blocked`, `error`, `rate_limited` |

`started_at` is set when the invocation enters Atlas's dispatch-processing boundary — not when an
external HTTP request is transmitted to the provider. An invocation may be blocked at any
ConsentProof check after `started_at` is set; in that case it records
`invocation_status = 'blocked'` and sets `completed_at` without transmitting any request.

**Invocation lifecycle invariant.** The following states are impossible and are prohibited. The
invariant is normative; exact enforcement (database CHECK constraint, application-layer guard, or
both) is specified in the implementing ticket following existing migration constraint patterns
(cf. the conditional-pairing CHECK on `digital_assets`).

- Terminal `invocation_status IS NOT NULL` with `completed_at IS NULL`.
- `completed_at IS NOT NULL` with `invocation_status IS NULL`.
- `completed_at IS NOT NULL` with `started_at IS NULL`.

Restated as a positive invariant: an invocation is in a terminal state if and only if both
`started_at` and `completed_at` are non-null and `invocation_status` is non-null. Any other
combination is a programming error.

**ConsentProof binding.** The ConsentProof for a given provider invocation carries both
`discovery_run_id` and `invocation_id` (from this table's `id`). This makes the authorization
proof specific to one provider invocation attempt within one discovery run, not merely to the
umbrella scan. The proof covers both blocked and dispatched invocations. See §4.

**Retention — invocation-first.** A `discovery_provider_invocations` row is retained while
any `discovery_evidence` row, `discovery_candidate` row, `digital_assets` row, or
`privacy_findings` row derived from that invocation still exists and has a retained downstream
dependency. Once no such dependency exists, the invocation row becomes eligible for deletion under
a separately defined operational-retention policy. The parent `discovery_runs` row is retained
while any of its child invocation rows is retained. The operational retention policy duration is
deferred; it must be defined before the discovery feature launches, with input from legal and
compliance on applicable regulatory lookback windows.

### 11. Connected-Source Deferral (D8.1)

Connected-source providers are deferred. This ADR does not define the provider-specific OAuth
contract, token handling, mailbox scopes, message schemas, or evidence-retention rules for
connected sources.

The `discovery_connected_sources` consent type defined in ADR-007 is reserved. Its existence in
the schema does not authorize any connected-source provider implementation.

**Governing-principle stub.** Any future connected-source provider is already bound by the full
ADR-008 framework:
- `ConsentProof` required; provider-class scoped; fail-closed.
- Dispatch validation per §4.
- Disclosure scope explicitly specified (no implicit authorization).
- Data minimization for evidence storage per §6.
- No plaintext personal data in application logs per §8.
- Closed audit events for outbound access per §9.
- Evidence retention rules per §10.
- Per-field scoping where applicable (§2 prohibition on inferred identifiers).
- No silent expansion of discovery inputs.

**Prerequisites before any connected-source provider implementation:**

1. CASA/compliance go/no-go resolved.
2. Provider-specific scope reviewed and approved.
3. Explicit specification produced: what data leaves Atlas, what Atlas receives, what is retained,
   what is discarded.
4. ADR-008 amendment or a dedicated connected-sources ADR produced and approved.
5. Explicit approval before code begins.

OAuth token fields, mailbox scopes, message schemas, and provider-specific retention are not
defined here and must not be implemented before the prerequisites above are satisfied.

---

## Consequences

### Schema additions — new tables

| Table | Notes |
|---|---|
| `discovery_provider_invocations` | Consequential refinement of ADR-007; see §10. Composite unique `(user_id, id)` for downstream FKs. Run association uses the cross-user composite FK `FOREIGN KEY (user_id, run_id) REFERENCES discovery_runs (user_id, id)` — a plain `run_id` FK is not sufficient. |
| `discovery_provider_invocation_fields` | Consequential refinement of ADR-008 §10; see §10. Preserves the one-invocation-per-disclosure-attempt invariant for providers that query multiple fields in a single network call. Cross-user composite FKs to `discovery_provider_invocations (user_id, id)` and `user_personal_fields (user_id, id)`. Unique `(user_id, invocation_id, field_id)` prevents duplicate field entries per invocation. Implementing ticket must verify `UNIQUE (user_id, id)` on `user_personal_fields` before declaring the cross-user FK. |

### Encrypted-column inventory additions

| Column | Encryption |
|---|---|
| `discovery_evidence.provider_evidence_json` | AES-256-GCM, per-user DEK, AAD = `discovery_evidence.provider_evidence_json:<record_uuid>` |

### New `user_encryption_keys` entry per user

Each user gains one additional key material entry: the per-user rejection key for
HMAC-SHA256 fingerprints (§5). Wrapped under the existing KEK hierarchy. The implementing ticket
must inspect `user_encryption_keys` and reuse its wrapping pattern exactly.

### New consent types (enum additions to `consents`)

`discovery_hashed_query` replaces `discovery_nonidentifying` (consequential ADR-007 amendment).
`discovery_identifying` and `discovery_connected_sources` are unchanged from ADR-007.

### New audit event types (closed enum additions to `audit_events`)

Six new event type strings per §9:
`discovery.consent.granted`, `discovery.consent.revoked`,
`discovery.disclosure.acknowledged`, `discovery.provider.invoked`,
`discovery.candidate.adjudicated`, `discovery.candidate.deconfirmed`.

### New closed enumerations required (code-level)

- `invocation_status`: `success`, `blocked`, `error`, `rate_limited`
- `disclosure_class`: `hashed_query`, `identifying_lookup`, `broker_query`
- Atlas `error_code` vocabulary: extended with discovery-provider error codes (exact vocabulary
  deferred to implementing ticket)
- `ConsentProof` constructor extended: adds `invocation_id` field

### Code additions

- `discovery_provider_invocations` repository
- Provider HTTP client with request/response logging disabled by construction; test asserting this
- Disclosure acknowledgment service (write, read, invalidate on contract version change)
- Per-user rejection key generation and wrapping (integrated with `user_encryption_keys` flow)
- Rejection fingerprint service (HMAC-SHA256, versioned canonicalization per provider)
- `ConsentProof` extended with `invocation_id`; dispatch validation updated to all eight checks

### Deferred items (intentionally not specified here)

- Operational-retention policy duration for `discovery_runs` / `discovery_provider_invocations`
- Provider-specific canonicalization rules for rejection fingerprints (specified in annexes)
- Provider-specific persisted evidence fields for username providers (specified in annexes)
- Connected-source disclosure contract (prerequisite list per §11)
- Atlas closed `error_code` vocabulary for discovery providers

### Open questions resolved by this ADR

- Rejection fingerprint construction (ADR-007 §8 deferral).
- ConsentProof runtime validation contract (ADR-007 §4 deferral).
- Outbound disclosure scope per provider class.
- `discovery_provider_invocations` table design.
- `discovery_provider_invocation_fields` mapping table design; one-invocation-per-disclosure-attempt invariant; dispatch fail-closed rule for empty field sets.
- ADR-003 encrypted-column inventory additions.
- Consent type rename: `discovery_nonidentifying` → `discovery_hashed_query`.

---

## §12 — Consequential Amendments Required in ADR-007

ADR-007 must be amended as follows after ADR-008 is approved. These amendments do not change
any ADR-007 decision; they update ADR-007 to reflect decisions made here.

| Section | Amendment |
|---|---|
| §5 (Consent Model), consent table | Rename `discovery_nonidentifying` → `discovery_hashed_query` in the consent type table and all references. Add rationale footnote: "nonidentifying" overstated the guarantee; a partial hash is transmitted. |
| §4 (Provider Abstraction), ConsentProof | Add `invocation_id` to the ConsentProof field list. Add cross-reference to ADR-008 §4 for the full dispatch validation sequence. |
| Consequences — Schema additions | Add `discovery_provider_invocations` to the new-tables list with note: "consequential refinement introduced by ADR-008 §10." Add `discovery_provider_invocation_fields` with note: "consequential refinement introduced by ADR-008 §10 to preserve one-invocation-per-disclosure-attempt invariant." |
| §12 (MVP Provider Scope), HIBP | Update "exact prefix length must be verified" with the verified value (6 hex chars, breached-account range endpoint per HIBP API v3 docs; distinct from the Pwned Passwords API which uses 5 chars) and cite ADR-008 §1. |

---

*This ADR was produced following the Phase 0 decision sequence (D1.1–D8.1) documented in the ADR-008 decision register (2026-08-24). It does not authorize production code, migrations, or ATL tickets.*
