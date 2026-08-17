import { SCORE_DISCLAIMER } from "@/lib/score/score-copy";

/**
 * What the score does not claim (ATL-046, frontend §12).
 *
 * §12 requires "a disclaimer that score is a guide, not a guarantee", and
 * CLAUDE.md forbids claiming behaviour Atlas does not have. Both point at the
 * same sentence: the score describes the records the user gave Atlas, and Atlas
 * does not scan the internet or their accounts.
 *
 * Its own component, and rendered last, because it applies to every state —
 * scored, demo, and cold start alike. A disclaimer that appeared only next to a
 * number would be missing from the state where a user is most likely to wonder
 * what the score would even mean.
 */
export function ScoreLimitations() {
  return (
    <section aria-labelledby="score-limitations-heading" className="flex flex-col gap-2">
      <h2 id="score-limitations-heading" className="text-heading-md text-text-primary">
        What this score is
      </h2>
      <p data-slot="score-disclaimer" className="text-body-sm text-text-secondary">
        {SCORE_DISCLAIMER}
      </p>
    </section>
  );
}
