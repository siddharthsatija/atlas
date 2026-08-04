import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/**
 * Authenticated product shell (ATL-005).
 *
 * Composes the sidebar, sticky top bar, and main content region per frontend
 * spec §2. A Server Component: it holds no state, so only the two navigation
 * pieces that read the pathname cross the client boundary.
 *
 * Responsive behavior (§2, breakpoints §21):
 *   - Large (≥1024px) — full sidebar at 240–264px
 *   - Medium (640–1023px) — icon rail at 72–80px ("reduced sidebar or icon rail")
 *   - Small (<640px) — sidebar hidden. §3 requires a drawer rather than a
 *     compressed rail on mobile, and the drawer is **ATL-007**; rendering a rail
 *     here would contradict the specification.
 *
 * This component owns the single `<main id="main">` landmark that the root
 * layout's skip link targets. Pages therefore compose `PageContainer` /
 * `PageHeader` / `PageTitle` and must not render their own `<main>`.
 */
export interface AppShellProps {
  children: ReactNode;
  /** Server-resolved sidebar collapse preference (ATL-006). */
  sidebarCollapsed?: boolean;
  /** Server Action persisting the preference (ATL-006), injected by the layout. */
  onSidebarCollapsedChange?: (collapsed: boolean) => void | Promise<void>;
}

export function AppShell({
  children,
  sidebarCollapsed = false,
  onSidebarCollapsedChange,
}: AppShellProps) {
  return (
    <div data-slot="app-shell" className="flex min-h-dvh">
      {/* Exactly one sidebar in the DOM. Its rail/expanded presentation is
          CSS-driven; hidden below `sm` until ATL-007 adds the mobile drawer.
          Rendering one instance per breakpoint would create duplicate
          `navigation` landmarks sharing an accessible name. */}
      <div className="hidden shrink-0 sm:block">
        <Sidebar
          defaultCollapsed={sidebarCollapsed}
          {...(onSidebarCollapsedChange ? { onCollapsedChange: onSidebarCollapsedChange } : {})}
        />
      </div>

      <div className="flex min-w-0 grow flex-col">
        <TopBar />
        <main id="main" data-slot="main" className="grow">
          {children}
        </main>
      </div>
    </div>
  );
}
