import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-106 — Settings → Personal data, end to end.
 *
 * The claims only a browser can settle: that a saved value is absent from what
 * the server actually sent rather than merely hidden, that it appears solely in
 * response to a click, that it never enters the URL, and that a full add → reveal
 * → edit → delete round trip works against the real service, encryption and audit
 * chain.
 *
 * The component suite (`personal-fields-section.test.tsx`) already covers the
 * three consent states and the disclosures against mocked actions, and
 * `personal-field-service.test.ts` covers the gate, the masking and the audit
 * event. Neither is restated here.
 *
 * ## Why the consent step branches
 *
 * The E2E user is shared across specs and its `personal_fields_storage` consent
 * may already exist from an earlier run. So each test settles the state it needs
 * rather than assuming a first run — the same pattern the sibling assistant spec
 * uses. Every test also deletes what it created, because a leftover row would
 * change which branch the *next* run takes.
 */

const VALUE = "dana.scully@example.com";
const REVEAL = (label: string) => `Reveal Personal detail: ${label}`;

const uniqueLabel = (name: string) =>
  `E2E ${name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Leaves the page on `/settings` with saving permitted, granting only if needed. */
async function openSettingsWithConsent(page: Page): Promise<void> {
  await page.goto("/settings");

  const grant = page.getByRole("button", { name: "Allow Atlas to save personal details" });

  // Present on a first run, absent once permission exists. Both are valid states,
  // so the spec reads which one it is rather than requiring one of them.
  if (await grant.isVisible()) {
    await grant.click();
  }

  await expect(page.getByLabel("Value")).toBeVisible();
}

/**
 * The one row a test created, addressed by its own label.
 *
 * Necessary rather than tidy: the E2E user is shared and specs run in parallel,
 * so the list holds rows this test knows nothing about. Anything a row states
 * about itself — the last-used line, the revealed value, the kind — is text every
 * row also has, and asserting it against the page would either match several
 * elements (which strict mode rightly rejects) or, with an index, silently assert
 * against somebody else's row. The label is unique per test, so the row is too.
 */
const row = (page: Page, label: string) =>
  page.locator('[data-slot="personal-field-row"]').filter({ hasText: label });

/** Saves one detail and returns the label it was given. */
async function addDetail(page: Page, name: string, value = VALUE): Promise<string> {
  const label = uniqueLabel(name);

  await openSettingsWithConsent(page);
  await page.getByLabel("Kind of detail").selectOption("email");
  await page.getByLabel("Label").fill(label);
  await page.getByLabel("Value").fill(value);
  await page.getByRole("button", { name: "Save detail" }).click();

  await expect(page.getByText(label)).toBeVisible();
  return label;
}

/** Removes a detail through the confirmation dialog. */
async function deleteDetail(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: `Delete: ${label}` }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByText(label)).toHaveCount(0);
}

test.describe("saving a personal detail", () => {
  test("stores it and shows it masked, with the value absent from the document", async ({
    page,
  }) => {
    /**
     * The strong form of "masked by default": not hidden, absent. A value in the
     * delivered document is readable from view-source, the network panel and any
     * RSC payload dump, whatever the pixels show.
     */
    const label = await addDetail(page, "Masked");

    await expect(page.getByRole("button", { name: REVEAL(label) })).toBeVisible();
    expect(await page.content()).not.toContain(VALUE);
    expect(await page.content()).not.toContain("dana.scully");

    await deleteDetail(page, label);
  });

  test("does not leave the typed value in the form after saving", async ({ page }) => {
    const label = await addDetail(page, "Cleared");

    // The form is re-rendered by the revalidation; a value still sitting in the
    // box would be a plaintext on screen nobody asked to see.
    await expect(page.getByLabel("Value")).toHaveValue("");

    await deleteDetail(page, label);
  });

  test("says the field has never been used in a request", async ({ page }) => {
    /**
     * `last_used_at` is null until ATL-058 gives `markUsed` its first caller. The
     * row states that rather than showing a blank, which would read as a fault.
     */
    const label = await addDetail(page, "Unused");

    await expect(row(page, label).getByText("Not yet used in a request")).toBeVisible();

    await deleteDetail(page, label);
  });
});

test.describe("revealing a saved value", () => {
  test("shows the plaintext only after an explicit reveal", async ({ page }) => {
    const label = await addDetail(page, "Reveal");

    await page.getByRole("button", { name: REVEAL(label) }).click();

    await expect(row(page, label).getByText(VALUE)).toBeVisible();

    await deleteDetail(page, label);
  });

  test("keeps the value out of the URL", async ({ page }) => {
    // Security §8: no sensitive values in URLs or query strings. The action
    // carries the field id in a POST body; the address bar never changes.
    const label = await addDetail(page, "NoUrl");
    const before = page.url();

    await page.getByRole("button", { name: REVEAL(label) }).click();
    await expect(row(page, label).getByText(VALUE)).toBeVisible();

    expect(page.url()).toBe(before);
    expect(page.url()).not.toContain("dana");

    await deleteDetail(page, label);
  });

  test("is masked again after a reload, not left open", async ({ page }) => {
    // A reveal is a disclosure, not a preference. Persisting it would leave the
    // value on screen for whoever opens the page next.
    const label = await addDetail(page, "Reload");

    await page.getByRole("button", { name: REVEAL(label) }).click();
    await expect(row(page, label).getByText(VALUE)).toBeVisible();

    await page.goto("/settings");

    await expect(page.getByRole("button", { name: REVEAL(label) })).toBeVisible();
    expect(await page.content()).not.toContain(VALUE);

    await deleteDetail(page, label);
  });
});

test.describe("editing a saved detail", () => {
  test("changes the label without asking for the value again", async ({ page }) => {
    const label = await addDetail(page, "Edit");
    const renamed = `${label} renamed`;

    await page.getByRole("button", { name: `Edit: ${label}` }).click();

    /**
     * The editor's value box is empty and an empty value means "leave it alone".
     * Pre-filling it would require sending the plaintext to the browser — exactly
     * what `listMasked` exists to avoid.
     */
    const editor = page.locator('[data-slot="personal-field-edit-form"]');
    await expect(editor.getByLabel("Value")).toHaveValue("");

    await editor.getByLabel("Label").fill(renamed);
    await editor.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText(renamed)).toBeVisible();

    // The value survived a label-only edit: it can still be revealed.
    await page.getByRole("button", { name: REVEAL(renamed) }).click();
    await expect(row(page, renamed).getByText(VALUE)).toBeVisible();

    await deleteDetail(page, renamed);
  });

  test("replaces the value when a new one is typed", async ({ page }) => {
    const label = await addDetail(page, "Replace");
    const replacement = "fox.mulder@example.com";

    await page.getByRole("button", { name: `Edit: ${label}` }).click();
    const editor = page.locator('[data-slot="personal-field-edit-form"]');
    await editor.getByLabel("Value").fill(replacement);
    await editor.getByRole("button", { name: "Save changes" }).click();

    // Re-encrypted under the same record, so the old value is unrecoverable.
    await page.getByRole("button", { name: REVEAL(label) }).click();
    await expect(row(page, label).getByText(replacement)).toBeVisible();
    await expect(row(page, label).getByText(VALUE)).toHaveCount(0);

    await deleteDetail(page, label);
  });
});

test.describe("deleting a saved detail", () => {
  test("asks before deleting, and keeps the detail if declined", async ({ page }) => {
    const label = await addDetail(page, "Keep");

    await page.getByRole("button", { name: `Delete: ${label}` }).click();

    await expect(page.getByText("Delete this detail?")).toBeVisible();
    await expect(page.getByText(/permanently deletes the saved value/i)).toBeVisible();

    await page.getByRole("button", { name: "Keep it" }).click();

    await expect(page.getByText(label)).toBeVisible();

    await deleteDetail(page, label);
  });

  test("removes it for good once confirmed", async ({ page }) => {
    const label = await addDetail(page, "Delete");

    await deleteDetail(page, label);

    // Gone from a fresh read, not just from the current render.
    await page.goto("/settings");
    await expect(page.getByText(label)).toHaveCount(0);
  });
});

test.describe("the honest disclosures", () => {
  test("state that the encryption is server-side and that AI needs approval", async ({ page }) => {
    /**
     * ADR-003 requires that documentation not imply end-to-end encryption, and
     * ADR-002 that nothing reaches a provider without per-request approval. Both
     * sentences have to be on the page a person actually visits.
     */
    await page.goto("/settings");

    await expect(page.getByText(/not end-to-end/i)).toBeVisible();
    await expect(page.getByText(/never sends these to the AI assistant/i)).toBeVisible();
  });
});

test.describe("@a11y accessibility", () => {
  test("the section has no axe violations while masked", async ({ page }) => {
    const label = await addDetail(page, "AxeMasked");

    await expectNoAxeViolations(page);

    await deleteDetail(page, label);
  });

  test("and none while a value is revealed", async ({ page }) => {
    const label = await addDetail(page, "AxeRevealed");

    await page.getByRole("button", { name: REVEAL(label) }).click();
    await expect(row(page, label).getByText(VALUE)).toBeVisible();

    await expectNoAxeViolations(page);

    await deleteDetail(page, label);
  });

  test("reveal is operable by keyboard alone", async ({ page }) => {
    // CLAUDE.md: hover actions must have keyboard and touch equivalents.
    const label = await addDetail(page, "AxeKeyboard");

    await page.getByRole("button", { name: REVEAL(label) }).focus();
    await page.keyboard.press("Enter");

    await expect(row(page, label).getByText(VALUE)).toBeVisible();

    await deleteDetail(page, label);
  });
});
