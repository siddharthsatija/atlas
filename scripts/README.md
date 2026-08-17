# Scripts

| Script                 | Purpose                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-pr-template.mjs` | Mirrors `.claude/pull-request-template.md` to `.github/`. `--check` mode runs in CI to prevent drift.                                                 |
| `local-auth-pool.mts`  | Local only (#132). Recreates the Supabase auth container with a bounded, reusing GoTrue → Postgres pool. Re-run after every `supabase start`; `--check` reports without mutating. |

## Adding a script

- Keep scripts dependency-free where possible (Node built-ins only).
- Scripts that touch the database must never target a non-local environment by default.
- Never write a script that copies production data anywhere (architecture §18).
