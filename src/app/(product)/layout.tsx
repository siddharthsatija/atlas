import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";

/**
 * Layout for every authenticated product surface (ATL-005).
 *
 * Route protection is **ATL-012**: this layout deliberately performs no session
 * check yet. When that ticket lands, the session is verified here (server-side)
 * before the shell renders — client state is never authorization evidence
 * (architecture §5).
 *
 * Route-level `loading.tsx` / `error.tsx` boundaries are **ATL-010**.
 */
export default function ProductLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
