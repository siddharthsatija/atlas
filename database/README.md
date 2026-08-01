# Database

Design-time material for the schema. Executable migrations live in
`supabase/migrations/`; this directory holds the templates and conventions that keep
them consistent.

| Directory   | Contents                                                  |
| ----------- | --------------------------------------------------------- |
| `schema/`   | Per-table design notes as tables are designed (M3 onward) |
| `policies/` | RLS policy templates and the policy review checklist      |
| `seeds/`    | Seed strategy — why the global seed stays empty           |

## Sources of truth

- Data model: `docs/02-technical-architecture.md` §7
- Database rules: `docs/02-technical-architecture.md` §8
- RLS and encryption: `docs/03-security-and-access.md` §7–8
- Encrypted column inventory: `docs/03-security-and-access.md` §8 (authoritative)
- Working guidance: `.claude/skills/database/SKILL.md`

This directory does not restate the data model. Read the architecture document.

## Two constraints worth repeating

1. **Migrations are append-only after shared deployment.** Names are permanent.
2. **Encrypted columns are unqueryable.** No index, filter, sort, or join may touch
   one, and a plaintext "searchable copy" is prohibited (ADR-003). If a requirement
   seems to need it, escalate to `security-engineer` — the requirement is wrong, not
   the encryption.
