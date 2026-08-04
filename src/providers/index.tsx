import type { ReactNode } from "react";
import { ThemeProvider } from "./theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";
import { MonitoringProvider } from "./monitoring-provider";

/**
 * Composes application-wide providers.
 *
 * Keep this list short and justify each addition: every provider here is a client
 * boundary that wraps the entire tree. Data providers do not belong — Atlas reads
 * protected data in Server Components (architecture §6, performance skill).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      {/* Registers the browser error sink (ATL-095). Renders nothing; placed
          outermost so a failure in any provider below is still reported. */}
      <MonitoringProvider />
      <ToastProvider>
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <ToastViewport />
      </ToastProvider>
    </ThemeProvider>
  );
}
