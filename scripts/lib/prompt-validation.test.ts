import { describe, expect, it } from "vitest";
import {
  parsePromptName,
  sortPrompts,
  validatePrompts,
  type PromptFile,
} from "./prompt-validation";

/**
 * ATL-051 — the prompt immutability gate.
 *
 * This is the test that carries the first acceptance criterion. "Changing a
 * prompt requires a version bump" is not enforceable by review: a two-word edit
 * to a task template reads as a typo fix, ships an unevaluated prompt, and
 * leaves `ai_interactions` recording a version number against output that
 * version never produced.
 *
 * Pure functions over file lists, so every case runs without git.
 */

const file = (name: string, content = "export const x = 1;\n"): PromptFile => ({ name, content });

const V1 = file("explain-finding-v1.ts");
const POLICY_V1 = file("system-policy-v1.ts");

describe("filenames", () => {
  it("accepts slug-vN.ts", () => {
    expect(parsePromptName("explain-finding-v1.ts")).toEqual({
      slug: "explain-finding",
      version: 1,
    });
    expect(parsePromptName("system-policy-v12.ts")).toEqual({
      slug: "system-policy",
      version: 12,
    });
  });

  it("rejects a name with no version", () => {
    // The version lives in the filename so append-only can be checked without
    // reading the file.
    expect(parsePromptName("explain-finding.ts")).toBeNull();
  });

  it("rejects a zero or leading-zero version", () => {
    expect(parsePromptName("explain-finding-v0.ts")).toBeNull();
    expect(parsePromptName("explain-finding-v01.ts")).toBeNull();
  });

  it("rejects uppercase and underscores", () => {
    expect(parsePromptName("ExplainFinding-v1.ts")).toBeNull();
    expect(parsePromptName("explain_finding-v1.ts")).toBeNull();
  });

  it("reports an invalid filename as a violation", () => {
    const result = validatePrompts({ current: [file("nope.ts")], baseline: [] });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe("invalid-filename");
  });

  it("rejects two files claiming the same version", () => {
    // A version identifies exactly one prompt text, or the recorded number is
    // ambiguous.
    const result = validatePrompts({
      current: [file("explain-finding-v1.ts"), file("explain-finding-v1.ts", "different")],
      baseline: [],
    });

    expect(result.violations.map((violation) => violation.rule)).toContain("duplicate-version");
  });

  it("sorts deterministically", () => {
    const sorted = sortPrompts([file("explain-finding-v2.ts"), V1, POLICY_V1]);

    expect(sorted.map((entry) => entry.name)).toEqual([
      "explain-finding-v1.ts",
      "explain-finding-v2.ts",
      "system-policy-v1.ts",
    ]);
  });
});

describe("append-only", () => {
  it("passes when nothing changed", () => {
    const result = validatePrompts({ current: [V1, POLICY_V1], baseline: [V1, POLICY_V1] });

    expect(result.violations).toEqual([]);
    expect(result.appendOnlySkipped).toBe(false);
  });

  it("passes when a new version is added", () => {
    // The supported way to change a prompt.
    const result = validatePrompts({
      current: [V1, file("explain-finding-v2.ts", "new text")],
      baseline: [V1],
    });

    expect(result.violations).toEqual([]);
  });

  it("fails when a published version is edited", () => {
    /**
     * The case the gate exists for. Byte comparison rather than parsing means a
     * reformat, a moved constant, or a whitespace-preserving edit all trip it.
     */
    const result = validatePrompts({
      current: [file("explain-finding-v1.ts", "quietly reworded")],
      baseline: [V1],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe("prompt-modified");
    expect(result.violations[0]?.message).toMatch(/version bump/i);
  });

  it("fails when a published version is deleted", () => {
    // Interactions recorded against it would stop being reproducible.
    const result = validatePrompts({ current: [], baseline: [V1] });

    expect(result.violations[0]?.rule).toBe("prompt-deleted");
  });

  it("catches a modified policy as readily as a modified prompt", () => {
    // The shared policy is the higher-stakes file: it carries the refusal list.
    const result = validatePrompts({
      current: [file("system-policy-v1.ts", "refusals removed")],
      baseline: [POLICY_V1],
    });

    expect(result.violations[0]?.rule).toBe("prompt-modified");
  });

  it("reports every violation rather than stopping at the first", () => {
    const result = validatePrompts({
      current: [file("explain-finding-v1.ts", "edited")],
      baseline: [V1, POLICY_V1],
    });

    expect(result.violations.map((violation) => violation.rule).sort()).toEqual([
      "prompt-deleted",
      "prompt-modified",
    ]);
  });
});

describe("a missing baseline is a skip, never a pass", () => {
  it("reports the append-only comparison as skipped", () => {
    /**
     * `null` is not an empty baseline. An empty array means nothing was
     * published yet and legitimately passes; `null` means the comparison could
     * not run, and a gate that cannot run must say so — otherwise a shallow
     * clone silently disables the control.
     */
    const result = validatePrompts({ current: [V1], baseline: null });

    expect(result.appendOnlySkipped).toBe(true);
  });

  it("still runs the filename checks", () => {
    const result = validatePrompts({ current: [file("nope.ts")], baseline: null });

    expect(result.violations[0]?.rule).toBe("invalid-filename");
  });

  it("distinguishes an empty baseline from a missing one", () => {
    const empty = validatePrompts({ current: [V1], baseline: [] });

    expect(empty.appendOnlySkipped).toBe(false);
    expect(empty.violations).toEqual([]);
  });
});
