# Atlas Engineering Skills

Permanent engineering guidance for implementing Atlas. These skills apply the product documentation; they do not replace it.

## Authority

1. `docs/` and `docs/adr/` are the source of truth.
2. These skills are the working guidance for applying that documentation.
3. Where a skill and the documentation disagree, **the documentation wins** and the contradiction must be reported, not silently resolved.
4. Unresolved product decisions live in `docs/open-questions.md`. Never answer one by implementation choice.

## Skills

| Skill           | Use it when                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `architecture`  | Deciding where code belongs, layer and dependency rules, service boundaries, server vs client components, error philosophy |
| `product`       | Judging scope, writing user-facing copy, resolving product ambiguity, knowing what Atlas must never claim                  |
| `frontend`      | Building any UI surface: App Router, state, forms, tables, dialogs, responsive, loading/error/empty states, charts, motion |
| `design-system` | Tokens, typography, color, spacing, radius, elevation, icons, component inventory, visual hierarchy                        |
| `accessibility` | Any UI work; the pre-merge gate for WCAG 2.2 AA                                                                            |
| `security`      | Anything touching auth, data access, personal data, AI context, or infrastructure                                          |
| `database`      | Schema changes, migrations, indexes, RLS, query performance                                                                |
| `backend`       | Services, repositories, DTOs, validation, API conventions, jobs, rate limiting, logging                                    |
| `ai`            | Assistant, explanations, drafting: prompts, structured outputs, retrieval, hallucination prevention, evaluation            |
| `testing`       | Choosing test level, writing tests, judging whether a ticket's testing requirement is met                                  |
| `performance`   | Data-heavy views, caching decisions, budgets, investigating slowness                                                       |
| `deployment`    | Environments, secrets, CI/CD, releases, rollback, monitoring                                                               |
| `code-review`   | Reviewing any change, self-reviewing before opening a PR, judging done-ness                                                |

Each skill contains `SKILL.md`; most also contain `examples.md` (concrete patterns) and `checklists.md` (the review gate).

## How to use them

**Starting a ticket:** read the ticket in `docs/05-feature-ticket-list.md`, then the skills it touches. Most tickets touch `architecture` plus one or two domain skills, and every UI ticket touches `accessibility`.

**During implementation:** the "Common mistakes" and "Decision framework" sections answer most in-flight questions without escalation.

**Before opening a PR:** self-review with `code-review/checklists.md`. UI work must also pass `accessibility/checklists.md`.

**Reviewing:** follow `code-review` in order. Security and architecture first; style last.

## The rules that never bend

Drawn from the documentation, repeated here because they are the ones most often lost under delivery pressure:

- Server-side authorization for every protected operation; RLS is defense in depth, not the only layer.
- Every user-owned table has RLS and two-user tests.
- Restricted data is encrypted, masked by default, and never logged. Encrypted columns are unsearchable — accept it.
- AI explains and drafts; it never sets a stored value and never acts. Findings and score are deterministic.
- Nothing leaves Atlas without explicit user review.
- Atlas never claims to scan the internet, guarantee deletion, or use end-to-end encryption.
- Nothing sensitive is collected at onboarding; personal fields are just-in-time, optional, and per-request approved.
- WCAG 2.2 AA is a launch criterion.
- Migrations are append-only after shared deployment.
- Documentation contradictions get reported. Open questions get escalated.

Priority order when these conflict with delivery: **security → privacy → user control → clarity → convenience → speed.**
