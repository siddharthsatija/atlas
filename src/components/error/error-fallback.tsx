"use client";

import * as React from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The single presentational surface for every caught error (ATL-010).
 *
 * Route boundaries, the global boundary, and component boundaries all render this,
 * so the recovery experience cannot drift between them and there is exactly one
 * place to audit for leakage.
 *
 * What it will not render, by construction: there is no prop that accepts an
 * `Error`. Callers pass a `reference` (the validated Next.js digest — an opaque
 * hash) and nothing else. A message or stack cannot reach this component even by
 * mistake, which is the property `src/test/repo-guards.test.ts` asserts.
 *
 * Tone follows frontend §23: calm, direct, nonjudgmental, and honest about what we
 * do and do not know. It does not claim the user's data is safe — a render failure
 * cannot prove anything about what a preceding server action did — and it does not
 * dramatise. Danger styling is deliberately absent: design system §2 reserves
 * `danger` for destructive actions and verified critical risk, and a view that
 * failed to render is neither.
 */

export type ErrorFallbackLevel = "page" | "section";

export interface ErrorFallbackProps {
  level: ErrorFallbackLevel;
  title?: string;
  description?: string;
  /** Opaque support reference (validated digest). Never an error message. */
  reference?: string;
  /** Re-renders the failed subtree in place. Absent when no safe retry exists. */
  onRetry?: () => void;
  /** Retry in flight — the button shows its loading state and blocks re-entry. */
  retrying?: boolean;
  /** Rendered after the retry action, e.g. a link back to a known-good route. */
  secondaryAction?: React.ReactNode;
  className?: string;
}

const DEFAULT_COPY: Record<ErrorFallbackLevel, { title: string; description: string }> = {
  page: {
    title: "This page could not be displayed",
    description:
      "Something went wrong while loading this view. You can try again — the rest of Atlas is still available from the navigation.",
  },
  section: {
    title: "This section could not be displayed",
    description: "The rest of this page is unaffected. You can try loading it again.",
  },
};

function ErrorFallback({
  level,
  title,
  description,
  reference,
  onRetry,
  retrying = false,
  secondaryAction,
  className,
}: ErrorFallbackProps) {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const isPage = level === "page";
  const copy = DEFAULT_COPY[level];

  /**
   * Page-level failures replace the content the user navigated to, so focus is
   * moved to the heading — the same focus management frontend §20 requires for
   * route transitions. Without it, keyboard and screen-reader users are left with
   * focus on a control in a region that no longer exists.
   *
   * Section-level failures deliberately do NOT steal focus: the user may be working
   * elsewhere on a page that is still perfectly usable. They announce politely via
   * `role="alert"` instead.
   */
  React.useEffect(() => {
    if (isPage) headingRef.current?.focus();
  }, [isPage]);

  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center rounded-full bg-surface-subtle text-text-muted",
          isPage ? "size-12" : "size-9",
        )}
      >
        <TriangleAlertIcon className={isPage ? "size-6" : "size-4"} />
      </span>

      <div className="flex flex-col gap-1">
        {isPage ? (
          <h1
            ref={headingRef}
            tabIndex={-1}
            data-slot="error-title"
            className="text-h2 font-semibold outline-none"
          >
            {title ?? copy.title}
          </h1>
        ) : (
          <h3 data-slot="error-title" className="text-body font-medium">
            {title ?? copy.title}
          </h3>
        )}

        <p data-slot="error-description" className="max-w-prose text-body-sm text-text-secondary">
          {description ?? copy.description}
        </p>
      </div>

      {(onRetry ?? secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button
              type="button"
              variant={isPage ? "primary" : "secondary"}
              size={isPage ? "md" : "sm"}
              onClick={onRetry}
              loading={retrying}
            >
              Try again
            </Button>
          )}
          {secondaryAction}
        </div>
      )}

      {reference && (
        /**
         * The only identifier a user ever sees. It is Next.js's server-side digest:
         * a hash of the original message, not the message itself, so quoting it to
         * support discloses nothing about the account (architecture §16).
         */
        <p data-slot="error-reference" className="text-caption text-text-muted">
          Reference:{" "}
          <code data-testid="error-reference-code" className="font-mono">
            {reference}
          </code>
        </p>
      )}
    </>
  );

  return (
    <div
      data-slot="error-fallback"
      data-level={level}
      // Page-level moves focus (announcing the heading), so an additional live
      // region would double-announce. Section-level does not move focus and needs
      // the announcement.
      {...(isPage ? {} : { role: "alert" })}
      className={cn(
        "flex flex-col items-center text-center",
        isPage
          ? "mx-auto max-w-lg gap-4 px-6 py-20"
          : "gap-3 rounded-card border border-border-default bg-surface px-6 py-10",
        className,
      )}
    >
      {body}
    </div>
  );
}

export { ErrorFallback };
