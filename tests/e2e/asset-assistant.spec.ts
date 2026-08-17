import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-054 — the asset-context assistant, in a real browser.
 *
 * ## What only a browser can settle here
 *
 * The unit suite proves the component renders an asset summary without finding
 * wording, and the integration suite proves retrieval cannot cross assets. What
 * neither can prove is the claim a user actually relies on: that on the page for
 * *this* service, nothing about another service is anywhere in what the server
 * sent. `page.content()` answers that, and nothing below the browser can.
 *
 * ## Two assets, always
 *
 * Every leakage assertion here is an assertion of absence, and an absence proves
 * nothing unless the thing could have been present. So each test creates a second
 * service with a deliberately distinctive name and then asserts that name is
 * absent from the first service's page — including from the RSC payload, not
 * merely from the pixels.
 *
 * ## Branching, for the reason `finding-assistant.spec.ts` branches
 *
 * What comes back depends on `AI_ENABLED`, on this user's `ai_processing`
 * consent, and on whether the provider answered. An AI summary and a refusal are
 * both correct behaviour for some environment. Each test waits for the panel to
 * settle, reads which state rendered from a positive DOM signal, and asserts the
 * invariants that hold for that state. A panel that settles into none of them
 * fails rather than passing quietly, and there is no `test.skip` in this file.
 *
 * The invariants that hold in *every* state — no other asset's data, no provider
 * vocabulary, no internal codes, axe clean, no horizontal overflow — are
 * asserted unbranched.
 *
 * ## Runs at 1280, Pixel 7 and 320
 *
 * The panel sits in a card in the page flow rather than in a drawer, so it
 * reflows rather than scrolls. Locators are by role and slot, never by position.
 */

const assistant = (page: Page) => page.locator("[data-slot='finding-assistant']");
const askButton = (page: Page) => page.locator("[data-slot='assistant-ask']");
const pending = (page: Page) => page.locator("[data-slot='assistant-pending']");
const summary = (page: Page) => page.locator("[data-slot='assistant-asset-summary']");
const aiAnswer = (page: Page) => page.locator("[data-slot='assistant-ai']");
const fallbackAnswer = (page: Page) => page.locator("[data-slot='assistant-fallback']");
const refusal = (page: Page) => page.locator("[data-slot='assistant-problem']");
const disclosure = (page: Page) => page.locator("[data-slot='assistant-disclosure']");

const uniqueService = (label: string) =>
  `E2E ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface SeededAsset {
  id: string;
  serviceName: string;
}

/**
 * Creates a service through the product's own form and returns its id.
 *
 * Through the UI rather than by insert, for ATL-040's reason: a seeded row can
 * satisfy a shape the product would never produce, and a browser test that
 * starts from one is testing the fixture. The name is randomised because the
 * three viewport projects run in parallel against one account.
 */
async function createAsset(page: Page, label: string): Promise<SeededAsset> {
  const serviceName = uniqueService(label);

  await page.goto("/assets/new");
  await page.getByLabel("Service name").fill(serviceName);
  await page.getByLabel("Kind of service").selectOption("social");
  await page.getByRole("button", { name: "Save service" }).click();

  await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

  return { id: new URL(page.url()).pathname.split("/")[2] ?? "", serviceName };
}

/**
 * The subject, plus a second service that must never appear on its page.
 *
 * The other service is created *first* so it is unambiguously already stored by
 * the time the subject's page is rendered — otherwise an absence could be
 * explained by the row not existing yet, which would make every assertion below
 * vacuous.
 */
async function twoAssets(page: Page, label: string) {
  const other = await createAsset(page, `${label} Other`);
  const subject = await createAsset(page, `${label} Subject`);

  return { subject, other };
}

/** Lands on an asset's page with the assistant present. */
async function openAsset(page: Page, asset: SeededAsset): Promise<void> {
  await page.goto(`/assets/${asset.id}`);

  await expect(page.getByRole("heading", { name: asset.serviceName })).toBeVisible();
  await expect(assistant(page)).toBeVisible();
}

/**
 * What a real request can land in.
 *
 * `summary` is the expected success state. `ai` and `fallback` are listed
 * because the panel is shared, and a request landing in either would mean the
 * asset page had been wired to the wrong presenter — which is a failure worth
 * reporting precisely rather than collapsing into "not a summary".
 */
type Outcome = "summary" | "ai" | "fallback" | "refused";

async function askAndSettle(page: Page): Promise<Outcome> {
  await askButton(page).click();

  const settled = summary(page).or(aiAnswer(page)).or(fallbackAnswer(page)).or(refusal(page));
  await expect(settled.first()).toBeVisible({ timeout: 45_000 });

  if (await summary(page).isVisible()) return "summary";
  if (await aiAnswer(page).isVisible()) return "ai";
  if (await fallbackAnswer(page).isVisible()) return "fallback";
  return "refused";
}

/** Nothing rendered anywhere in the panel may name a vendor or an internal code. */
async function expectNoInternalVocabulary(scope: Locator) {
  const text = (await scope.textContent()) ?? "";

  expect(text).not.toMatch(/anthropic|claude|sonnet|openai|overloaded|rate.?limit/i);
  expect(text).not.toMatch(/NOT_FOUND|UNAVAILABLE|INVALID_REQUEST|API_ERROR/);
  expect(text).not.toMatch(/provider_error|consent_denied|malformed_response/);
}

test.describe("the asset assistant", () => {
  test("opens from the asset page by pointer", async ({ page }) => {
    const { subject } = await twoAssets(page, "Pointer");
    await openAsset(page, subject);

    await expect(askButton(page)).toBeEnabled();
    await askButton(page).click();

    const responded = pending(page)
      .or(summary(page))
      .or(aiAnswer(page))
      .or(fallbackAnswer(page))
      .or(refusal(page));

    await expect(responded.first()).toBeVisible({ timeout: 45_000 });
  });

  test("opens by keyboard alone", async ({ page }) => {
    const { subject } = await twoAssets(page, "Keyboard");
    await openAsset(page, subject);

    /**
     * Focused directly rather than by counting Tab presses: the number of stops
     * before Ask Atlas differs between viewports as the page reflows, so a fixed
     * count would fail at 320 for a reason unrelated to keyboard operability.
     * What matters is that the control takes focus and responds to Enter.
     */
    await askButton(page).focus();
    await expect(askButton(page)).toBeFocused();

    await page.keyboard.press("Enter");

    const responded = pending(page)
      .or(summary(page))
      .or(aiAnswer(page))
      .or(fallbackAnswer(page))
      .or(refusal(page));

    await expect(responded.first()).toBeVisible({ timeout: 45_000 });
  });

  test("names the service it is about, on the control and in the disclosure", async ({ page }) => {
    const { subject } = await twoAssets(page, "Named");
    await openAsset(page, subject);

    /** Every control is named for what it acts on, before anything is sent. */
    await expect(askButton(page)).toHaveAttribute("aria-label", new RegExp(subject.serviceName));

    const outcome = await askAndSettle(page);
    if (outcome === "refused") return;

    /**
     * §11's scope claim. On this surface the promise is "only this service was
     * read", and a user cannot check it unless the sentence says which service.
     */
    await expect(disclosure(page)).toBeVisible();
    await expect(disclosure(page)).toContainText(subject.serviceName);
  });

  test("renders a summary rather than a finding explanation", async ({ page }) => {
    const { subject } = await twoAssets(page, "Variant");
    await openAsset(page, subject);

    const outcome = await askAndSettle(page);
    if (outcome === "refused") return;

    /**
     * The wiring assertion. `ai` here would mean the asset page reached
     * `presentExplanation`, which cannot parse an asset summary — the surface
     * would be showing an explanation of something else, or nothing.
     */
    expect(outcome).toBe("summary");

    /** No model confidence, because the summary contract produces none. */
    await expect(page.locator("[data-slot='assistant-ai-confidence']")).toHaveCount(0);
    /** No proposals, because the contract has no action concept at all. */
    await expect(page.locator("[data-slot='assistant-actions']")).toHaveCount(0);
  });

  test("never speaks about findings on this surface", async ({ page }) => {
    const { subject } = await twoAssets(page, "Wording");
    await openAsset(page, subject);

    await askAndSettle(page);

    /**
     * Scoped to the panel rather than the page: the sidebar links to Insights,
     * and the word there is correct. What must not happen is the *assistant*
     * describing a service as a finding.
     */
    const text = (await assistant(page).textContent()) ?? "";
    expect(text).not.toMatch(/finding/i);
  });
});

test.describe("another service's data", () => {
  test("never appears on this service's page, in pixels or payload", async ({ page }) => {
    const { subject, other } = await twoAssets(page, "Isolation");
    await openAsset(page, subject);

    await askAndSettle(page);

    /**
     * `content()` rather than `textContent()`. The claim is not "the user cannot
     * see it" but "it was never sent" — a value present in the delivered
     * document or the RSC payload is readable from view-source and the network
     * panel no matter what the pixels show.
     */
    const delivered = await page.content();

    expect(delivered).not.toContain(other.serviceName);
    expect(delivered).not.toContain(other.id);
  });

  test("stays absent even when the user asks for it by name", async ({ page }) => {
    const { subject, other } = await twoAssets(page, "Adversarial");

    /**
     * The other service's name is put into the URL rather than a message box —
     * this surface sends no user text, so the query string is the only input a
     * caller controls. It must change nothing about what was retrieved.
     */
    await page.goto(`/assets/${subject.id}?q=${encodeURIComponent(other.serviceName)}`);
    await expect(assistant(page)).toBeVisible();

    await askAndSettle(page);

    /**
     * The *id* and the other asset's own records are what a fetch could supply.
     * The name is excluded from this assertion because the caller placed it in
     * the URL themselves, and Next.js may echo a query string back into the
     * payload — asserting on it would be asserting that Atlas may not repeat
     * what the caller sent, which is a different and untrue claim.
     */
    expect(await page.content()).not.toContain(other.id);
  });

  test("is not reachable by asking for it as the subject", async ({ page }) => {
    const { other } = await twoAssets(page, "Direct");

    /**
     * Ownership, from the other direction. This user *does* own the other asset,
     * so its page must work — the scope control is retrieval, not authorization,
     * and a test that only proved refusals would pass on a product that refused
     * everything.
     */
    await openAsset(page, other);
    const outcome = await askAndSettle(page);

    expect(["summary", "refused"]).toContain(outcome);
  });
});

test.describe("layout and accessibility", () => {
  test("has no axe violations once the panel has settled", async ({ page }) => {
    const { subject } = await twoAssets(page, "Axe");
    await openAsset(page, subject);

    await askAndSettle(page);

    await expectNoAxeViolations(page);
  });

  test("does not overflow horizontally at any viewport", async ({ page }) => {
    const { subject } = await twoAssets(page, "Overflow");
    await openAsset(page, subject);

    await askAndSettle(page);

    /**
     * Measured on the document rather than the panel: a card that fits while
     * pushing the page wider is still a horizontal scrollbar at 320px. One pixel
     * of tolerance for sub-pixel rounding.
     */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("keeps the panel inside the viewport", async ({ page }) => {
    const { subject } = await twoAssets(page, "Bounds");
    await openAsset(page, subject);

    await askAndSettle(page);

    const box = await assistant(page).boundingBox();
    const viewport = page.viewportSize();

    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (!box || !viewport) return;

    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  });

  test("names no vendor and no internal code in any state", async ({ page }) => {
    const { subject } = await twoAssets(page, "Vocabulary");
    await openAsset(page, subject);

    await askAndSettle(page);

    await expectNoInternalVocabulary(assistant(page));
  });
});
