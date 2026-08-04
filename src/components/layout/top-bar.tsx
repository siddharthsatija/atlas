"use client";

import { usePathname } from "next/navigation";
import { BellIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { findActiveNavItem } from "@/config/navigation";
import { MobileNav } from "./mobile-nav";

/**
 * Sticky top bar (ATL-005), per frontend spec §4.
 *
 * Contains the page title, a global search trigger, the notification control, and
 * the "Ask Atlas" trigger.
 *
 * Each control is rendered **present but disabled**, because its behavior belongs
 * to a later ticket:
 *   - Search overlay        ATL-072 / ATL-073
 *   - Notifications panel   ATL-108 (unread badge wired there; the ticket says
 *                           "badge wired later")
 *   - Ask Atlas panel       ATL-025 / ATL-053
 *
 * `disabled` is the honest state: the control exists, is announced, and is visibly
 * unavailable. A focusable button that silently does nothing would be worse for
 * every user, and inventing behavior here would pre-empt those tickets.
 *
 * The label shown here is a section indicator, deliberately NOT an `<h1>` — each
 * page owns its single `<h1>` via `PageTitle`, keeping the heading hierarchy
 * unambiguous (frontend §20).
 */

interface TopBarActionProps {
  label: string;
  icon: typeof BellIcon;
}

function TopBarAction({ label, icon: Icon }: TopBarActionProps) {
  return (
    <button
      type="button"
      disabled
      aria-label={label}
      className={cn(
        "grid size-11 place-items-center rounded-control text-text-secondary",
        "transition-colors duration-[--duration-standard]",
        "hover:bg-surface-subtle hover:text-text-primary",
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <Icon aria-hidden="true" className="size-5" />
    </button>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const active = findActiveNavItem(pathname);

  return (
    <header
      data-slot="top-bar"
      className={cn(
        "sticky top-0 z-30 border-b border-border-default bg-surface/95 backdrop-blur",
        "flex h-16 shrink-0 items-center gap-2 px-4 sm:px-6",
      )}
    >
      {/* Mobile navigation trigger (ATL-007). First in the bar so it is the first
          thing a keyboard user reaches on the layout where it is the *only* route
          to navigation. Hides itself from `sm` upward. */}
      <MobileNav />

      {/* Section indicator. `aria-live` is deliberately absent: route changes are
          announced by the focus move to the page heading, not by this label. */}
      <p data-slot="top-bar-title" className="text-body font-medium">
        {active?.label ?? ""}
      </p>

      <div className="grow" />

      <div className="flex items-center gap-1">
        <TopBarAction label="Search" icon={SearchIcon} />
        <TopBarAction label="Notifications" icon={BellIcon} />
        <TopBarAction label="Ask Atlas" icon={SparklesIcon} />
      </div>
    </header>
  );
}
