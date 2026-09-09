"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Dark mode is a token-layer concern (design system §2). This provider only
 * toggles the `dark` class on <html>; no component reads the theme directly.
 *
 * Phase 1 contract (PRD §5.7, design system §2): Atlas launches in light mode
 * unconditionally. The OS/system preference must NOT determine the initial theme.
 * `defaultTheme` is therefore "light" and `enableSystem` is explicitly false.
 * Dark mode remains fully supported as an explicit user opt-in: next-themes
 * persists an explicit "dark" choice to localStorage and restores it on subsequent
 * loads ahead of `defaultTheme`.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
