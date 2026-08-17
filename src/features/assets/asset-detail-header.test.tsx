import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { AssetDetailHeaderActions } from "./asset-detail-header";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";
import { ARCHIVE_COPY } from "@/lib/assets/archive-copy";
import type { AssetStatus } from "@/lib/assets/asset-fields";
import type { AssetActionFormState } from "./asset-action-form";

/**
 * ATL-034 M3 — the identity header's actions.
 *
 * ## The distinction these protect
 *
 * Four of the five controls do nothing, and the ticket's requirement is that
 * they still be *present, named, reachable and honest about why*. Those are four
 * separate properties and a control can satisfy three of them while failing the
 * one that matters — a native `<button disabled>` looks right and is invisible
 * to a keyboard user, which is exactly the failure the probe below caught.
 *
 * ## Probed before written
 *
 *   - `<Button disabled>` is **skipped by Tab**. ❌ not keyboard-reachable.
 *   - `<Button aria-disabled="true">` **is** in the tab order ✅ — but its
 *     `onClick` still fires ❌.
 *
 * Hence: `aria-disabled` for reachability, and no handler at all so there is
 * nothing to fire. "Does not dispatch" is asserted structurally — no `href`, and
 * `type="button"` so it cannot become a form submit — because that is what makes
 * it true, rather than a guard that could be removed.
 */

const ASSET = "44444444-4444-4444-8444-444444444444";
const SERVICE = "Beta Bank";

/**
 * A stand-in with the *real* action signature.
 *
 * Two arguments rather than one, because the tests read `mock.calls[0][1]` to
 * check which asset id was submitted — a one-argument double makes that a type
 * error, and casting it away would hide a double that no longer matches the
 * contract it stands for.
 */
type ActionMock = (
  previous: AssetActionFormState,
  formData: FormData,
) => Promise<AssetActionFormState>;

const succeeds = () =>
  vi.fn<ActionMock>((previous) =>
    Promise.resolve({ failure: null, attempt: previous.attempt + 1 }),
  );

const failsWith = (failure: NonNullable<AssetActionFormState["failure"]>) =>
  vi.fn<ActionMock>((previous) => Promise.resolve({ failure, attempt: previous.attempt + 1 }));

/**
 * The double's own type, not the contract it implements.
 *
 * Typing the helper parameters as `ActionMock` would hand back a plain function
 * and `mock.calls` — which is how these tests check *which asset id was
 * submitted* — would stop type-checking.
 */
type ActionDouble = ReturnType<typeof succeeds>;

/**
 * Renders the header inside the provider/viewport pair the app mounts, so the
 * archive toast renders in the structure it will actually live in.
 */
function header({
  status = "active",
  archive = succeeds(),
  restore = succeeds(),
}: { status?: AssetStatus; archive?: ActionDouble; restore?: ActionDouble } = {}) {
  const view = render(
    <ToastProvider>
      <AssetDetailHeaderActions
        assetId={ASSET}
        serviceName={SERVICE}
        status={status}
        archive={archive}
        restore={restore}
      />
      <ToastViewport />
    </ToastProvider>,
  );

  return { ...view, archive, restore };
}

/**
 * The two §7 controls whose capability does not exist yet, with the tab stop
 * each one occupies.
 *
 * The header's focus order is Edit (1), Archive (2), Request correction (3),
 * Request deletion (4), More (5) — §7's order, left to right. Pinning the exact
 * stop rather than "reachable within N tabs" means a control that quietly left
 * the tab order, or moved within it, fails here.
 *
 * Archive left this table in ATL-036 M5 without moving: it is now a real control
 * at the same stop, which is what rendering it unavailable rather than omitting
 * it was for. The stops below are therefore unchanged.
 */
const UNAVAILABLE = [
  ["Request correction", "Atlas cannot make data requests yet.", 3],
  ["Request deletion", "Atlas cannot make data requests yet.", 4],
] as const;

describe("the one action that works", () => {
  it("offers Edit, pointing at the existing edit route", () => {
    header();

    /**
     * A link, not a button: it navigates, so middle-click and open-in-new-tab
     * should work. Asserted by role for that reason.
     */
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/assets/${ASSET}/edit`,
    );
  });
});

describe("the controls whose capability does not exist yet", () => {
  it.each(UNAVAILABLE)("renders %s as present and unavailable", (label) => {
    header();

    const control = screen.getByRole("button", { name: new RegExp(label) });

    expect(control).toBeVisible();
    expect(control).toHaveAttribute("aria-disabled", "true");
  });

  it.each(UNAVAILABLE)("explains why %s cannot be used", (label, reason) => {
    header();

    /**
     * The reason is wired with `aria-describedby`, so it is announced on focus
     * rather than only being readable by someone who can see the line under the
     * button — the users most likely to need it are the ones who cannot.
     */
    expect(screen.getByRole("button", { name: new RegExp(label) })).toHaveAccessibleDescription(
      reason,
    );
  });

  it.each(UNAVAILABLE)("keeps %s reachable at tab stop %s", async (label, _reason, stop) => {
    const user = userEvent.setup();
    header();

    /**
     * Tabbed to, not focused programmatically. `focus()` succeeds on elements
     * the browser's tab order skips, so it would pass on a native `disabled`
     * button and prove nothing.
     */
    for (let step = 0; step < stop; step += 1) {
      await user.tab();
    }

    expect(screen.getByRole("button", { name: new RegExp(label) })).toHaveFocus();
  });

  it.each(UNAVAILABLE)("gives %s nothing to dispatch", (label) => {
    header();

    const control = screen.getByRole("button", { name: new RegExp(label) });

    /**
     * Structural rather than behavioural, and deliberately so. `aria-disabled`
     * does not block `onClick` — the probe confirmed that — so the guarantee
     * cannot be "the handler checks a flag". It is that there is no handler, no
     * destination, and no form to submit.
     */
    expect(control).not.toHaveAttribute("href");
    expect(control).toHaveAttribute("type", "button");
  });

  it("does not navigate when an unavailable control is activated", async () => {
    const user = userEvent.setup();
    header();

    const before = window.location.href;
    await user.click(screen.getByRole("button", { name: /Request correction/ }));

    /** No href, so activation cannot move the user anywhere. */
    expect(window.location.href).toBe(before);
  });
});

/**
 * ATL-036 M5 — the archive capability, wired.
 *
 * ## What this layer owns, and what it does not
 *
 * `AssetArchiveToast` proves its own behaviour: the toast, the undo, the durable
 * failure alerts, the status branching. Re-asserting all of that here would
 * duplicate coverage and fail in two places for one cause.
 *
 * What only exists once assembled is the *wiring*: that the header renders the
 * archive control at all, in the right place, driven by the status the page
 * read, and posting the actions the page passed in. That is what is asserted.
 *
 * ## This is the surface with undo, and the only one
 *
 * The asset card offers Archive and Restore with no toast, because an archived
 * card leaves the default list as soon as it is revalidated and takes any toast
 * it owned with it. The detail page does not move, so the undo lives here. The
 * asymmetry is deliberate and is asserted on the card side too.
 */
describe("archive and restore", () => {
  const archiveControl = () =>
    screen.getByRole("button", { name: `${ARCHIVE_COPY.archive}: ${SERVICE}` });
  const restoreControl = () =>
    screen.getByRole("button", { name: `${ARCHIVE_COPY.restore}: ${SERVICE}` });

  it("offers Archive on an active service", () => {
    header();

    expect(archiveControl()).toBeVisible();
    expect(archiveControl()).not.toHaveAttribute("aria-disabled", "true");
  });

  it("offers Restore instead once the service is archived", () => {
    header({ status: "archived" });

    expect(restoreControl()).toBeVisible();
    expect(
      screen.queryByRole("button", { name: `${ARCHIVE_COPY.archive}: ${SERVICE}` }),
    ).toBeNull();
  });

  it("keeps Archive at the second tab stop, where the unavailable one was", async () => {
    const user = userEvent.setup();
    header();

    /** Edit is first; Archive is second. §7's order, unchanged by the wiring. */
    await user.tab();
    await user.tab();

    expect(archiveControl()).toHaveFocus();
  });

  it("posts the page's archive action, naming this asset", async () => {
    const user = userEvent.setup();
    const { archive } = header();

    await user.click(archiveControl());

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    const formData = archive.mock.calls[0]?.[1] as FormData;
    expect(formData.get("assetId")).toBe(ASSET);
  });

  it("shows the undo toast once the archive succeeds", async () => {
    const user = userEvent.setup();
    header();

    await user.click(archiveControl());

    expect(await screen.findByText(ARCHIVE_COPY.archivedTitle)).toBeVisible();
    expect(screen.getByRole("button", { name: ARCHIVE_COPY.undo })).toBeVisible();
  });

  it("restores through Undo, using the action the page passed in", async () => {
    const user = userEvent.setup();
    const { restore } = header();

    await user.click(archiveControl());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    await user.click(screen.getByRole("button", { name: ARCHIVE_COPY.undo }));

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    const formData = restore.mock.calls[0]?.[1] as FormData;
    expect(formData.get("assetId")).toBe(ASSET);
  });

  it("reports a failed archive in the page, and shows no toast", async () => {
    const user = userEvent.setup();
    header({ archive: failsWith("unavailable") });

    await user.click(archiveControl());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Nothing was changed — please try again.",
    );
    /** A failure that looked like a success would be the worst outcome here. */
    expect(screen.queryByText(ARCHIVE_COPY.archivedTitle)).toBeNull();
  });

  it("reports a failed restore in the page", async () => {
    const user = userEvent.setup();
    header({ status: "archived", restore: failsWith("not_found") });

    await user.click(restoreControl());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This service is no longer available. Nothing was changed.",
    );
  });

  it("leaves Restore available after a failed undo", async () => {
    const user = userEvent.setup();
    /**
     * Rendered archived, which is the state the page is in by the time an undo
     * can fail: the successful archive revalidated this route, so the header
     * re-rendered with `status: "archived"` before the user reached the toast.
     *
     * That ordering is what makes the M4 contract safe. `ToastAction` closes the
     * toast on activation, so a failed undo has no toast left to report from —
     * the durable alert and this control are the whole recovery path.
     */
    header({ status: "archived", restore: failsWith("unavailable") });

    await user.click(restoreControl());
    await screen.findByRole("alert");

    expect(restoreControl()).toBeVisible();
    expect(restoreControl()).not.toBeDisabled();
  });

  it.each(["inactive", "removed"] as const)(
    "offers neither transition on a %s service",
    (status) => {
      /** `archiveAsset` expects `active` and `restoreAsset` expects `archived`. */
      header({ status });

      expect(archiveControl()).toHaveAttribute("aria-disabled", "true");
      expect(archiveControl()).toHaveAccessibleDescription(ARCHIVE_COPY.archiveUnavailableReason);
    },
  );
});

describe("naming", () => {
  it("names every control for the service it acts on", () => {
    header();

    for (const [label] of UNAVAILABLE) {
      expect(screen.getByRole("button", { name: `${label}: ${SERVICE}` })).toBeVisible();
    }

    /** Archive is named the same way, though it is now a live control. */
    expect(
      screen.getByRole("button", { name: `${ARCHIVE_COPY.archive}: ${SERVICE}` }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: `More actions for ${SERVICE}` })).toBeVisible();
  });

  it("gives every control an accessible name", () => {
    header();

    const named = [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].map(
      (control) => control.textContent || control.getAttribute("aria-label"),
    );

    expect(named.every((name) => name !== null && name !== "")).toBe(true);
  });
});

describe("the More menu", () => {
  it("opens from the existing dropdown primitive", async () => {
    const user = userEvent.setup();
    header();

    await user.click(screen.getByRole("button", { name: `More actions for ${SERVICE}` }));

    /** Radix's menu role — evidence the shared primitive is what opened. */
    expect(await screen.findByRole("menu")).toBeVisible();
  });

  it("exposes no actions, because none in scope exists", async () => {
    const user = userEvent.setup();
    header();

    await user.click(screen.getByRole("button", { name: `More actions for ${SERVICE}` }));
    await screen.findByRole("menu");

    /**
     * A label, not a disabled item: it makes no claim to be an action, so it
     * raises no question about whether it should be focusable. Anything with a
     * `menuitem` role here would be a capability this ticket did not build.
     */
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(screen.getByText("No other actions yet.")).toBeVisible();
  });

  it("names no capability that has not been built", async () => {
    const user = userEvent.setup();
    header();

    await user.click(screen.getByRole("button", { name: `More actions for ${SERVICE}` }));
    const menu = await screen.findByRole("menu");

    /**
     * The vocabulary of the tickets this one must not reach into: ATL-036's
     * restore, ATL-037's permanent deletion, M8's requests. A menu that grew any
     * of them would be building a later ticket by accident.
     */
    expect(menu.textContent ?? "").not.toMatch(/delete|restore|export|duplicate|request/i);
  });
});

describe("accessibility", () => {
  it("has no axe violations in the header's resting state", async () => {
    const { container } = header();

    expect(await axe(container)).toHaveNoViolations();
  });
});
