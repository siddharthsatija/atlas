/**
 * Shared domain types.
 *
 * Domain types are the internal truth and may hold decrypted values. They must not
 * be returned to a client directly — services map them to view DTOs with masked
 * fields (`.claude/skills/backend/SKILL.md`).
 *
 * Generated database row types live in `database.generated.ts` (`pnpm db:types`) and
 * stop at the repository layer.
 *
 * Domain types arrive with their schema tickets (M3 onward). This file currently
 * exports only the API envelope, which is defined by architecture §10 and is needed
 * before any feature code exists.
 */

/** Standard response envelope — architecture §10. */
export interface ApiSuccess<T> {
  data: T;
  error: null;
  requestId: string;
}

export interface ApiFailure {
  data: null;
  error: { code: string; message: string };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Cursor pagination — keyset, never offset (performance and database skills). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
