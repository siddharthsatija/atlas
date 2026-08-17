import type { ZodType } from "zod";
import { SCHEMA_IDS, type SchemaId } from "../prompts/prompt";
import { explanationSchema, EXPLANATION_SCHEMA_VERSION } from "./explanation";
import { draftSchema, DRAFT_SCHEMA_VERSION } from "./draft";
import { assetSummarySchema, ASSET_SUMMARY_SCHEMA_VERSION } from "./asset-summary";

/**
 * Schema identity → implementation (ATL-050).
 *
 * The identifiers come from **ATL-051's registry**, imported rather than
 * re-declared. One source of truth is the point: a prompt naming a schema this
 * module does not implement would fail validation on every call, retry once, and
 * fall back — a total outage of the surface produced by two artefacts drifting
 * apart. A test asserts every `SCHEMA_IDS` entry resolves here, so that drift is
 * caught in CI rather than in production.
 *
 * Versions are recorded alongside because `resolvePrompt` already returns a
 * `schemaVersion` that must agree with the implementation's. ATL-050 does not
 * persist either value — that is `ai_interactions`, deferred to task #95.
 */

export interface SchemaEntry {
  readonly id: SchemaId;
  readonly version: number;
  /**
   * `ZodType<unknown>` rather than a union of the two concrete output types:
   * the registry is looked up by a runtime identifier, so the caller narrows
   * with the concrete schema when it knows which one it wants. `validate`
   * returns `unknown` for the same reason and callers cast at the edge.
   */
  readonly schema: ZodType;
}

const ENTRIES: Record<SchemaId, SchemaEntry> = {
  explanation: {
    id: "explanation",
    version: EXPLANATION_SCHEMA_VERSION,
    schema: explanationSchema,
  },
  draft: {
    id: "draft",
    version: DRAFT_SCHEMA_VERSION,
    schema: draftSchema,
  },
  asset_summary: {
    id: "asset_summary",
    version: ASSET_SUMMARY_SCHEMA_VERSION,
    schema: assetSummarySchema,
  },
};

/** Every implemented schema, for the coverage test and for callers that enumerate. */
export function schemaEntries(): SchemaEntry[] {
  return SCHEMA_IDS.map((id) => ENTRIES[id]);
}

/**
 * Looks up a schema by identity.
 *
 * Total over `SchemaId` by construction — the `Record` type makes a missing
 * entry a compile error rather than a runtime surprise, which is why this cannot
 * return undefined.
 */
export function schemaFor(id: SchemaId): SchemaEntry {
  return ENTRIES[id];
}
