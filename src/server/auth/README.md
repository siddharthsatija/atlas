# Auth

Session verification and reauthentication helpers.

Tickets: ATL-011 (setup), ATL-012 (protected routes), ATL-013 (sessions),
ATL-075 (security settings), ATL-110 (optional TOTP MFA).

## Rules (security §5–6)

- Identity is derived from the **verified server-side session**. Client state is never
  authorization evidence.
- Reauthentication required before: account deletion, export creation and download,
  session revocation, MFA changes.
- Responses must never reveal whether an email address is registered — identical
  response and timing for known and unknown addresses.
- Absolute and idle session lifetimes are defined and enforced; custom middleware
  where the provider lacks native support.
- Auth attempts are rate-limited via the shared durable store (ATL-086).
- Sign-in, sign-out, and revocation emit audit events.
