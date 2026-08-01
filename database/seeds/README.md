# Seeds

`supabase/seed.sql` is intentionally empty of records.

## Why there is no global demo data

Demo data in Atlas is **per user**, created at runtime, labeled
`source_type = 'demo'`, and fully removable (ATL-018, ATL-083). Two documented
guarantees depend on that:

- **Demo isolation** — the privacy score is computed over demo records _or_ real
  records, never a mix, and demo scores carry a persistent "Demo score" label (ADR-004).
- **Demo removal** — a user can delete all demo records without touching real data.

Globally seeded rows would satisfy neither.

## What may go in a seed

Non-personal reference data only. Today there is none.

## Absolute rules

- No production data in seeds, fixtures, or tests (architecture §8)
- No realistic personal data — synthetic and obviously so (`ada@example.test`)
- No secrets, tokens, or keys
