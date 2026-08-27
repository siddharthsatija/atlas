/**
 * Step 1 of the request flow (ATL-058).
 *
 * The dialog is the only component a route needs; the rest are its parts and are
 * exported for tests rather than for other features to compose. `index.ts` is the
 * feature's public surface, and the ESLint `no-restricted-imports` rule stops
 * another feature reaching past it into these files.
 */
export { RequestReviewDialog, type RequestReviewDialogProps } from "./request-review-dialog";
export { RequestEvidence, type RequestEvidenceProps } from "./request-evidence";
export { RequestFieldChecklist, type RequestFieldChecklistProps } from "./request-field-checklist";
export { RequestRecipient, type RequestRecipientProps } from "./request-recipient";
export { REQUEST_REVIEW_COPY, type RequestReviewCopy } from "./request-review-copy";

/**
 * The view model, exported because the route has to build one — the same reason
 * `personal-fields/index.ts` publishes its own.
 */
export type {
  RequestReviewData,
  RequestReviewFailure,
  RequestReviewFormState,
  CreateDraftAction,
  FieldCaptureAction,
  FieldCaptureState,
  SelectableField,
  EvidenceItem,
} from "./request-review-view";

export { INITIAL_REVIEW_STATE, INITIAL_CAPTURE_STATE } from "./request-review-view";
