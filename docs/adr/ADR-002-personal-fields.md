# ADR-002: Personal Fields Architecture

**Status:** Accepted
**Date:** 2026-07-29
**Related:** `02-technical-architecture.md` §7.13, `03-security-and-access.md` §4, §8, FR-08, ADR-003

## Problem

Deletion and correction drafts must include the personal fields a service needs to identify the requester (name, email used with the service, sometimes address or username). The PRD correctly forbids collecting these during onboarding, and no table stores them. The draft flow references "user-approved fields" that have no source. Without a defined home for this data, implementation would improvise — the worst outcome for the most sensitive data in the product.

## Options considered

1. **Per-request ephemeral entry.** User types fields into each draft; nothing is stored outside the encrypted request body.
   Pros: minimal storage. Cons: retyping for every request contradicts the primary persona's need for "efficient request drafting and tracking"; repeat requests are the core loop; users would paste personal data into an unstructured body where Atlas cannot show, exclude, or redact individual fields; "show which personal fields are included" (FR-08) becomes impossible to implement faithfully.

2. **Derive from auth profile only.** Use the sign-in email and display name.
   Cons: the email used with a given service often differs from the Atlas sign-in email; no address/username support; silently couples authentication identity to request identity.

3. **Reusable encrypted personal-fields vault, collected just-in-time.**
   **Accepted.**

## Decision

Create `user_personal_fields`: a small, user-managed, application-layer-encrypted store of identity fields.

- **Where data lives:** `user_personal_fields` table (field key, label, encrypted value), plus the existing `digital_assets.account_identifier_encrypted` for per-service identifiers. Values are encrypted with the user's data-encryption key (ADR-003).
- **When collected:** just-in-time — first requested during the first draft flow (Step 1 of the request modal), never during onboarding. Every field is optional. Users can also add or edit fields in Settings → Personal data.
- **Encryption:** AES-256-GCM under the per-user DEK; values never appear in logs, analytics, search indexes, or AI context without explicit per-request approval.
- **Retention:** while the account is active or until the user deletes the field, whichever comes first. `last_used_at` is tracked so users can see and prune unused fields.
- **Deletion:** individual hard delete from Settings; account deletion destroys the per-user DEK first (crypto-shredding), making all values unrecoverable even in backups.
- **User control:** Settings → Personal data lists every stored field, masked by default, with reveal, edit, and delete. Consent to store is captured the first time a field is saved (`consent_type = personal_fields_storage`).
- **Request generation flow:** Step 1 shows stored fields plus service account identifier as unchecked-by-default checkboxes → user approves a subset → only approved field keys and values pass the AI policy layer → draft body is generated → `included_fields_json` stores approved keys only (never values) → body is encrypted at rest.

## Rationale

- Faithful to data minimization: fields are optional, collected only when a user-requested action needs them, and individually deletable.
- Makes FR-08's field-level inclusion/exclusion real: structured fields can be checked, unchecked, masked, and audited by key.
- Atlas already stores comparably sensitive data (account identifiers, request bodies) encrypted; this adds no new risk class.
- Crypto-shredding gives a stronger deletion guarantee than row deletion alone.

## Tradeoffs

- Atlas stores more restricted data than option 1. Accepted because the encryption model, masking defaults, and per-field deletion controls contain the risk, and the alternative degrades the core product loop.
- Encrypted values are not searchable or filterable — acceptable; there is no product requirement to search personal field values.
- Just-in-time collection adds a step to the first draft. Accepted; subsequent drafts get faster, which is where the loop lives.

## Consequences

- New table `user_personal_fields` with RLS and two-user tests.
- New Settings section (frontend spec §15) and tickets ATL-105/ATL-106.
- AI drafting rules (07 §6) updated: drafts may use only fields approved in the current request flow.
