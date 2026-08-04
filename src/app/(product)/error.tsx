"use client";

import { RouteError } from "@/components/error/route-error";

/**
 * Route-level error boundary for every authenticated product surface (ATL-010).
 *
 * It is placed inside the `(product)` group rather than at the app root on
 * purpose. A boundary catches errors from the segments *below* it, so this one
 * renders inside `ProductLayout` — the sidebar and top bar stay mounted and the
 * user keeps full navigation while a single view is broken, which is the ticket's
 * "calm recovery page preserving navigation".
 *
 * Errors thrown by `ProductLayout` itself escape upward to `src/app/error.tsx`,
 * and errors in the root layout escape to `src/app/global-error.tsx`.
 */
export default function ProductError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} homeHref="/overview" homeLabel="Go to Overview" />;
}
