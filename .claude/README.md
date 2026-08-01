# Atlas Implementation Framework

Operational framework for building Atlas. It does not restate the product documentation — it routes to it.

## Authority order

1. **`docs/` and `docs/adr/`** — the source of truth for what Atlas does and why
2. **`.claude/skills/`** — how to apply that documentation in engineering practice
3. **`.claude/agents/`** — who owns which domain, what they can block, and when they escalate
4. **This framework** — the process that ties them together

Where any of these conflicts with the documentation, **the documentation wins** and the contradiction gets reported, not resolved locally.

## Contents

| File                       | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `implementation-order.md`  | Milestone sequence M0–M12 and the reasoning behind it             |
| `definition-of-done.md`    | What must be true at ticket, milestone, and release level         |
| `workflow.md`              | The fifteen-step path from ticket to merge                        |
| `pull-request-template.md` | Submission template with per-domain review sections               |
| `decision-tree.md`         | How to resolve ambiguity, and when to stop and escalate           |
| `agents/`                  | Twelve domain specialists with authority and escalation rules     |
| `skills/`                  | Thirteen engineering knowledge bases with checklists and examples |

## Agents at a glance

| Agent                    | Domain                               | Blocking authority                      |
| ------------------------ | ------------------------------------ | --------------------------------------- |
| `architect`              | Structure, layers, ADR compliance    | Architecture violations                 |
| `product-manager`        | Requirements, scope, copy honesty    | Features failing product requirements   |
| `frontend-engineer`      | Next.js UI implementation            | — (implements)                          |
| `backend-engineer`       | Services, jobs, business logic       | — (implements)                          |
| `database-engineer`      | Schema, migrations, indexes          | Non-append-only or RLS-less migrations  |
| `security-engineer`      | Auth, encryption, privacy, AI safety | **Any security or privacy risk**        |
| `ai-engineer`            | Prompts, retrieval, evaluation       | — (implements)                          |
| `accessibility-reviewer` | WCAG 2.2 AA                          | **Inaccessible implementations**        |
| `qa-engineer`            | Acceptance and test adequacy         | Unmet testing requirements              |
| `performance-engineer`   | Rendering, caching, budgets          | Unsafe caching, budget regressions      |
| `release-manager`        | Deployment readiness                 | **Releases failing Definition of Done** |
| `design-reviewer`        | Visual consistency, design system    | Design-system violations                |

Security and accessibility blocks are not overridable by schedule. Agents collaborate through written artifacts — PR comments, ADRs, ticket notes, `docs/open-questions.md` — never through assumed context.

## Starting work

```
1. Pick a ticket           docs/05-feature-ticket-list.md, respecting implementation-order.md
2. Follow the workflow     .claude/workflow.md
3. Resolve ambiguity       .claude/decision-tree.md — escalate, never assume
4. Check completeness      .claude/definition-of-done.md
5. Submit                  .claude/pull-request-template.md
```

## The rules that never bend

- Server-side authorization on every protected operation; RLS is defense in depth
- RLS plus two-user tests on every user-owned table
- Restricted data encrypted, masked by default, never logged; encrypted columns are unsearchable
- AI explains and drafts; findings, score, and status are deterministic
- Nothing leaves Atlas without explicit user review
- No claim of scanning, guaranteed deletion, or end-to-end encryption
- Nothing sensitive collected at onboarding; personal fields just-in-time and per-request approved
- WCAG 2.2 AA on every surface
- Migrations append-only
- Open questions decided by the human owner, on the record

Priority when these conflict with delivery: **security → privacy → user control → clarity → convenience → speed.**
