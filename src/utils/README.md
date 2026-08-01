# utils

Pure, domain-free helpers. No imports from `lib/`, `server/`, `features/`, or
`components/` — enforced by ESLint.

If a helper knows anything about Atlas concepts (assets, findings, requests, scores,
masking rules), it belongs in `lib/` instead. Two homes for the same kind of code is
the drift this boundary prevents.

Empty by design: nothing generic has been needed yet. Do not pre-populate it.
