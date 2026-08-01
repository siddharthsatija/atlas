import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SCAFFOLD VALIDATION — not a product test.
 *
 * Repository-level invariants that are easy to violate accidentally and expensive
 * to discover late. These complement the ESLint boundary rules: lint governs import
 * direction, these assert the invariant even in files lint might not cover.
 */

const ROOT = join(__dirname, "../..");

/** Lists tracked-ish source files, excluding build output. */
function sourceFiles(dir: string, exts: string[]): string[] {
  const out = execFileSync(
    "find",
    [
      join(ROOT, dir),
      "-type",
      "f",
      ...exts.flatMap((e, i) => (i === 0 ? ["-name", `*.${e}`] : ["-o", "-name", `*.${e}`])),
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

function read(path: string): string {
  return execFileSync("cat", [path], { encoding: "utf8" });
}

describe("repository guards", () => {
  it("contains no raw hex colors outside the token source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src", ["ts", "tsx", "css"])) {
      if (file.endsWith("tokens.css")) continue; // the authorized token source
      // These assert on colour values by nature: they verify the token source and
      // the WCAG contrast primitives against known reference colours.
      if (file.endsWith("tokens.test.ts")) continue;
      if (file.endsWith("contrast.test.ts")) continue;
      if (/#[0-9a-fA-F]{6}\b/.test(read(file))) offenders.push(file.replace(ROOT, ""));
    }
    expect(offenders, "raw hex must live only in src/styles/tokens.css").toEqual([]);
  });

  it("uses no raw colour utilities in components", () => {
    // ATL-008: colour reaches components only through semantic tokens.
    // `transparent` and `current` are not colours — they are the absence of one
    // and inheritance respectively — so both remain permitted.
    const RAW_COLOUR =
      /\b(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|accent|caret|divide|placeholder)-(?:white|black)\b/;
    const TAILWIND_PALETTE =
      /\b(?:bg|text|border|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

    const offenders = sourceFiles("src/components", ["ts", "tsx"])
      .concat(sourceFiles("src/app", ["ts", "tsx"]))
      // Tests assert the ABSENCE of raw colours, so they necessarily name them.
      // The guard protects shipped component source.
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => {
        const content = read(f);
        return RAW_COLOUR.test(content) || TAILWIND_PALETTE.test(content);
      });

    expect(
      offenders.map((f) => f.replace(ROOT, "")),
      "colour must come from semantic tokens (design system §2)",
    ).toEqual([]);
  });

  it("keeps browser storage out of application code", () => {
    const offenders = sourceFiles("src", ["ts", "tsx"])
      .filter((f) => !f.endsWith("repo-guards.test.ts")) // this file names them by design
      .filter((f) => /\b(localStorage|sessionStorage)\b/.test(read(f)));
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("keeps utils/ domain-free", () => {
    const offenders = sourceFiles("src/utils", ["ts", "tsx"]).filter((f) =>
      /from "@\/(server|features|components|lib)/.test(read(f)),
    );
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("keeps UI primitives free of server and feature imports", () => {
    const offenders = sourceFiles("src/components", ["ts", "tsx"]).filter((f) =>
      /from "@\/(server|features)/.test(read(f)),
    );
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("keeps server modules free of component and feature imports", () => {
    const offenders = sourceFiles("src/server", ["ts", "tsx"]).filter((f) =>
      /from "@\/(components|features)/.test(read(f)),
    );
    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("marks modules that read secrets as server-only", () => {
    // env.ts reads process.env and must never be reachable from client code.
    expect(read(join(ROOT, "src/config/env.ts"))).toMatch(/^import "server-only";/m);
  });
});
