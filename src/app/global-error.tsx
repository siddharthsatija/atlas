"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ErrorFallback } from "@/components/error/error-fallback";
import { reportError } from "@/lib/telemetry/error-reporter";
import { toUserReference } from "@/lib/telemetry/error-report";
import "@/styles/globals.css";

/**
 * Last-resort boundary (ATL-010).
 *
 * Only reached when the root layout itself fails. Next.js replaces the entire
 * document at this point, so this file must render its own `<html>` and `<body>`
 * and import the stylesheet directly — the root layout that normally does both did
 * not survive.
 *
 * Consequences that shape the implementation:
 *
 *   - No providers. The theme provider is gone, so this renders in the default
 *     colour scheme; the tokens still resolve because `globals.css` is imported
 *     here, so nothing falls back to raw colour.
 *   - No router. `usePathname()` requires the router context this boundary sits
 *     outside of, so the location is read from `window` and redacted by the same
 *     route-template function as everywhere else.
 *   - No client-side retry worth trusting. `reset()` re-renders a tree whose root
 *     layout just failed, which usually fails again immediately, so the honest
 *     recovery action is a genuine reload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    reportError({
      error,
      boundary: "global",
      // The router context is unavailable here; `reportError` redacts this to a
      // route template before it is recorded either way.
      pathname: typeof window === "undefined" ? "/" : window.location.pathname,
    });
  }, [error]);

  const reference = toUserReference(error);

  return (
    <html lang="en">
      <body>
        <ErrorFallback
          level="page"
          title="Atlas could not start"
          description="Something went wrong before the application finished loading. Reloading usually resolves it."
          {...(reference ? { reference } : {})}
          onRetry={reset}
          secondaryAction={
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload Atlas
            </Button>
          }
        />
      </body>
    </html>
  );
}
