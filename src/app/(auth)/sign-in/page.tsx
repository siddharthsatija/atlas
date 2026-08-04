import type { Metadata } from "next";
import { env } from "@/config/env";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SIGN_IN_PURPOSE, SIGN_IN_REASON_MESSAGES, parseSignInReason } from "@/lib/auth/auth-copy";
import { RETURN_PATH_PARAM, toSafeReturnPath } from "@/lib/auth/return-path";
import { SignInForm } from "./sign-in-form";

/**
 * Sign-in screen (ATL-014).
 *
 * A Server Component: it reads and validates the URL parameters before anything
 * renders, so neither the `reason` code nor the `next` path reaches the client
 * unvalidated.
 *
 * The reason banner covers the redirects the rest of the system already produces —
 * an expired link (ATL-011), and the idle and absolute session limits (ATL-013).
 * Until this screen existed those redirects landed on a 404.
 */

export const metadata: Metadata = { title: "Sign in" };

/** Reads the session cookie is ATL-012's job; this route is deliberately public. */
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Both parameters are untrusted input. `parseSignInReason` accepts only the
  // closed vocabulary, and `toSafeReturnPath` only a known product section — so
  // neither can put arbitrary text on the page or a foreign origin in a redirect.
  const reason = parseSignInReason(firstValue(params.reason));
  const returnPath = toSafeReturnPath(firstValue(params[RETURN_PATH_PARAM]));

  const reasonMessage = reason ? SIGN_IN_REASON_MESSAGES[reason] : null;

  return (
    <div className="flex flex-col gap-6">
      {reasonMessage && (
        /**
         * `role="status"` rather than `alert`: the page has just loaded, so the
         * heading below is what a screen reader reaches first, and an assertive
         * interruption on arrival is disorienting. None of these reasons is an
         * emergency — each is followed by the form that resolves it.
         */
        <div
          role="status"
          data-slot="sign-in-reason"
          data-reason={reason}
          className={cn(
            "flex flex-col gap-1 rounded-card border px-4 py-3",
            reasonMessage.tone === "warning"
              ? "border-warning/40 bg-warning/10"
              : "border-border-default bg-surface-subtle",
          )}
        >
          <p className="text-body-sm font-medium">{reasonMessage.title}</p>
          <p className="text-body-sm text-text-secondary">{reasonMessage.description}</p>
        </div>
      )}

      <Card padding="prominent" radius="panel" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-h2 font-semibold">Sign in to Atlas</h1>
          <p className="text-body-sm text-text-secondary">{SIGN_IN_PURPOSE}</p>
        </div>

        <SignInForm
          returnPath={returnPath ?? undefined}
          googleEnabled={Boolean(env.ATLAS_GOOGLE_CLIENT_ID)}
        />
      </Card>
    </div>
  );
}

/** A repeated query parameter arrives as an array; take the first occurrence. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
