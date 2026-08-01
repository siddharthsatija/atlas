# lib

Cross-cutting application concerns. Shared by features and services; depends on
nothing above it.

| Directory      | Purpose                                                      | Ticket         |
| -------------- | ------------------------------------------------------------ | -------------- |
| `validation/`  | Shared Zod schemas and primitives (UUIDs, enums, pagination) | with consumers |
| `formatting/`  | Dates, relative times, masking helpers, number formatting    | with consumers |
| `permissions/` | Pure authorization predicates shared by services and UI      | with consumers |
| `telemetry/`   | Redaction-aware logger and allowlisted analytics             | **ATL-085**    |
| `utils.ts`     | `cn()` class merger for the UI primitives                    | done           |

## `lib` versus `utils`

- **`lib/`** — knows about Atlas concepts (a masking helper, a pagination schema).
- **`src/utils/`** — pure, domain-free helpers with no application knowledge.

If a helper mentions an Atlas concept, it belongs in `lib/`.

## telemetry: read before adding logging

`telemetry/` is empty until **ATL-085** (central log redaction). Until then, do not add
logging: `console` is an ESLint error outside this directory, and the allowlist-based
redaction utility is what makes logging safe.

Never log or telemeter personal data, request bodies, prompts, draft text, tokens, or
account identifiers (architecture §16).
