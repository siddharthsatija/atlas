import type { ReactNode } from "react";
import { APP_NAME } from "@/config/app";
import { requireVerifiedUser } from "@/server/auth/require-user";

/**
 * Layout for the onboarding flow (ATL-016).
 *
 * **Route protection.** The session is verified here, on the server, before
 * anything else renders — the same rule `(product)/layout.tsx` follows, and for
 * a sharper reason: `src/middleware.ts` derives its protected paths from
 * `NAV_ORDER` (ATL-012), and onboarding is deliberately *not* navigation. The
 * middleware therefore does not cover this route, so this check is not a second
 * line of defence here — it is the only one.
 *
 * ATL-012's `PROTECTED_SEGMENTS` was left alone on purpose. Its comment explains
 * that protection derives from navigation so a hand-maintained list cannot
 * drift; adding a non-navigation segment to `NAV_ORDER` to borrow its protection
 * would put onboarding in the sidebar.
 *
 * Visually this follows the auth surfaces (frontend §16): one column, no product
 * chrome. A sidebar offering seven destinations would undercut a flow whose
 * entire job is to get the user to one of them.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  // Throws a redirect when unauthenticated: nothing below runs, so no markup
  // reaches an unauthenticated visitor to flash.
  await requireVerifiedUser();

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* Owns the `<main id="main">` landmark the root layout's skip link
          targets, since these routes render outside `AppShell`. */}
      <main id="main" className="flex grow items-start justify-center px-4 py-10 sm:px-6 sm:py-16">
        <div className="w-full max-w-xl">
          <p className="mb-8 text-center text-h3 font-semibold tracking-tight">{APP_NAME}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
