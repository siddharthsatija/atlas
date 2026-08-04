import type { ReactNode } from "react";
import Link from "next/link";
import { APP_NAME } from "@/config/app";

/**
 * Layout for the authentication surfaces (ATL-014).
 *
 * Calm and minimal per frontend §16: one column, generous space, no product
 * chrome. The shell (sidebar, top bar) belongs to `(product)` and would be
 * meaningless here — there is nothing to navigate to until the user signs in.
 *
 * It owns the `<main id="main">` landmark that the root layout's skip link
 * targets, since these routes render outside `AppShell`.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <main id="main" className="flex grow items-center justify-center px-4 py-12 sm:px-6">
        <div className="w-full max-w-md">
          <p className="mb-8 text-center text-h3 font-semibold tracking-tight">{APP_NAME}</p>
          {children}
        </div>
      </main>

      {/*
        Privacy and terms links (frontend §16). Placed outside the card so they
        read as standing context rather than a step in the flow.
      */}
      <footer className="pb-10 text-center text-body-sm text-text-secondary">
        <Link href="/privacy" className="rounded-control underline-offset-4 hover:underline">
          Privacy
        </Link>
        <span aria-hidden="true" className="px-2 text-text-muted">
          ·
        </span>
        <Link href="/terms" className="rounded-control underline-offset-4 hover:underline">
          Terms
        </Link>
      </footer>
    </div>
  );
}
