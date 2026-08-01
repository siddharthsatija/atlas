# AI subsystem

Milestone M7. Nothing is implemented yet.

Structure to build (architecture §12, ADR-001, `docs/07-ai-behavior.md`):

| Module       | Ticket  | Responsibility                                                     |
| ------------ | ------- | ------------------------------------------------------------------ |
| `gateway.ts` | ATL-048 | Server-only provider adapter: timeout, bounded retry, typed errors |
| `schemas/`   | ATL-050 | Zod output schemas plus the invariant checks                       |
| `prompts/`   | ATL-051 | Versioned prompt registry (`explain-finding-v2`, …)                |
| `policy/`    | ATL-049 | Purpose classification, minimal retrieval, redaction               |
| `fallback/`  | ATL-052 | Deterministic explanations and draft templates                     |

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
