# AI subsystem

Milestone M7. The gateway is built (ATL-048); everything above it is not.

Structure (architecture §12 and §12.1, ADR-001, `docs/07-ai-behavior.md`):

| Module                | Ticket  | Responsibility                                                     | Status |
| --------------------- | ------- | ------------------------------------------------------------------ | ------ |
| `gateway.ts`          | ATL-048 | Server-only provider adapter: timeout, bounded retry, typed errors | Built  |
| `errors.ts`           | ATL-048 | Internal failure taxonomy; collapses to the closed `ApiErrorCode`  | Built  |
| `anthropic-client.ts` | ATL-048 | The **only** module that names a vendor                            | Built  |
| `prompts/`            | ATL-051 | Versioned prompt registry; append-only version files                | Built  |
| `evals/`              | ATL-051 | Deterministic evaluation harness, wired to prompt versions          | Built  |
| `schemas/`            | ATL-050 | Zod output schemas plus the invariant checks                        | Built\* |
| `structured-completion.ts` | ATL-050 | Validate, one repaired retry, fallback seam                    | Built\* |
| `policy/`             | ATL-049 | Purpose classification, minimal retrieval, redaction                | Built\*\* |
| `fallback/`           | ATL-052 | Deterministic explanations and draft templates                      | Built\*\*\* |
| `composition.ts`      | ATL-052 | Production wiring: gateway, recorder, fallback, `AI_ENABLED`        | Built  |

## Using the gateway

`createAiGateway()` in `anthropic-client.ts` builds the production instance; it
owns rate limiting, so callers inherit the limit without remembering it. Failures
arrive as `AiGatewayError` — pass `error.kind` to `toApiError` at the service
boundary and never render the error itself.

\* **ATL-050's outstanding clause is now closed.** Task #95 created
`ai_interactions`, and `StructuredCompletionService` records
`output_schema_version` on every interaction through an injected recorder that
defaults to inert. See architecture §7.11 and §12.3.

**Recording is metadata only.** `RecordInteractionInput` has no field capable of
carrying a prompt, a completion, user text or a provider message, and neither
does the table — a caller holding a completion cannot pass it in by mistake.
Entity IDs in `records_referenced` are the one deliberate exception to the usual
no-identifiers rule, because §7.11 makes this an authorized disclosure table
rather than a log.

\*\* **ATL-049 closes partially.** The five controls are built and tested, but two
criteria are bounded by unbuilt dependencies: stored personal fields cannot be
retrieved (`user_personal_fields` is ATL-105, approval is ATL-058), and only
`explain_finding` has a registered prompt, so other purposes retrieve within
their policy and then report `unavailable`. See architecture §12.4.

\*\*\* **ATL-052 closes partially.** Finding fallback, AI-disabled behaviour and
outage/rate-limit behaviour are complete. The standard editable **draft
template** is unmet: `data_requests` has no migration and the request flow
(ATL-058/059/060) is unbuilt, so there is no draft flow to offer it into. See
architecture §12.5.

**Use `createAiPolicyService(db)`** from `composition.ts` in production. Building
the policy layer by hand risks omitting the fallback or the recorder — exactly
the defect ATL-045 shipped and had to fix.

**`AI_ENABLED=false`** turns every AI surface off: no consent read, no
retrieval, no provider call. Surfaces serve deterministic text instead of
failing.

**Finding explanations (ATL-055) are server-side.** `userMessage` is optional —
a button-triggered request sends no question block at all, and never an empty
one. Low-confidence findings reach the model labelled `Potentially stale` so §4's
stale disclosure has an input; demo still wins. Grounding and hallucination
probes live in `policy/finding-explanation.integration.test.ts` and need no
provider. The "Ask Atlas" control remains ATL-053's.

**`AiPolicyService` is the only way in.** Never call
`StructuredCompletionService` directly — consent, retrieval caps, redaction and
fencing all live in the policy layer, and bypassing it bypasses all four. That is
why `policy/index.ts` does not re-export the completion service.

## Changing a prompt

Never edit a file under `prompts/versions/` — `pnpm prompts:verify` fails the
build if you do, and CI runs it. Add the next `slug-vN.ts`, point `registry.ts`
at it, add eval cases tagged with the new id (a version with no cases fails), and
run the pre-release live-model step in architecture §12.2. The system policy is
its own versioned artefact: adopting a newer policy means a new *prompt* version
that pins it, so `(promptVersion, policyVersion)` always reconstructs what ran.

Two operational notes that are easy to undo by accident: the SDK's own
`maxRetries` is set to `0` because its default composes with the gateway's retry
rather than replacing it (up to six provider calls per request), and **Anthropic
organisation settings must be configured to the strongest available data
retention mode before production traffic** — SDK 0.115.0 has no request-level
equivalent, so nothing in this code can enforce it.

## The controls that matter most

Schema validation alone is insufficient. The **invariant checks** are the privacy
controls (`.claude/skills/ai/SKILL.md`):

- `includedFieldKeys` must be a subset of the fields the user approved **in this flow**
- every `evidenceReference` must exist in the context that was actually sent
- `recipient` must match the user-entered value — the model may not invent one
- `actionType` must be in the allowlist; entity IDs must be owned and in context

A violation fails closed and falls back deterministically. It is never displayed.

Additionally: no tools are exposed to the model, retrieved user text is delimited as
untrusted, findings and score are never model-derived, and prompts and completions
are never logged.
