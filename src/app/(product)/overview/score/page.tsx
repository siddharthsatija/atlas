import type { Metadata } from "next";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import {
  ScoreBreakdown,
  ScoreChart,
  ScoreHistory,
  ScoreLimitations,
  ScoreSummary,
  type ScoreFactorView,
} from "@/features/score";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { PrivacyScoreService } from "@/server/score/privacy-score-service";

/**
 * The privacy score detail view (ATL-046, frontend §12).
 *
 * A Server Component calling `PrivacyScoreService.explainScore` directly — the
 * pattern ATL-031 and ATL-040 set for reads, so there is no route handler and no
 * `ApiEnvelope` to build. Entirely read-only: no Server Action, no mutation, and
 * nothing on this page writes a snapshot.
 *
 * ## Why it lives under Overview
 *
 * `/overview/score`, not a seventh top-level destination. The score is part of
 * the dashboard's story rather than a section of its own, and PRD §12 and
 * frontend §3 fix the seven navigation items — adding an eighth would change an
 * ordering two documents agree on. Nesting also means `findActiveNavItem`
 * already highlights Overview, because it matches on `pathname.startsWith`.
 *
 * **No entry point is added here.** ATL-021 owns the score card that links to
 * this page, and it depends on ATL-046 rather than the reverse. Until it lands
 * this route is reachable by URL, which is the honest state: a temporary button
 * somewhere would be a second thing to remove later.
 *
 * ## Current state and history are different things
 *
 * The number at the top is **calculated now**. The list below is what was
 * **recorded before**. ATL-045 writes no snapshot at cold start and no marker
 * when a scored user returns to it, so the newest snapshot can outlive the
 * records it described — presenting it as the current score would be a number
 * about services that no longer exist. `explainScore` returns both separately
 * and this page keeps them apart.
 */

export const metadata: Metadata = { title: "Privacy score" };

/** Reads a session and per-user data, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

export default async function ScoreDetailPage() {
  const user = await requireVerifiedUser();

  const result = await PrivacyScoreService.create().explainScore(user.id);

  if (!result.ok) {
    /**
     * Thrown to the route-level error boundary (ATL-010) rather than rendered
     * inline. A score that failed to load has nothing to show, and a bespoke
     * error panel here would be a second, less-tested version of the boundary
     * the shell already provides.
     */
    throw new Error(`Could not load the privacy score: ${result.code}`);
  }

  const { current, history, delta } = result.data;
  const scored = current.status === "scored";

  const factors: ScoreFactorView[] = scored
    ? current.factors.map((factor) => ({
        id: factor.id,
        label: factor.label,
        weight: factor.weight,
        normalisedWeight: factor.normalisedWeight,
        value: factor.value,
        excluded: factor.excluded,
        inputs: factor.inputs,
      }))
    : [];

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Privacy score</PageTitle>
        <PageDescription>
          How Atlas arrived at your score, what it covers, and what it does not.
        </PageDescription>
      </PageHeader>

      <div className="flex flex-col gap-8 pb-16">
        <ScoreSummary
          score={scored ? current.score : null}
          scoreVersion={current.scoreVersion}
          isDemo={scored ? current.isDemo : false}
          delta={delta}
        />

        {/*
          The breakdown describes a score, so it appears only when there is one.
          Rendering six empty factor rows at cold start would imply a calculation
          that did not happen.
        */}
        {scored && <ScoreBreakdown factors={factors} coverage={current.coverage} />}

        {/*
          ATL-047's visual summary, above the list it summarises. The list stays
          exactly as ATL-046 shipped it: the chart is additive, and it is never
          the only representation of the history.
        */}
        <ScoreChart entries={history} />

        <ScoreHistory entries={history} withoutCurrentScore={!scored} />

        <ScoreLimitations />
      </div>
    </PageContainer>
  );
}
