/**
 * Shared discovery type primitives (ATL-210, ADR-008 §2).
 *
 * This module is importable by both lib/ (client-safe) and server/ modules.
 * It must never import from server-only modules.
 *
 * `DisclosureClass` is declared here so that lib/discovery/disclosure-content-map.ts
 * and server/discovery/provider-adapter.ts share a single source of truth rather
 * than maintaining two structurally-compatible but independently-declared copies.
 */

/**
 * Disclosure classification (ADR-008 §2, table 1).
 *
 * Describes how identity data crosses the outbound boundary.
 *
 * - `hashed_query`:       A partial hash is transmitted; the raw value never
 *                         leaves Atlas (e.g. k-anonymity prefix lookup).
 * - `identifying_lookup`: The plaintext handle or value is transmitted to a
 *                         third-party API. Per-field first-disclosure
 *                         acknowledgment is required (ADR-008 §3).
 * - `broker_query`:       The value is submitted to a data-broker service.
 *                         Per-field acknowledgment is required.
 *
 * `hashed_query` is explicitly exempt from per-field acknowledgment (ADR-008
 * §3, check 8) — the hash prefix does not constitute identifying transmission.
 */
export type DisclosureClass = "hashed_query" | "identifying_lookup" | "broker_query";
