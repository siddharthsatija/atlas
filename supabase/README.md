# Supabase environments

Implementation runbook for ATL-003. The authority for environment rules is
`docs/02-technical-architecture.md` §18 and `docs/03-security-and-access.md` §9 —
this document explains how to operate them, it does not restate them.

## The four environments

| Environment    | Supabase project           | Data           | Who configures it              |
| -------------- | -------------------------- | -------------- | ------------------------------ |
| **local**      | Local stack via Docker     | Synthetic only | Each developer, from this repo |
| **preview**    | Ephemeral / shared preview | Synthetic only | CI, per pull request           |
| **staging**    | Dedicated hosted project   | Synthetic only | Owner, once                    |
| **production** | Dedicated hosted project   | Real user data | Owner, once, restricted access |

Three **persistent hosted projects are not required**: preview may run against an
ephemeral instance or the local stack. What is required is that staging and
production are separate projects with separate keys, databases, and storage, and
that **production data never reaches a lower environment**.

## Non-negotiable rules

These are enforced in code by `src/config/environment-isolation.ts`, which runs at
application boot and in `pnpm env:check`:

| Rule                                             | Enforced by                                  |
| ------------------------------------------------ | -------------------------------------------- |
| `local` must point at a loopback host            | `local-must-use-loopback`                    |
| `staging`/`production` must not be loopback      | `remote-must-not-use-loopback`               |
| production must be HTTPS end to end              | `production-requires-https`                  |
| no lower environment may target production       | `lower-environment-targets-production`       |
| service-role key ≠ anon key                      | `service-role-must-differ-from-anon`         |
| `ATLAS_KEK` ≠ `AUDIT_HMAC_KEY`                   | `kek-and-audit-key-must-differ`              |
| no placeholder secrets in staging/production     | `no-placeholder-secrets-in-hosted-environments` |

A violation fails the boot and fails `pnpm env:check`. Messages name the variable,
never its value.

## Local setup

```bash
git init                 # hooks require a git repository
pnpm install
cp .env.example .env.local

openssl rand -base64 32  # -> ATLAS_KEK
openssl rand -base64 32  # -> AUDIT_HMAC_KEY   (must differ from ATLAS_KEK)

pnpm db:start            # prints the local URL, anon key, and service-role key
# paste those three values into .env.local

pnpm env:check           # verifies configuration, isolation, and connectivity
```

`pnpm db:start` requires Docker. Everything except the database commands works
without it.

Local mail (magic links) is captured by Inbucket at <http://127.0.0.1:54324> and
never leaves the machine.

## Hosted setup (owner action)

Creating the hosted projects requires a Supabase account and cannot be done from
this repository.

1. Create two projects — `atlas-staging` and `atlas-production` — in separate
   regions or at minimum as separate projects. Never reuse one project for both.
2. For each, collect: project URL, anon key, service-role key, project ref.
3. Generate **independent** `ATLAS_KEK` and `AUDIT_HMAC_KEY` per environment
   (`openssl rand -base64 32`). Never copy keys between environments — reusing a
   KEK across environments would let a staging compromise decrypt production data.
4. Store every value in the deployment platform's secret store, scoped to that
   environment. Never in this repository.
5. Set `ATLAS_PRODUCTION_PROJECT_REF` in staging and CI to the production project
   ref. This turns "no lower environment targets production" into an enforced
   check rather than a convention.
6. Restrict production secret visibility to the smallest possible group.
7. Verify from a shell that has that environment's variables loaded:

```bash
pnpm env:check:staging
pnpm env:check:production
```

Both must print `Environment "<name>" is correctly configured.`

## Migration workflow

Migrations are **append-only after shared deployment** (architecture §8). A
deployed migration is never edited, renamed, or reverted — see
`supabase/migrations/README.md` for the authoring rules.

| Environment    | How migrations are applied                                   |
| -------------- | ------------------------------------------------------------ |
| **local**      | `pnpm db:migrate:local` — rebuilds from scratch and reseeds   |
| **preview**    | CI applies migrations to the ephemeral instance              |
| **staging**    | Deploy pipeline, before the new application version serves    |
| **production** | Deploy pipeline only (ATL-098). Never from a developer laptop |

```bash
pnpm db:migrate:status   # which migrations are applied where
pnpm db:migrate:local    # guarded: refuses unless ATLAS_ENV=local
pnpm db:types            # regenerate src/types/database.generated.ts
```

`pnpm db:reset` and `pnpm db:migrate:local` are destructive and refuse to run
unless `ATLAS_ENV=local`. There is deliberately **no** `db:push:production`
script: production migrations run in the deploy pipeline so that they are
reviewed, ordered, and recorded.

Every migration must be backward-compatible with the currently deployed
application version, because rolling the application back must remain safe with
the new schema in place. Breaking changes use expand/contract, forward-only.

## Preventing production data from reaching lower environments

- Never run `supabase db dump` from production into a local or staging database.
- Reproduce bugs with synthetic fixtures. If you cannot, improve observability
  rather than copying data (`.claude/skills/deployment/SKILL.md`).
- `pnpm db:reset` cannot target a hosted environment; the guard blocks it.
- Seeds contain no records: demo data is created per user at runtime and is
  removable (ATL-018 / ATL-083). See `database/seeds/README.md`.

## Troubleshooting

| Symptom                                             | Cause and fix                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `Configuration invalid` listing variables           | A variable is missing or malformed. The message names it             |
| `local-must-use-loopback`                           | `.env.local` points at a hosted project. Use the local stack         |
| `no-placeholder-secrets-in-hosted-environments`     | A development or CI value reached staging/production. Rotate it      |
| `kek-and-audit-key-must-differ`                     | The same key was pasted twice. Generate two independent keys         |
| `Supabase not reachable`                            | Run `pnpm db:start` (local) or check the project URL and key         |
| Hooks not installed                                 | The repository has no `.git`. Run `git init && pnpm install`         |
