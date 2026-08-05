import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { OnboardingService } from "@/server/onboarding/onboarding-service";
import { setSidebarCollapsed } from "./actions";
import {
  SIDEBAR_COLLAPSED_COOKIE,
  parseSidebarCollapsed,
} from "@/lib/preferences/sidebar-preference";

/**
 * Layout for every authenticated product surface (ATL-005).
 *
 * **Route protection (ATL-012).** The session is verified here, on the server,
 * before anything else in this layout runs — client state is never authorization
 * evidence (architecture §5). `src/middleware.ts` redirects earlier and avoids
 * the render entirely, but its coverage depends on a matcher glob; this check
 * does not, so a routing misconfiguration cannot expose a product surface.
 *
 * The verification is the **first statement** in the function on purpose. Reading
 * the sidebar preference first would be harmless today, but establishing the
 * order now means later data fetching cannot drift above the gate.
 *
 * The route-level error boundary for this group is `./error.tsx` (ATL-010). It
 * renders *inside* this layout, so the shell survives a failed view and the user
 * keeps navigation. Per-route `loading.tsx` skeletons belong to the tickets that
 * introduce the data they cover — a skeleton must resemble the final structure
 * (frontend §18), which is not knowable until that structure exists.
 *
 * The sidebar collapse preference (ATL-006) is resolved here, on the server, so
 * the shell renders in the user's chosen state with no flash. Reading a cookie
 * opts these routes into dynamic rendering — correct for an authenticated surface
 * that ATL-012 will gate on a session anyway, and the reason the collapse
 * preference is not read any earlier than it needs to be.
 */
export default async function ProductLayout({ children }: { children: ReactNode }) {
  // Throws a redirect when unauthenticated: nothing below runs, and no protected
  // markup is produced to flash.
  const user = await requireVerifiedUser();

  /**
   * Onboarding gate (ATL-016).
   *
   * A user who has not finished setup is sent to `/onboarding` rather than shown
   * an empty dashboard with no explanation of what Atlas does or does not do.
   * ATL-015 anticipated this check — `profiles_onboarding_incomplete_idx` exists
   * precisely because "the onboarding resume check runs on every product page
   * load until it completes", and it is partial so completed profiles, the
   * eventual majority, never pay for it.
   *
   * Placed immediately after the session check and before any product data is
   * read, for the same reason the session check is first: a gate that later data
   * fetching can drift above is not a gate.
   */
  const profile = await OnboardingService.create().start(user.id);
  if (profile.onboardingCompletedAt === null) redirect("/onboarding");

  const store = await cookies();
  const sidebarCollapsed = parseSidebarCollapsed(store.get(SIDEBAR_COLLAPSED_COOKIE)?.value);

  return (
    <AppShell sidebarCollapsed={sidebarCollapsed} onSidebarCollapsedChange={setSidebarCollapsed}>
      {children}
    </AppShell>
  );
}
