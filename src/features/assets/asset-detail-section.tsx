import { ChevronDownIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One collapsible section of the asset detail page (ATL-034).
 *
 * ## Native `<details>`, and nothing on top of it
 *
 * No state, no `onClick`, no `aria-expanded` written by hand. The browser
 * already gives `<details>`/`<summary>` a button role, expanded state, Enter and
 * Space activation, and find-in-page expansion — and it gives all of it before
 * any JavaScript loads. A custom accordion would reimplement that list and get
 * some of it wrong; the parts it got right would still be unavailable until
 * hydration.
 *
 * These are server components for the same reason: there is nothing to hydrate.
 *
 * ## The initial state is fixed, not responsive
 *
 * `defaultOpen` renders as the plain `open` attribute in the server's HTML. It
 * does not consult a viewport, a media query or a breakpoint hook, so there is
 * one DOM and one disclosure state at every width — which is what makes the
 * markup identical on the server and the client and removes hydration mismatch
 * as a possibility.
 *
 * Responsive CSS may restyle and restack the contents. It may not change what is
 * open, because that would make the semantics depend on a measurement.
 *
 * ## Focus
 *
 * No focus classes here. `src/styles/globals.css` sets a 2px accent outline on
 * `:focus-visible` for every focusable element, and `<summary>` is focusable by
 * default — so the visible focus state is inherited rather than re-declared.
 * `button.tsx` carries no focus classes for the same reason.
 *
 * The default disclosure triangle is hidden (`list-none` plus the WebKit
 * pseudo-element) and replaced with a chevron that rotates when the section
 * opens. That is presentation only: the marker is not what conveys state to
 * assistive technology — the `<details>` element's own expanded state is.
 */
export interface AssetDetailSectionProps {
  /** The section's visible heading, and its accessible name. */
  heading: string;
  /**
   * Whether the section starts expanded.
   *
   * Only Overview passes `true` (frontend §7 order, design system §15's
   * progressive disclosure). Every other section starts collapsed so the page
   * opens on the user's own summary rather than on everything at once.
   */
  defaultOpen?: boolean;
  /** Stable hook for tests and E2E. Never derived from content. */
  slot: string;
  /**
   * Short count or status shown beside the heading, e.g. "3 recorded".
   *
   * Explicitly `| undefined` because `exactOptionalPropertyTypes` is on: callers
   * compute this conditionally, and the alternative is a spread at every call
   * site to avoid passing the key at all.
   */
  meta?: string | undefined;
  children: React.ReactNode;
}

export function AssetDetailSection({
  heading,
  defaultOpen = false,
  slot,
  meta,
  children,
}: AssetDetailSectionProps) {
  return (
    <Card padding="none">
      <details open={defaultOpen} data-slot={slot} className="group">
        <summary
          className={cn(
            "flex cursor-pointer items-center justify-between gap-3 p-4",
            "list-none [&::-webkit-details-marker]:hidden",
          )}
        >
          <span className="flex items-baseline gap-2">
            <h2 className="text-body font-medium text-text-primary">{heading}</h2>
            {meta && <span className="text-body-sm text-text-muted">{meta}</span>}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-text-muted transition-transform group-open:rotate-180"
          />
        </summary>

        <div className="flex flex-col gap-4 px-4 pb-4">{children}</div>
      </details>
    </Card>
  );
}

/**
 * A labelled fact.
 *
 * Renders nothing when the value is absent, which is the whole
 * source-and-last-verified rule in one place: ATL-034 asks for provenance
 * "where available", and the three record types genuinely differ — a data
 * category has a source but no verified date, a permission has a verified date
 * but no source. Printing "Unknown source" or a fabricated date would state
 * something the database does not know.
 */
export function DetailFact({ label, value }: { label: string; value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;

  return (
    <div>
      <dt className="text-body-sm text-text-muted">{label}</dt>
      <dd className="text-body-sm text-text-primary">{value}</dd>
    </div>
  );
}

/** A section with nothing in it yet. Never implies the record never had any. */
export function DetailEmpty({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm text-text-muted">{children}</p>;
}

/**
 * A date, in UTC, as `YYYY-MM-DD`.
 *
 * The precedent the other detail surfaces already set (`finding-detail.tsx:327`,
 * the edit page). **Not** `toLocaleDateString`: these render on the server, so a
 * locale format would use the *server's* timezone and could land a day out, and
 * it would differ between the server render and any later client render.
 */
export const detailDate = (value: string | null): string | null =>
  value === null ? null : value.slice(0, 10);
