"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/config/app";
import { FOOTER_NAV_ITEMS, PRIMARY_NAV_ITEMS, type NavItem } from "@/config/navigation";

/**
 * Primary navigation sidebar (ATL-005).
 *
 * Order follows frontend spec §3 exactly: wordmark, collapse control, the six
 * primary destinations, a flexible spacer, Settings, then the user profile.
 *
 * Client component because selected state derives from the current pathname.
 *
 * Scope boundaries:
 *   - The collapse **control** and its per-user persistence are ATL-006. This
 *     component renders the collapsed/expanded *layout* (widths per §3) and
 *     reserves the control's position beside the wordmark, but owns no toggle.
 *   - The mobile **drawer** is ATL-007. Below the medium breakpoint this sidebar
 *     is hidden; it never becomes a compressed rail on mobile (§3).
 *   - The profile slot shows no user data: profiles arrive with ATL-015 and
 *     sessions with ATL-012. Inventing a name here would be fake data.
 */

interface SidebarProps {
  /**
   * Force the icon rail at every width.
   *
   * The default (`false`) is *responsive*: an icon rail on tablet and the full
   * sidebar from `lg` upward (§2), driven entirely by CSS so the navigation exists
   * exactly once in the DOM. Rendering a second copy per breakpoint produced
   * duplicate `navigation` landmarks with the same accessible name, which axe
   * correctly rejects (`landmark-unique`).
   *
   * ATL-006 will pass `true` from the user's persisted collapse preference.
   */
  collapsed?: boolean;
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

  return (
    <li>
      <Link
        href={item.href}
        // `aria-current="page"` is the programmatic selected state; the visual
        // treatment below is supplementary, never the only signal.
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
            hidden at rail width, so screen-reader users keep the text regardless. */}
        <span className={cn(collapsed ? "sr-only" : "sr-only lg:not-sr-only")}>{item.label}</span>
      </Link>
    </li>
  );
}

export function Sidebar({ collapsed = false }: SidebarProps) {
  const pathname = usePathname();
  const isActive = (item: NavItem) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <nav
      aria-label="Primary"
      data-slot="sidebar"
      data-collapsed={collapsed || undefined}
      className={cn(
        "flex h-full flex-col border-r border-border-default bg-surface",
        // §3: rail 72–80px, expanded 240–264px. Responsive by default (§2 tablet
        // uses the rail); `collapsed` forces the rail at every width for ATL-006.
        collapsed ? "w-20" : "w-20 lg:w-64",
      )}
    >
      {/* 1–2. Wordmark, with the collapse control's position reserved beside it.
              The control itself is ATL-006 and must not sit at the bottom (§3). */}
      <div
        className={cn(
          "flex h-16 shrink-0 items-center gap-2",
          collapsed ? "justify-center px-0" : "justify-center px-0 lg:justify-start lg:px-4",
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
      </div>

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
    </nav>
  );
}
