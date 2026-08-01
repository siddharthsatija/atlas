---
name: product
description: Atlas product vision, personas, product and UX principles, jobs to be done, success metrics, user journeys, and the decision framework for scope and behavior questions. Use when deciding what to build, judging whether a feature belongs in MVP, writing user-facing copy, or resolving product ambiguity during implementation.
---

# Atlas Product

**Source of truth:** `docs/01-product-requirements.md`. Unresolved decisions live in `docs/open-questions.md` — never assume an answer to one.

## Purpose

Give engineers enough product judgment to make small decisions correctly without escalating, and to recognize the decisions they must escalate.

## Vision and positioning

**Vision:** become the operating system for personal digital identity.
**Mission:** give every person complete visibility and meaningful control over their digital presence.
**Tagline:** Map your digital identity.

Atlas is **not** a password manager, identity-theft insurer, breach-alert service, or fear-driven privacy scanner. Its promise is **visibility and agency**. If a feature idea only works by scaring the user or by implying capabilities Atlas lacks, it is wrong for Atlas.

## What Atlas must never claim

This is the single most important product constraint, and it is also a legal and trust constraint:

- Atlas does **not** scan the internet. Findings come from the user's own records via deterministic rules (ADR-001).
- Atlas does **not** guarantee deletion from third-party systems. It helps prepare and track requests.
- Atlas does **not** send anything on the user's behalf in MVP.
- Atlas's encryption is server-side, **not** end-to-end (ADR-003). Copy must not imply otherwise.
- The privacy score is guidance, never a safety guarantee; 100 never means zero risk.
- Demo data is always labeled as demo.

When writing any string that touches these, prefer the weaker, truer claim.

## Personas

| Persona                                  | Core need                                                                                    | Design implication                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Privacy-aware professional** (primary) | Quick exposure picture, prioritized actions, efficient request drafting and tracking         | Speed and density matter; the repeat-request loop must be fast (this is why personal fields are reusable — ADR-002) |
| **Student / early-career**               | Education without judgment, low-effort cleanup, essential vs obsolete distinction            | Explanations must teach; never imply carelessness                                                                   |
| **AI power user**                        | Service-specific insight, permission visibility, confidence that Atlas itself is responsible | Show Atlas's own data handling plainly; permission data is first-class                                              |

## Product principles

1. **User ownership** — users control what Atlas stores, analyzes, exports, and deletes. No artificial lock-in.
2. **Calm clarity** — risk explained with evidence and context; no alarm, dark patterns, or exaggerated certainty.
3. **Human approval** — AI may summarize, recommend, and draft. The user reviews any external communication or irreversible action.
4. **Source transparency** — findings identify source, last verification, confidence, and limitations.
5. **Data minimization** — collect only what a user-requested function requires; sensitive fields optional wherever possible.
6. **Visible progress** — completed actions, remaining work, and score movement are all visible.

## UX principles

- Atlas is a **calm control center**, not a security dashboard. References: Apple restraint, Linear precision, Notion clarity.
- The user's data always outweighs the AI. The assistant is contextual, never the loudest element on screen (frontend §5.5).
- Every finding shows source and confidence. Every score view explains limitations.
- Danger styling is rare and reserved for destructive actions or verified critical risk.
- Hover reveals may enhance but never gate. Keyboard and touch equivalents are mandatory.
- Destructive actions use explicit confirmation language, never a vague "OK".
- Undo is preferred over confirmation for archive and dismissal.
- Empty states teach: explain the concept and offer the next step.

## Jobs to be done

1. When I want to understand my online presence, show me the services and information connected to me in one place.
2. When I see a privacy issue, explain why it matters and what I can do.
3. When I decide to remove information, help me prepare and track the request.
4. When I return later, show whether my situation improved.
5. When I lose trust in Atlas, let me export and permanently delete my data.

Job 5 is a feature, not an afterthought. Export and deletion quality is a trust signal.

## Primary journeys

Detailed steps in PRD §9. Engineering-relevant shape:

- **Onboarding:** explain purpose _and limitations_ → privacy goal → categories → demo or first asset → dashboard with a recommended first action. Nothing sensitive is collected here.
- **Review identity:** dashboard → score and changes → categories and findings → asset detail → keep/edit/archive/request.
- **Create a request:** review information and approve fields (unchecked by default, just-in-time capture on first use) → AI draft → edit → copy or mailto → mark sent → tracking and follow-up reminders.
- **Resolve a finding:** open → source, evidence, confidence, impact → recommended action → complete or dismiss → recorded decision and score update where appropriate.

## Success metrics

Build with these in mind (PRD §13): activation (onboarding completion, first meaningful action), engagement (weekly actives, assets reviewed, findings opened, 7/30-day return), action (drafts created, copied or sent, findings resolved, follow-ups completed), trust (explanation helpfulness, draft acceptance/edit rate, export and deletion completion).

**Guardrail metrics matter more than growth metrics here:** incorrect finding reports, AI hallucination reports, security incidents, sensitive logging incidents, and unintended external sends (target: zero). A feature that improves engagement while risking a guardrail is not a win.

## Common mistakes

- Writing copy that implies scanning, discovery, or guaranteed deletion.
- Using fear to drive action ("Your address is dangerously exposed!") instead of calm evidence ("Atlas found an address associated with this account.").
- Letting the AI assistant dominate a page, or presenting generated speculation as discovered fact.
- Adding a sensitive field to onboarding because it would be convenient later.
- Silently expanding MVP scope. Scope changes get documented (CHANGELOG) — see ATL-110 for how a justified addition is recorded.
- Answering an open question by picking whichever option is easier to code.
- Treating export and account deletion as low-priority plumbing.
- Showing a score for an account with no data instead of the honest "Not yet scored" state.

## Decision framework

**Does this belong in MVP?** Yes if it is required by an in-scope item in PRD §8.1 or by a P0 ticket. No if it appears in §8.2 out-of-scope. If neither, it is a scope change: document it or defer it.

**Is this copy honest?** Ask: could a reasonable user believe Atlas does something it does not? If yes, weaken the claim. Prefer "Atlas could not verify this recently" over confident phrasing.

**Deterministic or AI?** Anything the user might treat as fact — findings, score, status — is deterministic. AI explains and drafts.

**Should this be automatic?** Only if it is reversible and non-external. Nothing leaves Atlas without explicit user review (security §11).

**Two valid options and no documented answer?** Stop and escalate. Add it to `docs/open-questions.md` with the tradeoffs rather than guessing.

**Conflicting priorities?** Order: security → privacy → user control → clarity → convenience → delivery speed.

## Review checklist

See `checklists.md`. Fast pass:

- [ ] No claim of scanning, guaranteed deletion, autonomous sending, or end-to-end encryption
- [ ] Findings and score presented with source, confidence, and limitations
- [ ] Demo data labeled everywhere it appears
- [ ] Tone calm and nonjudgmental; danger styling reserved
- [ ] Destructive actions explicit; archive/dismiss offer undo
- [ ] No new sensitive data collected without a user-requested function needing it
- [ ] Scope addition documented, or the work maps to an existing ticket
- [ ] No open question silently answered
