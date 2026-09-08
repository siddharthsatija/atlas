# Atlas

**Personal digital identity and privacy management**
Tagline: _Map your digital identity._
Status: **M13 engineering complete — discovery infrastructure implemented; production discovery initiation remains a Phase 1 blocker. Pending Phase 1 product acceptance.**

Atlas gives people one trusted place to discover, understand, and control the personal
information, accounts, permissions, and traces connected to their digital life.

---

## Table of contents

- [What Atlas is (and is not)](#what-atlas-is-and-is-not)
- [Project setup](#project-setup)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [Folder structure](#folder-structure)
- [Development workflow](#development-workflow)
- [Documentation map](#documentation-map)
- [Contributing](#contributing)

---

## What Atlas is (and is not)

Atlas's promise is **visibility and agency**, not fear. These constraints are product
requirements, not preferences, and apply to code and copy alike:

- Atlas does **not** crawl the open internet and does **not** probe authentication,
  login, password-reset, or other account-existence surfaces. Atlas does **not** guess
  or infer handles or identifiers. Atlas may transmit the minimum explicitly authorized
  identity signal to a supported active discovery provider under the applicable
  consent/disclosure contract (ADR-007, ADR-008); results are probabilistic and
  evidence-backed. At Phase 1, GitHub is the currently active discovery provider
  (user-supplied eligible handle, transmitted under the `discovery_identifying` consent
  contract). HIBP is accepted infrastructure currently parked by ATL-216 and is not
  part of the active Phase 1 discovery journey.
  Confirmed candidates feed the deterministic rule engine (ADR-001, ADR-007).
- Atlas does **not** guarantee deletion from third-party systems. It helps prepare and
  track requests.
- Atlas does **not** send anything on the user's behalf in the MVP.
- Atlas's encryption is **server-side, not end-to-end** (ADR-003). Copy must never imply
  otherwise.
- The privacy score is guidance, never a safety guarantee. 100 never means zero risk.
- Demo data is always labeled as demo.

### MVP scope

Authentication and onboarding · authorized identity signals → automatic discovery through
supported providers → evidence-backed discovery candidates → user adjudication → confirmed
digital assets · digital identity dashboard · rule-generated privacy findings · versioned
privacy score · deletion and correction request drafts backed by an encrypted personal-fields
vault · in-app notifications and follow-up reminders · activity and request tracking · data
export and account deletion with crypto-shredding.

---

## Project setup

### Prerequisites

| Tool         | Version           | Notes                                |
| ------------ | ----------------- | ------------------------------------ |
| Node.js      | 22+               | Pinned in `.nvmrc`                   |
| pnpm         | 10+               | `corepack enable pnpm`               |
| Docker       | latest            | Required by the local Supabase stack |
| Supabase CLI | via devDependency | `pnpm supabase --help`               |

### First run

```bash
# 1. Install dependencies (this also installs git hooks via `prepare`)
pnpm install

# 2. Create your local environment file
cp .env.example .env.local

# 3. Generate the two local secrets that must not be blank
openssl rand -base64 32   # -> ATLAS_KEK
openssl rand -base64 32   # -> AUDIT_HMAC_KEY

# 4. Start the local database, auth, and storage stack
pnpm db:start             # prints the local anon + service-role keys

# 5. Paste those keys into .env.local, then start the app
pnpm dev
```

Full environment setup — including hosted staging and production — is documented in
[`supabase/README.md`](supabase/README.md).

`pnpm db:start` prints the local Supabase URL and keys. Local mail (magic links) is
captured by Inbucket at <http://127.0.0.1:54324> and never leaves your machine.

Steps 4–5 need Docker. **Everything else — lint, typecheck, tests, and the production
build — works without Docker or any external service**.

Environment validation runs at boot (`src/config/env.ts`): a missing or malformed value
fails fast with a message naming the variable — never echoing its value.

> Schema and migrations are in place through M13. Run `pnpm db:start` then
> `pnpm db:reset` to apply all migrations locally. See `.claude/implementation-order.md`.

### Verify your setup

```bash
pnpm env:check                  # configuration, isolation, and connectivity
pnpm verify:all                 # format:check -> lint -> typecheck -> test -> build
pnpm test:coverage              # unit tests with coverage thresholds
pnpm audit                      # dependency vulnerabilities

pnpm exec playwright install chromium   # one-time, ~195 MB
pnpm test:e2e                   # end-to-end + accessibility harness
```

All of the above are verified working except `pnpm test:e2e`, which additionally needs
system libraries for Chromium (`pnpm exec playwright install-deps`, may require sudo).

---

## Environment variables

Full annotated list in `.env.example`. Each environment (local, preview, staging,
production) uses its own values; secrets are never shared across environments and never
committed (`docs/03-security-and-access.md` §9).

### Public — safe in the browser

| Variable                        | Purpose                   |
| ------------------------------- | ------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL      |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key; RLS-constrained |
| `NEXT_PUBLIC_APP_URL`           | Canonical app URL         |

### Server-only — never prefix with `NEXT_PUBLIC`

| Variable                          | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `SUPABASE_SERVICE_ROLE_KEY`       | Bypasses RLS. Server-only modules exclusively                            |
| `ATLAS_KEK`                       | Key-encryption key, 32 bytes base64 (ADR-003)                            |
| `ATLAS_KEK_VERSION`               | Current KEK version, for rotation                                        |
| `AUDIT_HMAC_KEY`                  | HMAC key for pseudonymous audit subjects (ADR-006)                       |
| `ANTHROPIC_API_KEY`               | AI provider. Unused until milestone M7                                   |
| `RATE_LIMIT_REDIS_URL` / `_TOKEN` | Shared durable rate-limit store — serverless cannot rate-limit in memory |

CI asserts that no server secret reaches the client bundle. Any exposed credential is
rotated immediately and the exposure documented.

### What needs external infrastructure

| Command                                                           | Needs                           | Without it                       |
| ----------------------------------------------------------------- | ------------------------------- | -------------------------------- |
| `pnpm dev`, `build`, `start`                                      | nothing                         | works                            |
| `pnpm lint`, `typecheck`, `test`, `test:coverage`, `format:check` | nothing                         | works                            |
| `pnpm env:check`                                                  | Supabase reachable              | fails at the connectivity step   |
| `pnpm test:e2e`, `test:a11y`                                      | Chromium binary + system libs   | fails at browser launch          |
| `pnpm db:*`                                                       | Docker                          | fails to start the stack         |
| `pnpm test:integration`                                           | Docker + local Supabase stack   | runs against local DB with migrations |
| `pnpm audit`, `deps:verify`                                       | network (npm registry)          | fails offline                    |

No command requires production credentials. Local `.env.local` uses non-secret
placeholders plus two keys you generate yourself.

---

## Scripts

### Development

| Script                      | Purpose                  |
| --------------------------- | ------------------------ |
| `pnpm dev`                  | Start the dev server     |
| `pnpm build` / `pnpm start` | Production build / serve |

### Quality gates

| Script                         | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `pnpm format` / `format:check` | Prettier write / verify                |
| `pnpm lint` / `lint:fix`       | ESLint, including layer-boundary rules |
| `pnpm typecheck`               | `tsc --noEmit`, strict                 |
| `pnpm verify:all`              | Everything CI requires, in order       |
| `pnpm ci:verify-policy`        | Assert CI holds no production secrets and every architecture §19 gate runs on PRs |
| `pnpm gates:verify`            | Prove each gate blocks on a deliberate defect (`--only`, `--skip`) |
| `pnpm scan:secrets`            | Scan the working tree for credentials (redacted output) |
| `pnpm deps:verify`             | Dependency advisories vs. the time-boxed exception policy |

### Testing

| Script                          | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `pnpm test` / `test:watch`      | Unit tests (Vitest)                                 |
| `pnpm test:coverage`            | Unit tests with coverage thresholds                 |
| `pnpm test:integration`         | Services, repositories, RLS — needs `pnpm db:start` |
| `pnpm test:e2e` / `test:e2e:ui` | Playwright journeys                                 |
| `pnpm test:a11y`                | Accessibility-tagged Playwright checks              |

### Environment

| Script                                   | Purpose                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `pnpm env:check`                         | Validate the current environment: config, isolation, connectivity  |
| `pnpm env:check:staging`                 | Same for staging (that environment's variables must be loaded)     |
| `pnpm env:check:production`              | Same for production                                                |

Add `--skip-connectivity` to run the configuration and isolation checks offline.

### Database

| Script                      | Purpose                                      |
| --------------------------- | -------------------------------------------- |
| `pnpm db:start` / `db:stop` | Local Supabase stack                                          |
| `pnpm db:reset`             | Rebuild from migrations + seed. Refuses unless `ATLAS_ENV=local` |
| `pnpm db:migrate:local`     | Apply all migrations from scratch (alias of `db:reset`)       |
| `pnpm db:migrate:status`    | Which migrations are applied                                  |
| `pnpm db:validate-migrations` | Append-only + RLS validation (required CI gate)             |
| `pnpm db:types`             | Regenerate `src/types/database.generated.ts` |
| `pnpm db:lint`              | Supabase schema lint                         |

### Maintenance

| Script                    | Purpose                              |
| ------------------------- | ------------------------------------ |
| `pnpm sync:pr-template`   | Mirror the PR template to `.github/` |
| `pnpm verify:pr-template` | CI drift check for the above         |

---

## Folder structure

```
atlas/
├── .claude/                    Operating framework — agents, skills, workflow, DoD
│   ├── agents/                 12 domain specialists with review authority
│   ├── skills/                 13 engineering knowledge bases
│   ├── decision-tree.md        How to resolve ambiguity (escalate, never assume)
│   ├── definition-of-done.md   Ticket / milestone / release completeness
│   ├── implementation-order.md Milestones M0–M13 and their reasoning
│   ├── pull-request-template.md
│   └── workflow.md             The 15-step path from ticket to merge
│
├── .github/workflows/          CI gates: ci, lint, typecheck, test, build, security, accessibility
│
├── database/                   Design-time schema material (not executable)
│   ├── schema/                 Per-table design notes and naming conventions
│   ├── policies/               RLS policy template + policy review checklist
│   └── seeds/                  Seed strategy (why the global seed stays empty)
│
├── docs/                       Product documentation — the source of truth
│   ├── 01-product-requirements.md … 07-ai-behavior.md
│   ├── adr/                    ADR-001 … ADR-008
│   └── open-questions.md       Decisions belonging to the product owner
│
├── public/                     Static assets
├── scripts/                    Repository maintenance scripts
│
├── src/
│   ├── app/                    Next.js App Router
│   │   ├── (public)/           Unauthenticated, indexable surfaces
│   │   ├── (auth)/             Sign-in and verification
│   │   ├── (product)/          Authenticated product surfaces (shell: ATL-005)
│   │   └── api/                Route handlers: AI streaming, exports, webhooks
│   ├── components/
│   │   ├── ui/                 Domain-free primitives
│   │   └── layout/             Width, spacing, and landmark primitives
│   ├── config/                 Env validation, design tokens for TS, app constants
│   ├── features/               Feature-first modules (UI + schemas + server actions)
│   ├── hooks/                  Shared client hooks
│   ├── lib/                    Cross-cutting concerns: validation, formatting, permissions, telemetry
│   ├── middleware/             Middleware helpers (root middleware.ts: ATL-012)
│   ├── providers/              App-wide providers (theme, tooltip, toast)
│   ├── server/                 Server-only layer
│   │   ├── auth/               Session verification, reauthentication
│   │   ├── services/           Business rules, authorization, orchestration
│   │   ├── repositories/       Data access and encryption
│   │   ├── ai/                 Gateway, prompt registry, policy layer
│   │   ├── jobs/               Background work
│   │   └── audit/              Append-only audit writer + shared emitter
│   ├── styles/                 tokens.css (design system) + globals.css
│   ├── test/                   Unit test setup and shared harness
│   ├── types/                  Domain types and generated database types
│   └── utils/                  Pure, domain-free helpers
│
├── supabase/                   Local stack, migrations, seed, RLS tests
└── tests/                      Playwright e2e, integration, fixtures, a11y helpers
```

### Why `services/` and `repositories/` live under `src/server/`

`docs/02-technical-architecture.md` §6.3 places them there, and the documentation is
authoritative. Nesting them under `server/` is also what makes the boundary enforceable:
everything in `src/server/` is server-only, so a Client Component cannot import a
repository even by accident.

### `lib/` versus `utils/`

- **`lib/`** knows Atlas concepts — masking helpers, pagination schemas, permission predicates.
- **`utils/`** is pure and domain-free, with no imports from `lib/`, `server/`, `features/`, or `components/`.

If a helper mentions an Atlas concept, it belongs in `lib/`. ESLint enforces the direction.

---

## Development workflow

The full process is `.claude/workflow.md`. In short:

1. **Pick one ticket** from `docs/05-feature-ticket-list.md`, respecting milestone order.
2. **Read the documentation** the ticket links, in source-of-truth order.
3. **Read the governing ADRs** — they explain why a constraint exists.
4. **Read the relevant skills** in `.claude/skills/`, especially "Common mistakes".
5. **Read the relevant agents** in `.claude/agents/` — their approval checklists are what review will demand.
6. **Plan the slice**: data, security, UX, and test implications.
7. **Write tests first** for anything security-sensitive.
8. **Implement** the smallest complete vertical slice.
9. **Run the gates**: `pnpm verify:all`.
10. **Review for personal-data leakage** — logs, telemetry, URLs, view DTOs, prompts.
11. **Self-review** against `.claude/skills/code-review/checklists.md`.
12. **Update documentation** in the same PR.
13. **Submit** using the PR template.

### Layer boundaries

Dependencies point downward only, and ESLint enforces it:

```
components/ui   →  lib, types
features/*      →  components, lib, types, own server actions
server/services →  repositories, audit, ai, lib
repositories    →  database client, crypto, types
```

Violations fail CI rather than relying on a reviewer noticing.

### Rules that never bend

- Server-side authorization on every protected operation; RLS is defense in depth
- RLS plus two-user tests on every user-owned table
- Restricted data encrypted, masked by default, never logged; encrypted columns are unsearchable
- AI explains and drafts — findings, score, and status are deterministic
- Nothing leaves Atlas without prior explicit user authorization. Discovery invocation requires: (1) the user has granted the applicable standing discovery consent; (2) at least one user-supplied identity field is eligible for an active provider and has `include_in_discovery` enabled; (3) the provider-specific disclosure or first-disclosure acknowledgment has been presented and not cancelled; (4) all eight ADR-008 ConsentProof dispatch checks pass. Consent alone is not sufficient to trigger dispatch; no per-invocation re-confirmation is needed once all four preconditions are satisfied.
- Collect only the minimum necessary identity information; discovery fields are optional and per-field user-controlled (`include_in_discovery`); outbound provider use requires the applicable consent and disclosure gate (ADR-007, ADR-008)
- WCAG 2.2 AA on every surface
- Migrations are append-only
- Open questions are decided by the product owner, on the record

Priority when these conflict with delivery:
**security → privacy → user control → clarity → convenience → speed.**

---

## Documentation map

Read in this order. The documentation is the source of truth; code follows it.

| Order | Document                            | Defines                                                  |
| ----- | ----------------------------------- | -------------------------------------------------------- |
| 1     | `docs/03-security-and-access.md`    | Security and privacy requirements — override convenience |
| 2     | `docs/01-product-requirements.md`   | What Atlas must do                                       |
| 3     | `docs/02-technical-architecture.md` | How it is built                                          |
| 4     | `docs/04-frontend-specification.md` | UI behavior and required states                          |
| 5     | `docs/05-feature-ticket-list.md`    | Build order and acceptance criteria                      |
| 6     | `docs/06-design-system.md`          | Tokens and components                                    |
| 7     | `docs/07-ai-behavior.md`            | Assistant conduct                                        |
| 8     | `CLAUDE.md`                         | Working rules for contributors and agents                |

Supporting: `docs/adr/` (why major designs are what they are, same authority as the
documents they extend) · `docs/open-questions.md` (never assume an answer) ·
`CHANGELOG.md` (documentation and scope changes).

---

## Current implementation status

**Milestone: M13 complete (engineering).** Discovery architecture, the GitHub provider,
candidate lifecycle, adjudication surfaces, and E2E coverage are implemented. Production
discovery initiation (the DispatchEngine wired to a real application route) remains a
Phase 1 blocker. Phase 1 product acceptance has not yet been conducted.

| Area                            | State                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Toolchain                       | Verified: install, lint, typecheck, unit tests, coverage, production build, formatting all pass                            |
| Dependencies                    | Pinned exactly; lockfile committed; audit clean                                                                             |
| Design tokens                   | Implemented from design system §2.1 and asserted by tests (light + dark)                                                   |
| Schema / migrations             | Complete through M13 — discovery tables, RLS, consent types, soft-delete on digital_assets                                 |
| Auth                            | Complete (M2)                                                                                                               |
| Security infrastructure         | Complete: encryption, redaction, audit, idempotency, consent (M3)                                                          |
| Onboarding                      | M4 onboarding shell/demo milestone implemented; M13 Identity Profile and discovery-onboarding components implemented; Phase 1 discovery-first onboarding realignment and product acceptance pending |
| Digital assets                  | Complete (M5)                                                                                                               |
| Findings and score              | Complete (M6)                                                                                                               |
| AI subsystem                    | Complete (M7)                                                                                                               |
| Requests, personal fields, notifications | Complete (M8)                                                                                                     |
| Dashboard                       | Complete (M9)                                                                                                               |
| Activity, archive, search, settings | Complete (M10)                                                                                                         |
| Privacy operations              | Complete (M11)                                                                                                              |
| Quality and launch prep         | Complete (M12)                                                                                                              |
| Discovery pipeline (M13)        | DispatchEngine, ConsentProof gate, GitHub adapter, candidate lifecycle, adjudication — implemented; E2E coverage in place  |
| HIBP provider                   | Infrastructure present; **parked by ATL-216** — not wired to ACTIVE_DISCOVERY_PROVIDERS                                    |
| Production run trigger          | DispatchEngine not yet wired to a real application route; gap tracked post-M13                                              |

Next milestone is **Phase 1 product acceptance**. Review `.claude/implementation-order.md`
(M13 section) and `.claude/workflow.md` before beginning acceptance work.

---

## Contributing

### Before you start

Read `CLAUDE.md`, then `.claude/workflow.md`. Confirm your work maps to a ticket and
that no blocking open question applies.

### Non-negotiable expectations

- **Do not invent product behavior.** If the documentation is ambiguous, follow
  `.claude/decision-tree.md` and escalate. Never answer an open question by choosing
  whichever option is easiest to implement.
- **Do not weaken a security control** for convenience or schedule.
- **Report documentation contradictions** rather than resolving them in a PR discussion.
- **Ship tests with the change**, not after the milestone.
- **Update documentation in the same PR** as the behavior change.

### Review

Open PRs with `.github/pull_request_template.md` (generated from
`.claude/pull-request-template.md`) completed honestly — an empty review section is an
incomplete submission.

Request the agents whose domains you touched:

| Change touches                                               | Required reviewer                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| Auth, data access, personal data, AI context, infrastructure | `security-engineer` (can block)                            |
| Any UI                                                       | `accessibility-reviewer` (can block) and `design-reviewer` |
| Structure, layering, anything hard to reverse                | `architect` (can block)                                    |
| Behavior, scope, user-facing copy                            | `product-manager` (can block)                              |
| Schema or migrations                                         | `database-engineer`                                        |
| Test adequacy                                                | `qa-engineer`                                              |

Security and accessibility blocks are not overridable by schedule.

### Commits

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`) with the
ticket ID: `feat(assets): add asset list filters (ATL-031)`.

Hooks run `lint-staged` on commit and `typecheck` plus unit tests on push. A red gate is
fixed, never bypassed.
