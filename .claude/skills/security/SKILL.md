---
name: security
description: Atlas security engineering guidance covering authentication, authorization, Row Level Security, encryption, secrets, OWASP risks, audit logging, privacy, data minimization, AI safety, and the secure coding checklist. Use for any change touching auth, data access, personal data, AI context, or infrastructure — and before every merge.
---

# Atlas Security

**Source of truth:** `docs/03-security-and-access.md`, plus ADR-003 (encryption) and ADR-006 (audit logging). Security requirements **override delivery speed**. When this skill and the spec differ, the spec wins.

## Purpose

Atlas aggregates a person's entire digital footprint in one account. That makes it a high-value target and makes every security shortcut disproportionately expensive. This skill is the day-to-day application of the security specification.

## Core principles

1. Server-side authorization for every protected operation; RLS is defense in depth, not the only layer.
2. Deny by default.
3. Minimize what is collected, stored, logged, and sent to any processor.
4. Restricted data is encrypted, masked, and never logged.
5. Nothing leaves Atlas without explicit user review.
6. Every security-relevant action is auditable without creating a second sensitive dataset.
7. Assume any single component or provider can be compromised and limit the damage.

## Data classification

Know which tier you are handling (security §3) — it determines every other control:

| Tier           | Examples                                                                                                                                                                                            | Controls                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Public         | Marketing copy, docs                                                                                                                                                                                | None special                                                                                                          |
| Internal       | Feature flags, prompt versions, ops metrics                                                                                                                                                         | No user data                                                                                                          |
| Confidential   | Profile preferences, asset metadata, findings, activity summaries, consent history                                                                                                                  | RLS, authorization, no unnecessary exposure                                                                           |
| **Restricted** | Emails/phones (incl. request recipients), account identifiers, addresses, stored personal fields, request recipients/subjects/bodies, AI conversation content, tokens, credentials, export archives | Encrypted at rest, masked by default, never logged, never in analytics, minimal AI exposure with per-request approval |

## Authentication

- Supabase Auth: email magic link, optional Google OAuth. One identity per email — linking behavior is explicit and tested.
- Secure, HttpOnly, SameSite cookies.
- **Never reveal whether an email is registered** — identical responses and timing for known and unknown addresses.
- Rate-limit login and verification attempts (ATL-086) using the shared durable store; in-memory counters do not work on serverless.
- Reauthentication required before: account deletion, export creation and download, session revocation, MFA changes.
- Absolute and idle session lifetimes are defined and enforced, with custom middleware where the provider lacks native support.
- Optional TOTP MFA (ATL-110) — recommended given the aggregation risk; with magic-link-only auth, the user's email account is a single point of compromise.

## Authorization

- One customer role: `user`. Internal access is not an application role — support/engineering use narrowly scoped tooling with audited elevation.
- Identity is derived from the verified session, server-side. **Client-provided ownership fields are ignored, always.**
- Every entity lookup verifies ownership in the service layer, even when RLS also protects the row.
- Cross-user access returns not-found, never a distinguishable forbidden (no existence oracle).
- Export links are short-lived, single-purpose, revocable, and logged.
- No service-role credential ever reaches the browser. Verify with bundle analysis in CI (ATL-048).

## Row Level Security

- RLS enabled on **every** user-owned table. Pattern: `auth.uid() = user_id`.
- Documented exceptions: `profiles` uses `auth.uid() = id`; `audit_events` and `user_encryption_keys` enable RLS with **no client policies** (deny all) and are touched only by server-only service-role modules.
- Child tables carry `user_id` even when ownership is inferable through a parent.
- Foreign keys must prevent cross-user relationships.
- **Every policy is tested with two distinct users** (ATL-088), and the test matrix is generated from the schema list so a new table without tests fails CI.
- Migration review includes policy review. A new table without RLS is a blocking defect.

## Encryption

Full design in ADR-003; security §8 is authoritative for the column inventory.

- AES-256-GCM, random 96-bit nonce per value, AAD bound to `table.column:record_id` so ciphertext cannot be relocated between rows or columns.
- Envelope model: one KEK per environment in managed secret storage; one DEK per user, wrapped, in `user_encryption_keys`.
- Encrypted columns: `user_personal_fields.value_encrypted`, `digital_assets.account_identifier_encrypted`, `data_requests.recipient_encrypted`, `data_requests.subject_encrypted`, `data_requests.body_encrypted`, `ai_messages.content_encrypted`.
- **Encrypted columns are non-searchable and non-filterable.** Do not add a query on one; do not "just store a lowercase copy" — that defeats the control. A blind index requires separate security review.
- Rotation: KEK rotation re-wraps DEKs (metadata only); per-user DEK rotation re-encrypts that user's rows via an idempotent job.
- **Crypto-shredding:** account deletion destroys the user's DEK first, making values unrecoverable including in backups.
- One server-only crypto module owns all primitives. Reveal actions are audited.
- **This is not end-to-end encryption.** The server can decrypt for user-initiated operations. Never let copy imply otherwise.

## Secrets

- Secrets live in Vercel/Supabase/approved stores, separate per environment. Never in the repository, never in client bundles, never in logs.
- `.env` files are never committed; secret scanning runs in CI (ATL-090).
- Any exposed credential is rotated immediately — treat exposure as compromise.
- Production secret visibility is restricted; access is logged where the provider supports it.

## OWASP focus areas for Atlas

| Risk                         | Atlas control                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| Broken access control / IDOR | Service-layer ownership checks + RLS + UUID identifiers + two-user tests; not-found on cross-user       |
| Cryptographic failures       | ADR-003 envelope encryption; TLS everywhere; no mixed content                                           |
| Injection                    | Parameterized queries only; Zod validation at every boundary; output encoding                           |
| Insecure design              | Deterministic rules for score/status; explicit user approval for external effects                       |
| Security misconfiguration    | Nonce-based CSP, HSTS, frame-ancestors, Referrer-Policy, Permissions-Policy (ATL-087)                   |
| Vulnerable dependencies      | CI dependency and supply-chain scanning; critical findings block merge                                  |
| Auth failures                | Managed provider, rate limits, session revocation, reauth for sensitive ops, optional MFA               |
| Data integrity failures      | Idempotency keys, validated state transitions, audit hash chain                                         |
| Logging failures             | Central redaction allowlist; audit events with pseudonymous subjects                                    |
| SSRF                         | No user-supplied URL fetching in MVP; if introduced, allowlist and review                               |
| **Prompt injection**         | Untrusted stored text delimited, fixed system policy, no tools exposed, proposals not actions (ATL-089) |
| **Stored XSS**               | Encode all rendered user content; no rich text (asset names and notes are attacker-controlled)          |

## Audit logging

- Security events go to `audit_events`: server-only writer, deny-all client policies, INSERT/SELECT privileges only, per-subject hash chain for tamper evidence, pseudonymous HMAC `subject_ref`, allowlisted `context_json`.
- Distinct from `activity_events` (user-facing, user-owned, deleted with the account). Emit both through the shared emitter so they cannot drift.
- Log: auth security events, export lifecycle, deletion initiation/completion, DEK creation/destruction, request transitions, consent changes, sensitive-value reveals, operator elevation, policy/score/prompt versions.
- Never log: raw request bodies, full personal identifiers, AI prompts, export contents, tokens, sensitive query parameters.
- Retention 90 days; only deletion-completion evidence survives account deletion.

## Privacy and data minimization

- Nothing sensitive is collected at onboarding. Personal fields are collected just-in-time, optional, individually deletable, consent-gated (ADR-002).
- Personal fields are unchecked by default in every request flow; approval is per request.
- Mask identifiers by default; reveal is deliberate and temporary.
- No sensitive values in URLs, query strings, analytics, or error reports.
- No advertising use, no data sale, no external model training without explicit separate opt-in.
- Consent types: `ai_processing`, `personal_fields_storage`, `ai_conversation_history`, `product_updates`. Check consent server-side before the gated behavior.
- Export includes the user's own data only; account deletion is tested end to end.

## AI safety

- Server-side calls only; no provider key in client code.
- Purpose classification decides what data may be retrieved; retrieval is capped in count and sensitivity.
- Redaction runs before every provider call. Stored personal fields require per-request approval to be included.
- Retrieved user text is **untrusted data**: delimited, never able to alter system policy, no tools exposed to the model.
- Outputs are schema-validated; AI never writes score, findings, or status, and never triggers an external action.
- Provider retention configured to the strongest available mode; prompt and model versions recorded.
- Prohibited into the provider: tokens, unrelated records, full exports, secrets, background transmission without a user request.

## Common mistakes

- Trusting a `user_id` from the client "because the UI sets it correctly".
- Relying on RLS alone and skipping the service-layer ownership check.
- Adding a table without RLS or without two-user tests.
- Querying, filtering, or sorting on an encrypted column.
- Returning 403 for another user's record (confirms existence) instead of 404.
- Logging an error object that contains the request body or an identifier.
- Putting a token, email, or record ID in a URL or analytics event.
- Sending an unapproved personal field into AI context.
- Treating stored asset notes as trusted text in a prompt.
- Claiming end-to-end encryption.
- In-memory rate limiting on serverless.
- Committing a `.env` or pasting a production key into a preview environment.

## Decision framework

**Is this data restricted?** Check security §3. If restricted: encrypt, mask, exclude from logs/analytics/search, and require approval before AI exposure.

**Does this need authorization?** If it reads or writes user data, yes — in the service, plus RLS. No exceptions for "internal" endpoints.

**Can I log this?** Only allowlisted, non-restricted fields via the redaction utility. If you are unsure, do not log it.

**Should AI see this?** Only if the purpose requires it, the user authorized it, and it survives redaction. Default no.

**Is this an external effect?** If it leaves Atlas, it requires explicit user review. Nothing autonomous, ever.

**Encrypted or plaintext column?** Restricted text is encrypted. If you need to search it, the requirement is wrong or needs a reviewed blind-index design — do not weaken the encryption.

**Found a security gap in the spec?** Report it; do not paper over it. Security contradictions are blocking.

## Review checklist

`checklists.md` holds the full secure-coding gate. Fast pass:

- [ ] Server-side ownership check present; client identity ignored
- [ ] New tables have RLS and two-user tests
- [ ] Restricted fields encrypted, masked, absent from logs/analytics/URLs
- [ ] No encrypted-column queries
- [ ] Typed errors; no existence oracles; neutral auth messaging
- [ ] Audit + activity emitted for security-relevant actions
- [ ] AI context minimal, approved, redacted, and schema-validated
- [ ] Rate limits on auth, AI, export, and request generation
- [ ] No secrets in code, bundles, or logs
