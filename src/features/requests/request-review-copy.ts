import { UNVERIFIED_RECIPIENT_NOTICE } from "@/lib/requests/request-draft";

/**
 * Copy for Step 1 of the request flow (ATL-058, frontend §10).
 *
 * Held in one module rather than inline, for the reason `personal-fields-copy.ts`
 * gives: several sentences here make promises Atlas has to keep, and a promise
 * scattered through JSX can be softened in one place and still pass.
 *
 * ## The three claims that must stay exactly this honest
 *
 * 1. **Atlas does not verify the recipient.** FR-08 requires the address to be
 *    "clearly marked unverified" — there is no service directory until Phase 2.
 *    The sentence is imported from `request-draft.ts` rather than restated, so
 *    Step 1 and ATL-060's Step 2 cannot word it differently.
 * 2. **Atlas does not send anything.** Security §11 and frontend §9: "No control
 *    may imply Atlas sent the request unless it actually did." Step 1 prepares a
 *    draft and nothing more, and the copy says so before the person commits.
 * 3. **Nothing is included unless it is ticked.** FR-08 and ADR-002 make every
 *    field optional and unchecked by default, and the copy states that rather
 *    than leaving it to be inferred from the boxes.
 */

export interface RequestReviewCopy {
  title: string;
  description: string;

  evidenceTitle: string;
  evidenceEmpty: string;
  uncertainTitle: string;
  uncertainBody: string;

  fieldsTitle: string;
  fieldsDescription: string;
  fieldsEmpty: string;
  /** Shown when a key has more than one stored field (D1). */
  hiddenAlternatives: string;

  addFieldTitle: string;
  addFieldDescription: string;
  addFieldToggle: string;
  addFieldCancel: string;

  recipientLabel: string;
  recipientHint: string;
  recipientUnverified: string;

  submit: string;
  cancel: string;
  draftOnlyNotice: string;

  failureInvalidRecipient: string;
  failureMissingRecipient: string;
  failureUnavailable: string;
  failureNotFound: string;
}

export const REQUEST_REVIEW_COPY: RequestReviewCopy = {
  title: "Request deletion",
  description:
    "Review what this service is believed to hold, choose what to include about yourself, and confirm where the request should go.",

  evidenceTitle: "What this service is believed to hold",
  evidenceEmpty:
    "No categories of data are recorded for this service. You can still send a request; it will simply ask what they hold.",

  /**
   * The warning D5 defines: any low confidence, on the service or a category.
   * Worded as a prompt to check rather than a claim that something is wrong —
   * Atlas derived this from what the person recorded, and says so.
   */
  uncertainTitle: "Some of this is uncertain",
  uncertainBody:
    "Atlas is not confident about part of what is listed above — it comes from older or less certain information. Check it before you send, and edit the service if anything is wrong.",

  fieldsTitle: "What to include about you",
  fieldsDescription:
    "Nothing is included unless you tick it. Services usually need at least one way to identify your account.",
  fieldsEmpty:
    "You have not saved any personal details yet. You can add one now, or send the request without any.",
  hiddenAlternatives:
    "You have more than one saved detail of this kind. The most recently updated one is offered here; the others stay in Settings.",

  addFieldTitle: "Add a detail",
  addFieldDescription:
    "Saved to your encrypted vault so you can reuse it. Atlas asks for these only when a request needs them.",
  addFieldToggle: "Add a detail",
  addFieldCancel: "Cancel",

  recipientLabel: "Send to",
  recipientHint:
    "The privacy or support address for this service. You can usually find it on their privacy page.",
  recipientUnverified: UNVERIFIED_RECIPIENT_NOTICE,

  submit: "Continue to the draft",
  cancel: "Cancel",
  /**
   * Said before the person commits, not after. Step 1 creates a draft; nothing
   * is sent, and Atlas will never send it — the person does (security §11).
   */
  draftOnlyNotice:
    "This prepares a draft for you to review. Atlas never sends anything — you send it yourself.",

  failureMissingRecipient: "Enter the address this request should go to.",
  failureInvalidRecipient: "That does not look like an email address. Check it and try again.",
  failureNotFound: "That service is no longer here. Nothing was prepared.",
  failureUnavailable: "Atlas could not prepare this just now. Nothing changed — please try again.",
};
