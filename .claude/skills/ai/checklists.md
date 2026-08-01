# AI Review Checklist

## Prompt construction

- [ ] Prompt comes from the registry with a version identifier
- [ ] No prompt assembled from user input at the call site
- [ ] System policy fixed and not influenced by retrieved content
- [ ] Untrusted content wrapped in explicit delimiters with a do-not-follow instruction
- [ ] Context carries provenance (verified / user-authored / stale / demo)
- [ ] Prompt version bumped for any wording or behavior change
- [ ] Prompt and model version recorded on the interaction

## Context and retrieval

- [ ] Purpose classified against the defined taxonomy
- [ ] Retrieval limited to the purpose's allowlist
- [ ] Record count and sensitivity caps enforced
- [ ] `product_question` purposes retrieve no user records
- [ ] Personal fields limited to those approved in the current flow
- [ ] `ai_processing` consent verified before the call
- [ ] Central redaction applied before sending
- [ ] No tokens, secrets, wrapped keys, unrelated records, or full exports in context
- [ ] Transient context discarded after the request

## Output handling

- [ ] Zod schema validation before any use
- [ ] Unknown fields stripped
- [ ] Evidence references verified present in the sent context
- [ ] `includedFieldKeys` verified a subset of approved keys
- [ ] Draft body checked for values of unapproved fields
- [ ] Recipient matches the user-entered value
- [ ] Action types within the allowlist; entity IDs owned and in context
- [ ] Prohibited claims screened (sent, deleted, discovered, legal guarantees)
- [ ] Schema failure: retry once, then deterministic fallback
- [ ] Invariant violation: fail closed, never display

## Grounding and honesty

- [ ] No factual statement about the user without a context record
- [ ] Findings, severity, confidence, and score never produced by the model
- [ ] Demo data labeled in output and UI
- [ ] Stale sources disclosed
- [ ] Low confidence surfaced, not buried
- [ ] Inference distinguished from fact
- [ ] Output labeled AI-assisted in the UI
- [ ] Drafts editable before any use
- [ ] Sources shown alongside explanations

## Safety

- [ ] Model exposed to no tools
- [ ] Actions returned as proposals; no code path lets a response trigger a mutation
- [ ] Refusal list honored (other people's data, surveillance, credentials, impersonation, automated outreach, messages to individuals)
- [ ] Injection test cases added for the new surface (ATL-089)
- [ ] No provider key reachable from client code

## Privacy

- [ ] Calls server-side only
- [ ] `ai_interactions` stores metadata only unless history is enabled
- [ ] Conversation history off by default, consent-gated, encrypted, deleted on disable
- [ ] Feedback capture carries no restricted content
- [ ] Provider retention set to the strongest available mode
- [ ] No prompts or completions in logs or analytics

## Fallback and resilience

- [ ] Deterministic fallback implemented for this surface
- [ ] Fallback preserves user input
- [ ] No provider error text shown to the user
- [ ] Manual workflow fully functional with AI disabled (tested)
- [ ] Long operations show progress and support cancellation
- [ ] AI operations rate-limited

## Evaluation

- [ ] Eval cases added for the new or changed prompt
- [ ] Pass criteria explicit (assertion-based where possible; documented rubric otherwise)
- [ ] Eval covers grounding, low-confidence disclosure, demo labeling, injection, minimization, legal claims, field inclusion, false sending/deletion claims, tone, outage fallback
- [ ] Evals run against the candidate version before release; regressions block
