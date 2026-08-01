import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import testingLibrary from "eslint-plugin-testing-library";
import prettier from "eslint-config-prettier";

/**
 * ESLint flat configuration.
 *
 * Every package here ships a native flat config, so `FlatCompat`/`@eslint/eslintrc`
 * is not used: routing modern flat configs through the legacy adapter produced a
 * circular-structure failure during config validation.
 *
 * ESLint is pinned to 9.x deliberately: eslint-plugin-import@2.32.0 and
 * eslint-plugin-jsx-a11y@6.10.2 both cap their peer range at ESLint 9, so ESLint 10
 * would break plugin resolution. See the version rationale in the validation report.
 */

/**
 * `eslint-plugin-import` is a declared dependency but its plugin object is
 * registered by eslint-config-next; the import/* rules below use that registration.
 *
 * Architecture boundaries are enforced here rather than left to code review.
 * Source: .claude/skills/architecture/SKILL.md and docs/02-technical-architecture.md §6.2.
 *
 * Dependencies point downward only:
 *   components/ui -> lib, types
 *   features/*    -> components, lib, types, own server actions
 *   server/*      -> repositories, audit, ai, lib
 *   repositories  -> db client, crypto, types
 */
const boundaryZones = [
  {
    target: "./src/components",
    from: ["./src/server", "./src/features"],
    message:
      "UI primitives must not import services, repositories, or features. See skills/architecture.",
  },
  {
    target: "./src/features",
    from: ["./src/server/repositories", "./src/server/ai"],
    message:
      "Features must call services (server actions), never repositories or the AI adapter directly.",
  },
  {
    target: "./src/server/repositories",
    from: ["./src/server/services", "./src/features", "./src/components"],
    message: "Repositories must not call upward. Data access only — no business rules.",
  },
  {
    target: "./src/server",
    from: ["./src/components", "./src/features"],
    message: "Server modules must not import React components or feature modules.",
  },
  {
    target: "./src/lib",
    from: ["./src/server", "./src/features", "./src/components"],
    message: "lib/ is shared leaf code and must not depend on higher layers.",
  },
  {
    target: "./src/utils",
    from: ["./src/server", "./src/features", "./src/components", "./src/lib"],
    message: "utils/ holds pure, domain-free helpers with no application dependencies.",
  },
];

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "node_modules/**",
      "src/types/database.generated.ts",
    ],
  },

  js.configs.recommended,
  ...nextCoreWebVitals,
  ...nextTypescript,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import/resolver": { typescript: { alwaysTryTypes: true } },
    },
    rules: {
      /**
       * Full jsx-a11y recommended ruleset. eslint-config-next enables only a
       * six-rule subset; WCAG 2.2 AA is a launch criterion (PRD §14), so the rules
       * are merged in here. The plugin itself stays registered by Next — adding it
       * again would raise "Cannot redefine plugin".
       */
      ...jsxA11y.flatConfigs.recommended.rules,

      /* --- Type safety (CLAUDE.md: strict mode, no invented types) --- */
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      /* --- Layer boundaries --- */
      "import/no-restricted-paths": ["error", { zones: boundaryZones }],
      "import/no-cycle": ["error", { maxDepth: 3 }],

      /* --- Feature isolation --- */
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/features/*/*", "!@/features/*/actions"],
              message:
                "Do not import another feature's internals. Promote shared code to lib/ or components/ui.",
            },
          ],
        },
      ],

      /* --- Logging discipline (ATL-085: central redaction utility only) --- */
      "no-console": "error", // all console methods; use the redaction-aware logger
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message:
            "Browser storage is prohibited for preferences and any privacy-relevant value. Persist server-side.",
        },
        { name: "sessionStorage", message: "Browser storage is prohibited. Persist server-side." },
      ],

      /* --- General correctness --- */
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-param-reassign": "error",
    },
  },

  /* Config files and scripts run outside the app: relax type-aware rules. */
  {
    files: ["*.config.{ts,mts,mjs,js}", "scripts/**/*.{mjs,ts}"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-console": "off" },
  },

  /**
   * Vitest + Testing Library tests only.
   *
   * Playwright specs are deliberately excluded: `page.getByRole()` is Playwright's
   * API, which testing-library rules misread as destructured RTL queries.
   */
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    extends: [testingLibrary.configs["flat/react"]],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },

  /* Playwright specs: no Testing Library rules; non-null assertions are idiomatic. */
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },

  /* Instrumentation is allowed to reach the transport it wraps. */
  {
    files: ["src/lib/telemetry/**/*.ts"],
    rules: { "no-console": "off" },
  },

  prettier,
);
