# Schema design notes

One file per table as it is designed, capturing decisions that do not belong in a
migration comment: why a column is nullable, why an index exists, which ADR governs it.

The data model itself is defined in `docs/02-technical-architecture.md` §7 — this
directory does not duplicate it.

## Naming conventions

| Object           | Convention                  | Example                           |
| ---------------- | --------------------------- | --------------------------------- |
| Table            | plural, snake_case          | `digital_assets`, `data_requests` |
| Column           | singular, snake_case        | `service_name`, `follow_up_at`    |
| Encrypted column | `_encrypted` suffix         | `body_encrypted`                  |
| JSON column      | `_json` suffix              | `factor_breakdown_json`           |
| Timestamp        | `_at` suffix, `timestamptz` | `created_at`, `resolved_at`       |
| Boolean          | `is_` / `has_` prefix       | `is_demo`                         |
| Foreign key      | `<singular_table>_id`       | `asset_id`                        |
| Index            | `idx_<table>_<columns>`     | `idx_digital_assets_user_status`  |
| Constraint       | `<table>_<rule>`            | `data_requests_status_valid`      |
| Policy           | `users_<action>_own`        | `users_read_own`                  |

## Type rules

- `timestamptz` always; store UTC and convert at the edge using the profile timezone
- Integer for the privacy score (0–100) — never a float
- Enum values constrained in the database **and** matching the TypeScript union;
  drift between the two is a defect
- `not null` by default; nullability needs a documented reason
- JSON columns validated with Zod at the repository boundary
