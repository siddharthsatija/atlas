import {
  ArchiveIcon,
  ClockIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SendIcon,
  LayersIcon,
  type LucideIcon,
} from "lucide-react";
import { NAV_ORDER, type NavKey } from "./app";

/**
 * Primary navigation definitions (ATL-005).
 *
 * Ordering is NOT defined here — it comes from `NAV_ORDER` in `./app`, which
 * encodes PRD §12 and frontend spec §3. Keeping one ordering source prevents the
 * sidebar and any future navigation surface from drifting apart.
 *
 * `Settings` is rendered separately at the foot of the sidebar, after a flexible
 * spacer (frontend §3, items 9–10), so it is flagged rather than duplicated here.
 */
export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Rendered below the flexible spacer rather than in the main list. */
  footer?: boolean;
}

const NAV_DEFINITIONS: Record<NavKey, Omit<NavItem, "key">> = {
  overview: { label: "Overview", href: "/overview", icon: LayoutDashboardIcon },
  assets: { label: "Digital Assets", href: "/assets", icon: LayersIcon },
  insights: { label: "Privacy Insights", href: "/insights", icon: ShieldAlertIcon },
  requests: { label: "Requests", href: "/requests", icon: SendIcon },
  activity: { label: "Activity", href: "/activity", icon: ClockIcon },
  archive: { label: "Archive", href: "/archive", icon: ArchiveIcon },
  settings: { label: "Settings", href: "/settings", icon: SettingsIcon, footer: true },
};

/** All items in the order defined by frontend §3. */
export const NAV_ITEMS: NavItem[] = NAV_ORDER.map((key) => ({ key, ...NAV_DEFINITIONS[key] }));

/** Items 3–8: the main navigation list. */
export const PRIMARY_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.footer !== true);

/** Item 10: rendered after the flexible spacer. */
export const FOOTER_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.footer === true);

/**
 * Resolves the navigation item a pathname belongs to, including nested routes
 * (`/assets/123` selects "Digital Assets"). Returns null for unknown paths rather
 * than guessing.
 */
export function findActiveNavItem(pathname: string): NavItem | null {
  return (
    NAV_ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`)) ?? null
  );
}
