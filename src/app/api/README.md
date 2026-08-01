# Route handlers

Reserved for cases a server action cannot serve: AI streaming (`ai/`), export
downloads (`exports/`), and provider webhooks (`webhooks/`).

Rules (architecture §10, security §19):

- Authenticate before reading the body where possible
- Validate every input with Zod
- Verify webhook signatures
- Return the `{ data, error, requestId }` envelope with typed error codes
- Never place sensitive values in URLs or query strings
- Apply rate limits (ATL-086)

Prefer a server action. Adding a route handler requires a reason recorded in the PR.
