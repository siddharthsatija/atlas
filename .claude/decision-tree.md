# Atlas Decision Tree

How to resolve an implementation decision when the answer is not immediately obvious.

**The governing rule: do not invent product behavior. Escalate instead of assuming.**

## Priority order

Consult in this order. Stop at the first source that answers the question.

```
1. Product documentation   docs/01 … docs/07
2. ADRs                    docs/adr/ADR-001 … ADR-006
3. Security requirements   docs/03-security-and-access.md
4. Skills                  .claude/skills/<domain>/
5. Existing code           established patterns in the repository
6. Escalate                if still ambiguous
```

### Why this order

Product documentation defines _what_ Atlas does; nothing downstream may contradict it. ADRs record _why_ major designs are what they are and carry the same authority as the documents they extend. Security requirements sit third in lookup order but **override on conflict** — the specification says security overrides delivery convenience, so a security requirement beats a preference found lower in the list. Skills are the working interpretation of the above. Existing code is a pattern, not an authority: a mistake repeated three times is still a mistake.

## The one override

When sources conflict, resolve in this order:

```
security  →  privacy  →  user control  →  clarity  →  convenience  →  delivery speed
```

If following the documentation would create a security or privacy risk, that is not a decision to make — it is a contradiction to report (see below).

## Step-by-step

### Step 1 — Is it answered in the product documentation?

Search `docs/` for the behavior. Check the PRD for requirements and scope, the frontend specification for states and layout, the AI behavior specification for assistant conduct.

- **Answered** → implement it. Cite the section in your PR.
- **Answered but seems wrong** → do not "fix" it in code. Report it as a documentation contradiction.
- **Not answered** → Step 2.

### Step 2 — Is it answered in an ADR?

| Question about                                                         | ADR     |
| ---------------------------------------------------------------------- | ------- |
| Where findings come from, rule catalog, confidence, auto-resolution    | ADR-001 |
| Personal fields: storage, collection timing, approval, deletion        | ADR-002 |
| Encryption, keys, rotation, crypto-shredding, searchability            | ADR-003 |
| Score factors, weights, cold start, demo mode, versioning              | ADR-004 |
| Notifications: model, unread state, delivery, scope                    | ADR-005 |
| Audit logging: storage, immutability, retention, activity relationship | ADR-006 |

- **Answered** → implement it. If your case is a genuine variation the ADR did not consider, escalate to the Architect; the outcome may be a new ADR.
- **Not answered** → Step 3.

### Step 3 — Does a security requirement constrain the answer?

Check `docs/03-security-and-access.md` and the `security` skill. Ask:

- What is the data classification (§3)? Restricted data narrows your options immediately.
- Does this touch authorization, RLS, encryption, secrets, audit, or AI context?
- Would any option here create an external effect without user review?

If a security requirement narrows the choice to one option, that is your answer — **even if a lower-priority source suggests otherwise**. If two options are both compliant, continue to Step 4.

### Step 4 — Do the skills resolve it?

Each skill has a **Decision framework** section for exactly this. Common entry points:

| Question                                                 | Skill           |
| -------------------------------------------------------- | --------------- |
| Where does this code belong? Server or client component? | `architecture`  |
| Is this in MVP scope? Is this copy honest?               | `product`       |
| Where should this state live? Modal, panel, or page?     | `frontend`      |
| New component or variant? Which radius?                  | `design-system` |
| Can I use a `div`? Where should focus go?                | `accessibility` |
| Is this data restricted? Can I log this?                 | `security`      |
| New table or column? Hard delete or status?              | `database`      |
| Service or job? New error code?                          | `backend`       |
| Should AI do this at all? What context does it need?     | `ai`            |
| What test level? Mock or real?                           | `testing`       |
| Can I cache this?                                        | `performance`   |
| Safe to deploy? Rollback or forward-fix?                 | `deployment`    |

### Step 5 — Is there an established pattern in the code?

If the code already solves this problem in a documented, review-approved way, follow it. Consistency has real value.

But existing code is the weakest source. Do not follow a pattern that:

- Contradicts documentation, an ADR, or a security requirement
- Was never reviewed against the current specification
- Exists only because it was expedient once

If you find such a pattern, note it as technical debt with a ticket rather than propagating it.

### Step 6 — Escalate

If you reach here, **stop implementing**. Escalate to the agent who owns the domain:

| Ambiguity about                                                 | Escalate to              |
| --------------------------------------------------------------- | ------------------------ |
| Product behavior, scope, copy, acceptance criteria              | `product-manager`        |
| Structure, layering, service ownership, reversibility           | `architect`              |
| Authorization, encryption, restricted data, AI context, privacy | `security-engineer`      |
| Schema shape, migration sequencing, retention mechanics         | `database-engineer`      |
| Visual tokens, hierarchy, component inventory                   | `design-reviewer`        |
| Accessible pattern conflicts                                    | `accessibility-reviewer` |
| Prompt behavior, retrieval scope, evaluation criteria           | `ai-engineer`            |
| Test adequacy, acceptance validation                            | `qa-engineer`            |
| Budgets, caching, query performance                             | `performance-engineer`   |
| Release sequencing, rollback, environments                      | `release-manager`        |

If the owning agent cannot resolve it from the documentation either, it is a **product decision for the human owner**. Record it in `docs/open-questions.md` with the options and tradeoffs — never pick the option that is easiest to code.

## Special cases

### The question is already an open question

Check `docs/open-questions.md` **first** for anything touching: EU/EEA launch scope, request jurisdictions, disputed-finding score fairness, notification email timing, audit retention periods, provider selection, pre-auth demo mode, or monetization.

These are decided by the human owner, on the record. Implementing around one silently is a blocking defect.

### You found a documentation contradiction

Do not resolve it in the PR discussion. Report it:

1. State both sources and what each implies.
2. Apply the override order (security → privacy → user control → …) to decide how to proceed **temporarily**, choosing the stricter option.
3. Escalate to the owning agent so the documentation gets fixed and, if the decision is major, an ADR is written.

The documentation is the source of truth precisely because it gets corrected rather than worked around.

### The honest implementation is worse than the misleading one

This resolves in one direction: honesty. Atlas may not claim scanning, guaranteed deletion, autonomous sending, or end-to-end encryption. If the honest version undermines the feature's value, that is a product conversation, not an engineering workaround.

### Delivery pressure

Security overrides delivery speed by specification. Accessibility is a launch criterion. Neither is negotiable against a schedule; both escalate rather than bend.

## Quick reference

```
Is it in docs/?              → implement, cite the section
Is it in an ADR?             → implement, cite the ADR
Does security constrain it?  → the constrained option wins
Does a skill resolve it?     → follow the decision framework
Is there a reviewed pattern? → follow it (unless it contradicts the above)
Still unclear?               → STOP. Escalate. Record in open-questions.md.

Never: invent product behavior, answer an open question by coding,
       weaken a security control, or resolve a contradiction silently.
```
