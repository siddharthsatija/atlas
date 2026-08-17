import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Records the props the component hands `Toast`, then renders the real one.
 *
 * A wrapper rather than a replacement: every other test in this file exercises
 * the genuine Radix primitive, including its close-on-action behaviour. This
 * exists because `duration` is consumed by Radix and never reaches the DOM, so
 * the only way to assert the component *passes* it — rather than that a constant
 * happens to hold the right number — is to observe the call.
 *
 * A sabotage run proved the need: changing the component's default from the
 * constant to 5000 broke nothing, because the test was checking the constant.
 */
type ToastProps = Parameters<typeof ToastModule.Toast>[0];
type ToastActionProps = Parameters<typeof ToastModule.ToastAction>[0];

const toastProps: ToastProps[] = [];
const actionProps: ToastActionProps[] = [];

vi.mock("@/components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();

  return {
    ...actual,
    Toast: (props: ToastProps) => {
      toastProps.push(props);
      return actual.Toast(props);
    },
    ToastAction: (props: ToastActionProps) => {
      actionProps.push(props);
      return actual.ToastAction(props);
    },
  };
});

import { AssetArchiveToast } from "./asset-archive-toast";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";
import { ARCHIVE_COPY, ARCHIVE_TOAST_DURATION_MS } from "@/lib/assets/archive-copy";
import type { AssetActionFormState } from "./asset-action-form";
import type * as ToastModule from "@/components/ui/toast";

/**
 * ATL-036 M4 — the archive control and its undo toast.
 *
 * ## No timers, anywhere
 *
 * The toast's `open` state is controlled and driven by action results, so every
 * assertion below waits on a state change rather than on a clock. Auto-dismiss
 * is the one behaviour that genuinely needs elapsed time, and it is **not**
 * asserted here: the M1 probe measured it in jsdom, where the pause-on-focus
 * behaviour did not resume as documented, so M6 settles it in a browser. A test
 * here that advanced fake timers would be asserting jsdom's timer model rather
 * than what a user experiences.
 *
 * ## Why the failure assertions matter
 *
 * A failed archive must not look like a success, and a failed undo must not take
 * away the undo. Those are the two ways this component could quietly lose a
 * user's service, so both are asserted against the *shared* failure vocabulary
 * rather than against strings written here.
 */

const ASSET = "44444444-4444-4444-8444-444444444444";
const SERVICE = "Beta Bank";

const ok = (attempt: number): AssetActionFormState => ({ failure: null, attempt });
const fails = (
  failure: NonNullable<AssetActionFormState["failure"]>,
  attempt: number,
): AssetActionFormState => ({ failure, attempt });

/**
 * A stand-in with the *real* action signature.
 *
 * Typed as `(previous, formData)` rather than `(previous)` because the tests
 * read `mock.calls[0][1]` to check which asset id was submitted — a one-argument
 * mock makes that a type error, and casting it away would have hidden the fact
 * that the double no longer matched the contract it stands for.
 */
type ActionMock = (
  previous: AssetActionFormState,
  formData: FormData,
) => Promise<AssetActionFormState>;

const succeeds = () =>
  vi.fn<ActionMock>((previous, _formData) => Promise.resolve(ok(previous.attempt + 1)));

const failsWith = (failure: NonNullable<AssetActionFormState["failure"]>) =>
  vi.fn<ActionMock>((previous, _formData) => Promise.resolve(fails(failure, previous.attempt + 1)));

function harness(overrides: Partial<React.ComponentProps<typeof AssetArchiveToast>> = {}): {
  archive: ReturnType<typeof succeeds>;
  restore: ReturnType<typeof succeeds>;
  container: HTMLElement;
} {
  const archive = (overrides.archive as ReturnType<typeof succeeds>) ?? succeeds();
  const restore = (overrides.restore as ReturnType<typeof succeeds>) ?? succeeds();

  const { container } = render(
    /*
      The same provider/viewport pair `src/providers/index.tsx` mounts around the
      app, so the toast renders in the structure it will actually live in.
    */
    <ToastProvider>
      <button type="button">Before</button>
      <AssetArchiveToast
        assetId={ASSET}
        serviceName={SERVICE}
        {...overrides}
        /*
          Resolved after the spread so an override still wins but an absent one
          does not pass `undefined` into a required prop. `active` is the
          default because it is the state every archive test starts from.
        */
        status={overrides.status ?? "active"}
        archive={archive}
        restore={restore}
      />
      <ToastViewport />
    </ToastProvider>,
  );

  return { archive, restore, container };
}

beforeEach(() => {
  toastProps.length = 0;
  actionProps.length = 0;
});

/**
 * The archive control, queried by its full accessible name.
 *
 * Named for the service since ATL-036 M5, matching every other control on the
 * detail header. It is not cosmetic: the asset list renders one of these per
 * card, and a control announced as "Archive" a dozen times over tells a
 * screen-reader user nothing about which service it would archive.
 */
const archiveButton = () =>
  screen.getByRole("button", { name: `${ARCHIVE_COPY.archive}: ${SERVICE}` });
const restoreButton = () =>
  screen.getByRole("button", { name: `${ARCHIVE_COPY.restore}: ${SERVICE}` });
const toastTitle = () => screen.queryByText(ARCHIVE_COPY.archivedTitle);

describe("archiving", () => {
  it("shows the toast once the archive succeeds", async () => {
    const user = userEvent.setup();
    harness();

    expect(toastTitle()).toBeNull();

    await user.click(archiveButton());

    expect(await screen.findByText(ARCHIVE_COPY.archivedTitle)).toBeVisible();
  });

  it("submits the asset id the surface gave it", async () => {
    const user = userEvent.setup();
    const { archive } = harness();

    await user.click(archiveButton());

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    const formData = archive.mock.calls[0]?.[1] as FormData;
    expect(formData.get("assetId")).toBe(ASSET);
  });

  it("shows no success toast when the archive failed", async () => {
    const user = userEvent.setup();
    harness({ archive: failsWith("unavailable") });

    await user.click(archiveButton());

    /** The alert proves the submission completed, so this is not a race. */
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(toastTitle()).toBeNull();
  });

  it("reports an archive failure in the page, using the shared wording", async () => {
    const user = userEvent.setup();
    harness({ archive: failsWith("not_found") });

    await user.click(archiveButton());

    /**
     * The same sentence `AssetActionForm` shows for a failed status change. A
     * second vocabulary would let the two drift.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This service is no longer available. Nothing was changed.",
    );
  });
});

/**
 * ATL-036 M5 — which control the status decides on.
 *
 * The status is server state, re-read after every successful transition, and the
 * component holds no copy of it. So these are pure input/output assertions: the
 * risk they guard is a surface offering a transition the service will refuse —
 * `archiveAsset` expects `active`, `restoreAsset` expects `archived`, and both
 * answer `NOT_FOUND` on anything else.
 */
describe("the control the status chooses", () => {
  it("offers Archive on an active service, and no Restore", () => {
    harness();

    expect(archiveButton()).toBeVisible();
    expect(
      screen.queryByRole("button", { name: `${ARCHIVE_COPY.restore}: ${SERVICE}` }),
    ).toBeNull();
  });

  it("offers Restore on an archived service, and no Archive", () => {
    harness({ status: "archived" });

    expect(restoreButton()).toBeVisible();
    expect(
      screen.queryByRole("button", { name: `${ARCHIVE_COPY.archive}: ${SERVICE}` }),
    ).toBeNull();
  });

  it("restores the named service when Restore is pressed", async () => {
    const user = userEvent.setup();
    const { restore, archive } = harness({ status: "archived" });

    await user.click(restoreButton());

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    const formData = restore.mock.calls[0]?.[1] as FormData;
    expect(formData.get("assetId")).toBe(ASSET);
    /** The archived surface must not be able to reach the archive transition. */
    expect(archive).not.toHaveBeenCalled();
  });

  it("reports a failed Restore durably, in the shared vocabulary", async () => {
    const user = userEvent.setup();
    harness({ status: "archived", restore: failsWith("unavailable") });

    await user.click(restoreButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Nothing was changed — please try again.",
    );
  });

  it("keeps Restore available after it failed, so the user can retry", async () => {
    const user = userEvent.setup();
    harness({ status: "archived", restore: failsWith("unavailable") });

    await user.click(restoreButton());
    await screen.findByRole("alert");

    /**
     * The recovery path the M4 contract depends on. `ToastAction` closes the
     * toast on activation, so a failed undo leaves this control as the only way
     * back — a surface that hid or disabled it after a failure would strand the
     * service in the archive.
     */
    expect(restoreButton()).toBeVisible();
    expect(restoreButton()).not.toBeDisabled();
  });

  it("shows no toast when a Restore succeeds from the archived state", async () => {
    const user = userEvent.setup();
    harness({ status: "archived" });

    await user.click(restoreButton());

    /**
     * The toast belongs to archiving. Restore already returns the service to
     * the place the user can see it, so a confirmation with an undo would be
     * offering to archive again — which is not an undo, it is the original
     * action.
     */
    await waitFor(() => expect(toastTitle()).toBeNull());
  });

  it.each(["inactive", "removed"] as const)(
    "offers neither transition on a %s service, and says why",
    (status) => {
      /**
       * Both writes would match no row and answer `NOT_FOUND`. Present and
       * unavailable rather than absent, so the header keeps its shape.
       */
      harness({ status });

      const control = archiveButton();

      expect(control).toHaveAttribute("aria-disabled", "true");
      expect(control).toHaveAccessibleDescription(ARCHIVE_COPY.archiveUnavailableReason);
      expect(
        screen.queryByRole("button", { name: `${ARCHIVE_COPY.restore}: ${SERVICE}` }),
      ).toBeNull();
    },
  );

  it.each(["inactive", "removed"] as const)(
    "gives the unavailable control nothing to dispatch on a %s service",
    async (status) => {
      const user = userEvent.setup();
      const { archive, restore } = harness({ status });

      await user.click(archiveButton());

      /**
       * Structural, deliberately: `aria-disabled` does not block `onClick`, so
       * the guarantee cannot be a handler that checks a flag. There is no
       * handler, no form, and `type="button"` so it cannot become a submit.
       */
      expect(archiveButton()).toHaveAttribute("type", "button");
      expect(archive).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    },
  );

  it("keeps the unavailable control in the tab order", async () => {
    const user = userEvent.setup();
    harness({ status: "inactive" });

    /** One stop past the harness's "Before" button. */
    await user.tab();
    await user.tab();

    /**
     * `aria-disabled`, not `disabled`: a native disabled button is skipped by
     * Tab, so the keyboard user would never land on it and never hear the
     * reason it cannot be used.
     */
    expect(archiveButton()).toHaveFocus();
  });
});

describe("the copy", () => {
  it("says the external service was not touched", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    /**
     * The claim this whole ticket turns on. A user who reads "archived" as
     * "deleted from my bank" stops looking for an account that is still open.
     */
    expect(screen.getByText(ARCHIVE_COPY.archivedDescription)).toHaveTextContent(
      /Nothing was deleted from the service itself/i,
    );
  });

  it("says the service left the active list, not that it was removed", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    expect(screen.getByText(ARCHIVE_COPY.archivedDescription)).toHaveTextContent(
      /no longer appears in your active services/i,
    );
  });

  it("never claims Atlas changed anything at the service", () => {
    /**
     * Asserted over the whole copy module rather than the rendered toast: the
     * risk is a future sentence added elsewhere in the file, and checking only
     * what renders today would miss it.
     */
    const everything = Object.values(ARCHIVE_COPY).join(" ");

    expect(everything).not.toMatch(/delete[sd]? (it |them |your |the )?(account|data) from/i);
    expect(everything).not.toMatch(/\b(closed|cancelled|canceled|deactivated) your\b/i);
  });
});

describe("undo", () => {
  it("calls restore with the same asset id", async () => {
    const user = userEvent.setup();
    const { restore } = harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    await user.click(screen.getByRole("button", { name: ARCHIVE_COPY.undo }));

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    const formData = restore.mock.calls[0]?.[1] as FormData;
    expect(formData.get("assetId")).toBe(ASSET);
  });

  it("closes the toast and tells the surface when the restore succeeds", async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    harness({ onRestored });

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    await user.click(screen.getByRole("button", { name: ARCHIVE_COPY.undo }));

    await waitFor(() => expect(toastTitle()).toBeNull());
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("closes the toast on Undo and reports a failure durably in the page", async () => {
    const user = userEvent.setup();
    harness({ restore: failsWith("unavailable") });

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    await user.click(screen.getByRole("button", { name: ARCHIVE_COPY.undo }));

    /**
     * `ToastAction` dismisses on activation — Radix's design, verified by probe
     * — so the toast is gone before the result arrives and cannot report it.
     * The failure therefore has to be durable and in the page, which is also
     * what frontend §19 asks for: "durable status appears in the page".
     */
    await waitFor(() => expect(toastTitle()).toBeNull());

    expect(
      await screen.findByText("Something went wrong. Nothing was changed — please try again."),
    ).toBeVisible();
  });

  it("tells the surface the restore failed, and does not claim it succeeded", async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    const onRestoreFailed = vi.fn();
    harness({ onRestored, onRestoreFailed, restore: failsWith("not_found") });

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);
    await user.click(screen.getByRole("button", { name: ARCHIVE_COPY.undo }));

    /**
     * The surface needs to know, because recovery now lives there: M5 adds a
     * Restore control to an archived service, and that is where the user
     * retries once the toast has gone.
     */
    await waitFor(() => expect(onRestoreFailed).toHaveBeenCalledWith("not_found"));
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("reports the failure with the shared vocabulary, not a toast-only string", async () => {
    const user = userEvent.setup();
    harness({ restore: failsWith("not_found") });

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);
    await user.click(screen.getByRole("button", { name: ARCHIVE_COPY.undo }));

    /** The same sentence a failed status change shows. */
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This service is no longer available. Nothing was changed.",
    );
  });
});

describe("the toast contract", () => {
  it("passes an explicit duration to the toast rather than inheriting one", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    /**
     * Asserted on the value the component actually handed the primitive.
     * Radix's own default is 5s (M1 probe), so inheriting would silently change
     * the undo window the next time the library did — and this toast asks the
     * reader to take in two sentences before deciding.
     */
    expect(toastProps.at(-1)?.duration).toBe(ARCHIVE_TOAST_DURATION_MS);
    expect(ARCHIVE_TOAST_DURATION_MS).toBe(10_000);
  });

  it("lets a surface override the duration", async () => {
    const user = userEvent.setup();
    harness({ duration: 30_000 });

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    expect(toastProps.at(-1)?.duration).toBe(30_000);
  });

  it("gives Undo the descriptive altText Radix requires", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    /**
     * Asserted on what was handed to `ToastAction`, not on the constant — a
     * sabotage run showed that checking the constant passes even when the
     * component sends the bare label instead.
     *
     * `altText` is what a screen-reader user is told when the visual control is
     * out of reach, so it must describe the action rather than repeat the label:
     * "Undo" alone announces a verb with no object.
     */
    const altText = actionProps.at(-1)?.altText;

    expect(altText).toBe(ARCHIVE_COPY.undoAltText);
    expect(altText).not.toBe(ARCHIVE_COPY.undo);
    expect(altText).toMatch(/return this service to your active services/i);
  });

  it("leaves Close operable", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(toastTitle()).toBeNull());
  });
});

describe("accessibility", () => {
  it("does not steal focus when the toast opens", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    /**
     * Verified in the M1 probe and asserted here: a toast that grabbed focus
     * would interrupt whatever the user was doing, and this one appears without
     * being asked for.
     */
    expect(screen.getByRole("button", { name: ARCHIVE_COPY.undo })).not.toHaveFocus();
  });

  it("puts Undo in the tab order, after the toast container", async () => {
    const user = userEvent.setup();
    harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    /**
     * Tabbed to, never focused programmatically: `focus()` succeeds on elements
     * the tab order skips, so it would pass on a control no keyboard user can
     * reach.
     *
     * Two stops, measured rather than guessed. Activating Archive leaves focus
     * on it, so Tab moves to the toast container — which is itself a stop, per
     * the M1 probe — and then to Undo. Pinning the count means a control that
     * quietly left the order, or moved within it, fails here.
     */
    await user.tab();
    await user.tab();

    expect(screen.getByRole("button", { name: ARCHIVE_COPY.undo })).toHaveFocus();
  });

  it("has no axe violations with the toast open", async () => {
    const user = userEvent.setup();
    const { container } = harness();

    await user.click(archiveButton());
    await screen.findByText(ARCHIVE_COPY.archivedTitle);

    expect(await axe(container)).toHaveNoViolations();
  });
});
