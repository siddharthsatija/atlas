---
name: architecture
description: Atlas project architecture, layer responsibilities, dependency rules, service boundaries, repository pattern, feature-first organization, Server vs Client Components, error handling philosophy, and coding standards. Use when creating new modules, deciding where code belongs, reviewing structural changes, or resolving "which layer should own this?" questions.
---

# Atlas Architecture

**Source of truth:** `docs/02-technical-architecture.md`. This skill is the working guidance for applying it. Where this skill and the documentation disagree, the documentation wins and the contradiction must be reported.

## Purpose

Keep Atlas structurally sound as it grows: one obvious home for every piece of code, dependencies that point one direction, and security enforced at layer boundaries rather than sprinkled through UI.

## Core principles

From architecture §2, non-negotiable:

1. Server-side authorization for every protected operation.
2. RLS is defense in depth, not the only authorization layer.
3. Personal data is minimized, classified, and masked.
4. AI is an assistive subsystem, never the source of truth.
5. Business rules are deterministic where possible.
6. External effects require explicit user approval.
7. Every score change and request transition is auditable.
8. The product functions in a limited form when AI is unavailable.

## Layer responsibilities

```
UI components         render, gather input, present state. No data access, no business rules.
Feature modules       compose UI, own feature-local state and server-action wrappers.
Application services  business rules, authorization, orchestration, event emission.
Repositories/adapters data access, encryption calls, provider I/O. No business rules.
Database/providers    storage and external systems. RLS enforced here.
```

**Dependency rule:** dependencies point downward only. A layer may import from the layer directly below it plus `lib/` and `types/`. Never upward, never sideways between features.

| Layer                 | May import                                          | Must never import                                        |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `components/ui`       | `lib/`, `types/`                                    | features, services, repositories                         |
| `features/*`          | `components/`, `lib/`, `types/`, own server actions | repositories, AI adapter, DB client                      |
| `server/services`     | repositories, `server/audit`, `server/ai`, `lib/`   | React components, feature modules                        |
| `server/repositories` | DB client, crypto module, `types/`                  | services, UI                                             |
| `server/ai`           | `lib/`, prompt registry, output schemas             | repositories directly (must go through the policy layer) |

**Enforcement:** ESLint `no-restricted-imports` boundaries configured in ATL-001. Violations fail CI rather than relying on review.

## Service boundaries

One service per domain concept, per architecture §9: `AssetService`, `FindingService`, `FindingsEngine`, `PrivacyScoreService`, `RequestService`, `PersonalFieldsService`, `NotificationService`, `AssistantService`, `AuditWriter`.

- **Services own authorization.** Every public method verifies the caller owns the entity even though RLS also protects it. Never trust a `user_id` argument that originated client-side.
- **Services own events.** State changes emit activity and audit through the shared emitter (ADR-006) from one call site so the two records cannot drift.
- **Services never touch another service's repository.** Cross-domain work is service to service (e.g. `RequestService` asks `PersonalFieldsService` for approved fields).
- **Keep the engine separate from the reader.** `FindingsEngine` generates, dedups, and auto-resolves; `FindingService` reads and handles user actions. The engine stays a pure rule evaluator (ADR-001).
- **One writer per derived value.** Only `PrivacyScoreService` writes score snapshots. Never a feature action, never AI.

## Repository pattern

Repositories are the only code that touches the database client.

- One repository per table or tightly coupled group.
- Return domain types from `types/`; never leak provider row types upward.
- Encryption and decryption happen here via the crypto module (ADR-003): services deal in plaintext domain objects, repositories deal in ciphertext columns.
- Parameterized queries only; no string-built SQL.
- Every read scoped by `user_id`; every write sets it from the verified session.
- Cursor-based pagination for anything that grows: activity, notifications, requests, findings.
- Remember encrypted columns are non-searchable and non-filterable by design (ADR-003). Filter on non-restricted columns only.

## Feature-first organization

Group by feature, not by technical kind:

```
src/features/requests/
  components/    RequestList, RequestDetail, DraftEditor, RequestModal
  hooks/         useDraftAutosave
  actions.ts     server actions: authenticate, validate, call service, map errors
  schemas.ts     Zod schemas for this feature's inputs
```

A feature owns its UI, input schemas, and server-action wrappers. Shared primitives go to `components/ui`; shared logic to `lib/`. If two features need the same helper, promote it — never import across features.

## Server vs Client Components

Default to Server Components. Add `"use client"` only for event handlers, browser APIs, React state/effects, or a client-only library.

| Server Component                                             | Client Component                             |
| ------------------------------------------------------------ | -------------------------------------------- |
| Data-heavy read views (asset list, request detail, activity) | Forms with live validation                   |
| Anything reading protected data                              | Dialogs, drawers, dropdowns, command palette |
| Score and dashboard aggregates                               | Charts (lazy-loaded), assistant panel        |
| Rendering masked values                                      | The reveal interaction on a masked value     |

- Never import the DB client, crypto module, or AI adapter into client code. Mark server-only modules `server-only` so mistakes fail the build.
- Push `"use client"` to the leaves: the page stays server, the interactive card is the boundary.
- Pass only the props the UI renders. Never pass secrets, full records, or values the user has not revealed.
- Mutations go through server actions: authenticate first, validate with Zod, then call a service.

## Error handling philosophy

- **Typed error codes, never raw provider errors** (architecture §10). Envelope: `{ data, error: { code, message }, requestId }`.
- **Exceptions inside, values at the boundary.** Services throw domain errors; actions and route handlers catch and map to codes.
- **Messages are user-safe:** no provider text, stack traces, record identifiers, or personal data. Auth errors stay neutral about whether an email is registered.
- **Preserve user work.** Recoverable errors keep form input and draft text (NFR-02). Draft autosave is a requirement, not polish.
- **Degrade, do not block.** AI failure falls back to deterministic templates (ATL-052); every manual workflow works with AI off.
- **Fail closed on authorization.** Ambiguous ownership is denial. Cross-user access returns not-found rather than a distinguishable forbidden.

## Common mistakes

- Calling a repository from a feature module "just this once" — this is how layering dies.
- Accepting a `user_id` parameter and trusting it instead of deriving identity from the session.
- Letting the AI layer read records directly instead of through the policy layer (security §10).
- Writing score or findings from a feature action instead of the owning service.
- Marking a whole page `"use client"` because one button needs an onClick.
- Emitting activity without audit by bypassing the shared emitter.
- Returning provider error text to the UI.
- Putting business rules in a repository or a React component.
- Filtering or searching on an encrypted column.

## Decision framework

**Where does this code go?**

1. Does it render? → `components/ui` (generic) or `features/*/components` (specific).
2. Does it enforce a rule, authorize, or orchestrate? → a service.
3. Does it read or write storage/providers? → a repository or adapter.
4. Is it a pure helper used by two or more features? → `lib/`.
5. Still unclear? The lowest layer that can own it without an upward import.

**Server or Client Component?** Start server; move to client only for an interaction the server cannot express. If only part needs interactivity, split the component.

**New service or extend an existing one?** New when the concept has its own lifecycle, table group, or authorization surface. Extend when it is another operation on the same concept.

**Deterministic or AI?** If a user-visible number, status, or eligibility depends on it, it is deterministic. AI explains outcomes; it never produces them (ADR-001, ADR-004).

## Coding standards

- TypeScript strict mode. No `any` (use `unknown` and narrow); no non-null assertions on external data.
- Validate everything crossing a boundary with Zod: client input, provider responses, AI output, job payloads, JSON columns.
- Domain types in `types/`; provider row types stop at the repository.
- Name by intent (`archiveAsset`, not `updateAssetStatus2`); booleans read as predicates (`isDemo`, `hasApprovedFields`).
- Rules and calculations are pure functions, unit-testable without a database.
- No direct console/transport logging; use the redaction-aware logger (ATL-085).
- Never log or telemeter personal data, prompts, draft bodies, tokens, or account identifiers (architecture §16).
- Comments explain _why_. Rule and score constants cite the ADR that set them.
- Migrations are append-only after shared deployment: get names right the first time.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] Dependencies point downward only; no cross-feature imports
- [ ] Server-side authorization in the service, not only RLS
- [ ] Client boundary minimal; no server-only imports in client code
- [ ] Repository owns data access and encryption; no business rules in it
- [ ] Typed error codes with user-safe messages; user input preserved on failure
- [ ] Activity and audit emitted together via the shared emitter
- [ ] Deterministic logic pure and unit-tested; AI not in the source-of-truth path
- [ ] Documentation updated if behavior or architecture changed
