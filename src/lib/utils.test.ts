import { describe, expect, it } from "vitest";
import { cn } from "./utils";

/**
 * Harness validation. Confirms the unit runner, path aliases, and TypeScript
 * configuration work end to end. Feature tests arrive with their tickets.
 */
describe("cn", () => {
  it("merges class names", () => {
    expect(cn("p-2", "text-body")).toBe("p-2 text-body");
  });

  it("resolves conflicting Tailwind utilities in favor of the last one", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("ignores falsy values", () => {
    expect(cn("p-2", false, undefined, null, "gap-2")).toBe("p-2 gap-2");
  });
});
