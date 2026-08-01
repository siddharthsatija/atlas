# Test fixtures

## Rules

1. **No production data. Ever.** Not in fixtures, seeds, snapshots, or screenshots
   (`docs/02-technical-architecture.md` §8).
2. Synthetic personal data must be **obviously synthetic** — use `.test` domains
   (`ada@example.test`), never plausible real addresses or phone numbers.
3. Demo fixtures carry `source_type = 'demo'` so demo-isolation assertions
   (ADR-004) are meaningful.
4. Fixtures for time-dependent behavior use the injected clock and assert at
   boundaries (179/180 days, 364/365 days), not comfortable midpoints.
5. Never commit a fixture containing a real secret, token, or key.
