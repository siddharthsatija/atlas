import { DatabaseIcon, SearchXIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The two empty states the asset list can reach (ATL-031, frontend §6, §18).
 *
 * They are different situations and must not share copy. "Nothing here yet" told
 * to someone whose filter simply matched nothing is actively misleading — they
 * would reasonably conclude their assets had been lost.
 */

/**
 * Nothing exists yet.
 *
 * Frontend §6 asks for three things: add a first asset, use demo data, and
 * explain how Atlas discovers assets. The third is copy rather than a link,
 * because the honest answer is short and the product has nowhere else to put it:
 * Atlas does not scan for accounts, so the user is the source. Saying that here
 * prevents the reasonable assumption that the empty list means "we looked and
 * found nothing".
 */
export function AssetsFirstRunEmptyState() {
  return (
    <EmptyState
      variant="first-run"
      icon={DatabaseIcon}
      title="No services yet"
      description="A digital asset is any online account or service that holds information about you. Atlas does not scan the internet to find them — you add the ones you know about, and Atlas helps you keep track of what each one holds."
      action={
        // ATL-032 built the flow, so this is a real destination now.
        <Button asChild>
          <Link href="/assets/new">Add your first service</Link>
        </Button>
      }
      secondaryAction={
        // ATL-018 owns the demo dataset itself, and OQ-03 fixed demo mode as
        // post-signup only. The offer belongs here per §6; the data does not
        // exist yet, so the control is honest about being unavailable.
        <Button variant="tertiary" disabled>
          Explore with sample data
        </Button>
      }
    />
  );
}

/**
 * The default list is empty, and archived assets were excluded from it (ATL-036).
 *
 * ## Why this is a third state rather than a reuse
 *
 * The first-run state says "no services yet", which is false for someone whose
 * only services are archived — and telling them that would read as data loss,
 * the same failure the filtered state exists to avoid. The filtered state is
 * equally wrong: they did not filter anything.
 *
 * ## Why it does not distinguish the two cases
 *
 * "Zero assets ever" and "only archived assets" are different situations, and
 * separating them would cost a second database read purely to choose copy.
 * ATL-036 declined that, so this wording is true of both: it offers the action a
 * new user needs and names the filter an archiving user needs, without asserting
 * which of them is reading it.
 */
export function AssetsNoActiveEmptyState() {
  return (
    <EmptyState
      variant="first-run"
      icon={DatabaseIcon}
      title="No active services to show."
      description="Add a service, or use the Archived status filter to view archived services."
      action={
        <Button asChild>
          <Link href="/assets/new">Add a service</Link>
        </Button>
      }
      secondaryAction={
        /** The same URL the status filter produces, so it is linkable and typed. */
        <Button asChild variant="tertiary">
          <Link href="/assets?status=archived">View archived services</Link>
        </Button>
      }
    />
  );
}

/**
 * Assets exist, but none match the current filters.
 *
 * The primary action clears them — a plain link back to the unfiltered route, so
 * it works without JavaScript and is the same URL the user could have typed.
 */
export function AssetsFilteredEmptyState() {
  return (
    <EmptyState
      variant="filtered"
      icon={SearchXIcon}
      title="No services match those filters"
      description="Try removing a filter or searching for a different name."
      action={
        <Button asChild variant="secondary">
          <Link href="/assets">Clear filters</Link>
        </Button>
      }
    />
  );
}
