import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";
import {
  removeSeededAsset,
  seedSensitiveAsset,
  type SeededFinding,
} from "./support/finding-fixture";

/**
 * ATL-053 — the finding assistant, in a real browser.
 *
 * ## Why these tests branch instead of expecting one outcome
 *
 * `finding-assistant.test.tsx` renders each state directly, so it can assert
 * every one. A browser cannot: what comes back depends on whether `AI_ENABLED`
 * is set, whether this user granted `ai_processing` consent, and whether the
 * provider answered. All four results — an AI answer, a deterministic fallback,
 * a consent refusal, an outage — are *correct* behaviour for some environment.
 *
 * So each test waits for the panel to leave pending, reads which state actually
 * rendered, and asserts the invariants that hold for **that** state. Nothing is
 * skipped on a maybe: the branch is chosen from a positive signal in the DOM,
 * and a panel showing none of the four fails rather than passing quietly.
 *
 * The invariants that hold in *every* state — no provider vocabulary, no
 * internal codes, axe clean, no horizontal overflow — are asserted unbranched.
 *
 * ## The precondition is created, not waited for
 *
 * This spec previously skipped in full: a fresh E2E user has no assets, every
 * rule in the catalog needs a data category, a permission or elapsed time, and
 * there is no UI for the first two. So the finding-dependent path was
 * unreachable and all 51 tests skipped while reporting green.
 *
 * `seedSensitiveAsset` fixes that by creating the *upstream* records — an asset
 * through the product's own form, one high-sensitivity data category — and
 * letting the real `FindingsEngine` derive R-003. **No `privacy_findings` row is
 * ever written by the fixture.** See `support/finding-fixture.ts` for why this
 * is a deliberate, narrowed exception to ATL-040's no-seeding decision.
 *
 * There is no `test.skip` left in this file. A missing panel now fails.
 *
 * ## Runs at 1280, Pixel 7 and 320
 *
 * The assistant is inside a drawer that is 32rem on desktop and full-width
 * below it, so nothing here assumes the desktop presentation. Locators are by
 * role and slot, never by position.
 */

const cards = (page: Page) => page.locator("[data-slot='finding-card']");
const panel = (page: Page) => page.locator("[data-slot='finding-detail']");

/**
 * The fixture's own card, and the link on it.
 *
 * **Never a global `.first()`.** A full-suite run leaves other specs' findings
 * on this account — `asset-edit.spec.ts` adds permissions, which the engine
 * turns into R-004 findings that are never cleaned up — so the first card in the
 * list is frequently somebody else's. That is exactly how the focus assertion
 * failed while the product was working: it resolved a link labelled "View
 * details: E2E Permissions … has a broad permission" and reported it unfocused,
 * when focus had correctly returned to *this* fixture's card.
 *
 * Scoping by the fixture's service name makes the assertion stronger, not
 * weaker: it now checks the link that actually opened the drawer.
 */
const seededCard = (page: Page) => cards(page).filter({ hasText: seeded.serviceName }).first();

const seededDetailsLink = (page: Page) =>
  seededCard(page).locator("[data-slot='finding-details-link']");

const assistant = (page: Page) => page.locator("[data-slot='finding-assistant']");
const askButton = (page: Page) => page.locator("[data-slot='assistant-ask']");
const announcer = (page: Page) => page.locator("[data-slot='assistant-announcer']");
const pending = (page: Page) => page.locator("[data-slot='assistant-pending']");
const cancelButton = (page: Page) => page.locator("[data-slot='assistant-cancel']");
const clearButton = (page: Page) => page.locator("[data-slot='assistant-clear']");
const aiAnswer = (page: Page) => page.locator("[data-slot='assistant-ai']");
const fallbackAnswer = (page: Page) => page.locator("[data-slot='assistant-fallback']");
const refusal = (page: Page) => page.locator("[data-slot='assistant-problem']");
const disclosure = (page: Page) => page.locator("[data-slot='assistant-disclosure']");

/**
 * The fixture's records for the current test.
 *
 * Per-test rather than per-file: Playwright runs the three viewport projects in
 * parallel workers against one account, and a shared asset would let one
 * worker's teardown delete the finding another was mid-assertion on.
 */
let seeded: SeededFinding;

test.beforeEach(async ({ page }) => {
  seeded = await seedSensitiveAsset(page);
});

test.afterEach(async () => {
  await removeSeededAsset(seeded);
});

/**
 * Opens the panel of the finding the fixture caused the engine to derive.
 *
 * Returns nothing conditional: the fixture established the precondition in
 * `beforeEach`, so no cards here is a real failure, not a reason to skip.
 */
async function openPanel(page: Page): Promise<void> {
  await page.goto("/insights?view=all");

  /** The page itself rendered: the ATL-010 error boundary has no description. */
  await expect(page.locator("[data-slot='page-description']")).toBeVisible();

  /** Scoped to the fixture's own asset — see `seededCard`. */
  await expect(seededCard(page)).toBeVisible();

  await seededDetailsLink(page).click();
  await page.waitForURL(/finding=/);
  await expect(panel(page)).toBeVisible();
  await expect(assistant(page)).toBeVisible();
}

/**
 * What a real request can land in.
 *
 * The three refusals collapse into one variant here because the *shape* of the
 * panel is identical for all of them — one alert, no answer. Which refusal it
 * was is read from `data-refusal` where a test needs to know, rather than being
 * baked into a type that would then need widening for every new one.
 */
type Outcome = "ai" | "fallback" | "refused";

/**
 * Asks, waits for the request to settle, and reports which state rendered.
 *
 * Fails rather than returning when the panel settles into something this spec
 * does not recognise — a fifth state would be a contract change and should not
 * pass silently.
 */
async function askAndSettle(page: Page): Promise<Outcome> {
  await askButton(page).click();

  const settled = aiAnswer(page).or(fallbackAnswer(page)).or(refusal(page));
  await expect(settled.first()).toBeVisible({ timeout: 45_000 });

  if (await aiAnswer(page).isVisible()) return "ai";
  if (await fallbackAnswer(page).isVisible()) return "fallback";
  return "refused";
}

/** Nothing rendered anywhere in the panel may name a vendor or an internal code. */
async function expectNoInternalVocabulary(scope: Locator) {
  const text = (await scope.textContent()) ?? "";

  expect(text).not.toMatch(/anthropic|claude|sonnet|openai|overloaded|rate.?limit/i);
  expect(text).not.toMatch(/NOT_FOUND|UNAVAILABLE|INVALID_REQUEST|API_ERROR/);
  /** Internal statuses from `ai_interactions`, which are never user-facing. */
  expect(text).not.toMatch(/provider_error|consent_denied|malformed_response/);
}

test.describe("the finding assistant", () => {
  test("opens the assistant from the panel by pointer", async ({ page }) => {
    await openPanel(page);

    await expect(askButton(page)).toBeEnabled();
    await askButton(page).click();

    /** Something happened: either it is waiting, or it already settled. */
    const responded = pending(page).or(aiAnswer(page)).or(fallbackAnswer(page)).or(refusal(page));
    await expect(responded.first()).toBeVisible({ timeout: 45_000 });
  });

  test("opens the assistant by keyboard alone", async ({ page }) => {
    await openPanel(page);

    /**
     * Focused directly rather than by counting Tab presses: the number of stops
     * before Ask Atlas differs between viewports — the drawer's contents reflow
     * — so a fixed count would pass at 1280 and fail at 320 for a reason that
     * has nothing to do with keyboard operability. What matters is that the
     * control takes focus and responds to Enter, which is what this asserts.
     */
    await askButton(page).focus();
    await expect(askButton(page)).toBeFocused();

    await page.keyboard.press("Enter");

    const responded = pending(page).or(aiAnswer(page)).or(fallbackAnswer(page)).or(refusal(page));
    await expect(responded.first()).toBeVisible({ timeout: 45_000 });
  });

  test("keeps focus inside the drawer while the assistant is in use", async ({ page }) => {
    await openPanel(page);

    await askButton(page).focus();

    /**
     * Radix supplies the trap; this asserts the outcome rather than the
     * mechanism. Ten stops is more than the drawer contains at any viewport, so
     * the cycle wraps — and every stop must still be inside the panel.
     */
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press("Tab");
      await expect(panel(page).locator(":focus")).toHaveCount(1);
    }
  });

  test("returns focus to the card when the drawer closes", async ({ page }) => {
    await openPanel(page);

    /** Focus starts *inside* the drawer, so the restore has real work to do. */
    await askButton(page).focus();

    await page.keyboard.press("Escape");
    await page.waitForURL((url) => !url.searchParams.has("finding"));

    /**
     * Radix restores focus to its `Trigger`, and this drawer has none — it is
     * URL state. `FindingDetail` therefore owns the restore itself, via
     * `onCloseAutoFocus`. Before that fix this landed on `document.body`.
     *
     * `toBeFocused` retries, which matters: `react-focus-scope` dispatches its
     * unmount-autofocus inside a `setTimeout`, so focus moves a macrotask after
     * the URL changes. No sleep is needed here or in the component.
     *
     * Asserted on the **fixture's own** link rather than the first on the page:
     * in a full-suite run other specs' findings share this list, and the first
     * card is often not the one that opened the drawer.
     */
    await expect(seededDetailsLink(page)).toBeFocused();
  });
});

test.describe("waiting and cancelling", () => {
  test("announces the wait through a live region that was already present", async ({ page }) => {
    await openPanel(page);

    /**
     * Present *before* the request. That is the whole design: a region that
     * mounts alongside its text is announced unreliably, so the region persists
     * and only its text changes.
     */
    await expect(announcer(page)).toBeAttached();
    await expect(announcer(page)).toHaveAttribute("data-status", "idle");

    await askButton(page).click();

    /**
     * Either the wait was announced, or the answer already was. A fast provider
     * must not fail this — what is asserted is that the region speaks, not that
     * the request was slow.
     */
    await expect(announcer(page)).not.toHaveAttribute("data-status", "idle");
    await expect(announcer(page)).not.toBeEmpty();
  });

  test("offers Cancel while waiting, reachable by keyboard", async ({ page }) => {
    await openPanel(page);

    await askButton(page).click();

    /**
     * A fast provider can settle before Cancel is ever visible, and that is not
     * a failure — so this asserts Cancel only once pending is positively on
     * screen. When it never appears, the request already finished, which the
     * settled-state tests below cover.
     */
    if (!(await pending(page).isVisible())) {
      await expect(aiAnswer(page).or(fallbackAnswer(page)).or(refusal(page)).first()).toBeVisible({
        timeout: 45_000,
      });
      return;
    }

    await expect(cancelButton(page)).toBeVisible();
    await cancelButton(page).focus();
    await expect(cancelButton(page)).toBeFocused();

    await page.keyboard.press("Enter");

    /** Back to the resting state, with the ask control offered again. */
    await expect(askButton(page)).toBeVisible();
  });

  test("never claims the server request was stopped", async ({ page }) => {
    await openPanel(page);

    await askButton(page).click();

    if (!(await pending(page).isVisible())) return;

    await cancelButton(page).click();

    const note = page.locator("[data-slot='assistant-cancelled']");
    await expect(note).toBeVisible();

    /**
     * The locked semantics: Cancel is UI-only. No `AbortSignal` is created, the
     * server request may finish and record normally, and the copy has to say so
     * rather than implying the work stopped.
     */
    await expect(note).toContainText(/may still finish/i);
    await expect(note).not.toContainText(/stopped the request|cancelled the request|aborted/i);
  });
});

test.describe("what the assistant renders", () => {
  test("renders an answer or a refusal, and never leaks internals", async ({ page }) => {
    await openPanel(page);

    const outcome = await askAndSettle(page);

    if (outcome === "ai") {
      /** §11's context disclosure accompanies every answer. */
      await expect(disclosure(page)).toBeVisible();
      /** The **model's** confidence, worded so it cannot read as the rule's. */
      await expect(page.locator("[data-slot='assistant-ai-confidence']")).toBeVisible();
      await expect(page.locator("[data-slot='assistant-ai-confidence']")).toContainText(
        /confiden/i,
      );
    }

    if (outcome === "fallback") {
      /** Says who wrote it, without naming why the other path failed. */
      await expect(page.locator("[data-slot='assistant-notice']")).toBeVisible();
      await expect(disclosure(page)).toBeVisible();

      /**
       * **No AI confidence, ever.** The view model has no such field on this
       * variant, so this cannot regress without a type change — asserted anyway,
       * because that is the guarantee a user actually depends on.
       */
      await expect(page.locator("[data-slot='assistant-ai-confidence']")).toHaveCount(0);
      await expect(fallbackAnswer(page)).not.toContainText(/confidence/i);
    }

    if (outcome === "refused") {
      /** The panel's own vocabulary, distinguishing the three refusals. */
      await expect(refusal(page)).toHaveAttribute(
        "data-refusal",
        /consent_required|unavailable|not_found/,
      );

      if ((await refusal(page).getAttribute("data-refusal")) === "consent_required") {
        await expect(refusal(page)).toContainText(/does not have your permission/i);
        await expect(refusal(page)).toContainText(/nothing about this finding was sent/i);

        /**
         * No link to Settings. There is no AI-consent control there yet —
         * onboarding captures consent once and the privacy surface is
         * ATL-074–077 — so pointing a user at it would be a promise the product
         * cannot keep (task #127).
         */
        await expect(assistant(page)).not.toContainText(/settings/i);
      }
    }

    await expectNoInternalVocabulary(assistant(page));
  });

  test("cites records the user can actually reach", async ({ page }) => {
    await openPanel(page);

    const outcome = await askAndSettle(page);
    if (outcome === "refused") return;

    const sources = page.locator("[data-slot='assistant-sources']");

    /**
     * Sources are omitted entirely when nothing resolved — the presenter drops
     * citations it cannot match rather than rendering a bare UUID. So this
     * asserts the *contents* only once the list is positively present.
     */
    if ((await sources.count()) === 0) return;

    await expect(sources).toBeVisible();

    const entries = sources.locator("li");
    await expect(entries.first()).toBeVisible();

    /** Whatever renders, no raw identifier reaches the user. */
    await expect(sources).not.toContainText(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );

    for (const link of await sources.getByRole("link").all()) {
      await expect(link).toHaveAttribute("href", /^\//);
    }
  });

  test("proposes next steps without offering to carry them out", async ({ page }) => {
    await openPanel(page);

    if ((await askAndSettle(page)) !== "ai") return;

    const actions = page.locator("[data-slot='assistant-actions']");
    if ((await actions.count()) === 0) return;

    /**
     * "AI can propose but cannot execute." A button here would be the assistant
     * acting — it chose both the action and its target — even with a click in
     * between.
     */
    await expect(actions.getByRole("button")).toHaveCount(0);
  });
});

test.describe("feedback and clearing", () => {
  test("records feedback when an interaction exists to attach it to", async ({ page }) => {
    await openPanel(page);

    const outcome = await askAndSettle(page);
    if (outcome === "refused") return;

    const yes = page.locator("[data-slot='assistant-feedback-yes']");

    /**
     * Offered only when the answer carries an `ai_interactions` id (task #109).
     * A recorder outage produces an answer with no id and no feedback control,
     * which is correct — so its absence is not a failure, and this asserts the
     * submission only once the control is positively present.
     */
    if ((await yes.count()) === 0) return;

    await expect(yes).toBeEnabled();
    await yes.click();

    const result = page
      .locator("[data-slot='assistant-feedback-result']")
      .or(page.locator("[data-slot='assistant-feedback-error']"));

    /** Either outcome is a real answer; silence would not be. */
    await expect(result.first()).toBeVisible();

    /** No free-text field exists, here or on the table. */
    await expect(assistant(page).getByRole("textbox")).toHaveCount(0);
  });

  test("clears the conversation locally, leaving the finding untouched", async ({ page }) => {
    await openPanel(page);

    const outcome = await askAndSettle(page);
    if (outcome === "refused") return;

    const urlBefore = page.url();

    await expect(clearButton(page)).toBeVisible();
    await clearButton(page).click();

    /** The answer is gone and the panel is back at rest. */
    await expect(aiAnswer(page)).toHaveCount(0);
    await expect(fallbackAnswer(page)).toHaveCount(0);
    await expect(askButton(page)).toBeVisible();

    /**
     * Local only: the URL does not change, the drawer stays open, and the
     * finding's own content is still there. Clearing a conversation is not a
     * navigation and must not read as one.
     */
    expect(page.url()).toBe(urlBefore);
    await expect(panel(page)).toBeVisible();
    await expect(page.locator("[data-slot='detail-evidence']")).toBeVisible();
  });

  test("a reload leaves no trace of the conversation", async ({ page }) => {
    await openPanel(page);

    if ((await askAndSettle(page)) === "refused") return;

    await page.reload();

    /**
     * The conversation is ephemeral by construction — React state only, nothing
     * in storage. The panel itself is URL state and does come back, which is the
     * distinction this asserts: the finding returns, the answer does not.
     */
    await expect(panel(page)).toBeVisible();
    await expect(aiAnswer(page)).toHaveCount(0);
    await expect(fallbackAnswer(page)).toHaveCount(0);
    await expect(askButton(page)).toBeVisible();
  });
});

test.describe("layout and accessibility", () => {
  test("does not overflow horizontally at any viewport", async ({ page }) => {
    await openPanel(page);

    await askAndSettle(page);

    /**
     * Measured on the document rather than the panel: a drawer that fits while
     * pushing the page wider is still a horizontal scrollbar at 320px. One
     * pixel of tolerance for sub-pixel rounding.
     */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("keeps long cited labels inside the panel", async ({ page }) => {
    await openPanel(page);

    if ((await askAndSettle(page)) === "refused") return;

    const sources = page.locator("[data-slot='assistant-sources']");
    if ((await sources.count()) === 0) return;

    const panelBox = await panel(page).boundingBox();
    const sourcesBox = await sources.boundingBox();

    if (!panelBox || !sourcesBox) return;

    /** An asset name Atlas did not choose must not push the drawer open. */
    expect(sourcesBox.x + sourcesBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
  });

  test("has no axe violations with the assistant at rest", async ({ page }) => {
    await openPanel(page);

    await expectNoAxeViolations(page);
  });

  test("has no axe violations once the assistant has settled", async ({ page }) => {
    await openPanel(page);

    await askAndSettle(page);

    /**
     * Whichever state landed. Each is a real thing a user sees, so each has to
     * be accessible — an answer, a deterministic explanation, and a refusal
     * alike.
     */
    await expectNoAxeViolations(page);
  });
});
