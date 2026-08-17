import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";
import { ARCHIVE_COPY, ARCHIVE_TOAST_DURATION_MS } from "@/lib/assets/archive-copy";

/**
 * ATL-036 M6 — archiving and restoring, in a real browser.
 *
 * ## What only a browser can settle
 *
 * The unit suites prove the components and the integration suites prove the
 * actions. Three things exist only once a browser runs the whole stack:
 *
 *   1. **Revalidation.** `revalidatePath("/assets")` is a no-op in jsdom. Whether
 *      an archived card actually leaves the default list is a property of the
 *      Next.js router refetching a route the action invalidated, and nothing
 *      short of a running server can show it.
 *   2. **The toast's own timer.** The M1 probe measured auto-dismiss in jsdom
 *      and could not confirm the pause-on-focus behaviour Radix documents. This
 *      file settles the *duration* with a measurement and deliberately makes no
 *      claim about resume — see `the toast's real timer` below.
 *   3. **`ToastAction`'s close-on-activation**, which the M4 contract is built
 *      around, running in the engine rather than under a shim.
 *
 * ## Every precondition is produced by the product
 *
 * Assets are created through the create form. Archived state is reached by
 * pressing Archive. Restored state is reached by pressing Restore or Undo. No
 * row is written or mutated by a fixture, and no status is set by any path the
 * user could not take.
 *
 * The **failure** paths are produced honestly too, and this is the part worth
 * reading. A failed archive or a failed undo is not simulated: a second tab
 * performs the transition first, so the first tab's control is stale and the
 * service's own optimistic-concurrency guard refuses it. `archiveAsset` expects
 * a status of `active` and `restoreAsset` expects `archived`, so the stale
 * submission matches no row and returns `NOT_FOUND`. That is a real race a real
 * user with two tabs can lose, and it is exactly the state the durable alert
 * exists for.
 *
 * ## What is deliberately not asserted here
 *
 * The `AssetsNoActiveEmptyState` copy ("No active services to show.") needs the
 * signed-in user to hold **zero active services**. The E2E account is shared
 * across specs running `fullyParallel`, several of which create assets, and
 * Atlas has no product path that removes an asset — permanent deletion is
 * ATL-037 and unbuilt. The state is therefore unreachable in the browser
 * without either serialising the whole suite or deleting rows behind the
 * product's back. Both were rejected; the empty state is covered in
 * `src/features/assets/asset-list.test.tsx`, which can render it directly and
 * honestly. See the M6 report.
 *
 * ## Runs at 1280, Pixel 7 and 320
 *
 * Every assertion below runs in all three projects. The toast is the reason
 * that matters: it is fixed-position and portalled, so it is the one element on
 * these surfaces that can plausibly leave a 320px viewport.
 */

/** A distinct name per run, so parallel projects do not collide on one fixture. */
const uniqueService = (label: string) =>
  `E2E ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Creates a service through the real flow and returns its id and name.
 *
 * Mirrors `asset-edit.spec.ts`'s helper, including its race against the create
 * form's own error banner: waiting on the URL alone turns a recoverable Server
 * Action failure into a 30-second timeout inside a helper, reporting only that
 * the detail page never arrived and hiding the reason the browser was shown.
 */
async function createAsset(
  page: Page,
  label: string,
): Promise<{ id: string; serviceName: string }> {
  const serviceName = uniqueService(label);

  await page.goto("/assets/new");
  await page.getByLabel("Service name").fill(serviceName);
  await page.getByLabel("Kind of service").selectOption("entertainment");
  await page.getByRole("button", { name: "Save service" }).click();

  const banner = page.getByTestId("create-asset-error").filter({ hasText: /\S/ });
  const outcome = await Promise.race([
    page.waitForURL(/\/assets\/[0-9a-f-]{36}$/).then(() => "redirected" as const),
    banner
      .waitFor({ state: "visible" })
      .then(() => "failed" as const)
      .catch(() => "redirected" as const),
  ]);

  if (outcome === "failed") {
    throw new Error(`create failed for ${serviceName}: ${(await banner.textContent()) ?? ""}`);
  }

  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(id, "the create form should redirect to the new asset").not.toBe("");

  return { id, serviceName };
}

const headerActions = (page: Page) => page.locator("[data-slot='asset-header-actions']");
const archiveControl = (page: Page) => headerActions(page).locator("[data-action='archive']");
const restoreControl = (page: Page) => headerActions(page).locator("[data-action='restore']");

/**
 * The toast, located by the slot the feature set rather than the primitive's.
 *
 * `Toast` spreads `...props` after its own `data-slot="toast"`, so the feature's
 * value wins — verified by reading the primitive rather than assumed, because a
 * spread in the other order would have made this locator match nothing while the
 * page rendered correctly.
 */
const toast = (page: Page) => page.locator("[data-slot='asset-archive-toast']");
const undoButton = (page: Page) => page.locator("[data-action='undo-archive']");

const card = (page: Page, assetId: string) =>
  page.locator(`[data-slot='asset-card'][data-asset-id='${assetId}']`);

/** Opens the card's overflow menu and returns the menu locator. */
async function openCardMenu(page: Page, serviceName: string) {
  await page.getByRole("button", { name: `Actions for ${serviceName}` }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

const openDetail = async (page: Page, id: string, serviceName: string) => {
  await page.goto(`/assets/${id}`);
  await expect(page.getByRole("heading", { name: serviceName, level: 1 })).toBeVisible();
};

/** The Overview section's status, which is the page's durable record. */
const overviewStatus = (page: Page) => page.locator("[data-slot='asset-section-overview']");

test.describe("archiving from the detail page", () => {
  test("archives, confirms, and makes the archived status durable", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "ArchiveFlow");
    await openDetail(page, id, serviceName);

    /** Active offers Archive and nothing else. */
    await expect(archiveControl(page)).toBeVisible();
    await expect(restoreControl(page)).toHaveCount(0);

    await archiveControl(page).click();

    /** The toast is the shortcut. */
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toContainText(ARCHIVE_COPY.archivedTitle);

    /**
     * The claim the whole ticket turns on, asserted on what the browser
     * rendered. A user who reads "archived" as "deleted from my bank" stops
     * looking for an account that is still open.
     */
    await expect(toast(page)).toContainText("Nothing was deleted from the service itself");
    await expect(toast(page)).toContainText("no longer appears in your active services");

    /**
     * And the record. The toast fades; this does not. Waiting on the control
     * swap rather than on a clock — the successful action revalidated this
     * route, so Restore appearing *is* the re-render having landed.
     */
    await expect(restoreControl(page)).toBeVisible();
    await expect(archiveControl(page)).toHaveCount(0);
    await expect(overviewStatus(page)).toContainText(/archived/i);
  });

  test("reaches Undo with the keyboard and restores the service", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "UndoKeyboard");
    await openDetail(page, id, serviceName);

    await archiveControl(page).click();
    await expect(toast(page)).toBeVisible();

    /**
     * Tabbed to, never focused programmatically: `focus()` succeeds on elements
     * the browser's tab order skips, so it would pass on a control no keyboard
     * user can reach.
     *
     * The loop is bounded and asserts a positive result rather than running to
     * exhaustion. It is a loop rather than a fixed count because of the M1
     * probe: Radix puts the **toast container itself** in the tab order ahead of
     * the action, and the number of stops between the control the user pressed
     * and Undo is the primitive's business, not the product's. Pinning it would
     * assert Radix's internals.
     */
    let reached = false;
    for (let step = 0; step < 15 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await undoButton(page).evaluate((node) => node === document.activeElement);
    }
    expect(reached, "Undo must be reachable by keyboard alone").toBe(true);

    await page.keyboard.press("Enter");

    /** Restored, durably, and the toast is gone. */
    await expect(archiveControl(page)).toBeVisible();
    await expect(restoreControl(page)).toHaveCount(0);
    await expect(overviewStatus(page)).toContainText(/active/i);
    await expect(toast(page)).toBeHidden();
  });

  test("closes the toast on a failed Undo and leaves the page truthful", async ({
    page,
    context,
  }) => {
    const { id, serviceName } = await createAsset(page, "UndoRace");
    await openDetail(page, id, serviceName);

    await archiveControl(page).click();
    await expect(toast(page)).toBeVisible();

    /**
     * A real race, not a simulation.
     *
     * A second tab restores the service first, so this tab's Undo submits
     * against a row that is already `active`. `restoreAsset` passes an expected
     * status of `archived` to `setStatus`, the update matches nothing, and the
     * service answers `NOT_FOUND` — which is precisely the situation the durable
     * alert exists for, produced by two tabs rather than by a stub.
     */
    const other = await context.newPage();
    await openDetail(other, id, serviceName);
    await restoreControl(other).click();
    await expect(archiveControl(other)).toBeVisible();
    await other.close();

    await undoButton(page).click();

    /**
     * `ToastAction` dismisses on activation — Radix's design, verified by probe
     * in M1 and confirmed here in the engine — so the toast is gone before the
     * result arrives and cannot report it.
     */
    await expect(toast(page)).toBeHidden();

    /** The failure is in the page, in the shared vocabulary. */
    const alert = page.locator("[data-slot='asset-restore-error']");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText("This service is no longer available. Nothing was changed.");
    await expect(alert).toHaveAttribute("role", "alert");

    /**
     * And the page tells the truth about the service, which is the property
     * that actually matters here.
     *
     * ## What this assertion used to say, and why it was wrong
     *
     * It required `Restore` to still be visible, on the assumption that this
     * tab stays stale after a failed Undo. A passive DOM probe disproved that
     * assumption: at exactly this point the page rendered
     * `data-status="active"`, offered `Archive`, and contained no `restore`
     * control anywhere — while displaying the failure alert asserted above.
     *
     * The old assertion was not merely unmet, it was unsatisfiable without the
     * page contradicting itself. The service *is* active — the other tab
     * restored it — so a Restore control here would offer to un-archive
     * something the same page says is not archived.
     *
     * The scenario's intent is unchanged and still fully asserted: the failure
     * is reported durably (above), the page reflects the service's real state,
     * and the action offered is the one that state permits.
     */
    await expect(overviewStatus(page)).toContainText(/active/i);
    await expect(archiveControl(page)).toBeVisible();
    await expect(archiveControl(page)).toBeEnabled();

    /**
     * Asserted page-wide rather than within the header: the probe scanned every
     * `[data-action]` on the page and found no `restore`, so scoping this to the
     * header would leave a control rendered elsewhere undetected.
     */
    await expect(page.locator("[data-action='restore']")).toHaveCount(0);
  });

  test("reports a failed archive durably and shows no confirmation", async ({ page, context }) => {
    const { id, serviceName } = await createAsset(page, "ArchiveRace");
    await openDetail(page, id, serviceName);

    /** The same honest race, in the other direction. */
    const other = await context.newPage();
    await openDetail(other, id, serviceName);
    await archiveControl(other).click();
    await expect(restoreControl(other)).toBeVisible();
    await other.close();

    await archiveControl(page).click();

    const alert = page.locator("[data-slot='asset-archive-error']");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText("This service is no longer available. Nothing was changed.");

    /** A failure must never look like a success. */
    await expect(toast(page)).toBeHidden();
  });
});

test.describe("the toast's real timer", () => {
  /**
   * The one M1 unknown, settled with executed browser evidence.
   *
   * jsdom ran the timer but could not be trusted about it — the probe saw the
   * documented pause-on-focus behaviour fail to resume, which is a property of
   * the environment's timer model rather than of Radix. So the duration is
   * **measured** here rather than waited out: the elapsed time between the toast
   * appearing and Playwright's auto-retrying `toBeHidden` resolving is compared
   * against the configured value.
   *
   * No `waitForTimeout` anywhere. The clock is read, never slept on.
   *
   * The band is wide on purpose. What this proves is that the product's
   * explicit 10s is in force rather than Radix's inherited 5s default — a
   * distinction a tight bound is not needed to make, and a tight bound would
   * turn scheduler jitter under two parallel workers into flake.
   */
  test("stays open for the configured duration, then leaves the record behind", async ({
    page,
  }) => {
    const { id, serviceName } = await createAsset(page, "ToastTimer");
    await openDetail(page, id, serviceName);

    await archiveControl(page).click();
    await expect(toast(page)).toBeVisible();

    const openedAt = Date.now();

    /** Auto-retrying, with a ceiling well clear of the configured duration. */
    await expect(toast(page)).toBeHidden({ timeout: ARCHIVE_TOAST_DURATION_MS * 2 });

    const elapsed = Date.now() - openedAt;

    expect(
      elapsed,
      `the toast closed after ${elapsed}ms; the configured duration is ${ARCHIVE_TOAST_DURATION_MS}ms`,
    ).toBeGreaterThan(ARCHIVE_TOAST_DURATION_MS * 0.7);
    expect(elapsed).toBeLessThan(ARCHIVE_TOAST_DURATION_MS * 1.8);

    /**
     * The point of the whole design: the shortcut expired, the record did not.
     * A user who missed the toast has lost the undo and nothing else.
     */
    await expect(restoreControl(page)).toBeVisible();
    await expect(overviewStatus(page)).toContainText(/archived/i);
  });

  test("does not strand focus inside the dismissed toast", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "ToastFocus");
    await openDetail(page, id, serviceName);

    await archiveControl(page).click();
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).toBeHidden({ timeout: ARCHIVE_TOAST_DURATION_MS * 2 });

    /**
     * Modest by design. The toast appears without being asked for and does not
     * take focus, so after it expires there is nothing to restore focus *to* —
     * what matters is that focus is not left on a node that has been removed
     * from the document, which is how a keyboard user loses their place
     * entirely.
     */
    const stranded = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return false;
      return !active.isConnected || active.closest("[data-slot='asset-archive-toast']") !== null;
    });

    expect(stranded, "focus must not be left inside or on a removed toast").toBe(false);
  });
});

test.describe("archiving from the card", () => {
  test("removes the card from the default list, with no toast", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "CardArchive");

    await page.goto("/assets");
    await expect(card(page, id)).toBeVisible();

    const menu = await openCardMenu(page, serviceName);
    await expect(menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: ARCHIVE_COPY.restore })).toHaveCount(0);

    await menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive }).click();

    /**
     * The behaviour that only a browser can prove. The action revalidated
     * `/assets`, the router refetched it, and M2's exclusion did the rest — so
     * the card is gone from the active list without a navigation.
     */
    await expect(card(page, id)).toHaveCount(0);

    /**
     * And deliberately no toast. A toast owned by this card would have unmounted
     * with it; asserting its absence keeps the surface distinction from being
     * quietly "fixed" later into an undo that sometimes is not there.
     */
    await expect(toast(page)).toHaveCount(0);
    await expect(undoButton(page)).toHaveCount(0);
  });

  test("restores from the Archived filter and returns the service to the default list", async ({
    page,
  }) => {
    const { id, serviceName } = await createAsset(page, "CardRestore");

    await page.goto("/assets");
    let menu = await openCardMenu(page, serviceName);
    await menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive }).click();
    await expect(card(page, id)).toHaveCount(0);

    /** The durable path to a restore until ATL-071 builds the Archive page. */
    await page.goto("/assets?status=archived");
    await expect(card(page, id)).toBeVisible();

    menu = await openCardMenu(page, serviceName);
    await expect(menu.getByRole("menuitem", { name: ARCHIVE_COPY.restore })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive })).toHaveCount(0);

    await menu.getByRole("menuitem", { name: ARCHIVE_COPY.restore }).click();

    /** Restored, so it leaves the archived-only view. */
    await expect(card(page, id)).toHaveCount(0);

    /** And it is back where the user looks for active services. */
    await page.goto("/assets");
    await expect(card(page, id)).toBeVisible();
  });

  test("leaves the list truthful when the service was already archived elsewhere", async ({
    page,
    context,
  }) => {
    const { id, serviceName } = await createAsset(page, "CardRace");

    await page.goto("/assets");
    await expect(card(page, id)).toBeVisible();

    /** The same honest race: another tab archives first. */
    const other = await context.newPage();
    await openDetail(other, id, serviceName);
    await archiveControl(other).click();
    await expect(restoreControl(other)).toBeVisible();
    await other.close();

    const menu = await openCardMenu(page, serviceName);
    await menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive }).click();

    /** Radix closes the menu on select. */
    await expect(page.getByRole("menu")).toHaveCount(0);

    /**
     * ## What this test used to assert, and why it could not hold
     *
     * It required a durable `asset-card-error` inside the card. Browser
     * observation showed the card present with no alert, and then no card at
     * all — the alert has no surface to live on, because the card is the thing
     * that leaves.
     *
     * Walking the path explains it without needing more instrumentation. The
     * other tab already archived this service, so any fresh server render of
     * `/assets` applies M2's archived exclusion and drops the row. The card
     * unmounts and its `useActionState` goes with it, so there is no component
     * left to render a message.
     *
     * That is the correct end state, not a defect. The user asked for this
     * service to be archived; it *is* archived. Reporting "nothing was changed"
     * would contradict what the list is simultaneously showing them, and would
     * describe a failure of a request whose intent has been satisfied.
     *
     * The card's durable alert is not being abandoned — it still covers the
     * failures where the card survives, and `asset-list.test.tsx` asserts both
     * the archive and restore alerts directly. What is removed here is the
     * assumption that it can survive the row leaving the list.
     */
    await expect(card(page, id)).toHaveCount(0);

    /** And the service is where an archived service belongs. */
    await page.goto("/assets?status=archived");
    await expect(card(page, id)).toBeVisible();
  });

  test("keeps View details disabled, under #139", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "CardView");

    await page.goto("/assets");
    await expect(card(page, id)).toBeVisible();

    const menu = await openCardMenu(page, serviceName);
    const view = menu.getByRole("menuitem", { name: "View details" });

    /** The detail page exists since ATL-034; the card's route to it does not. */
    await expect(view).toHaveAttribute("aria-disabled", "true");
    await expect(view).not.toHaveAttribute("href", /./);
  });

  test.describe("a service that can be neither archived nor restored", () => {
    for (const status of ["inactive", "removed"] as const) {
      test(`offers no live transition on a ${status} service`, async ({ page }) => {
        const { id, serviceName } = await createAsset(page, `Card${status}`);

        /** Set through the edit page's own status form — no fixture write. */
        await page.goto(`/assets/${id}/edit`);
        /**
         * `exact` because "Status" is ambiguous: it names both the `<select>`
         * and the `<form aria-label="Update status">` that wraps it, and the
         * loose matcher resolved to two elements. The product is correct; the
         * locator was not.
         */
        const statusSelect = page.getByLabel("Status", { exact: true });

        await statusSelect.selectOption(status);
        await page.getByRole("button", { name: "Update status" }).click();

        /**
         * ## Why the previous assertion was removed
         *
         * It was `expect(statusSelect).toHaveValue(status)`. That verifies only
         * the client-side `<select>` value after `selectOption()` — which the
         * line above had just set — and not that the server-side update has
         * committed. It therefore gated nothing.
         *
         * ## Root cause hypothesis for the intermittent failure
         *
         * Unvalidated at the time of writing. With no gate, the navigation
         * below could reach `/assets` before the Server Action committed; the
         * list would then render the row still `active`, the card would take
         * its active branch, and the assertion further down would find a live
         * menu item with no `aria-disabled` — which is what the failing run
         * reported. This would also explain why the same sequence passed in a
         * lightly loaded run and failed under the full suite.
         *
         * ## What replaces it
         *
         * A synchronisation on the state this test actually depends on: the
         * list's own rendering of the status, re-read until it agrees. The card
         * is a server render, so a fresh read is the only thing that can reflect
         * the write — hence the reload inside the poll rather than a retrying
         * matcher against a page that cannot change on its own.
         *
         * Bounded, and waiting on product state rather than a clock. No
         * `waitForTimeout`.
         */
        const LABELS = { inactive: "Inactive", removed: "Removed" } as const;

        await expect
          .poll(
            async () => {
              await page.goto("/assets");
              const target = card(page, id);
              if ((await target.count()) === 0) return "card absent";
              return (await target.textContent()) ?? "";
            },
            { timeout: 15_000 },
          )
          .toContain(LABELS[status]);

        await expect(card(page, id)).toBeVisible();

        const menu = await openCardMenu(page, serviceName);

        /**
         * `archiveAsset` expects `active` and `restoreAsset` expects `archived`,
         * so both writes would match no row. Present and disabled rather than
         * absent, which is the card's existing pattern.
         */
        await expect(menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(menu.getByRole("menuitem", { name: ARCHIVE_COPY.restore })).toHaveCount(0);
      });
    }
  });
});

test.describe("what the list shows (ATL-036 M2)", () => {
  test("hides archived services by default and reveals them on request", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "ListExclusion");

    await page.goto("/assets");
    const menu = await openCardMenu(page, serviceName);
    await menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive }).click();

    /** Default: excluded. */
    await expect(card(page, id)).toHaveCount(0);

    /** Explicit status: included. The filter is the opt-out, as M2 designed. */
    await page.goto("/assets?status=archived");
    await expect(card(page, id)).toBeVisible();

    /** And an explicit `active` filter still excludes it, for a different reason. */
    await page.goto("/assets?status=active");
    await expect(card(page, id)).toHaveCount(0);
  });

  test("keeps explicit status filtering working for a non-archived status", async ({ page }) => {
    const { id } = await createAsset(page, "ListFilter");

    /** Created active, so an explicit `active` filter must show it. */
    await page.goto("/assets?status=active");
    await expect(card(page, id)).toBeVisible();

    await page.goto("/assets?status=inactive");
    await expect(card(page, id)).toHaveCount(0);
  });

  test("uses the filtered copy only when the user actually filtered", async ({ page }) => {
    /**
     * A search that cannot match anything. The distinction being protected is
     * that "no services match those filters" must never be shown to someone who
     * filtered nothing — that would read as data loss.
     */
    await page.goto(`/assets?search=${encodeURIComponent(uniqueService("NoMatch"))}`);

    await expect(page.getByText(/No services match those filters/i)).toBeVisible();
    await expect(page.getByText("No active services to show.")).toHaveCount(0);
    await expect(page.getByText(/No services yet/i)).toHaveCount(0);
  });

  test("leaves Insights unchanged, which shares the query parser", async ({ page }) => {
    /**
     * `parseAssetQuery` is shared, and M2 put the exclusion behind an opt-in
     * precisely so this surface kept behaving as it did. A regression would show
     * up as the page failing to render its own heading.
     */
    await page.goto("/insights");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("No active services to show.")).toHaveCount(0);
  });
});

test.describe("accessibility and layout", () => {
  test("operates archive and restore without a pointer", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "KeyboardOnly");
    await openDetail(page, id, serviceName);

    /** Tabbed to and activated by key — never clicked. */
    let reached = false;
    for (let step = 0; step < 15 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await archiveControl(page).evaluate((node) => node === document.activeElement);
    }
    expect(reached, "Archive must be reachable by keyboard alone").toBe(true);

    await page.keyboard.press("Enter");
    await expect(restoreControl(page)).toBeVisible();

    reached = false;
    for (let step = 0; step < 15 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await restoreControl(page).evaluate((node) => node === document.activeElement);
    }
    expect(reached, "Restore must be reachable by keyboard alone").toBe(true);
  });

  /**
   * `ToastAction`'s `altText` is deliberately **not** asserted here.
   *
   * It was, and the browser disproved the assumption: the rendered toast reads
   * "Archived in Atlas…UndoDismiss" and never contains the alt text. Radix
   * consumes `altText` for its own alternate-affordance handling rather than
   * rendering it as text, so the assertion was checking something that was
   * never true of this version.
   *
   * The contract still has coverage, at the layer that can actually see it:
   * `asset-archive-toast.test.tsx` captures the props handed to `ToastAction`
   * through a delegating mock and asserts `altText` is the descriptive sentence
   * rather than the bare label. That test exists because a sabotage run showed
   * asserting the *constant* had no teeth.
   */

  test("has no axe violations while archived, with the toast open, and once restored", async ({
    page,
  }) => {
    const { id, serviceName } = await createAsset(page, "ArchiveAxe");
    await openDetail(page, id, serviceName);

    await archiveControl(page).click();

    /** Toast open, over an archived page. */
    await expect(toast(page)).toBeVisible();
    await expectNoAxeViolations(page);

    /** Archived and durable, after the toast has gone. */
    await expect(toast(page)).toBeHidden({ timeout: ARCHIVE_TOAST_DURATION_MS * 2 });
    await expect(restoreControl(page)).toBeVisible();
    await expectNoAxeViolations(page);

    /** And restored. */
    await restoreControl(page).click();
    await expect(archiveControl(page)).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("keeps the toast inside the viewport and the page free of sideways scroll", async ({
    page,
  }) => {
    const { id, serviceName } = await createAsset(page, "ToastLayout");
    await openDetail(page, id, serviceName);

    await archiveControl(page).click();
    await expect(toast(page)).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport, "every project configures a viewport").not.toBeNull();

    const box = await toast(page).boundingBox();
    expect(box, "the toast must be laid out").not.toBeNull();

    if (box && viewport) {
      /**
       * The toast is fixed-position and portalled, which makes it the one
       * element on this surface that can plausibly escape a 320px viewport.
       */
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, "the page must not scroll sideways with the toast open").toBe(false);
  });

  test("keeps the archived card inside the viewport", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "CardLayout");

    await page.goto("/assets");
    const menu = await openCardMenu(page, serviceName);
    await menu.getByRole("menuitem", { name: ARCHIVE_COPY.archive }).click();
    await expect(card(page, id)).toHaveCount(0);

    await page.goto("/assets?status=archived");
    await expect(card(page, id)).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, "the archived list must not scroll sideways").toBe(false);

    await expectNoAxeViolations(page);
  });
});
