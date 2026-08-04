"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorFallback } from "./error-fallback";
import { reportError } from "@/lib/telemetry/error-reporter";
import { toUserReference } from "@/lib/telemetry/error-report";

/**
 * Shared body for every route-level `error.tsx` (ATL-010).
 *
 * Next.js requires one `error.tsx` file per segment, each receiving `{ error,
 * reset }`. Without a shared component the reporting and redaction rules would be
 * copy-pasted per segment and would drift — and the one place drift is expensive
 * is the code deciding what is safe to record.
 *
 * `reset()` re-renders the failed segment in place. That is the "restores state
 * without full reload" criterion: the layout above the boundary is untouched, so
 * in `(product)` the sidebar, top bar, scroll position, and theme all survive, and
 * the user is not thrown back to a cold start. It is wrapped in a transition so
 * the retry has a real pending state rather than appearing to do nothing while the
 * segment re-renders.
 */

export interface RouteErrorProps {
  /** Next.js passes the client-safe error object; `digest` is present for server errors. */
  error: Error & { digest?: string };
  reset: () => void;
  /** Route the user can fall back to when retrying does not help. */
  homeHref: string;
  homeLabel: string;
  title?: string;
  description?: string;
}

export function RouteError({
  error,
  reset,
  homeHref,
  homeLabel,
  title,
  description,
}: RouteErrorProps) {
  const pathname = usePathname();
  const [isRetrying, startTransition] = React.useTransition();

  // Reported once per distinct error. `pathname` is redacted to a route template
  // inside the reporter — it is never recorded as given, because a concrete path
  // can carry a record identifier.
  React.useEffect(() => {
    reportError({ error, boundary: "route", pathname: pathname ?? "/" });
  }, [error, pathname]);

  const reference = toUserReference(error);

  return (
    <ErrorFallback
      level="page"
      {...(title ? { title } : {})}
      {...(description ? { description } : {})}
      {...(reference ? { reference } : {})}
      retrying={isRetrying}
      onRetry={() => {
        startTransition(() => {
          reset();
        });
      }}
      secondaryAction={
        <Button asChild variant="secondary">
          <Link href={homeHref}>{homeLabel}</Link>
        </Button>
      }
    />
  );
}
