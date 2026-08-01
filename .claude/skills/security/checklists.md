# Secure Coding Checklist

Run before every merge. Any unchecked item on a change that touches auth, data access, personal data, AI context, or infrastructure is blocking.

## Authorization

- [ ] Identity derived from the verified server-side session
- [ ] No client-provided `user_id` or ownership field is trusted
- [ ] Service-layer ownership check present (not relying on RLS alone)
- [ ] Cross-user access returns not-found, not forbidden
- [ ] Protected route or action authenticates before reading input where possible
- [ ] No service-role credential reachable from client code (bundle check)

## RLS and schema

- [ ] RLS enabled on every new user-owned table
- [ ] Policies cover select, insert, update, delete
- [ ] Child tables carry `user_id`; FKs prevent cross-user relationships
- [ ] Two-user tests written and passing for every new table and endpoint
- [ ] Internal tables (`audit_events`, `user_encryption_keys`) have RLS with no client policies
- [ ] Migration review included policy review

## Encryption

- [ ] Restricted text stored in an encrypted column per the §8 inventory
- [ ] Encryption performed in the repository via the crypto module
- [ ] AAD bound to table, column, and record ID
- [ ] No query, filter, sort, or index on an encrypted column
- [ ] No plaintext "searchable copy" of a restricted value
- [ ] Deletion paths destroy the DEK before deleting rows where applicable

## Secrets

- [ ] No secret in code, tests, fixtures, or client bundle
- [ ] Environment-specific secrets used; no cross-environment reuse
- [ ] No `.env` committed; secret scan passing
- [ ] Any exposed credential rotated and the exposure documented

## Input and output safety

- [ ] Every boundary validated with Zod (client input, provider responses, AI output, job payloads, JSON columns)
- [ ] Parameterized database access only
- [ ] All rendered user content encoded; no rich text rendering
- [ ] Uploads (if any) enforce type and size limits
- [ ] CSRF protection on state-changing endpoints where relevant
- [ ] Rate limits applied to auth, AI, export, and request generation via the shared store

## Logging, telemetry, audit

- [ ] All logging goes through the redaction utility
- [ ] No personal data, request bodies, prompts, draft text, tokens, or identifiers in logs or analytics
- [ ] Security-relevant actions emit audit events with allowlisted context
- [ ] Audit and activity emitted from the shared emitter
- [ ] No UPDATE or DELETE issued against `audit_events`
- [ ] Error reports carry codes and request IDs only

## Privacy and data minimization

- [ ] No new sensitive data collected unless a user-requested function requires it
- [ ] Nothing sensitive collected during onboarding
- [ ] Personal fields optional, masked by default, individually deletable
- [ ] Personal fields unchecked by default in request flows; approval is per request
- [ ] Consent checked server-side before gated behavior
- [ ] No sensitive value in a URL, query string, or analytics event
- [ ] Export contains only the requesting user's data
- [ ] Retention respected (notifications 90d, audit 90d, exports 24h, idempotency keys 24h)

## AI safety

- [ ] Provider calls are server-side only
- [ ] Purpose classified; retrieval minimal and capped
- [ ] Redaction applied before the provider call
- [ ] Only user-approved personal fields included
- [ ] Retrieved user text delimited and marked untrusted
- [ ] No tools exposed to the model; outputs are proposals only
- [ ] Output schema-validated; AI writes no stored value directly
- [ ] Prompt and model versions recorded
- [ ] Injection tests cover any new AI surface

## External effects

- [ ] Nothing sends, publishes, or shares without explicit user review
- [ ] No background transmission of user data
- [ ] No retry that could duplicate an external request
- [ ] No tracking pixels or hidden telemetry in user-facing content

## Headers and configuration

- [ ] CSP nonce-based with no unsafe-inline in production
- [ ] HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors present
- [ ] Cookies secure, HttpOnly, SameSite

## Threat-model spot check

For the surface you touched, confirm the relevant control still holds:

- [ ] T1 cross-user access — RLS + service checks + two-user tests
- [ ] T2 account takeover — rate limits, session revocation, reauth, MFA path
- [ ] T3 prompt injection — delimiting, fixed policy, no tools, proposals only
- [ ] T4 log leakage — central redaction, allowlist, tests on payloads
- [ ] T5 misleading AI output — schemas, evidence references, uncertainty, user review
- [ ] T6 export link compromise — short expiry, signed URL, reauth, download logging
- [ ] T7 insider access — least privilege, no routine data browsing, audited elevation
- [ ] T8 provider compromise — minimization, separate keys, revocation path
