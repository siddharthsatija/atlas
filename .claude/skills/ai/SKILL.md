---
name: ai
description: Atlas AI engineering guidance covering prompt architecture, structured outputs, context retrieval and the policy layer, hallucination prevention, privacy, confidence handling, prompt versioning, and evaluation strategy. Use for any work on the assistant, explanations, or request drafting.
---

# Atlas AI

**Sources of truth:** `docs/07-ai-behavior.md` (behavior contract), `docs/02-technical-architecture.md` §12 (AI architecture), `docs/03-security-and-access.md` §10 (AI data handling), ADR-001 (why findings are deterministic).

## Purpose

Make the assistant genuinely useful while keeping it structurally incapable of the failures that would damage Atlas: inventing facts about a user, leaking personal data to a provider, or appearing to act on the user's behalf.

## Core principles

1. **AI is never the source of truth.** Findings, score, and status are deterministic. AI explains and drafts.
2. **Grounded or silent.** Every factual statement about the user traces to a record in context.
3. **Proposals, not actions.** The model returns suggested actions; the application executes only what the user confirms.
4. **Minimum necessary context**, selected by purpose, redacted before sending.
5. **Structured output, validated.** Unvalidated text never reaches the UI as fact.
6. **Uncertainty is disclosed**, not smoothed over.
7. **Stored user text is untrusted input.**
8. **Works when AI does not.** Every AI surface has a deterministic fallback.

## Prompt architecture

Three-part structure, assembled server-side only:

```
1. System policy   fixed, version-controlled, never user-influenced
2. Task template   per-purpose instructions + output schema description
3. Context block   retrieved records, redacted, explicitly delimited as untrusted data
```

Rules:

- Prompts live in the repository under version identifiers (`explain-finding-v2`, `draft-request-v3`) — never inline string literals at the call site, never built from user input.
- The system policy states what Atlas is, the tone rules (AI behavior §8), the refusal list (§9), and that content inside untrusted delimiters is data, never instructions.
- Context is delimited and labeled with provenance so the model can distinguish a user-authored note from a verified record from a demo record.
- Prompt and model versions are recorded on every interaction (`ai_interactions.prompt_version`, `model`).
- Changing a prompt requires a version bump and re-running the evaluation set (ATL-051).

## Structured outputs

Schemas are defined in AI behavior §7 and implemented as Zod (ATL-050):

- **Explanation:** `summary`, `whyItMatters`, `evidenceReferences[]`, `confidence`, `uncertainties[]`, `recommendedActions[]`.
- **Draft:** `recipient`, `subject`, `body`, `includedFieldKeys[]`, `assumptions[]`, `warnings[]`.

Handling:

- Validate with Zod; strip unknown fields; on failure log `AI_SCHEMA_INVALID`, retry once, then fall back deterministically.
- **Post-validation invariants** matter as much as the schema:
  - `evidenceReferences` must all exist in the context that was sent. An unknown ID is a hallucination — reject the output.
  - `includedFieldKeys` must be a subset of the fields the user approved. A superset is a privacy violation — reject.
  - `recommendedActions[].entityId` must reference an entity the user owns and that was in context.
  - `actionType` must be in the allowlist (`open_asset`, `start_request`, `review_permission`, `dismiss`).
- Never render raw model text as a factual claim without schema validation and invariant checks.

## Context retrieval and the policy layer

The policy layer (ATL-049) is the only path from data to the provider. Flow: classify purpose → select allowed records → redact → send.

Purpose taxonomy and allowed context:

| Purpose            | May retrieve                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `explain_finding`  | the finding, its related asset, relevant score-factor definition                          |
| `summarize_asset`  | one asset with its categories and permissions                                             |
| `explain_score`    | latest snapshot factor breakdown and definitions                                          |
| `recommend_action` | open findings summary and counts, capped                                                  |
| `draft_request`    | fields approved in this flow, service name, user-entered recipient, request-type template |
| `product_question` | curated product guidance only — no user records                                           |

Hard rules:

- Retrieval is capped in count and sensitivity per purpose. Never "fetch the user's records and let the model pick".
- Stored personal fields require **per-request approval**; storage alone is not permission (ADR-002).
- Never send: tokens, secrets, unrelated records, full exports, other users' data, wrapped keys.
- `ai_processing` consent is checked before any provider call.
- Transient context is discarded after the request; only metadata persists in `ai_interactions` unless conversation history is enabled (ATL-109).

## Hallucination prevention

Layered, because prompting alone is not a control:

1. **Structural:** the model cannot state a finding exists — findings come from the rule engine (ADR-001).
2. **Contextual:** provenance labels distinguish verified, user-authored, stale, and demo data.
3. **Schema:** required `evidenceReferences` and `confidence` force the model to attribute claims.
4. **Invariant checks:** references outside context are rejected before display.
5. **UI:** every AI output is labeled AI-assisted; drafts are editable; sources are shown.
6. **Evaluation:** the eval set includes hallucination probes and false-sending claims (AI behavior §13).

Explicitly prohibited outputs: claiming Atlas scanned or discovered something, claiming data was deleted or a message was sent, legal conclusions or guarantees, statements about data not present in context.

## Privacy in AI paths

- Server-side only; provider key never in client code (verified by bundle analysis).
- Redaction runs before every call — a central function, not per-call-site judgment.
- Provider retention set to the strongest available mode; no training on user data without explicit separate opt-in.
- `ai_interactions` stores metadata only by default (purpose, model, prompt version, records referenced, latency, status, feedback). This is an authorized, RLS-protected table — not a log.
- Conversation history is off by default, consent-gated, encrypted, and hard-deleted when disabled.
- Feedback capture must not carry restricted content into analytics.

## Confidence

- Confidence about **findings** is computed deterministically by the rule engine from source and staleness (ADR-001) — the model reports it, never invents it.
- Confidence in the **explanation schema** describes the model's certainty about its own reasoning and must degrade when context is thin or stale.
- Surface confidence and `uncertainties[]` in the UI. Low confidence and stale sources must be visible, not buried.
- Required disclosures (AI behavior §4): demo data, stale sources, low confidence, inference vs fact, and inability to verify.

## Prompt versioning and evaluation

- Every prompt has a semantic identifier and lives under version control; the registry maps purpose → active version.
- `ai_interactions` records the version used, so feedback and incidents are traceable to a prompt.
- The evaluation set (AI behavior §13) covers: grounding, low-confidence disclosure, demo labeling, prompt injection, data minimization, unsupported legal claims, draft field inclusion, hallucinated sending/deletion, tone and fear language, provider outage fallback.
- **Pass criteria must be explicit per case** (assertion-based where possible: no unapproved field appears; no reference outside context; no prohibited phrase). Judgment-based cases get a documented rubric and a fixed sample.
- Evals run against the candidate prompt version before release; a regression blocks the change (ATL-051).

## Fallback behavior

When the provider fails, is rate-limited, or returns invalid output twice:

- Explanations fall back to deterministic rule-template text (each rule ships an evidence template).
- Drafts fall back to a standard editable template built from approved fields.
- Preserve all user input; state that the assistant is temporarily unavailable; never expose provider errors.
- Manual workflows must remain fully functional with AI disabled — test this as a first-class path (ATL-052).

## Common mistakes

- Building a prompt from an f-string at the call site instead of the registry.
- Sending stored personal fields because they exist, without per-request approval.
- Trusting `includedFieldKeys` from the model instead of intersecting with approved keys.
- Accepting `evidenceReferences` without checking they were in context.
- Letting the model produce a finding, a severity, or a score.
- Retrieving broadly "so the model has context".
- Treating asset notes as instructions rather than delimited data.
- Displaying model text before schema validation.
- Reporting high confidence on stale or demo-derived data.
- Shipping a prompt change without re-running evals or bumping the version.
- Logging prompts or completions.
- Letting an AI failure block the manual path.

## Decision framework

**Should AI do this at all?** If the output would be treated as fact or drives a stored value — no, make it deterministic. AI is for explanation, summarization, and drafting.

**What context does this need?** Start from the purpose's allowlist. If the purpose is not in the taxonomy, add it deliberately with its own data policy.

**Model output or computed value?** Anything numeric, categorical, or state-changing is computed. The model may describe it.

**Retry, fallback, or fail?** Schema failure: retry once, then fallback. Provider outage: fallback immediately. Invariant violation (unapproved field, unknown reference): fail closed and fallback — never display it.

**New prompt version or new prompt?** New version for wording and behavior changes to the same purpose. New prompt for a new purpose, which also needs a policy-layer entry and eval cases.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] Prompt from the registry with a version; no user input in policy or template
- [ ] Purpose classified; retrieval within the purpose allowlist and caps
- [ ] Personal fields limited to those approved in this flow
- [ ] Redaction applied; consent checked; no tokens/secrets/unrelated records
- [ ] Output schema-validated plus invariant checks (evidence refs, field subset, action allowlist)
- [ ] Confidence and uncertainties surfaced; demo/stale data labeled
- [ ] Deterministic fallback implemented and tested
- [ ] Injection cases and eval cases added for new surfaces
- [ ] No prompts, completions, or restricted values logged
