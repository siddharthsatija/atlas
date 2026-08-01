import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Route-level accessibility smoke check (ATL-091).
 *
 * Automation is necessary but not sufficient: axe cannot judge focus order,
 * announcement quality, or keyboard completability. Those remain manual items on
 * .claude/skills/accessibility/checklists.md.
 */
export async function expectNoAxeViolations(page: Page, options?: { disableRules?: string[] }) {
  const builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22aa",
  ]);

  if (options?.disableRules?.length) {
    builder.disableRules(options.disableRules);
  }

  const results = await builder.analyze();
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
}

function formatViolations(violations: { id: string; help: string; nodes: unknown[] }[]): string {
  if (violations.length === 0) return "No accessibility violations";
  return violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join("\n");
}

/**
 * Asserts the whole surface is operable without a pointer.
 * Feed it the accessible names, in expected tab order.
 */
export async function expectKeyboardReachable(page: Page, accessibleNames: string[]) {
  for (const name of accessibleNames) {
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveAccessibleName(new RegExp(name, "i"));
  }
}
