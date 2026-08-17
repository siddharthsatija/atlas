import { z } from "zod";

/**
 * The draft output schema (ATL-050, AI behavior §7).
 *
 * Exactly the specified shape: `recipient`, `subject`, `body`,
 * `includedFieldKeys`, `assumptions`, `warnings`.
 *
 * ## `includedFieldKeys` is the privacy-critical field
 *
 * It is the model's claim about which personal fields it used. The schema can
 * only check that it is an array of non-empty strings; whether those keys were
 * *approved in this flow* is an invariant check, because approval is per-request
 * state (ADR-002, security §10) that no schema can see. The skill names trusting
 * this field without intersecting it against approved keys as a common mistake,
 * and a superset is a privacy violation rather than a formatting error — so it
 * fails closed with no retry.
 *
 * ## `recipient` is a string, not an email
 *
 * Deliberate. AI behavior §5: in MVP the recipient is user-entered and
 * unverified. Validating it as an email address here would imply a check Atlas
 * has not performed, and services accept postal and web-form recipients too. The
 * invariant layer asserts the model did not invent one instead.
 *
 * ## No draft schema is registered to a prompt yet
 *
 * `draft_request` has no prompt until ATL-059 — the ticket that owns the
 * field-approval flow its wording depends on. The schema exists now because §7
 * specifies it and ATL-050 is the ticket that implements §7; it is validated by
 * fixtures rather than by live output.
 */

export const draftSchema = z.object({
  recipient: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** Field keys the model claims it used. Checked against approvals downstream. */
  includedFieldKeys: z.array(z.string().min(1)),
  assumptions: z.array(z.string().min(1)),
  warnings: z.array(z.string().min(1)),
});

export type DraftOutput = z.infer<typeof draftSchema>;

/** Bumped when the shape changes. Recorded against every interaction (#95). */
export const DRAFT_SCHEMA_VERSION = 1;
