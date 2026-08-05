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

/**
 * Removes block and line comments so a guard asserts on code rather than prose.
 *
 * Deliberately naive — it does not understand comment markers inside string or
 * regex literals. That is acceptable here: these guards only ever widen their
 * match as a result, so the failure mode is a false alarm a human resolves, never
 * a silently skipped violation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
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
    // Comments are stripped first, for the same reason as the error-UI guard
    // below: a module that deliberately avoids browser storage should be free to
    // say so and explain what it uses instead. Prose cannot call an API, so this
    // narrows the guard to real usage without weakening it.
    const offenders = sourceFiles("src", ["ts", "tsx"])
      .filter((f) => !f.endsWith("repo-guards.test.ts")) // this file names them by design
      .filter((f) => /\b(localStorage|sessionStorage)\b/.test(stripComments(read(f))));
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

  it("never renders an error message or stack in error UI", () => {
    /**
     * ATL-010. The error surfaces are the one place in the application where an
     * object full of restricted data is in scope and the temptation to "just show
     * the message while debugging" is highest — and such a change reads as
     * harmless in review. Architecture §16 forbids capturing message text; showing
     * it to the user is strictly worse than logging it.
     *
     * `ErrorFallback` has no prop that accepts an error, so this asserts the rule
     * at the boundaries that do hold one.
     */
    const errorSurfaces = sourceFiles("src/components/error", ["tsx"])
      .concat(sourceFiles("src/app", ["tsx"]))
      .filter((f) => !/\.test\.tsx?$/.test(f)); // tests name what they forbid

    // Comments are stripped first. These files must be free to *explain* why they
    // do not forward a message, a stack, or React's component stack; a guard that
    // punished the explanation would push the reasoning out of the code.
    const offenders = errorSurfaces.filter((file) =>
      /\berror\??\.(message|stack)\b|\bcomponentStack\b/.test(stripComments(read(file))),
    );

    expect(
      offenders.map((f) => f.replace(ROOT, "")),
      "error UI must never render error.message, error.stack, or a component stack",
    ).toEqual([]);
  });

  it("keeps cryptography out of client-reachable code", () => {
    /**
     * ATL-084. The ESLint layer boundaries stop `src/components` and
     * `src/features` importing `src/server`, but `src/app` is not in those
     * zones — a `"use client"` file there could reach the crypto module and pull
     * key handling into a browser bundle.
     */
    const offenders = sourceFiles("src", ["ts", "tsx"])
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((file) => {
        const content = read(file);
        return /^\s*["']use client["']/m.test(content) && /@\/server\/crypto/.test(content);
      });

    expect(
      offenders.map((f) => f.replace(ROOT, "")),
      "client components must never import the crypto module",
    ).toEqual([]);
  });

  it("marks every secret-reading crypto module server-only", () => {
    /**
     * `envelope.ts` is deliberately exempt: it takes key material as arguments,
     * reads no environment variable, and holds no secret, which is what allows
     * its round-trip and tamper tests to run in the unit project on every pull
     * request. Everything that touches the KEK or the database carries the
     * marker.
     */
    const exempt = new Set(["envelope.ts", "envelope.test.ts"]);

    const offenders = sourceFiles("src/server/crypto", ["ts"])
      .filter((f) => !exempt.has(f.split("/").pop() ?? ""))
      .filter((f) => !/\.test\.ts$/.test(f))
      .filter((file) => !/^import "server-only";/m.test(read(file)));

    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("keeps key material out of logs", () => {
    // `no-console` already covers the obvious case; this catches a logger being
    // introduced into the one place where a stray line prints a key.
    const offenders = sourceFiles("src/server/crypto", ["ts"])
      .filter((f) => !/\.test\.ts$/.test(f))
      .filter((file) => /\bconsole\.|\blogger\b/.test(stripComments(read(file))));

    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });

  it("keeps error UI away from network transports", () => {
    /**
     * ATL-010/ATL-095: boundaries hand a built `ErrorReport` to the registered
     * sink and nothing else. A boundary that called a transport directly would
     * bypass report construction — which is the only thing standing between a raw
     * error and the network.
     */
    const TRANSPORT = /\bfetch\s*\(|sendBeacon|XMLHttpRequest|axios/;

    const offenders = sourceFiles("src/components/error", ["tsx"])
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((file) => TRANSPORT.test(stripComments(read(file))));

    expect(offenders.map((f) => f.replace(ROOT, ""))).toEqual([]);
  });
});
