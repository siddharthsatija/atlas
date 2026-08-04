"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MenuIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/config/app";
import { FOOTER_NAV_ITEMS, PRIMARY_NAV_ITEMS, type NavItem } from "@/config/navigation";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

/**
 * Mobile navigation drawer (ATL-007).
 *
 * Below `sm` the sidebar is hidden and frontend §2 requires it to become a drawer
 * — explicitly *not* a compressed rail (§3). Until this ticket there was no
 * replacement at all, so primary navigation was unreachable on a phone.
 *
 * Behaviour comes from the Drawer primitive (ATL-009), which wraps Radix Dialog:
 * focus trap, Escape, scrim dismissal, focus return to the trigger, and an inert
 * background. Reimplementing any of that by hand is how keyboard traps appear.
 *
 * **No `<nav>` landmark inside the drawer, deliberately.** The desktop sidebar
 * already owns the `navigation` landmark named "Primary". A second landmark with
 * the same name fails axe `landmark-unique`, and giving this one a different name
 * would invent a distinction the specification does not make. The drawer is a
 * modal dialog named "Navigation" with focus trapped inside it, so its purpose is
 * already announced and landmark navigation is not the mechanism a user reaches
 * for while trapped in a dialog.
 */

function MobileNavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;

  return (
    <li>
      <Link
        href={item.href}
        // Derived from the pathname, exactly as the sidebar does it, so the
        // selected destination is identical in both presentations.
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-control px-3 py-2 text-body font-medium",
          "min-h-11", // 44px target (frontend §20)
          "transition-colors duration-[--duration-standard]",
          active
            ? "bg-accent-subtle text-accent"
            : "text-text-secondary hover:bg-surface-subtle hover:text-text-primary",
        )}
      >
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        {item.label}
      </Link>
    </li>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  /**
   * Close on route change.
   *
   * Keyed on the pathname rather than on link clicks so it also covers browser
   * back/forward and any programmatic navigation — a drawer left open over the
   * destination is disorienting, and on a phone it hides the page entirely.
   *
   * The ref skips the initial render: without it this would close a drawer the
   * user just opened if the component mounted mid-navigation.
   */
  const previousPathname = React.useRef(pathname);
  React.useEffect(() => {
    if (previousPathname.current !== pathname) {
      previousPathname.current = pathname;
      setOpen(false);
    }
  }, [pathname]);

  const isActive = (item: NavItem) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      {/* Hidden from `sm` upward, where the sidebar rail takes over (§2 tablet).
          `sm:hidden` rather than a JS breakpoint check so there is no hydration
          mismatch and no flash of the wrong control. */}
      <DrawerTrigger
        data-slot="mobile-nav-trigger"
        aria-label="Open navigation menu"
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-control sm:hidden",
          "text-text-secondary transition-colors duration-[--duration-standard]",
          "hover:bg-surface-subtle hover:text-text-primary",
        )}
      >
        <MenuIcon aria-hidden="true" className="size-5" />
      </DrawerTrigger>

      <DrawerContent side="left" data-slot="mobile-nav" className="w-72 gap-6">
        <DrawerHeader>
          <DrawerTitle>Navigation</DrawerTitle>
          {/* Names the product inside the drawer, where the sidebar wordmark is
              not visible. Doubles as the dialog's description. */}
          <DrawerDescription>{APP_NAME}</DrawerDescription>
        </DrawerHeader>

        {/* Primary destinations, then Settings after a spacer — the same order as
            the sidebar (§3). "Primary actions remain reachable" (§2 mobile). */}
        <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
          <ul className="flex flex-col gap-1">
            {PRIMARY_NAV_ITEMS.map((item) => (
              <MobileNavLink key={item.key} item={item} active={isActive(item)} />
            ))}
          </ul>

          <div className="grow" />

          <ul className="flex flex-col gap-1 border-t border-border-default pt-2">
            {FOOTER_NAV_ITEMS.map((item) => (
              <MobileNavLink key={item.key} item={item} active={isActive(item)} />
            ))}
          </ul>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
