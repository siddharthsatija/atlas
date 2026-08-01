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
      if (file.endsWith("tokens.test.ts")) continue; // asserts on hex by design
      if (/#[0-9a-fA-F]{6}\b/.test(read(file))) offenders.push(file.replace(ROOT, ""));
    }
    expect(offenders, "raw hex must live only in src/styles/tokens.css").toEqual([]);
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
