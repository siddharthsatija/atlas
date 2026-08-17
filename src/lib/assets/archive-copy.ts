/**
 * Everything Atlas says about archiving and restoring a service (ATL-036).
 *
 * One home, for the reason `fallback-copy.ts` and `assistant-copy.ts` have one:
 * a sentence that appears in a toast, a button and a confirmation must not drift
 * between them.
 *
 * ## The claim these sentences must never make
 *
 * Atlas does not touch the external service. It has no connection to it, no
 * credentials for it, and no way to delete anything from it — archiving changes
 * a row in Atlas and nothing else. A user who reads "archived" as "deleted from
 * my bank" has been misled by us, and would stop looking for an account that is
 * still open. So every string below either says what Atlas did, or says plainly
 * what it did not do; none of them uses "remove", "delete" or "close" without
 * naming Atlas as the only thing affected.
 *
 * ## Why the toast is not the whole story
 *
 * Frontend §19: "Toasts confirm temporary events; durable status appears in the
 * page." The toast below is the *undo affordance*, not the record. The archived
 * status itself is durable and visible on the asset card and the detail page's
 * Overview, both of which already render an `archived` badge — so a user who
 * misses the toast has lost the shortcut, not the information.
 */

/**
 * How long the undo toast stays open, in milliseconds.
 *
 * ## Why 10 seconds, and why it is stated rather than inherited
 *
 * Radix's default is 5 seconds (measured in the ATL-036 M1 probe: present at
 * 5000 ms, gone by 6000 ms). That is enough to notice a confirmation, but this
 * toast asks the reader to take in two sentences — one of which corrects a
 * likely misunderstanding about the external service — and then decide whether
 * to undo. Ten seconds is the smaller of the two risks: a toast that lingers
 * costs a little screen space, and one that vanishes mid-sentence costs the
 * undo.
 *
 * Set explicitly so the value is a decision. Inheriting the default would mean
 * the undo window changed the next time the library did.
 *
 * The M1 probe also showed Radix **pauses** this countdown while the toast has
 * focus, so a keyboard user who has tabbed to Undo is not racing it. That
 * pausing behaviour is jsdom evidence; M6 confirms it in a browser.
 */
export const ARCHIVE_TOAST_DURATION_MS = 10_000;

export const ARCHIVE_COPY = {
  /** The control that archives. Named for the service by its caller. */
  archive: "Archive",
  /** The control that brings an archived service back. */
  restore: "Restore",

  /**
   * Why the control is present but unavailable on an inactive or removed
   * service (ATL-036 M5).
   *
   * `archiveAsset` passes an expected status of `active` to `setStatus`, so on
   * any other status the write matches no row and answers `NOT_FOUND`. A
   * service the user marked `Inactive` on the edit page is therefore in a state
   * where the button would always fail, and offering it would be offering an
   * action Atlas cannot perform.
   *
   * Present and unavailable rather than absent, following the ATL-005 pattern
   * the header and card already use: the control keeps its place in the layout
   * and the tab order, and says why.
   */
  archiveUnavailableReason: "Only active services can be archived.",

  /**
   * The toast's heading after a successful archive.
   *
   * States what happened to the record in Atlas, in Atlas's own terms.
   */
  archivedTitle: "Archived in Atlas",

  /**
   * The toast's body — the two facts a user needs and one they might assume.
   *
   * First sentence: what changed, and where. Second: what did *not* change, said
   * without hedging, because the whole point is to correct an assumption the
   * word "archive" invites.
   */
  archivedDescription:
    "This service no longer appears in your active services. Nothing was deleted from the service itself — Atlas only changed its own record.",

  /** The undo control inside the toast. */
  undo: "Undo",

  /**
   * `altText` for the toast's action, which Radix requires.
   *
   * It is what a screen-reader user is told when the visual button is not
   * reachable, so it has to describe the action rather than repeat the label —
   * "Undo" alone would announce a verb with no object.
   */
  undoAltText: "Undo archiving and return this service to your active services",

  /** Shown in the toast once the undo succeeded, before it closes. */
  restoredTitle: "Restored to your active services",

  /**
   * The durable explanation, for a surface showing an archived service.
   *
   * Not a toast: this is the sentence that has to still be there tomorrow, on
   * the detail page of a service the user archived last week.
   */
  archivedExplanation:
    "Archived services are hidden from your active services in Atlas. Archiving does not delete anything from the service itself. Restore returns it to your active services.",
} as const;
