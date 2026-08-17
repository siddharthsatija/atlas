import { CheckCircle2Icon, DatabaseIcon, EyeOffIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The empty states the Insights page can reach (ATL-040, frontend §8, §18).
 *
 * The acceptance criterion is explicit that they **differ per tab** and that
 * they **explain how findings are generated**. Both matter for the same reason:
 * an empty Insights page is ambiguous in a way an empty list of assets is not.
 * "Nothing here" could mean Atlas looked and found nothing, that it has not
 * looked yet, or that there is nothing to look at — and only the last is ever
 * true at first run. Shared copy would leave the user to guess, and the
 * flattering guess ("Atlas scanned me and I am fine") is the wrong one.
 *
 * So each state says where findings come from: the user's own records, examined
 * by Atlas's rules. Atlas does not scan the internet, and CLAUDE.md forbids
 * implying otherwise.
 */

/** The sentence every state is built around. Written once so it cannot drift. */
const HOW_FINDINGS_WORK =
  "Atlas looks at the services you have recorded and the details you have added about them. It does not scan the internet or your accounts, so findings only appear once there is something of yours to examine.";

/**
 * No findings at all, and no assets to generate them from.
 *
 * The next step is adding a service, not waiting: with nothing recorded there is
 * nothing for a rule to evaluate, and saying so is more useful than an
 * encouraging empty page.
 */
export function FindingsFirstRunEmptyState() {
  return (
    <EmptyState
      variant="first-run"
      icon={DatabaseIcon}
      title="No findings yet"
      description={`A finding is something Atlas noticed about one of your services — an account you have not reviewed in a long time, or a permission that looks broader than it needs to be. ${HOW_FINDINGS_WORK}`}
      action={
        <Button asChild>
          <Link href="/assets">Add a service</Link>
        </Button>
      }
    />
  );
}

/**
 * The Recommended view with nothing outstanding.
 *
 * A real and good outcome — every finding has been resolved or dismissed — and
 * worth stating plainly. It must not be confused with the first-run state:
 * telling someone who has cleared their list that Atlas has nothing to examine
 * would be false, and telling a new user "you are all clear" would be a claim
 * Atlas has not earned.
 */
export function FindingsRecommendedEmptyState() {
  return (
    <EmptyState
      variant="filtered"
      icon={CheckCircle2Icon}
      title="Nothing needs your attention"
      description={`Every finding Atlas has raised is resolved or dismissed. ${HOW_FINDINGS_WORK} New ones appear here as your records change.`}
      action={
        <Button asChild variant="secondary">
          <Link href="/insights?view=all">See all findings</Link>
        </Button>
      }
    />
  );
}

/** The Resolved view before anything has been resolved. */
export function FindingsResolvedEmptyState() {
  return (
    <EmptyState
      variant="filtered"
      icon={SparklesIcon}
      title="Nothing resolved yet"
      description="Findings you mark as resolved are kept here, so you have a record of what you have dealt with and when."
      action={
        <Button asChild variant="secondary">
          <Link href="/insights">Back to recommended</Link>
        </Button>
      }
    />
  );
}

/**
 * The Dismissed view before anything has been dismissed.
 *
 * The copy states ADR-004's rule up front rather than letting someone discover
 * it after the fact: dismissing does not improve the privacy score, because the
 * underlying condition is still true. ATL-043 owns the dismissal flow and its
 * fuller explanation; this is the part that belongs to an empty list.
 */
export function FindingsDismissedEmptyState() {
  return (
    <EmptyState
      variant="filtered"
      icon={EyeOffIcon}
      title="Nothing dismissed yet"
      description="Dismissing a finding tells Atlas you have seen it and do not plan to act. It stays here rather than disappearing, and it does not improve your privacy score — the underlying situation has not changed."
      action={
        <Button asChild variant="secondary">
          <Link href="/insights">Back to recommended</Link>
        </Button>
      }
    />
  );
}

/**
 * The All view when findings exist in other views but not this one.
 *
 * Only reachable when the user has assets and every finding has been filtered
 * out of view, which for the All view means there are none of any status.
 */
export function FindingsAllEmptyState() {
  return (
    <EmptyState
      variant="filtered"
      icon={CheckCircle2Icon}
      title="No findings recorded"
      description={`Atlas has not raised anything about your services. ${HOW_FINDINGS_WORK}`}
      action={
        <Button asChild variant="secondary">
          <Link href="/assets">Review your services</Link>
        </Button>
      }
    />
  );
}
