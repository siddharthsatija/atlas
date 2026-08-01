# Atlas Engineering Workflow

The path every change takes, from picking up a ticket to merging. Skipping steps is how a young codebase acquires permanent problems.

## Principles

1. One ticket at a time. Vertical slices, not layers.
2. Read before writing. The documentation already answers most questions.
3. Tests come with the change, not after the milestone.
4. Agents collaborate through written artifacts — PR comments, ADRs, ticket notes, open questions — never through assumptions.
5. Documentation updates ship in the same PR as the behavior change.
6. Stop and escalate rather than guessing. See `decision-tree.md`.

## The workflow

### 1. Select one ticket

From `docs/05-feature-ticket-list.md`, respecting milestone order (`implementation-order.md`) and the ticket's stated dependencies.

Confirm before starting:

- Dependencies are complete or explicitly stubbed
- Acceptance criteria are testable as written — if not, escalate to `product-manager` now, not later
- No blocking open question applies (`docs/open-questions.md`)

### 2. Read the documentation

Read the ticket's linked specifications in source-of-truth order: security, product requirements, architecture, frontend, AI behavior, design system.

Read what the ticket touches, not the whole corpus. A schema ticket needs architecture §7–8 and security §7–8; a UI ticket needs the frontend specification section and the design system.

### 3. Review the ADRs

Identify which ADRs govern the ticket and read them fully. They explain _why_ the design is what it is, which is what keeps a reasonable-looking change from breaking an intentional constraint.

Findings → ADR-001 · Personal fields → ADR-002 · Encryption → ADR-003 · Score → ADR-004 · Notifications → ADR-005 · Audit → ADR-006

### 4. Review the relevant skills

Read the primary skill plus its `examples.md`. Note the **Common mistakes** section — it is a list of things reviewers will otherwise catch later.

Every UI ticket includes the `accessibility` skill. Every ticket includes `architecture`.

### 5. Review the relevant agents

Read the agent definitions for the domains you are touching, especially their **Approval checklist** and **Escalation rules**. This tells you what review will demand and what you must not decide alone.

If your ticket touches a domain with blocking authority — `security-engineer`, `accessibility-reviewer`, `architect`, `product-manager` — read that agent before implementing, not after being blocked.

### 6. Plan the slice

Before writing code, identify:

- Data implications: new tables, new columns, restricted fields, RLS, indexes
- Security implications: authorization path, encryption, consent, audit events
- UX implications: every required state including cold-start, demo, and failure
- Test implications: which mandatory suites apply

If any of these is unclear, escalate now. The cheapest escalation is the one before implementation.

### 7. Write or update tests

Write the failing case first for anything security-sensitive. A guard with no failing-case test is not verified.

Mandatory suites by change type are listed in `testing/checklists.md`:

| Change               | Required tests                          |
| -------------------- | --------------------------------------- |
| New user-owned table | Two-user RLS tests, all four operations |
| New or changed rule  | Boundary, severity, confidence, dedup   |
| Score change         | Golden test updated, version bumped     |
| New transition       | Exhaustive matrix                       |
| New encrypted column | Round-trip, AAD mismatch, post-shred    |
| New AI surface       | Schema, invariant, injection, fallback  |
| New job              | Idempotency, telemetry                  |
| New UI route         | axe smoke, keyboard journey             |

### 8. Implement the smallest complete vertical slice

A slice that works end to end beats four layers that do not connect. Follow the layering rules in the `architecture` skill; keep deterministic logic pure and separate.

While implementing: no invented behavior, no silently-answered open questions, no weakened security control. Anything ambiguous goes to `decision-tree.md`.

### 9. Run the checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
```

Plus the security and E2E tests relevant to the change. A red check is fixed, never bypassed.

### 10. Review for personal-data leakage

An explicit step because it is the failure most easily missed. Trace every value that could reach a log, telemetry sink, analytics event, URL, view DTO, notification body, or AI prompt.

Confirm: nothing restricted in any of them, identifiers masked by default, no encrypted-column query, no `.env` or secret in the diff.

### 11. Self-review

Run `code-review/checklists.md` on your own change, in order: architecture → security → accessibility → performance → UX → maintainability → testing → documentation → technical debt.

UI work also runs `accessibility/checklists.md` in full.

Fix what you find. Reviewers should be catching subtleties, not the checklist.

### 12. Update the documentation

In the same PR:

- Behavior or architecture changed → update `docs/`
- Major decision made → write an ADR
- Scope added → record in `CHANGELOG.md` with rationale
- New unresolved product decision → add to `docs/open-questions.md`
- Ticket notes → record assumptions and anything deferred

### 13. Submit

Open the PR using `pull-request-template.md`, completed honestly. Empty review sections are an incomplete submission.

Request review from the agents whose domains you touched. Anything touching auth, data access, personal data, AI context, or infrastructure requires `security-engineer`. Any UI change requires `accessibility-reviewer` and `design-reviewer`.

### 14. Respond to review

- Blocking findings are fixed, not negotiated.
- Disagreement is resolved by citing documentation, not preference. If the documentation is genuinely ambiguous, that is an open question or an ADR — not a debate in the thread.
- Deferred work gets a ticket and an owner before merge. Undocumented debt is not acceptable.

### 15. Merge and close

Confirm all gates green, all blocking findings resolved, documentation current, and the ticket's acceptance criteria and testing requirements met. Update the ticket with what shipped and what was deferred.

## Cross-agent collaboration

Agents coordinate through artifacts, never through assumed context:

| Artifact                 | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| PR review comments       | Findings with severity from the `code-review` skill                   |
| ADRs                     | Major decisions with problem, options, decision, rationale, tradeoffs |
| `docs/open-questions.md` | Decisions belonging to the human owner                                |
| `CHANGELOG.md`           | Scope and documentation changes with rationale                        |
| Ticket notes             | Assumptions surfaced, work deferred, follow-ups created               |
| `docs/`                  | The behavior contract itself                                          |

If a decision only exists in someone's head or in a chat thread, it does not exist.

## When the workflow does not fit

**Trivial change** (typo, comment): steps 1, 9, 13 suffice. If it touches user-facing copy, `product-manager` still reviews it for honesty.

**Urgent production fix**: the security and accessibility gates still apply — they exist for urgent situations. Documentation may follow within 24 hours, tracked by a ticket. Suspected exposure of restricted data goes to incident response (security §20) first.

**Spike or investigation**: no merge to `main`. Output is a written finding or an ADR draft, not code.
