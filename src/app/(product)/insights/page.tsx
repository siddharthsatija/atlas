import type { Metadata } from "next";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import { FindingDetail, FindingList, FindingViewNav } from "@/features/findings";
import { findingView, parseFindingView } from "@/lib/findings/finding-views";
import { parseAssetQuery } from "@/lib/assets/asset-query";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import { FindingService } from "@/server/findings/finding-service";
import {
  dismissFindingAction,
  explainFindingAction,
  resolveFindingAction,
  restoreFindingAction,
  submitAiFeedbackAction,
} from "./actions";
import { INITIAL_DISMISS_STATE, INITIAL_RESOLVE_STATE, INITIAL_RESTORE_STATE } from "./form-state";

/**
 * Privacy Insights (ATL-040, frontend §8).
 *
 * A Server Component calling `FindingService` directly, the pattern ATL-031
 * established for the asset list: CLAUDE.md prefers server components for reads
 * and server-only services for protected operations, so there is no route
 * handler and therefore no `ApiEnvelope` to build.
 *
 * ## Nothing is sorted here
 *
 * The service returns findings in recommended order for every view, using
 * `src/lib/findings/recommendation.ts`. This route does not re-sort, re-rank or
 * re-filter — ATL-039 exists precisely so the ordering has one home, and a
 * second implementation in a page is one that would eventually disagree with the
 * tested one.
 *
 * ## The detail panel is URL state (ATL-041)
 *
 * `?finding=<id>` opens the drawer. Parsed here on the server and fetched with
 * `getFindingDetail`, so a panel survives a refresh, can be deep linked, and
 * answers Back and Forward without any client state to keep in step. A finding
 * that does not exist — or belongs to someone else — simply renders the list
 * with no panel: the service answers `NOT_FOUND` for both, and erroring would
 * confirm that some id names a real record.
 *
 * ## Which call each view makes
 *
 * Recommended is `calculateRecommendations`, which is not a status filter: it
 * excludes finished findings rather than selecting one status. The other three
 * are `listFindings`, filtered by the view's status (All filters nothing).
 */

export const metadata: Metadata = { title: "Privacy Insights" };

/** Reads a session and per-user data, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireVerifiedUser();
  const params = await searchParams;

  const raw = Array.isArray(params.view) ? params.view[0] : params.view;
  const viewId = parseFindingView(raw);
  const view = findingView(viewId);

  const findings = FindingService.create();
  const result =
    viewId === "recommended"
      ? await findings.calculateRecommendations(user.id)
      : await findings.listFindings(user.id, view.status ? { status: view.status } : {});

  if (!result.ok) {
    /**
     * Thrown to the route-level error boundary (ATL-010) rather than rendered
     * inline. A list that failed to load has nothing to show, and a bespoke
     * error panel here would be a second, less-tested version of the boundary
     * the shell already provides.
     */
    throw new Error(`Could not load findings: ${result.code}`);
  }

  /**
   * The panel's finding, when the URL asks for one.
   *
   * A second read rather than a lookup in `result.data`: the requested finding
   * may sit outside the current view — a resolved finding deep linked while the
   * Recommended view is showing — and `getFindingDetail` also resolves the
   * evidence records the list does not need.
   */
  const requestedId = Array.isArray(params.finding) ? params.finding[0] : params.finding;
  const detail = requestedId ? await findings.getFindingDetail(user.id, requestedId) : null;

  /** Preserves view and every other query value; only `finding` moves. */
  const urlWith = (findingId: string | null): string => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "finding" || value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) next.append(key, entry);
    }
    if (findingId) next.set("finding", findingId);
    const query = next.toString();
    return query ? `/insights?${query}` : "/insights";
  };

  /**
   * Only asked when the list is empty, and only to choose between two empty
   * states: "Atlas has nothing of yours to examine" and "Atlas examined your
   * records and raised nothing". A page with findings on it never runs this
   * query. `limit: 1` because the answer is a yes or a no.
   *
   * An asset read failure is not fatal here — the findings loaded, and the worst
   * case is the more general empty state rather than an error page for a user
   * who simply has nothing to see.
   */
  let hasNoAssets = false;
  if (result.data.length === 0) {
    const { query } = parseAssetQuery({ limit: 1 });
    const assets = await AssetService.create().listAssets(user.id, query);
    hasNoAssets = assets.ok && assets.data.items.length === 0;
  }

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Privacy Insights</PageTitle>
        <PageDescription>
          What Atlas noticed in the services you have recorded. Every finding comes from your own
          data — Atlas does not scan the internet or your accounts.
        </PageDescription>
      </PageHeader>

      <div className="flex flex-col gap-6 pb-16">
        <FindingViewNav view={viewId} />

        <section aria-labelledby="finding-results-heading">
          <h2 id="finding-results-heading" className="sr-only">
            {view.label} findings
          </h2>
          <FindingList
            view={viewId}
            findings={result.data}
            hasNoAssets={hasNoAssets}
            detailHref={urlWith}
          />
        </section>

        {detail?.ok && (
          <FindingDetail
            finding={{ ...detail.data, evidenceRecords: detail.data.evidenceRecords }}
            closeHref={urlWith(null)}
            /*
              ATL-042's flow, supplied by the route that owns the action. The
              panel stays renderable without a server boundary, which is what
              lets its tests exercise it directly.
            */
            resolve={{ action: resolveFindingAction, initialState: INITIAL_RESOLVE_STATE }}
            /* ATL-043's dismissal and its undo, supplied together. */
            dismiss={{
              action: dismissFindingAction,
              initialState: INITIAL_DISMISS_STATE,
              restoreAction: restoreFindingAction,
              restoreInitialState: INITIAL_RESTORE_STATE,
            }}
            /*
              ATL-053's assistant, supplied the same way. Both actions are
              server-only and re-verify the user themselves; the panel receives
              functions, never a user id.
            */
            assistant={{
              request: explainFindingAction,
              submitFeedback: submitAiFeedbackAction,
            }}
          />
        )}
      </div>
    </PageContainer>
  );
}
