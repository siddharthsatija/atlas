import type { ReactNode } from "react";
import { ThemeProvider } from "./theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";

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
      <ToastProvider>
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <ToastViewport />
      </ToastProvider>
    </ThemeProvider>
  );
}
