import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import eslintConfig from "../../../eslint.config.mjs";

/**
 * ATL-085 — "direct transport use fails lint".
 *
 * The acceptance criteria make a lint rule part of the deliverable, so the rule
 * gets a test like any other unit of behaviour. Asserting the config *contains* a
 * rule is not enough on its own: a selector with a typo is present, well-formed,
 * and matches nothing. These tests therefore run ESLint over fixture source and
 * assert on the reports.
 *
 * `Linter` is used rather than the full `ESLint` class deliberately — it needs no
 * file resolution, so the test exercises the rules themselves without depending
 * on the TypeScript import resolver.
 */

type FlatConfig = { files?: string[]; rules?: Record<string, unknown> };

const config = eslintConfig as unknown as FlatConfig[];

/** The main application block — the one that sets the logging rules. */
const applicationRules = config.find((entry) => entry.rules?.["no-console"])?.rules ?? {};

/** The telemetry override, which owns the reviewed transport. */
const telemetryOverride = config.find((entry) =>
  entry.files?.includes("src/lib/telemetry/**/*.ts"),
);

function lint(code: string, rules: Record<string, unknown>): Linter.LintMessage[] {
  return new Linter().verify(code, { rules: rules as Linter.RulesRecord });
}

describe("configuration", () => {
  it("forbids console across the application", () => {
    expect(applicationRules["no-console"]).toBe("error");
  });

  it("does not hand the telemetry package a blanket console exemption", () => {
    /**
     * This is a regression guard on a real weakening.
     *
     * Before ATL-085 the telemetry package had `no-console: off` wholesale,
     * because the seam had no other way to emit. With a redaction-aware logger in
     * place, restoring that exemption would let any telemetry module print an
     * unredacted payload — the exact leak the central utility exists to close.
     * The sanctioned sink carries narrow inline disables instead.
     */
    expect(telemetryOverride?.rules).not.toHaveProperty("no-console");
  });

  it("configures a restricted-syntax rule for telemetry transports", () => {
    expect(applicationRules["no-restricted-syntax"]).toBeDefined();
  });
});

describe("rule behaviour", () => {
  const restrictedSyntax = {
    "no-restricted-syntax": applicationRules["no-restricted-syntax"],
  };

  const violations: { name: string; code: string }[] = [
    { name: "navigator.sendBeacon", code: 'navigator.sendBeacon("/collect", payload);' },
    { name: "new XMLHttpRequest", code: "const xhr = new XMLHttpRequest();" },
  ];

  for (const { name, code } of violations) {
    it(`reports ${name}`, () => {
      const messages = lint(code, restrictedSyntax);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.ruleId).toBe("no-restricted-syntax");
      // The message has to name the route out, or the rule just blocks people.
      expect(messages[0]?.message).toContain("src/lib/telemetry");
    });
  }

  it("reports console use", () => {
    const messages = lint('console.log("anything");', {
      "no-console": applicationRules["no-console"],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("no-console");
  });

  const allowed: { name: string; code: string }[] = [
    { name: "the logger", code: 'logger.info("request.completed", { status: 200 });' },
    { name: "ordinary data fetching", code: 'await fetch("/api/assets");' },
    { name: "an unrelated navigator call", code: "navigator.clipboard.writeText(text);" },
  ];

  for (const { name, code } of allowed) {
    it(`permits ${name}`, () => {
      // A rule that also blocks legitimate code gets disabled, so the negative
      // cases matter as much as the positive ones.
      expect(lint(code, restrictedSyntax)).toEqual([]);
    });
  }
});
