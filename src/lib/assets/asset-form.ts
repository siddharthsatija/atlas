import { z } from "zod";
import { isAssetCategory } from "./categories";
import { MAX_NOTES_LENGTH, MAX_SERVICE_NAME_LENGTH, SERVICE_DOMAIN_PATTERN } from "./asset-fields";

/**
 * The create-asset form contract (ATL-032, frontend §6).
 *
 * **One schema, both sides.** ATL-032's criterion is "Zod validation client- and
 * server-side", and this is that schema — imported by the client form for
 * immediate feedback and by the Server Action for the check that actually
 * matters. Two schemas would drift, and the way that failure presents is the
 * worst kind: the form says a value is fine and the server silently disagrees.
 *
 * Client-side validation here is a convenience, never a control. The Server
 * Action re-parses the same payload because a form is not a trustworthy source
 * (architecture §10: "Validate every input with Zod").
 *
 * ## Bounds mirror the database
 *
 * `MAX_SERVICE_NAME_LENGTH`, `SERVICE_DOMAIN_PATTERN`, and `MAX_NOTES_LENGTH`
 * come from `asset-fields.ts`, which mirrors ATL-027's check constraints. Stating
 * them once means a value the form accepts cannot be one the database rejects —
 * which would surface to the user as an unexplained failure after they had
 * already filled the form in.
 *
 * ## Scope
 *
 * Asset fields only. ATL-032's objective also names data categories and
 * permissions; creating those alongside the asset is a multi-record write, and
 * CLAUDE.md requires a transaction for that while PostgREST cannot open one. They
 * are therefore added through **ATL-033**, whose objective already covers
 * "data categories, permissions".
 */

/** Field-level messages. Calm, specific, and safe to display (architecture §10). */
const MESSAGES = {
  serviceName: "Enter the name of the service.",
  serviceNameLong: `Use ${String(MAX_SERVICE_NAME_LENGTH)} characters or fewer.`,
  category: "Choose the kind of service this is.",
  domain: "Enter a domain like example.com, without https:// or a path.",
  notesLong: `Use ${String(MAX_NOTES_LENGTH)} characters or fewer.`,
  identifierLong: "Use 200 characters or fewer.",
} as const;

/**
 * The account identifier's bound.
 *
 * Not in `asset-fields.ts` because the column has no length check — it stores
 * ciphertext, which is longer than its plaintext and of a size the application
 * controls. The limit exists so a caller cannot ask the crypto module to seal an
 * unbounded string.
 */
export const MAX_ACCOUNT_IDENTIFIER_LENGTH = 200;

/**
 * An optional text field, however it arrives.
 *
 * Two shapes have to be handled, and missing the second is easy: a **form**
 * sends an untouched input as `""`, while a **direct caller** — a test, or any
 * future API — simply omits the key. Both must mean "not provided". Accepting
 * only the first would make the schema pass for every real submission and fail
 * for every programmatic one, which is the sort of gap that surfaces long after
 * it is introduced.
 *
 * So the input accepts `string | undefined`, normalises blank to `undefined`,
 * and the whole field is optional on the object.
 */
const optionalText = <T extends z.ZodType<string, string>>(schema: T) =>
  z
    .union([z.string(), z.undefined()])
    .transform((value) => {
      const trimmed = (value ?? "").trim();
      return trimmed === "" ? undefined : trimmed;
    })
    .pipe(schema.optional())
    .optional();

export const createAssetFormSchema = z.object({
  serviceName: z
    .string()
    .trim()
    .min(1, MESSAGES.serviceName)
    .max(MAX_SERVICE_NAME_LENGTH, MESSAGES.serviceNameLong),

  category: z.string().refine(isAssetCategory, MESSAGES.category),

  /**
   * Lowercased before validation.
   *
   * People type "Spotify.com"; the column's check constraint is lowercase-only.
   * Rejecting the capital would be technically correct and unhelpful — the user
   * meant the right thing, and the fix is mechanical.
   */
  serviceDomain: optionalText(
    z
      .string()
      .transform((value) => value.toLowerCase())
      .pipe(z.string().regex(SERVICE_DOMAIN_PATTERN, MESSAGES.domain)),
  ),

  /**
   * Restricted (security §3). Optional — ATL-032's objective says "optional
   * identifier", and someone can record that they hold a Spotify account without
   * telling Atlas which one.
   *
   * Never logged, never echoed into an error message, and encrypted before it
   * reaches storage (ADR-003, ATL-027).
   */
  accountIdentifier: optionalText(
    z.string().max(MAX_ACCOUNT_IDENTIFIER_LENGTH, MESSAGES.identifierLong),
  ),

  notes: optionalText(z.string().max(MAX_NOTES_LENGTH, MESSAGES.notesLong)),
});

export type CreateAssetFormValues = z.infer<typeof createAssetFormSchema>;

/** Field-keyed errors, the shape the form renders directly. */
export type CreateAssetFieldErrors = Partial<Record<keyof CreateAssetFormValues, string>>;

export interface CreateAssetParseResult {
  success: boolean;
  values?: CreateAssetFormValues;
  errors: CreateAssetFieldErrors;
}

/**
 * Parses form input, returning field-keyed errors rather than throwing.
 *
 * One message per field, not a list: a field showing three simultaneous
 * complaints is harder to act on than the first one, and the user will see the
 * next after fixing this one.
 */
export function parseCreateAssetForm(input: unknown): CreateAssetParseResult {
  const result = createAssetFormSchema.safeParse(input);

  if (result.success) return { success: true, values: result.data, errors: {} };

  const errors: CreateAssetFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in errors)) {
      errors[field as keyof CreateAssetFormValues] = issue.message;
    }
  }

  return { success: false, errors };
}

/**
 * Reads the form's fields out of `FormData`.
 *
 * Separate from parsing so the same extraction serves validation *and* the
 * re-render that preserves what the user typed. ATL-032 requires the form to
 * survive a recoverable error, and it cannot do that if the only thing kept
 * after a failure is the error list.
 *
 * **The account identifier is deliberately absent** from what is preserved —
 * see `preservedValues`.
 */
export function readCreateAssetForm(formData: FormData): Record<string, string> {
  const read = (name: string): string => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };

  return {
    serviceName: read("serviceName"),
    category: read("category"),
    serviceDomain: read("serviceDomain"),
    accountIdentifier: read("accountIdentifier"),
    notes: read("notes"),
  };
}

/** What the form re-renders with after a recoverable failure. */
export type PreservedAssetValues = Omit<Record<string, string>, "accountIdentifier">;

/**
 * Everything the user typed except the account identifier.
 *
 * The identifier is Restricted, and returning it from a Server Action would put
 * it back into the response payload and the React tree on every failed attempt —
 * a value the architecture works hard to keep encrypted at rest and masked on
 * screen. Retyping one field is a small cost; the alternative is a restricted
 * value making a round trip for every typo elsewhere in the form.
 */
export function preservedValues(fields: Record<string, string>): PreservedAssetValues {
  const { accountIdentifier: _identifier, ...preserved } = fields;
  return preserved;
}
