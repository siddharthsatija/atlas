"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SeverityBadge } from "@/components/ui/severity-badge";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { findingDestination } from "@/lib/findings/finding-navigation";
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_METHOD,
  PROVENANCE_LIMITATION,
  parseProvenance,
} from "@/lib/findings/provenance";
import { FINDING_TYPES, type FindingSeverity } from "@/lib/findings/findings";
import { FindingResolve, type ResolveState } from "./finding-resolve";
import { FindingDismiss, type DismissState, type RestoreState } from "./finding-dismiss";
import { FindingAssistant, type FindingAssistantProps } from "./finding-assistant";

/**
 * The finding detail panel (ATL-041).
 *
 * Read-only, entirely. Nothing here mutates a finding, and nothing here decides
 * anything the service has not already decided — provenance parsing lives in
 * `lib/findings/provenance.ts` and the destination in
 * `lib/findings/finding-navigation.ts`, so this component renders and does not
 * derive.
 *
 * ## A drawer, driven by the URL
 *
 * Frontend §19: "side panels support contextual inspection" — the user is
 * scanning a list and wants to look closer without losing their place. Open
 * state lives in `?finding=<id>` rather than in React state, matching the
 * URL-driven pattern ATL-040 and ATL-031 already use, so a panel can be deep
 * linked, survives a refresh, and answers Back and Forward without any special
 * handling.
 *
 * Radix Dialog underneath supplies the focus trap, Escape to close, focus
 * return to the trigger, and the inert background. Those are not reimplemented
 * here — hand-rolling them is how keyboard traps appear.
 *
 * ## What is deliberately absent
 *
 * Resolve (ATL-042), dismiss with undo (ATL-043) and Ask Atlas (ATL-053) are all
 * live, each supplied by the route that owns its action. No evaluation timestamp
 * and no per-input confidence appear, because neither is persisted (see
 * `provenance.ts`); the limitation is stated rather than papered over with a
 * proxy.
 *
 * ## Two confidences, never under one label
 *
 * The panel renders the **finding's** confidence — ADR-001's derivation from
 * source and staleness — in its facts list. The assistant below may render the
 * **model's** confidence in its own reasoning. They are different quantities
 * sitting centimetres apart, so each is worded to say which it is; the view
 * model keeps them structurally separate as well (`lib/ai/explanation-view.ts`).
 */

/** What the panel needs. A subset of the service's `FindingDetail`. */
export interface FindingDetailView {
  id: string;
  findingType: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: string;
  status: string;
  sourceType: string;
  sourceReference: string | null;
  evidenceSummary: string;
  recommendedAction: string;
  impactedAsset: string;
  assetId: string | null;
  createdAt: string;
  evidenceRecords: {
    id: string;
    kind: "asset" | "dataCategory" | "permission";
    label: string;
    href: string | null;
  }[];
}

const TYPE_LABELS = new Map<string, string>(FINDING_TYPES.map((entry) => [entry.id, entry.label]));

/*
  `DEFERRED_ACTIONS` is gone.

  It held exactly one entry — Ask Atlas, disabled, waiting for ATL-053 — after
  resolve left in ATL-042 and dismiss in ATL-043. ATL-053 supplies the assistant,
  so the list is empty and an empty list rendering an empty row is worse than no
  list. The finding *card* keeps its own deferred entry: this ticket enables the
  panel's control only, and the card's remains ATL-054's.
*/

/**
 * Lets a `Button` carrying a sentence wrap instead of overflowing.
 *
 * Applied per instance rather than changed in `button.tsx`: `whitespace-nowrap`
 * is correct for the short labels most buttons have, and relaxing it globally
 * would let every control in the product reflow in ways nobody has looked at.
 */
const wrapping = "h-auto py-2 text-left whitespace-normal";

/** A labelled fact. Used throughout so every value is announced with its name. */
function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-body-sm text-text-muted">{term}</dt>
      <dd className="text-body-sm text-text-secondary">{children}</dd>
    </>
  );
}

export interface FindingDetailProps {
  finding: FindingDetailView;
  /** Where closing returns to — the list URL with `finding` removed. */
  closeHref: string;
  /**
   * The ATL-042 resolution flow, supplied by the route.
   *
   * Passed in rather than imported here: a `"use server"` action belongs to the
   * route that owns it, and this keeps the panel renderable in tests without a
   * server boundary.
   */
  resolve?: {
    action: (state: ResolveState, formData: FormData) => Promise<ResolveState>;
    initialState: ResolveState;
  };
  /**
   * ATL-043's dismissal and undo, supplied the same way and for the same reason.
   *
   * One prop carrying both actions rather than two: they are two halves of one
   * decision, and the component picks between them from the finding's status,
   * so a route that supplied only one would leave the user able to dismiss with
   * no way back.
   */
  dismiss?: {
    action: (state: DismissState, formData: FormData) => Promise<DismissState>;
    initialState: DismissState;
    restoreAction: (state: RestoreState, formData: FormData) => Promise<RestoreState>;
    restoreInitialState: RestoreState;
  };
  /**
   * ATL-053's assistant, supplied the same way and for the same reason.
   *
   * Optional, like resolve and dismiss: the panel stays renderable without a
   * server boundary, so its own tests need no action wiring. Absent means the
   * assistant does not appear at all — which is the honest rendering, because a
   * control with no action behind it can do nothing.
   */
  assistant?: Pick<FindingAssistantProps, "request" | "submitFeedback">;
}

export function FindingDetail({
  finding,
  closeHref,
  resolve,
  dismiss,
  assistant,
}: FindingDetailProps) {
  const router = useRouter();
  const provenance = parseProvenance(finding.sourceReference);
  const destination = findingDestination(finding.findingType, finding.assetId);
  const typeLabel = TYPE_LABELS.get(finding.findingType) ?? finding.findingType;

  /**
   * Closing is a navigation, not a state change.
   *
   * `push` rather than `replace`, so the panel behaves like the rest of the
   * product: Back reopens what you just closed, Forward closes it again. A
   * `replace` would silently rewrite history and make Back skip past the list
   * entirely.
   */
  const close = (open: boolean) => {
    if (!open) router.push(closeHref);
  };

  /**
   * Returns focus to the card that opened this panel (RC-3).
   *
   * ## Why this component has to do it at all
   *
   * Radix restores focus to its `Trigger`:
   *
   * ```js
   * onCloseAutoFocus: composeEventHandlers(props.onCloseAutoFocus, (event) => {
   *   event.preventDefault();
   *   context.triggerRef.current?.focus();
   * })
   * ```
   *
   * `triggerRef` is populated only by `DialogPrimitive.Trigger`. This panel is
   * **URL state** — it is rendered `open` by the route, with no trigger — so
   * `triggerRef.current` is null and that `?.focus()` does nothing. Worse, Radix
   * has already called `preventDefault()`, which cancels `FocusScope`'s own
   * fallback restore. The net effect is that focus lands on `<body>`, which a
   * browser run confirmed: body immediately after close, and still body once the
   * list settled.
   *
   * ## Why here and not in `Drawer`
   *
   * Radix's behaviour is correct for a trigger-based drawer, and that is what
   * every other consumer of the primitive is. This component is the one that
   * chose to drive the dialog from the URL, so it owns that choice's
   * consequence. Changing the shared primitive would alter unrelated surfaces to
   * fix a problem only URL-driven ones have.
   *
   * ## Why a DOM query rather than a ref
   *
   * The originating link lives in the finding list — a different, server-rendered
   * tree that this component has no handle on. `data-finding-id` and
   * `data-slot="finding-details-link"` already exist on the card for exactly this
   * kind of addressing, so nothing new is introduced to support it.
   *
   * `preventDefault` first: `composeEventHandlers` runs this handler before
   * Radix's and skips Radix's when the default has been prevented, so this takes
   * ownership cleanly rather than racing it. No timer is involved — the list is
   * already committed by the time the drawer unmounts.
   */
  const restoreFocusToCard = (event: Event) => {
    event.preventDefault();

    const originating = document.querySelector<HTMLElement>(
      `[data-slot="finding-card"][data-finding-id="${finding.id}"] [data-slot="finding-details-link"]`,
    );

    /**
     * Falls back to nothing on purpose. If the finding has left the current view
     * — resolved, and the user is on Recommended — there is no card to return
     * to, and moving focus somewhere arbitrary would be worse than leaving the
     * browser to its default.
     */
    originating?.focus();
  };

  return (
    <Drawer open onOpenChange={close}>
      <DrawerContent
        side="right"
        className="w-[32rem]"
        data-slot="finding-detail"
        data-finding-id={finding.id}
        onCloseAutoFocus={restoreFocusToCard}
      >
        <DrawerHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <Badge tone="neutral">{typeLabel}</Badge>
            <Badge tone="neutral" data-slot="detail-status">
              {finding.status}
            </Badge>
            {finding.sourceType === "demo" && <Badge tone="accent">Demo</Badge>}
          </div>
          <DrawerTitle>{finding.title}</DrawerTitle>
          <DrawerDescription>{finding.description}</DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="flex flex-col gap-6">
          <section aria-labelledby="detail-evidence-heading">
            <h3 id="detail-evidence-heading" className="text-label font-medium text-text-primary">
              Evidence
            </h3>
            <p data-slot="detail-evidence" className="text-body-sm text-text-secondary">
              {finding.evidenceSummary}
            </p>

            {/*
              ADR-001: "every finding cites rule ID, rule version, and input
              records". These are those records — identifiers in the database,
              names and destinations here, because a UUID explains nothing.
            */}
            <h4 className="mt-3 text-label font-medium text-text-primary">Records Atlas read</h4>
            {finding.evidenceRecords.length === 0 ? (
              <p data-slot="detail-no-records" className="text-body-sm text-text-muted">
                No individual records were recorded for this finding.
              </p>
            ) : (
              <ul data-slot="detail-records" className="mt-1 flex flex-col gap-1">
                {finding.evidenceRecords.map((record) => (
                  <li key={record.id} className="text-body-sm" data-record-kind={record.kind}>
                    {record.href ? (
                      <Link href={record.href} className="text-accent underline underline-offset-2">
                        {record.label}
                      </Link>
                    ) : (
                      /*
                        Kept rather than dropped. Omitting a record that no
                        longer resolves would make the finding look better
                        founded than it is.
                      */
                      <span className="text-text-muted">{record.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="detail-provenance-heading">
            <h3 id="detail-provenance-heading" className="text-label font-medium text-text-primary">
              Where this came from
            </h3>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <Fact term="Rule">
                <span data-slot="detail-rule">{provenance.ruleId ?? "Not produced by a rule"}</span>
              </Fact>
              <Fact term="Rule version">
                <span data-slot="detail-rule-version">{provenance.ruleVersion ?? "—"}</span>
              </Fact>
              <Fact term="Confidence">
                <span data-slot="detail-confidence">
                  {CONFIDENCE_LABELS[finding.confidence] ?? finding.confidence}
                </span>
              </Fact>
              <Fact term="Impacted asset">
                <span data-slot="detail-impacted-asset">{finding.impactedAsset}</span>
              </Fact>
              <Fact term="First raised">
                <span data-slot="detail-created">{finding.createdAt.slice(0, 10)}</span>
              </Fact>
            </dl>

            <p className="mt-2 text-body-sm text-text-secondary">{CONFIDENCE_METHOD}</p>
            {/*
              Frontend §8 requires a view that explains its limitations, and
              CLAUDE.md forbids claiming behaviour Atlas does not have. Saying
              what is missing is more honest than a proxy value that would read
              as an evaluation time.
            */}
            <p data-slot="detail-limitation" className="mt-1 text-body-sm text-text-muted">
              {PROVENANCE_LIMITATION}
            </p>
          </section>

          <section aria-labelledby="detail-action-heading">
            <h3 id="detail-action-heading" className="text-label font-medium text-text-primary">
              Recommended action
            </h3>
            <p data-slot="detail-recommended-action" className="text-body-sm text-text-secondary">
              {finding.recommendedAction}
            </p>

            {/*
              `wrapping` lets these labels reflow inside the drawer.

              `button.tsx` styles every button `shrink-0 whitespace-nowrap` with
              a fixed `h-10`, which is right for a short control and wrong for a
              sentence. "Review what this service holds" measured 261px wide
              inside a drawer clamped to 272px at a 320px viewport, so the text
              ran past the drawer's edge.

              The label is a fixed string from `finding-navigation.ts`, not user
              data, so this is not the ATL-053 `aria-label` treatment: there is
              nothing unbounded to move out of sight, and the visible text is the
              accessible name. It simply needs to wrap. `h-auto` because the
              fixed height would otherwise clip the second line, `py-2` to keep
              the vertical rhythm, and `text-left` because a wrapped sentence
              centred over two lines reads as a mistake.
            */}
            <div className="mt-2">
              {destination.available ? (
                <Button asChild variant="secondary" className={wrapping}>
                  <Link href={destination.href} data-slot="detail-destination">
                    {destination.label}
                  </Link>
                </Button>
              ) : (
                <>
                  {/*
                    Present, announced, and visibly unavailable — the ATL-005
                    precedent. Requests are M8; inventing a route would be a
                    promise the product cannot keep.
                  */}
                  <Button
                    variant="secondary"
                    disabled
                    className={wrapping}
                    data-slot="detail-destination-unavailable"
                  >
                    {destination.label}
                  </Button>
                  <p className="mt-1 text-body-sm text-text-muted">
                    {destination.unavailableReason}
                  </p>
                </>
              )}
            </div>
          </section>

          <div className="flex flex-col gap-3 border-t border-border-default pt-4">
            {resolve && (
              <FindingResolve
                findingId={finding.id}
                title={finding.title}
                action={resolve.action}
                initialState={resolve.initialState}
                closed={finding.status === "resolved" || finding.status === "dismissed"}
              />
            )}

            {dismiss && (
              <FindingDismiss
                findingId={finding.id}
                title={finding.title}
                dismiss={{ action: dismiss.action, initialState: dismiss.initialState }}
                restore={{
                  action: dismiss.restoreAction,
                  initialState: dismiss.restoreInitialState,
                }}
                status={finding.status}
              />
            )}
          </div>

          {/*
            ATL-053. Last in the drawer deliberately: the finding's own facts,
            evidence and lifecycle controls are what the user came for, and an
            assistant above them would put a generated answer ahead of the
            record it describes (UI rules: "AI is contextual and must not
            overpower the user's data").
          */}
          {assistant && (
            <FindingAssistant
              subjectId={finding.id}
              title={finding.title}
              request={assistant.request}
              {...(assistant.submitFeedback ? { submitFeedback: assistant.submitFeedback } : {})}
            />
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
