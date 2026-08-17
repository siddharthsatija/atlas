import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The shared frame around a chart (design system §16, ATL-047).
 *
 * §16 lists `ChartContainer` among the required reusable components, and §13
 * says what a chart owes its reader: a heading, summary text, and labelled
 * units. This provides the first two and the layout; the units belong to
 * whatever is drawn inside it.
 *
 * ## Deliberately small
 *
 * It holds no data, no scales, no geometry and no knowledge of what is being
 * charted. Everything score-specific lives in `features/score`, and anything
 * genuinely general — axes, legends, tooltips — is left unbuilt rather than
 * guessed at from a sample of one. A second chart will show which parts are
 * shared; inventing them now would be designing for a caller that does not
 * exist.
 *
 * ## What it is actually for: the accessible relationship
 *
 * The one thing worth centralising is the association between a visual and its
 * text alternative. Frontend §20 requires text alternatives for charts, and the
 * mistake it prevents is subtle — a summary rendered *near* a chart is not
 * connected to it. Here the summary is a real element with a generated id, the
 * region is `aria-describedby` that id, and the heading names the region. A
 * chart whose visual is `aria-hidden` therefore still has its meaning reachable,
 * because the description carries it.
 *
 * ## No motion
 *
 * Nothing here animates, transitions or transforms. ATL-047's criterion is that
 * reduced motion is respected, and the smallest honest way to respect it is to
 * introduce none — the global `prefers-reduced-motion` rule in `globals.css`
 * then has nothing to suppress. Adding an entrance animation so it could be
 * disabled would be motion invented for the sake of turning it off.
 */

export interface ChartContainerProps {
  /** A stable id prefix, so the heading and description can be referenced. */
  id: string;
  title: string;
  /**
   * The chart's text alternative — not a caption.
   *
   * This is what a screen-reader user receives *instead of* the graphic, so it
   * has to be sufficient on its own. It is rendered visibly as well: a sentence
   * good enough to replace the chart is worth showing to everybody.
   */
  summary: ReactNode;
  /** The visual itself. Expected to be `aria-hidden` when the summary suffices. */
  children: ReactNode;
  className?: string;
}

export function ChartContainer({ id, title, summary, children, className }: ChartContainerProps) {
  const headingId = `${id}-title`;
  const summaryId = `${id}-summary`;

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={summaryId}
      data-slot="chart-container"
      className={cn("flex flex-col gap-3", className)}
    >
      <h2 id={headingId} className="text-heading-md text-text-primary">
        {title}
      </h2>

      <p id={summaryId} data-slot="chart-summary" className="text-body-sm text-text-secondary">
        {summary}
      </p>

      {/*
        The visual sits in its own box so a chart can size itself against a
        predictable container rather than against whatever the page happens to
        give it. `w-full` and no fixed height: the child decides its own aspect
        ratio, which is what lets an SVG scale down to 320px without JavaScript.
      */}
      <div data-slot="chart-figure" className="w-full">
        {children}
      </div>
    </section>
  );
}
