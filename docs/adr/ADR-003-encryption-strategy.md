# ADR-003: Application-Layer Encryption Strategy

**Status:** Accepted
**Date:** 2026-07-29
**Related:** `03-security-and-access.md` §8, `02-technical-architecture.md` §7.16, ATL-084, ADR-002

## Problem

The security spec mandates application-layer encryption for restricted text (request bodies, account identifiers) but specifies no algorithm, key hierarchy, rotation mechanics, or column inventory. ATL-084 was an XL ticket with no design. Additionally, the classification marks email addresses as Restricted while `deletion_requests.recipient` and `subject` were stored in plaintext — a direct contradiction. Ad hoc encryption here is the highest technical-debt risk in the product.

## Options considered

1. **Provider-managed encryption only (at-rest disk encryption).**
   Rejected: does not protect against database operator access, SQL-level exfiltration, or backup exposure; explicitly insufficient per the security spec.

2. **Single service-wide key encrypting all restricted columns.**
   Pros: simplest. Cons: one key compromises every user; rotation requires re-encrypting the whole database; no per-user deletion guarantee.

3. **Envelope encryption with per-user data-encryption keys (DEKs) wrapped by a master key-encryption key (KEK).**
   **Accepted.**

4. **Per-user keys derived from user credentials (end-to-end style).**
   Rejected for MVP: magic-link auth provides no stable user secret; would break server-side draft generation, export, and AI-context assembly, all of which legitimately require server-side plaintext for user-initiated operations.

## Decision

- **Algorithm:** AES-256-GCM, random 96-bit nonce per value, authenticated with AAD = `table.column:record_id` to prevent ciphertext swapping between rows or columns.
- **Key hierarchy:** one KEK per environment held in managed secret storage (never in the repository or client bundle). One DEK per user, generated on first need, stored in `user_encryption_keys` wrapped by the KEK with a `kek_version`.
- **Encrypted columns (MVP inventory):**
  - `user_personal_fields.value_encrypted`
  - `digital_assets.account_identifier_encrypted`
  - `data_requests.recipient_encrypted`
  - `data_requests.subject_encrypted`
  - `data_requests.body_encrypted`
  - `ai_messages.content_encrypted` (only when conversation history is enabled)
- **Searchable vs non-searchable:** encrypted columns are non-searchable and non-filterable by design. Search and filters operate only on non-restricted fields (service name, domain, category, status, severity, dates). No product requirement needs search over restricted values; if one emerges, use a separately reviewed blind-index design rather than weakening encryption.
- **Rotation:**
  - KEK rotation: generate new KEK, re-wrap all DEKs (fast, metadata-only), bump `kek_version`. Procedure documented before production launch.
  - DEK rotation (rare, per-user, e.g., after suspected compromise): background job re-encrypts that user's rows; idempotent and resumable.
- **Crypto-shredding:** account deletion destroys the user's DEK as its first data-destruction step, rendering all encrypted values unrecoverable including in provider backups, then proceeds with row deletion.
  - **Irreversibility is enforced in the service, not the schema.** The unique index on `user_encryption_keys` is partial (`where status = 'active'`), so a destroyed row leaves the active slot free and the database will accept a replacement key. The encryption service therefore classifies a user's key rows without filtering by status, and refuses both reads and writes for a shredded account. Without that check a single later write silently re-keys the account and it resumes accumulating recoverable ciphertext — destruction downgraded from permanent to temporary.
  - **Reads never lazily create a key.** Lazy DEK creation belongs to the first restricted *write*. On a read there is nothing to create, and a fresh key is guaranteed not to open existing ciphertext.
  - **A destroyed key is detected before AES-GCM is attempted.** GCM cannot distinguish a wrong key from tampered ciphertext, so decrypting under any replacement key reports `integrity_failure` — which means "wrong key, wrong AAD, or tampering" and reads as a security incident. After a shred the truth is `key_destroyed`: permanent and expected. Ordering the check first is what keeps the two signals apart.
- **Module boundary:** a single server-only `crypto` module owns encrypt/decrypt; repositories call it; UI and AI layers never see the primitives. Decryption events for reveal actions are auditable.

## Rationale

- Envelope encryption bounds blast radius (one user per DEK), makes KEK rotation cheap, and enables crypto-shredding — a materially stronger deletion story for a privacy product.
- GCM with binding AAD prevents both tampering and cross-row ciphertext replay.
- Explicit column inventory and the "no search on encrypted fields" rule prevent the most common encryption-adjacent design drift.

## Tradeoffs

- Server can decrypt: this is not end-to-end encryption, and documentation must not claim otherwise. Required for drafts, exports, and AI context; honest framing preserved in user-facing copy.
- Per-value nonce + wrapped-DEK lookups add minor latency; negligible at MVP scale.
- Encrypted recipient means the request list cannot show full recipient addresses without decryption; list views show the associated service name and a masked recipient, consistent with masking defaults.

## Consequences

- `deletion_requests.recipient`/`subject` → `data_requests.recipient_encrypted`/`subject_encrypted` (contradiction resolved).
- New `user_encryption_keys` table (no RLS read access from the client; service-role only).
- ATL-084 rewritten with concrete acceptance criteria; account deletion (ATL-082) gains the crypto-shred step.
