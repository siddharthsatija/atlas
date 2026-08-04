"use client";

import { RouteError } from "@/components/error/route-error";

/**
 * Root-segment error boundary (ATL-010).
 *
 * Catches errors from routes that sit outside the product shell — the foundation
 * page today, and the `(public)` and `(auth)` surfaces as they land — plus errors
 * thrown by the `(product)` layout itself, which are above that group's own
 * boundary.
 *
 * There is no navigation to preserve at this level, so the recovery affordance is
 * a retry plus a link home rather than a shell.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} homeHref="/" homeLabel="Go to the start page" />;
}
