"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  AI_CONFIDENCE_COPY,
  AI_CONFIDENCE_LABELS,
  ASSISTANT_COPY,
  type AssistantCopy,
  contextDisclosureText,
  FEEDBACK_COPY,
} from "@/lib/ai/assistant-copy";
import { AI_FEEDBACK_CATEGORIES } from "@/lib/ai/interaction-vocabulary";
import type { AiFeedbackState, AssistantState, ExplanationView } from "@/lib/ai/explanation-view";

/**
 * The finding assistant (ATL-053).
 *
 * Sits inside the ATL-041 drawer, below the finding's own facts, and explains the
 * finding the user is already looking at. It renders what the server decided; it
 * derives nothing about the answer itself.
 *
 * ## The conversation is ephemeral, deliberately
 *
 * Everything lives in `useState` and dies with the component. Nothing is written
 * to `sessionStorage`, no history is fetched, and closing the drawer discards the
 * answer. Two reasons, in order of weight:
 *
 *   1. An explanation is *about records as they were when it was asked*. A stored
 *      answer would keep asserting things about a finding the user has since
 *      resolved, which is worse than no answer.
 *   2. Task #109's clear-conversation requirement then costs nothing and can
 *      promise something true: Clear removes it from this view because this view
 *      is the only place it ever was.
 *
 * The `ai_interactions` row is a separate matter — it is metadata about a request
 * Atlas made, not the conversation, and the user sees it in their own disclosure
 * surface rather than here.
 *
 * ## Cancel affects this component and nothing else
 *
 * No `AbortSignal` is created and none is passed anywhere. Cancel sets the local
 * state back to idle; the server request continues, may complete, and records its
 * interaction normally. The copy says exactly that rather than implying the work
 * stopped — a message claiming otherwise would be the kind of small untruth that
 * makes the rest of the panel less believable.
 *
 * ## AI and fallback are rendered by two functions, not one with branches
 *
 * The view model makes `confidence` exist only on the AI variant, so the fallback
 * renderer *cannot* read it — a type error, not a review catch. Keeping them
 * separate is what makes that guarantee visible at the call site as well as in
 * the type.
 */

export interface FindingAssistantProps {
  /**
   * The record being asked about — a finding on the insights panel, an asset on
   * the asset page (ATL-054).
   *
   * Renamed from `findingId`. Passing an asset id to a parameter called
   * `findingId` would be a quiet untruth of exactly the kind this file's other
   * notes keep refusing, and the type would have stopped telling the reader
   * anything. The component never interprets the value; it hands it back to the
   * action that supplied it.
   */
  subjectId: string;
  /** The record's title, so every control is named for what it acts on. */
  title: string;
  /**
   * The server action that answers, supplied by the route that owns it
   * (ATL-041's pattern).
   *
   * Renamed from `explain` for the same reason as `subjectId`: on the asset page
   * this summarises, and calling it `explain` would name a different operation.
   */
  request: (subjectId: string) => Promise<AssistantState>;
  /**
   * Wording for this surface. Defaults to the finding copy, so the ATL-053 call
   * site is unchanged and a new surface opts in explicitly rather than
   * inheriting sentences about findings by omission.
   */
  copy?: AssistantCopy;
  /** Feedback on an answer (§12). Absent when the surface offers no feedback. */
  submitFeedback?: (
    interactionId: string,
    helpful: boolean,
    category?: string,
  ) => Promise<AiFeedbackState>;
}

/** A labelled block. Used for every section so nothing is announced unnamed. */
function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h5 className="text-label font-medium text-text-primary">{heading}</h5>
      {children}
    </section>
  );
}

/**
 * The records the answer cited (§4, ADR-001's "cites input records").
 *
 * Renders nothing when empty rather than an empty heading: the presenter drops
 * ids it could not resolve, so "no sources" is a real state and a bare heading
 * over nothing reads as a loading bug.
 */
function Sources({ explanation, copy }: { explanation: ExplanationView; copy: AssistantCopy }) {
  if (explanation.sources.length === 0) return null;

  return (
    <Section heading={copy.sourcesHeading}>
      <ul data-slot="assistant-sources" className="flex flex-col gap-1">
        {explanation.sources.map((source) => (
          <li key={source.id} className="text-body-sm">
            {source.href ? (
              <Link href={source.href} className="text-accent underline underline-offset-2">
                {source.label}
              </Link>
            ) : (
              <span className="text-text-secondary">{source.label}</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * §11's context disclosure. Shown on every answer, AI or deterministic.
 *
 * The sentence is built by `contextDisclosureText` rather than indexed here, so
 * the surfaces that scope retrieval to one named record (ATL-054) say so without
 * this component knowing which surface it is on.
 */
function Disclosure({ explanation }: { explanation: ExplanationView }) {
  return (
    <p data-slot="assistant-disclosure" className="text-body-sm text-text-muted">
      {contextDisclosureText(explanation.disclosure)}
    </p>
  );
}

/**
 * An AI answer.
 *
 * `confidence` here is the **model's** certainty about its own reasoning. The
 * finding's rule confidence is rendered by the panel above under its own label,
 * and the wording is deliberately a sentence rather than a badge so the two
 * cannot be read as the same measurement.
 */
function AiAnswer({
  explanation,
  copy,
}: {
  explanation: Extract<ExplanationView, { source: "ai" }>;
  copy: AssistantCopy;
}) {
  return (
    <div data-slot="assistant-ai" className="flex flex-col gap-3">
      <Section heading={copy.summaryHeading}>
        <p className="text-body-sm text-text-secondary">{explanation.summary}</p>
      </Section>

      <Section heading={copy.whyHeading}>
        <p className="text-body-sm text-text-secondary">{explanation.whyItMatters}</p>
      </Section>

      <p data-slot="assistant-ai-confidence" className="text-body-sm text-text-muted">
        <span className="font-medium text-text-secondary">
          {AI_CONFIDENCE_LABELS[explanation.confidence]}
        </span>{" "}
        {AI_CONFIDENCE_COPY[explanation.confidence]}
      </p>

      {explanation.uncertainties.length > 0 && (
        <Section heading={copy.uncertaintiesHeading}>
          <ul data-slot="assistant-uncertainties" className="flex flex-col gap-1">
            {explanation.uncertainties.map((entry) => (
              <li key={entry} className="text-body-sm text-text-secondary">
                {entry}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Sources explanation={explanation} copy={copy} />

      {explanation.actions.length > 0 && (
        <Section heading={copy.actionsHeading}>
          <ul data-slot="assistant-actions" className="flex flex-col gap-1">
            {explanation.actions.map((action) => (
              <li key={`${action.actionType}:${action.entityId}`} className="text-body-sm">
                <span className="text-text-secondary">{action.label}</span>
              </li>
            ))}
          </ul>
          {/*
            Rendered as text, never as buttons. AI rules: "AI can propose but
            cannot execute irreversible or external actions" — a control here
            would be the assistant acting, even with the user's click, because
            the assistant chose both the action and its target.
          */}
          <p className="text-body-sm text-text-muted">{copy.proposalNote}</p>
        </Section>
      )}

      <Disclosure explanation={explanation} />
    </div>
  );
}

/**
 * An asset summary (ATL-054).
 *
 * A third renderer for the same reason there is a second: the variant it accepts
 * has no `whyItMatters`, no `confidence` and no `actions`, so this function
 * **cannot** render any of them — not by convention but because the fields do
 * not exist on the type it is given. That is the same guarantee `FallbackAnswer`
 * relies on to keep a model's confidence off deterministic text, applied to a
 * surface that describes records rather than judging them.
 *
 * No proposal note, because nothing is proposed. The panel above already links
 * to the edit page for anyone who wants to change something.
 */
function AssetSummaryAnswer({
  explanation,
  copy,
}: {
  explanation: Extract<ExplanationView, { source: "asset_summary" }>;
  copy: AssistantCopy;
}) {
  return (
    <div data-slot="assistant-asset-summary" className="flex flex-col gap-3">
      <Section heading={copy.summaryHeading}>
        <p className="text-body-sm text-text-secondary">{explanation.summary}</p>
      </Section>

      {explanation.uncertainties.length > 0 && (
        <Section heading={copy.uncertaintiesHeading}>
          <ul data-slot="assistant-uncertainties" className="flex flex-col gap-1">
            {explanation.uncertainties.map((entry) => (
              <li key={entry} className="text-body-sm text-text-secondary">
                {entry}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Sources explanation={explanation} copy={copy} />

      <Disclosure explanation={explanation} />
    </div>
  );
}

/**
 * A deterministic answer.
 *
 * **No confidence is rendered and none can be.** `FallbackExplanationView` has no
 * such field, so this function could not read one if it tried. The notice above
 * says who wrote the text, which is the honest substitute for a certainty the
 * fallback does not have.
 */
function FallbackAnswer({
  explanation,
  copy,
}: {
  explanation: Extract<ExplanationView, { source: "fallback" }>;
  copy: AssistantCopy;
}) {
  return (
    <div data-slot="assistant-fallback" className="flex flex-col gap-3">
      <p
        data-slot="assistant-notice"
        className="rounded-control bg-surface-subtle p-3 text-body-sm text-text-secondary"
      >
        {explanation.notice}
      </p>

      <Section heading={copy.summaryHeading}>
        <p className="text-body-sm text-text-secondary">{explanation.summary}</p>
      </Section>

      <Section heading={copy.whyHeading}>
        <p className="text-body-sm text-text-secondary">{explanation.whyItMatters}</p>
      </Section>

      <Section heading={copy.actionsHeading}>
        {/* Prose, because the rule named a step but not a target to act on. */}
        <p data-slot="assistant-fallback-action" className="text-body-sm text-text-secondary">
          {explanation.recommendedAction}
        </p>
      </Section>

      <Sources explanation={explanation} copy={copy} />

      {explanation.disclosures.length > 0 && (
        <ul data-slot="assistant-disclosures" className="flex flex-col gap-1">
          {explanation.disclosures.map((entry) => (
            <li key={entry} className="text-body-sm text-text-muted">
              {entry}
            </li>
          ))}
        </ul>
      )}

      <Disclosure explanation={explanation} />
    </div>
  );
}

/**
 * The §12 feedback control.
 *
 * Two buttons and an optional category, offered only when an interaction id
 * exists — without a row there is nothing to attach feedback to, and a control
 * that silently discarded the click would be worse than no control.
 *
 * There is no free-text box. The table has no column for one, and a comment field
 * is where a user's own account details end up in a store that was never designed
 * to hold them.
 */
function Feedback({
  interactionId,
  submitFeedback,
}: {
  interactionId: string;
  submitFeedback: NonNullable<FindingAssistantProps["submitFeedback"]>;
}) {
  const [state, setState] = useState<AiFeedbackState>({ status: "idle" });
  const [category, setCategory] = useState<string>("");
  const [pending, startTransition] = useTransition();

  if (state.status === "recorded") {
    return (
      <p
        data-slot="assistant-feedback-result"
        role="status"
        className="text-body-sm text-text-muted"
      >
        {FEEDBACK_COPY.recorded}
      </p>
    );
  }

  const send = (helpful: boolean) => {
    startTransition(async () => {
      setState(
        await submitFeedback(interactionId, helpful, category === "" ? undefined : category),
      );
    });
  };

  return (
    <div data-slot="assistant-feedback" className="flex flex-col gap-2">
      <p className="text-body-sm text-text-muted">{FEEDBACK_COPY.question}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          data-slot="assistant-feedback-yes"
          onClick={() => send(true)}
        >
          {FEEDBACK_COPY.yes}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          data-slot="assistant-feedback-no"
          onClick={() => send(false)}
        >
          {FEEDBACK_COPY.no}
        </Button>
      </div>

      {/*
        The closed vocabulary, rendered as a select rather than free text. A user
        who wants to say more can say nothing here; the thumb is still recorded.
      */}
      <label className="flex flex-col gap-1 text-body-sm text-text-muted">
        What was wrong? (optional)
        <select
          data-slot="assistant-feedback-category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="rounded-input border border-border-default bg-surface p-2 text-text-primary"
        >
          <option value="">No comment</option>
          {AI_FEEDBACK_CATEGORIES.map((entry) => (
            <option key={entry} value={entry}>
              {entry.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>

      {state.status === "unavailable" && (
        <p role="alert" data-slot="assistant-feedback-error" className="text-body-sm text-danger">
          {FEEDBACK_COPY.unavailable}
        </p>
      )}
    </div>
  );
}

export function FindingAssistant({
  subjectId,
  title,
  request,
  copy = ASSISTANT_COPY,
  submitFeedback,
}: FindingAssistantProps) {
  /** The whole conversation. Ephemeral by construction — see the module note. */
  const [state, setState] = useState<AssistantState>({ status: "idle" });
  const [, startTransition] = useTransition();

  /**
   * Set when the user cancels, so the panel can say what actually happened.
   *
   * Separate from `state` rather than a seventh status: cancelling returns the
   * panel to idle, and the note is about the *previous* request. Folding it into
   * the state machine would mean inventing a status the server never produces.
   */
  const [cancelled, setCancelled] = useState(false);

  const ask = () => {
    setCancelled(false);
    setState({ status: "pending" });

    startTransition(async () => {
      const next = await request(subjectId);

      /**
       * Applied unconditionally, including after a cancel.
       *
       * Deliberate: `setState` on an unmounted component is a no-op in React 19,
       * and if the user cancelled and then asked again, `ask` has already reset
       * the state — so a late answer from the abandoned request lands on a panel
       * the user is actively waiting on. Guarding on `cancelled` here would need
       * a ref and would not make the result any more correct.
       */
      setState(next);
    });
  };

  /** Cancel and Clear do the same thing to state; they differ in what they say. */
  const cancel = () => {
    setCancelled(true);
    setState({ status: "idle" });
  };

  const clear = () => {
    setCancelled(false);
    setState({ status: "idle" });
  };

  /**
   * What the live region below says at each step.
   *
   * A region that *mounts* alongside its text is announced unreliably — several
   * screen readers only watch regions that were already in the accessibility tree
   * when the text changed. So the region is always present and this string is
   * what changes, which is the pattern `finding-resolve.tsx` already uses for its
   * submitting state.
   *
   * Empty for idle: there is nothing to announce about a panel at rest, and an
   * announcement on every Clear would interrupt a user who is reading something
   * else.
   *
   * The refusal states are **absent on purpose**. Each renders a visible
   * `role="alert"`, which is specified to be announced when it appears, so
   * repeating it here would say the same sentence twice.
   */
  const announcement =
    state.status === "pending"
      ? copy.pending
      : state.status === "answered"
        ? copy.answeredAnnouncement
        : cancelled
          ? copy.cancelled
          : "";

  return (
    <section
      data-slot="finding-assistant"
      aria-labelledby="assistant-heading"
      className="flex flex-col gap-3 border-t border-border-default pt-4"
    >
      <h4 id="assistant-heading" className="text-label font-medium text-text-primary">
        {copy.ask}
      </h4>

      {/*
        Always mounted, never conditional. Announces pending, the arrival of an
        answer, every refusal, and a cancellation — one region rather than a
        `role="status"` per branch, so a screen reader hears one voice for this
        panel instead of several appearing and disappearing.

        `polite`, not `assertive`: nothing here is urgent enough to interrupt
        what the user is currently reading.
      */}
      <span
        role="status"
        data-slot="assistant-announcer"
        className="sr-only"
        data-status={state.status}
      >
        {announcement}
      </span>

      {state.status === "idle" && (
        <>
          <p className="text-body-sm text-text-muted">{copy.askHint}</p>
          {/* No `role` here: the announcer above already speaks for this panel. */}
          {cancelled && (
            <p data-slot="assistant-cancelled" className="text-body-sm text-text-muted">
              {copy.cancelled}
            </p>
          )}
          <div>
            <Button
              type="button"
              variant="secondary"
              data-slot="assistant-ask"
              onClick={ask}
              aria-label={`${copy.ask}: ${title}`}
            >
              {copy.ask}
            </Button>
          </div>
        </>
      )}

      {state.status === "pending" && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Visible only; the announcer carries the same words to a reader. */}
          <p data-slot="assistant-pending" className="text-body-sm text-text-secondary">
            {copy.pending}
          </p>
          {/*
            A real `<button>`, so Tab reaches it and Enter and Space activate it
            with no key handling of our own. Cancel must be reachable without a
            mouse — it is the only way out of a wait.
          */}
          <Button
            type="button"
            variant="tertiary"
            size="sm"
            data-slot="assistant-cancel"
            onClick={cancel}
          >
            {copy.cancel}
          </Button>
        </div>
      )}

      {state.status === "answered" && (
        <>
          {/*
            One renderer per variant, dispatched on `source`.

            Nested ternaries rather than a `switch` only because this is JSX. The
            property that matters is that each branch hands its renderer a
            *narrowed* value: `AssetSummaryAnswer` cannot be given an explanation
            and `AiAnswer` cannot be given a summary, so neither can read a field
            the other's shape does not have. Adding a fourth variant fails to
            compile here until it is handled — which is how this branch was
            written in the first place.
          */}
          {state.explanation.source === "ai" ? (
            <AiAnswer explanation={state.explanation} copy={copy} />
          ) : state.explanation.source === "asset_summary" ? (
            <AssetSummaryAnswer explanation={state.explanation} copy={copy} />
          ) : (
            <FallbackAnswer explanation={state.explanation} copy={copy} />
          )}

          {submitFeedback && state.explanation.interactionId !== undefined && (
            <Feedback
              interactionId={state.explanation.interactionId}
              submitFeedback={submitFeedback}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="tertiary"
              size="sm"
              data-slot="assistant-clear"
              onClick={clear}
            >
              {copy.clear}
            </Button>
          </div>
        </>
      )}

      {(state.status === "unavailable" ||
        state.status === "consent_required" ||
        state.status === "not_found") && (
        <div className="flex flex-col gap-2">
          {/*
            `role="alert"` rather than a second live region: an alert is
            announced when it appears, which is exactly this case, and it is why
            the announcer above deliberately says nothing for these three.

            `data-refusal` distinguishes them for a surface or a test without
            anyone re-deriving the reason from the sentence — and without any
            internal code reaching the DOM. The three values are the panel's own
            vocabulary, not the policy layer's and not a provider's.
          */}
          <p
            role="alert"
            data-slot="assistant-problem"
            data-refusal={state.status}
            className="text-body-sm text-text-secondary"
          >
            {state.status === "consent_required"
              ? copy.consentRequired
              : state.status === "not_found"
                ? copy.notFound
                : copy.unavailable}
          </p>

          {/*
            Retry is offered only where retrying could work.

            Not for consent: granting it is a decision made elsewhere, and there
            is no in-product control for it yet — onboarding captures it once
            (ATL-016/ATL-078) and the privacy settings that would let a user
            change their mind are ATL-074–077. A "Try again" here would loop the
            user through the same refusal, and a link to `/settings` would send
            them to a page with no such control. So the state explains and stops.

            Not for a missing finding either: it will not reappear.
          */}
          {state.status === "unavailable" && (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-slot="assistant-retry"
                onClick={ask}
              >
                {copy.retry}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
