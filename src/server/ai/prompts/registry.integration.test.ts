import { describe, expect, it } from "vitest";
import {
  AI_PURPOSES,
  PLACEHOLDER_PATTERN,
  PROMPT_ID_PATTERN,
  SCHEMA_IDS,
  registeredPrompts,
  resolvePrompt,
  hasPrompt,
  UnregisteredPromptError,
} from "./index";
import { systemPolicyV1 } from "./versions/system-policy-v1";

/**
 * ATL-051 — the prompt registry.
 *
 * `*.integration.test.ts` so it runs in the `server` project: the registry is
 * `server-only`, which throws under every export condition except `react-server`.
 *
 * The assertions worth the most here are the structural ones — that no prompt
 * can carry interpolated user data, and that metadata travels with the text.
 * Wording is graded by the eval harness, not by exact-string tests, which would
 * fail on every legitimate edit and teach people to update assertions without
 * reading them.
 */

describe("identifiers and structure", () => {
  it("registers at least one prompt", () => {
    // A registry with nothing in it would pass every other test here.
    expect(registeredPrompts().length).toBeGreaterThan(0);
  });

  it("gives every prompt a slug-vN identifier", () => {
    for (const prompt of registeredPrompts()) {
      expect(prompt.promptId).toMatch(PROMPT_ID_PATTERN);
    }
  });

  it("matches each identifier's suffix to its version number", () => {
    // `explain-finding-v1` carrying promptVersion 2 would record a version that
    // does not correspond to any file.
    for (const prompt of registeredPrompts()) {
      expect(prompt.promptId.endsWith(`-v${prompt.promptVersion}`)).toBe(true);
    }
  });

  it("registers each prompt under the purpose it declares", () => {
    for (const purpose of AI_PURPOSES) {
      if (!hasPrompt(purpose)) continue;
      expect(resolvePrompt(purpose).purpose).toBe(purpose);
    }
  });

  it("ties every prompt to exactly one known schema identifier", () => {
    /**
     * The coupling ATL-050 depends on. A prompt naming a schema nobody
     * implements fails validation on every call, retries once, then falls back —
     * a total outage of the surface, produced by two artefacts drifting apart.
     */
    for (const prompt of registeredPrompts()) {
      expect(SCHEMA_IDS).toContain(prompt.schemaId);
      expect(prompt.schemaVersion).toBeGreaterThan(0);
    }
  });
});

describe("no user data can be embedded in a registered prompt", () => {
  it("keeps the repair instruction free of placeholders too", () => {
    /**
     * ATL-050 appends this on the second attempt. A repair instruction with a
     * substitution slot is the one place a caller would be tempted to paste the
     * model's own invalid output back in — which would let text the model
     * emitted re-enter the prompt as instruction.
     */
    for (const prompt of registeredPrompts()) {
      expect(prompt.repairInstruction).not.toMatch(PLACEHOLDER_PATTERN);
      expect(prompt.repairInstruction.length).toBeGreaterThan(0);
    }
  });

  it("contains no placeholder or interpolation syntax anywhere", () => {
    /**
     * The structural privacy guarantee. Security §10 and AI behavior §10 require
     * retrieved text to arrive delimited as untrusted data rather than
     * substituted into instructions; asserting the absence of placeholder syntax
     * makes that a property of the registry instead of a rule every future call
     * site has to remember.
     */
    for (const prompt of registeredPrompts()) {
      expect(prompt.taskTemplate).not.toMatch(PLACEHOLDER_PATTERN);
    }

    expect(systemPolicyV1.text).not.toMatch(PLACEHOLDER_PATTERN);
  });

  it("exposes no function that builds a prompt from a value", async () => {
    /**
     * The callable surface is closed on purpose. Every entry either takes a
     * purpose or is an error class — there is deliberately no
     * `buildPrompt(text)` or `renderPrompt(values)`, because that function is
     * how an asset note becomes an instruction. A new export here should be a
     * decision, not a convenience someone added mid-feature.
     */
    const registry = await import("./index");
    const callables = Object.entries(registry)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();

    expect(callables).toEqual([
      "UnknownPolicyVersionError",
      "UnregisteredPromptError",
      "hasPrompt",
      "registeredPrompts",
      "resolvePrompt",
    ]);
  });

  it("resolves from a purpose alone, taking no other input", () => {
    // Arity 1: there is no second parameter through which a value could arrive.
    expect(resolvePrompt.length).toBe(1);
  });
});

describe("the system policy carries the shared safety rules", () => {
  /**
   * Presence checks, not wording checks. Each of these corresponds to a rule the
   * specification states outright, and a policy that silently lost one would
   * still read fluently — which is exactly why it is asserted rather than
   * eyeballed.
   */

  it("frames context as untrusted data", () => {
    expect(systemPolicyV1.text).toMatch(/<atlas-context>/);
    expect(systemPolicyV1.text).toMatch(/data, not instruction/i);
  });

  it("forbids claiming Atlas scanned or deleted anything", () => {
    expect(systemPolicyV1.text).toMatch(/does not scan the internet/i);
    expect(systemPolicyV1.text).toMatch(/never claim that data was deleted/i);
  });

  it("forbids describing a recipient as verified", () => {
    // AI behavior §5: in MVP the recipient is user-provided and unverified.
    expect(systemPolicyV1.text).toMatch(/never describe a recipient as verified/i);
  });

  it("carries the refusal list", () => {
    expect(systemPolicyV1.text).toMatch(/surveillance or stalking/i);
    expect(systemPolicyV1.text).toMatch(/credential theft/i);
  });

  it("requires the §4 disclosures", () => {
    expect(systemPolicyV1.text).toMatch(/demo data/i);
    expect(systemPolicyV1.text).toMatch(/stale/i);
    expect(systemPolicyV1.text).toMatch(/inference/i);
  });
});

describe("resolution carries metadata with the text", () => {
  const resolved = resolvePrompt("explain_finding");

  it("returns both version numbers", () => {
    /**
     * B3: ATL-051 owns no persistence, so the versions travel with the prompt.
     * A caller that had to look them up separately would eventually record one
     * prompt's version against another prompt's output.
     */
    expect(resolved.promptVersion).toBe(1);
    expect(resolved.policyVersion).toBe(1);
  });

  it("returns the schema identity the output will be validated against", () => {
    expect(resolved.schemaId).toBe("explanation");
    expect(resolved.schemaVersion).toBe(1);
  });

  it("assembles the policy ahead of the task template", () => {
    // Order matters: the task instructions are read in the policy's light.
    const policyAt = resolved.system.indexOf("You are Atlas");
    const taskAt = resolved.system.indexOf("TASK");

    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(taskAt).toBeGreaterThan(policyAt);
  });

  it("includes the pinned policy text verbatim", () => {
    expect(resolved.system).toContain(systemPolicyV1.text.trim());
  });

  it("exposes the task template alone as well", () => {
    // So an eval can assert on the task portion without the policy's bulk.
    expect(resolved.taskTemplate).toContain("TASK");
    expect(resolved.taskTemplate).not.toContain("You are Atlas");
  });

  it("carries the fixed repair instruction for ATL-050's second attempt", () => {
    expect(resolved.repairInstruction).toContain("JSON object");
    // Names the required structure — fixed wording, already in the task template.
    expect(resolved.repairInstruction).toContain("evidenceReferences");
  });

  it("returns the identical repair instruction every time", () => {
    // "Fixed" is the property ATL-050 relies on; a generated one would be a
    // prompt nobody versioned and nobody evaluated.
    expect(resolvePrompt("explain_finding").repairInstruction).toBe(resolved.repairInstruction);
  });

  it("is frozen, so a caller cannot mutate a published prompt", () => {
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("is deterministic across calls", () => {
    // Temperature is 0 at the gateway; a prompt that varied would undo that.
    expect(resolvePrompt("explain_finding").system).toBe(resolved.system);
  });
});

describe("an unregistered purpose fails loudly", () => {
  it("throws rather than returning a default prompt", () => {
    /**
     * A fallback would be worse than an error: it would send *something* to the
     * provider for a purpose nobody wrote instructions for. Five purposes are
     * intentionally unregistered until the ticket that consumes each one writes
     * its prompt.
     */
    expect(() => resolvePrompt("draft_request")).toThrow(UnregisteredPromptError);
  });

  it("names the purpose on the error for the developer", () => {
    try {
      resolvePrompt("product_question");
      expect.unreachable("resolvePrompt should have thrown");
    } catch (error) {
      expect((error as UnregisteredPromptError).purpose).toBe("product_question");
    }
  });

  it("reports the same purposes through hasPrompt", () => {
    expect(hasPrompt("explain_finding")).toBe(true);
    expect(hasPrompt("draft_request")).toBe(false);
  });
});
