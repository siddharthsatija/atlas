"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/config/app";
import { FOOTER_NAV_ITEMS, PRIMARY_NAV_ITEMS, type NavItem } from "@/config/navigation";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Primary navigation sidebar (ATL-005) with its collapse control (ATL-006).
 *
 * Order follows frontend spec §3 exactly: wordmark, collapse control, the six
 * primary destinations, a flexible spacer, Settings, then the user profile.
 *
 * Client component because selected state derives from the current pathname and
 * the collapse control mutates state.
 *
 * Collapse behaviour (ATL-006):
 *   - The initial state arrives from the server as `defaultCollapsed`, resolved
 *     from the persisted preference, so there is no expanded-then-collapsed flash.
 *   - Persistence is injected as `onCollapsedChange` rather than imported, keeping
 *     the layer boundaries intact (see the prop docs).
 *   - Selected state is derived from the pathname, so collapsing never disturbs it.
 *
 * Scope boundaries:
 *   - Below `sm` this sidebar is hidden entirely and `MobileNav` takes over with
 *     a drawer (ATL-007). It never becomes a compressed rail on mobile (§3).
 *   - The profile slot shows no user data: profiles arrive with ATL-015 and
 *     sessions with ATL-012. Inventing a name here would be fake data.
 */

interface SidebarProps {
  /**
   * Initial collapse state, resolved on the server from the persisted preference
   * (ATL-006). Server-resolved rather than client-restored so the sidebar renders
   * in the right state immediately — a client-side restore would flash expanded
   * on every navigation.
   *
   * `true` forces the icon rail at every width. `false` is *responsive*: an icon
   * rail on tablet and the full sidebar from `lg` upward (§2), driven entirely by
   * CSS so the navigation exists exactly once in the DOM. Rendering a second copy
   * per breakpoint produced duplicate `navigation` landmarks with the same
   * accessible name, which axe correctly rejects (`landmark-unique`).
   */
  defaultCollapsed?: boolean;

  /**
   * Persists the preference. Injected by the layout as a Server Action rather
   * than imported here: `src/components` may not import `src/server` or
   * `src/features` (eslint layer boundaries), and injection keeps this component
   * testable with a plain spy.
   *
   * Optional — the sidebar is fully operable without it, the choice simply does
   * not outlive the page.
   */
  onCollapsedChange?: (collapsed: boolean) => void | Promise<void>;
}

function NavLink({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      // `aria-current="page"` is the programmatic selected state, and it is driven
      // by the pathname rather than by collapse state — so the selection survives
      // collapsing and expanding (§3 "preserve selected state").
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-control px-3 py-2 text-body-sm font-medium",
        "transition-colors duration-[--duration-standard]",
        "min-h-11", // 44px target (frontend §20)
        collapsed ? "justify-center px-0" : "justify-center px-0 lg:justify-start lg:px-3",
        active
          ? "bg-accent-subtle text-accent"
          : "text-text-secondary hover:bg-surface-subtle hover:text-text-primary",
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      {/* The label always stays in the accessibility tree — it is only visually
          hidden at rail width, so screen-reader users keep the text regardless.
          The tooltip below is therefore an addition for sighted users, never the
          only route to the label (frontend §19: hover enhances, never gates). */}
      <span className={cn(collapsed ? "sr-only" : "sr-only lg:not-sr-only")}>{item.label}</span>
    </Link>
  );

  return (
    <li>
      {/**
       * A local provider, despite `AppProviders` already supplying one.
       *
       * It makes the sidebar self-contained — rendering it without a provider
       * ancestor would otherwise throw — and lets rail navigation use a shorter
       * delay than the application default, which is tuned for incidental hints
       * rather than for labels the user needs in order to navigate at all.
       *
       * Nested Radix tooltip providers are supported; the nearest one wins.
       */}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          {/* `asChild` keeps the link as the trigger, so the tooltip opens on
              keyboard focus as well as hover — Radix handles both. */}
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent
            side="right"
            /**
             * ATL-007: the tooltip exists wherever the label is *visually* hidden,
             * which is not the same as "collapsed".
             *
             * When collapsed the rail is forced at every width, so the tooltip
             * always applies. When expanded, the label is still hidden below `lg`
             * (§2 tablet uses an icon rail), so the tooltip is needed there and
             * suppressed only from `lg` upward, where repeating a visible label
             * would be noise.
             *
             * `lg:hidden` is `display: none`, which removes it from the
             * accessibility tree too — not merely hidden from sight.
             */
            className={cn(!collapsed && "lg:hidden")}
          >
            {item.label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </li>
  );
}

/**
 * The collapse control (ATL-006).
 *
 * Sits beside the wordmark at the top — §3 states explicitly that it must not sit
 * at the bottom.
 *
 * Accessible name announces the *action*, and `aria-expanded` announces the
 * current state, so a screen reader reads "Collapse sidebar, button, expanded".
 * Naming it after the action rather than the state ("Sidebar, collapsed") is what
 * tells the user what pressing it will do.
 */
function CollapseControl({
  collapsed,
  navId,
  onToggle,
}: {
  collapsed: boolean;
  navId: string;
  onToggle: () => void;
}) {
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;

  return (
    <button
      type="button"
      data-slot="sidebar-collapse-control"
      onClick={onToggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      aria-controls={navId}
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-control", // 44px target
        "text-text-secondary transition-colors duration-[--duration-standard]",
        "hover:bg-surface-subtle hover:text-text-primary",
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
    </button>
  );
}

export function Sidebar({ defaultCollapsed = false, onCollapsedChange }: SidebarProps) {
  const pathname = usePathname();
  const navId = React.useId();

  /**
   * Client state seeded from the server-resolved preference.
   *
   * The toggle applies immediately and persistence is fire-and-forget: a layout
   * change must not wait on a network round trip, and a failed write costs the
   * user a preference, not the interaction.
   */
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const [, startTransition] = React.useTransition();

  const toggle = React.useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      startTransition(() => {
        void onCollapsedChange?.(next);
      });
      return next;
    });
  }, [onCollapsedChange]);

  const isActive = (item: NavItem) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    /**
     * The sidebar is a container, not a landmark.
     *
     * The `navigation` landmark below wraps the destination lists *only*. It
     * previously wrapped this whole column, which put the wordmark link and the
     * profile block inside the primary navigation — so a screen-reader user
     * listing the primary destinations was handed "Atlas — go to Overview"
     * alongside "Overview", two links to the same route, one of which is not a
     * destination at all. Frontend §3 defines the order of the *sidebar*; it does
     * not say the landmark encloses the wordmark or the profile, and enclosing
     * them is what made "Overview" ambiguous.
     *
     * A plain `div` rather than `aside`: `aside` is a `complementary` landmark,
     * and inventing one the specification does not call for trades one landmark
     * problem for another.
     */
    <div
      data-slot="sidebar"
      /**
       * The container carries the width and collapse state but has no role and no
       * accessible name — correctly so, since it is not a landmark. A test id is
       * how Testing Library reaches an element that is deliberately invisible to
       * the accessibility tree (same pattern as the sign-in form's return path).
       */
      data-testid="sidebar"
      data-collapsed={collapsed || undefined}
      className={cn(
        "flex h-full flex-col border-r border-border-default bg-surface",
        // §3: rail 72–80px, expanded 240–264px. Responsive by default (§2 tablet
        // uses the rail); `collapsed` forces the rail at every width.
        collapsed ? "w-20" : "w-20 lg:w-64",
      )}
    >
      {/* 1–2. Wordmark, then the collapse control beside it (§3: never at the
              bottom). At rail width the two would not fit side by side, so the
              wordmark abbreviates and the control sits beneath it — still at the
              top, still the first thing after the wordmark in DOM order. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          collapsed
            ? "h-auto flex-col justify-center px-0 py-3"
            : "h-auto flex-col justify-center px-0 py-3 lg:h-16 lg:flex-row lg:justify-between lg:px-4 lg:py-0",
        )}
      >
        <Link
          href="/overview"
          className="rounded-control text-h3 font-semibold tracking-tight"
          // The accessible name is fixed, so the visual abbreviation below never
          // changes what assistive technology announces.
          aria-label={`${APP_NAME} — go to Overview`}
        >
          <span aria-hidden="true">
            <span className={cn(collapsed ? "" : "lg:hidden")}>{APP_NAME.charAt(0)}</span>
            {!collapsed && <span className="hidden lg:inline">{APP_NAME}</span>}
          </span>
        </Link>

        <CollapseControl collapsed={collapsed} navId={navId} onToggle={toggle} />
      </div>

      {/* 3–10. The navigation landmark: destinations and nothing else, so every
              link a user finds here is somewhere they can go. */}
      <nav id={navId} aria-label="Primary" data-slot="sidebar-nav" className="flex grow flex-col">
        {/* 3–8. Primary destinations. */}
        <ul className="flex flex-col gap-1 px-3">
          {PRIMARY_NAV_ITEMS.map((item) => (
            <NavLink key={item.key} item={item} collapsed={collapsed} active={isActive(item)} />
          ))}
        </ul>

        {/* 9. Flexible spacer. */}
        <div className="grow" />

        {/* 10. Settings. */}
        <ul className="flex flex-col gap-1 px-3">
          {FOOTER_NAV_ITEMS.map((item) => (
            <NavLink key={item.key} item={item} collapsed={collapsed} active={isActive(item)} />
          ))}
        </ul>
      </nav>

      {/* 11. User profile. Intentionally data-free until ATL-012/ATL-015. */}
      <div className="mt-2 border-t border-border-default p-3">
        <div
          data-slot="sidebar-profile"
          className={cn(
            "flex items-center gap-3 rounded-control py-2",
            collapsed ? "justify-center px-0" : "justify-center px-0 lg:justify-start lg:px-3",
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-subtle text-label text-text-muted"
          >
            —
          </span>
          <span
            className={cn(
              "text-body-sm text-text-muted",
              collapsed ? "sr-only" : "sr-only lg:not-sr-only",
            )}
          >
            Not signed in
          </span>
        </div>
      </div>
    </div>
  );
}
