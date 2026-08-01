# Atlas Security and Access Specification

## 1. Purpose

Atlas handles highly sensitive information about a person’s digital identity. This document establishes minimum security and privacy requirements for the MVP. These requirements are mandatory and override delivery speed.

## 2. Security objectives

- Prevent unauthorized access to user data.
- Minimize the amount and sensitivity of stored data.
- Make all external actions user-controlled.
- Preserve confidentiality and integrity of deletion drafts.
- Ensure users can export and delete their information.
- Produce useful auditability without creating a second sensitive dataset.
- Limit damage if a component or provider is compromised.

## 3. Data classification

### Public

- Marketing copy
- Public service directory content
- Product documentation

### Internal

- Feature flags
- Non-sensitive operational metrics
- Prompt template versions

### Confidential

- User profile preferences
- Asset metadata
- Findings
- Activity summaries
- Consent history

### Restricted

- Email addresses and phone numbers (including request recipients)
- Account identifiers
- Addresses and location history
- Stored personal fields (`user_personal_fields`)
- Request draft recipients, subjects, and bodies
- AI conversation content (when history is enabled)
- Authentication tokens
- Provider credentials
- Export archives

Restricted data receives the strongest controls. Restricted text fields stored in the database are application-layer encrypted per §8; the encrypted-column inventory in §8 is authoritative.

## 4. Data minimization

- Do not request legal name, address, or phone number during onboarding.
- Collect personal fields only when needed for a user-requested action. Personal fields are stored in the encrypted `user_personal_fields` vault, collected just-in-time during the first draft flow, individually deletable, and consent-gated (ADR-002).
- Allow users to omit fields from request drafts; fields are unchecked by default and approval is per request.
- Mask identifiers by default.
- Store AI interaction metadata, not raw prompt and response text, unless conversation history is explicitly enabled.
- Delete temporary context after completion.
- Do not store third-party credentials directly.

## 5. Authentication

### Requirements

- Supabase Auth or equivalent managed identity provider.
- Email magic link or secure passwordless method.
- Optional Google OAuth.
- Secure, HttpOnly, SameSite cookies where applicable.
- Reauthentication before account deletion, export access, or session revocation.
- Rate-limit login and verification attempts.
- Do not reveal whether an email address is registered.

### Session management

- Show active sessions where provider support allows.
- Support “sign out all devices.”
- Revoke sessions after password or identity-provider compromise.
- Define absolute and idle session lifetimes.
- Rotate refresh tokens according to provider capabilities.

## 6. Authorization

### Roles

MVP has one customer role: `user`.

Internal administrative access is not a broad application role. Any support or engineering access must use narrowly scoped operational tooling with audited elevation.

### Rules

- Users may access only records where `user_id = auth.uid()`.
- The server derives user identity from the verified session.
- Client-provided ownership fields are ignored.
- Every entity lookup verifies ownership.
- Shared links to exports are short-lived, single-purpose, and revocable.
- No direct browser access to service-role credentials.

## 7. Row Level Security

RLS is enabled on every user-owned table.

Baseline pattern:

```sql
create policy "users_read_own"
on public.digital_assets
for select
using (auth.uid() = user_id);

create policy "users_insert_own"
on public.digital_assets
for insert
with check (auth.uid() = user_id);

create policy "users_update_own"
on public.digital_assets
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "users_delete_own"
on public.digital_assets
for delete
using (auth.uid() = user_id);
```

Requirements:

- Test every policy with two distinct users.
- Child tables include `user_id` even when ownership can be inferred through a parent.
- `profiles` uses `auth.uid() = id` (its primary key is the owner). Internal tables (`audit_events`, `user_encryption_keys`) enable RLS with **no client policies** — deny all; only server-side service-role modules touch them.
- Service-role operations are isolated in server-only modules.
- Migration review must include policy review.
- Deny by default.

## 8. Encryption

### In transit

- TLS for all network connections.
- No mixed content.
- Secure webhook verification.

### At rest

- Provider-managed encryption for database and storage as the base layer.
- Application-layer envelope encryption for restricted text (full design in ADR-003):
  - **Algorithm:** AES-256-GCM, random 96-bit nonce per value, AAD bound to `table.column:record_id` so ciphertext cannot be moved between rows or columns.
  - **Key hierarchy:** one KEK per environment in managed secret storage; one DEK per user, generated on first need and stored wrapped in `user_encryption_keys` with a `kek_version`. The KEK never appears in the repository, client bundle, or logs.
  - **Encrypted columns (authoritative inventory):** `user_personal_fields.value_encrypted`, `digital_assets.account_identifier_encrypted`, `data_requests.recipient_encrypted`, `data_requests.subject_encrypted`, `data_requests.body_encrypted`, `ai_messages.content_encrypted`.
  - **Searchability:** encrypted columns are non-searchable and non-filterable by design. Search and filters operate only on non-restricted fields. Any future need for search over restricted values requires a separately reviewed blind-index design.
  - **Rotation:** KEK rotation re-wraps DEKs (metadata-only, fast). Per-user DEK rotation re-encrypts that user's rows via an idempotent background job. Both procedures documented and rehearsed before production launch.
  - **Crypto-shredding:** account deletion destroys the user's DEK as the first data-destruction step, making encrypted values unrecoverable including in provider backups.
  - **Honesty rule:** this is server-side encryption, not end-to-end encryption. The server can decrypt for user-initiated operations (drafting, export, approved AI context). User-facing copy must never claim otherwise.
  - A single server-only crypto module owns encrypt/decrypt; sensitive-value reveal actions are recorded in `audit_events`.

### Display

- Mask email, phone, and account identifiers by default.
- Require deliberate reveal.
- Avoid sensitive values in URL paths and query strings.

## 9. Secret management

- Secrets reside in Vercel, Supabase, or approved secret stores.
- Use separate secrets per environment.
- Never commit `.env` files.
- Add automated secret scanning.
- Rotate any exposed credential immediately.
- Restrict who can view production secrets.
- Log secret access where provider support exists.

## 10. AI data handling

### Allowed

- Minimal asset metadata required to answer a user question
- Redacted finding summaries
- Personal fields explicitly approved by the user **in the current draft flow** (per-request approval; stored personal fields are never sent to the provider without it)
- Curated product and service guidance

### Prohibited

- Authentication tokens
- Unrelated user records
- Full exports
- Secret keys
- Background transmission without a user request
- Training usage without explicit, separate opt-in

### Controls

- Server-side AI gateway
- Purpose classification
- Data selection policy
- Redaction before provider call
- Structured output validation
- Output content filtering
- Model and prompt version logging
- User-visible disclosure when AI is used
- Provider data-retention settings configured to the strongest available mode

## 11. External communications

For MVP:

- Atlas drafts but does not autonomously send deletion or correction requests.
- User must review the recipient, included fields, subject, and body.
- “Send” opens a user-controlled email client or later uses a confirmation step if direct sending is introduced.
- No bulk outreach.
- No hidden tracking pixels.
- No retry that may duplicate an external request.

## 12. Audit logging

Full design in ADR-006. Security-relevant events are recorded in the internal `audit_events` table, which is distinct from the user-facing `activity_events` timeline:

|            | `activity_events`           | `audit_events`                                                                                                            |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Audience   | The user (product timeline) | Security and incident response only                                                                                       |
| Access     | RLS-owned, visible in UI    | No client access; server-only writer                                                                                      |
| Subject    | `user_id`                   | Pseudonymous HMAC `subject_ref`                                                                                           |
| Lifecycle  | Deleted with the account    | 90-day rolling retention; only deletion-completion evidence survives account deletion                                     |
| Mutability | Normal table                | Append-only: app role has INSERT/SELECT only; per-subject hash chain provides tamper evidence, verified by a periodic job |

Events recorded (via a single emitter so activity and audit cannot drift):

- Sign-in and sign-out security events
- Export requests, downloads, and expiries
- Account deletion initiation and completion; DEK creation and destruction
- Request state transitions
- Consent changes
- Sensitive-value reveal actions
- Administrative elevation
- Policy, score, and prompt versions used

Do not record in either table:

- Raw request bodies
- Full personal identifiers
- AI prompts
- Export contents
- Tokens
- Sensitive database query parameters

The audit writer enforces a context-key allowlist; unknown keys are dropped and counted as a telemetry warning. Provider log streaming remains enabled as a secondary copy of security-relevant application logs.

## 13. Privacy score integrity

- Score calculation is deterministic and versioned.
- AI cannot directly modify score.
- Every score change links to factor changes.
- User actions cannot manipulate score without changing underlying state.
- Score is guidance, not a guarantee of safety.

## 14. Data retention

MVP policy:

- Active user data: retained while account is active.
- Personal fields (`user_personal_fields`): retained until the user deletes the field or the account; individually deletable at any time.
- AI transient context: discarded after request completion.
- AI conversation history: only stored when explicitly enabled; disabling hard-deletes all conversations.
- Notifications: purged after 90 days.
- Score snapshots: full history 90 days, then compacted to one per day.
- Idempotency keys: purged after 24 hours.
- Export archives: expire within 24 hours.
- Audit events: 90-day rolling window (configurable pending jurisdiction review, see `docs/open-questions.md`).
- Deleted-account backups: expire according to provider backup lifecycle and disclosed policy; encrypted values in backups are unrecoverable after DEK destruction.
- Demo data: removable at any time.

Retention values must be confirmed in the public privacy notice.

## 15. Data export

- User requests export from Settings.
- Reauthentication is required.
- Job runs asynchronously.
- Archive is encrypted or protected by a short-lived signed URL.
- Download is logged.
- Archive expires automatically.
- Export includes source data and readable documentation of fields.
- Internal secrets and other users’ information are excluded.

## 16. Account deletion

1. Explain consequences and retention exceptions (including which audit evidence survives, per §12).
2. Require reauthentication and explicit confirmation.
3. Revoke sessions.
4. Cancel pending jobs.
5. **Destroy the user's data-encryption key (crypto-shredding, ADR-003)** — all encrypted values become unrecoverable, including in provider backups.
6. Delete or anonymize user-owned records.
7. Delete storage objects.
8. Queue deletion with external processors where required.
9. Record minimal non-identifying completion evidence in `audit_events` (pseudonymous `subject_ref`, retained for the 90-day window).
10. Notify user when complete, if a delivery address remains lawfully available.

Deletion must be tested end to end.

## 17. Threat model

### T1: Cross-user data access

Controls:

- RLS
- Server authorization
- UUID identifiers
- Automated two-user tests

### T2: Account takeover

Controls:

- Secure auth provider
- Rate limiting
- session revocation
- login notifications
- optional TOTP MFA (ticket ATL-110, P1 — Atlas aggregates a person's full digital footprint, making the account a high-value target; with magic-link auth the user's email account is otherwise a single point of compromise)

### T3: Prompt injection through asset content

Controls:

- Treat stored and external text as untrusted data
- Delimit retrieved content
- Fixed system policy
- Tool allowlist
- No autonomous external actions

### T4: Sensitive data leakage to logs

Controls:

- Central redaction utility
- allowlisted telemetry fields
- tests for log payloads
- production logging review

### T5: Malicious or misleading AI output

Controls:

- Structured schemas
- evidence references
- uncertainty disclosure
- user review
- deterministic rules for score and status

### T6: Export link compromise

Controls:

- Short expiration
- signed URL
- reauthentication
- download logging
- one-click revocation

### T7: Insider access

Controls:

- least privilege
- production access approval
- audited elevation
- no routine database browsing
- break-glass procedure

### T8: Third-party provider compromise

Controls:

- data minimization
- vendor review
- separate keys
- revocation procedure
- processor inventory

## 18. Security headers

At minimum:

- Content-Security-Policy
- Strict-Transport-Security
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy
- frame-ancestors restriction
- Secure cookie attributes

CSP should avoid unsafe inline scripts wherever practical.

## 19. Application security requirements

- Validate all inputs.
- Encode all rendered user content.
- Sanitize rich text or do not support it.
- Protect state-changing endpoints against CSRF where relevant.
- Apply rate limits to auth, AI, exports, and request generation.
- Enforce file type and size limits.
- Scan attachments if attachments are introduced.
- Use parameterized database access.
- Avoid sensitive data in URLs.
- Use dependency and supply-chain scanning.

## 20. Incident response

### Severity

- Critical: confirmed large-scale exposure, active compromise, or external action without consent
- High: limited exposure, authentication bypass, or restricted-data leakage
- Medium: exploitable weakness with meaningful constraints
- Low: hardening or low-impact issue

### Initial response

1. Contain.
2. Preserve evidence without copying sensitive data unnecessarily.
3. Revoke keys or sessions.
4. Assess impacted users and processors.
5. Fix and validate.
6. Notify according to legal and contractual obligations.
7. Complete post-incident review.

## 21. Security launch checklist

- [ ] RLS enabled and tested on every user table
- [ ] No service-role key in browser bundle
- [ ] Secrets scanned
- [ ] Restricted fields encrypted per the §8 column inventory (including request recipient and subject)
- [ ] KEK rotation and DEK rotation procedures documented and rehearsed
- [ ] Crypto-shredding verified in account-deletion test
- [ ] Audit writer immutability and hash-chain verification tested
- [ ] Logs reviewed for personal data
- [ ] AI context minimization tested; per-request personal-field approval enforced
- [ ] AI-processing consent captured at onboarding; processor DPAs in place (hosting, database, AI provider, email provider)
- [ ] Direct external sending disabled
- [ ] Export expiration tested
- [ ] Account deletion tested end to end (sessions, DEK, rows, storage, audit survivors)
- [ ] Rate limits enabled and backed by the shared durable store
- [ ] Security headers verified (nonce-based CSP)
- [ ] Dependency scan clean of unresolved critical issues
- [ ] Incident contacts and key-rotation procedure documented
