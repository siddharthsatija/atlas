/**
 * Ambient types for `jest-axe`.
 *
 * DOCUMENTED EXCEPTION (third-party type incompatibility):
 * jest-axe@11 ships no type declarations, and the only published typings
 * (`@types/jest-axe@3.5.9`) target the v3 API and would misdescribe v11.
 * Rather than install stale types or relax `noImplicitAny`, the surface we
 * actually use is declared here.
 *
 * Types are intentionally self-contained: `axe-core` is only a transitive
 * dependency, so importing its types here would depend on an undeclared package.
 *
 * Delete this file if jest-axe ships first-party types.
 */
declare module "jest-axe" {
  interface AxeViolationNode {
    html: string;
    target: string[];
    failureSummary?: string;
  }

  interface AxeViolation {
    id: string;
    impact?: "minor" | "moderate" | "serious" | "critical" | null;
    description: string;
    help: string;
    helpUrl: string;
    nodes: AxeViolationNode[];
  }

  interface AxeResults {
    violations: AxeViolation[];
    passes: unknown[];
    incomplete: unknown[];
    inapplicable: unknown[];
  }

  interface AxeRunOptions {
    rules?: Record<string, { enabled: boolean }>;
    runOnly?: string[] | { type: "tag" | "rule"; values: string[] };
  }

  /** Runs axe against a DOM node or an HTML string. */
  export function axe(
    html: Element | Document | string,
    options?: AxeRunOptions,
  ): Promise<AxeResults>;

  /** Creates a preconfigured `axe` runner. */
  export function configureAxe(options?: AxeRunOptions): typeof axe;

  /** Matcher object passed to `expect.extend`. */
  export const toHaveNoViolations: {
    toHaveNoViolations(results: AxeResults): {
      pass: boolean;
      actual: unknown;
      message(): string;
    };
  };
}
