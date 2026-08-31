import "server-only";

import type { ConsentProof } from "@/server/discovery/discovery-consent-service";
import { DispatchEngine, type DispatchResult } from "./dispatch-engine";
import { HibpAdapter } from "./hibp-adapter";
import { HibpResultWriter } from "./hibp-result-writer";

/**
 * Thin orchestration service for HIBP discovery dispatches (ATL-207).
 *
 * Composes the dispatch engine (ATL-206) and the HIBP result writer (ATL-207)
 * into a single callable entry point.  Does no authorization work of its own —
 * that belongs entirely to `DispatchEngine.dispatch`.
 *
 * ## Sequence
 *
 * 1. `DispatchEngine.dispatch` runs the eight-check authorization sequence,
 *    calls the adapter if all checks pass, and writes the invocation's terminal
 *    state before returning.
 * 2. On `outcome: "success"`, `HibpResultWriter.write` is called with the
 *    opaque `providerData` from the dispatch result.  The engine has already
 *    committed the terminal `success` state; the writer handles everything that
 *    follows (evidence encryption, idempotent evidence writes, aggregator
 *    routing, rejection lookup, candidate creation).
 * 3. Non-success outcomes (blocked, rate_limited, error, already_dispatched)
 *    are returned as-is; the writer is not called.
 *
 * ## Error handling
 *
 * Writer errors propagate to the caller.  The invocation is already in a
 * terminal `success` state in the database at that point; the caller decides
 * how to surface a persistence failure.
 */
export class HibpDiscoveryService {
  private readonly engine: DispatchEngine;
  private readonly writer: HibpResultWriter;
  private readonly adapter: HibpAdapter;

  constructor(engine: DispatchEngine, writer: HibpResultWriter) {
    this.engine = engine;
    this.writer = writer;
    this.adapter = HibpAdapter.create();
  }

  /** Uses the service-role client for all downstream operations. */
  static create(): HibpDiscoveryService {
    return new HibpDiscoveryService(DispatchEngine.create(), HibpResultWriter.create());
  }

  /**
   * Runs the full HIBP dispatch: authorization → adapter call → persistence.
   *
   * Returns the `DispatchResult` from the engine so the caller can surface the
   * outcome.  On `outcome: "success"`, also awaits the result writer before
   * returning.
   */
  async dispatch(consentProof: ConsentProof, invocationId: string): Promise<DispatchResult> {
    const result = await this.engine.dispatch(consentProof, invocationId, this.adapter);

    if (result.outcome === "success") {
      await this.writer.write(consentProof.userId, invocationId, result.providerData);
    }

    return result;
  }
}
