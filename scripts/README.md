# Scripts

| Script                 | Purpose                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `sync-pr-template.mjs` | Mirrors `.claude/pull-request-template.md` to `.github/`. `--check` mode runs in CI to prevent drift. |

## Adding a script

- Keep scripts dependency-free where possible (Node built-ins only).
- Scripts that touch the database must never target a non-local environment by default.
- Never write a script that copies production data anywhere (architecture §18).
