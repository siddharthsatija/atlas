import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SeverityBadge } from "@/components/ui/severity-badge";
import {
  FINDING_TYPES,
  type FindingConfidence,
  type FindingSeverity,
} from "@/lib/findings/findings";

/**
 * One finding, as a card (ATL-040, frontend §8).
 *
 * §8 names nine things a finding card carries: severity, title, explanation,
 * evidence summary, source, confidence, impacted asset, recommended action, and
 * the "Ask Atlas" explanation, followed by resolve or dismiss. All nine are
 * here; the last three are present and visibly unavailable, below.
 *
 * ## Severity styling
 *
 * `SeverityBadge` unchanged, which is the design system's mapping and always
 * carries a text label — severity is never colour alone (§2, and the acceptance
 * criterion says so directly).
 *
 * §8 also reserves critical styling for "genuinely critical, **verified**
 * findings", and the design system reserves danger for "verified critical
 * risk". Nothing in the data model records whether a finding is verified, and
 * the product decision (OQ-11) is that verification will be modelled explicitly
 * rather than derived from confidence or `source_type`. So this card applies the
 * existing severity styling only and adds no extra emphasis of its own; the
 * stricter rule lands with the verification model.
 *
 * ## Actions exist but do not work yet
 *
 * Resolve is ATL-042, which requires the user to select or confirm the action
 * taken; dismiss is ATL-043, which captures an optional reason and offers undo;
 * "Ask Atlas" is ATL-053's panel. `FindingService.resolveFinding` and
 * `dismissFinding` already work, but shipping either button here would let
 * someone close a finding without the confirmation, the reason, or the undo that
 * their own tickets exist to provide. Following ATL-005 and ATL-031: the control
 * exists, is announced, and is visibly unavailable — honest about what the
 * product can do today, and each later ticket removes one `disabled` rather than
 * redesigning the card.
 */

/** What the card needs — a subset of `FindingView`, so it cannot read more. */
export interface FindingSummary {
  id: string;
  findingType: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  sourceType: string;
  sourceReference: string | null;
  evidenceSummary: string;
  recommendedAction: string;
  /** Resolved by `FindingService`; never an id, and never looked up here. */
  impactedAsset: string;
  status: string;
}

/**
 * Typed `string → string` rather than inferred from the tuple: `finding_type` is
 * a text column whose vocabulary lives in the application (§7.2), so a row can
 * legitimately carry a value this build does not know. The lookup falls back to
 * the raw value instead of failing to compile against a narrower key type.
 */
const TYPE_LABELS = new Map<string, string>(FINDING_TYPES.map((entry) => [entry.id, entry.label]));

/** §11.1's three-value scale, spelled for a reader rather than a database. */
const CONFIDENCE_LABELS: Record<FindingConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/**
 * Where the finding came from, in words.
 *
 * `source_reference` is `rule_id@version` (ATL-101), which is provenance a user
 * can quote back but not a sentence. §8 requires the source to be shown; ATL-041
 * owns explaining the rule itself, so this states the origin and stops there.
 *
 * Demo findings say so first. Demo records must be clearly marked wherever they
 * render (§8, ATL-018), and a fabricated finding presented as a real one is the
 * single most misleading thing this page could do.
 */
function sourceLabel(sourceType: string, sourceReference: string | null): string {
  if (sourceType === "demo") return "Sample data";
  if (sourceType === "user") return "Your own entry";
  return sourceReference ? `Atlas rule ${sourceReference}` : "Atlas analysis";
}

/** The three §8 affordances ATL-040 does not own, each with the ticket that does. */
const CARD_ACTIONS = [
  { key: "resolve", label: "Resolve", enabledBy: "ATL-042" },
  { key: "dismiss", label: "Dismiss", enabledBy: "ATL-043" },
  { key: "ask-atlas", label: "Ask Atlas", enabledBy: "ATL-053" },
] as const;

export interface FindingCardProps {
  finding: FindingSummary;
  /**
   * Where "View details" points (ATL-041), or undefined to omit the control.
   *
   * Supplied by the route rather than built here: the href must preserve the
   * current view and any other query state, and only the page knows that.
   */
  detailHref?: string;
}

export function FindingCard({ finding, detailHref }: FindingCardProps) {
  const typeLabel = TYPE_LABELS.get(finding.findingType) ?? finding.findingType;

  return (
    <Card data-slot="finding-card" data-finding-id={finding.id} data-severity={finding.severity}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <Badge tone="neutral">{typeLabel}</Badge>
          <Badge tone="neutral" data-slot="finding-confidence">
            {CONFIDENCE_LABELS[finding.confidence]}
          </Badge>
          {finding.sourceType === "demo" && <Badge tone="accent">Demo</Badge>}
        </div>
        {/*
          An h3, not an h2: the page owns its single h1 and the view's region
          heading is the h2 (frontend §20, one h1 per page).
        */}
        {/*
          `break-words` because the title embeds a service name the user typed.
          A name with no spaces — a long domain, say — is a single unbreakable
          token that would otherwise widen the card past the viewport (RC-1).
        */}
        <h3 className="text-body font-medium break-words text-text-primary">{finding.title}</h3>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <p data-slot="finding-description" className="max-w-prose text-body-sm text-text-secondary">
          {finding.description}
        </p>

        {/*
          A description list, because these are labelled facts rather than
          prose. The labels are visible: §8 asks the card to show source and
          confidence, and a value with no label is only readable by someone who
          already knows the layout.
        */}
        {/*
          `min-w-0` on the values: a grid item defaults to `min-width: auto`,
          which refuses to shrink below its longest unbreakable token, and an
          asset name is exactly that. Without it the second column widens the
          grid and the card with it (RC-1).
        */}
        <dl className="grid gap-x-6 gap-y-2 text-body-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-text-muted">Evidence</dt>
          <dd data-slot="finding-evidence" className="min-w-0 break-words text-text-secondary">
            {finding.evidenceSummary}
          </dd>

          <dt className="text-text-muted">Impacted asset</dt>
          <dd
            data-slot="finding-impacted-asset"
            className="min-w-0 break-words text-text-secondary"
          >
            {finding.impactedAsset}
          </dd>

          <dt className="text-text-muted">Source</dt>
          <dd data-slot="finding-source" className="min-w-0 break-words text-text-secondary">
            {sourceLabel(finding.sourceType, finding.sourceReference)}
          </dd>
        </dl>

        <div className="rounded-card border border-border-default bg-surface-subtle p-3">
          <p className="text-label font-medium text-text-primary">Recommended action</p>
          <p data-slot="finding-recommended-action" className="text-body-sm text-text-secondary">
            {finding.recommendedAction}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {detailHref && (
            /*
              The entry point to ATL-041's panel. A real link, so it is
              keyboard reachable, middle-clickable and shareable — the panel is
              URL state, not component state.
            */
            <Button asChild variant="secondary">
              {/*
                The visible label is short; the finding's title lives in
                `aria-label` instead (RC-1).

                It used to be rendered as visible text — `View details: {title}`
                — which put an unbounded, user-derived string inside a control
                that `button.tsx` styles `shrink-0 whitespace-nowrap`. The button
                therefore could not wrap or shrink, and a real R-003 title
                ("{service} holds more sensitive information") produced a control
                ~600px wide. At 320px that overflowed the document by 376px,
                measured.

                The accessible name is unchanged: `getByRole` reads `aria-label`,
                so a screen-reader user still hears which finding the link opens,
                and this is the pattern the sibling actions below already use.
              */}
              <Link
                href={detailHref}
                data-slot="finding-details-link"
                aria-label={`View details: ${finding.title}`}
              >
                View details
              </Link>
            </Button>
          )}
          {CARD_ACTIONS.map((action) => (
            <Button
              key={action.key}
              variant={action.key === "resolve" ? "secondary" : "tertiary"}
              disabled
              data-action={action.key}
              /*
                Named for the finding, so a screen-reader user moving between
                cards hears which one each button belongs to rather than
                "Resolve, Resolve, Resolve".
              */
              aria-label={`${action.label}: ${finding.title}`}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
